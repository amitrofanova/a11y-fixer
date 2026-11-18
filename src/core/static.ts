import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { EXCLUDED_DIR_NAMES } from './apply'
import { resolveLibraryTag, type LibraryId, type LibraryMatch } from './libraries'
import {
  buildQuickEdit,
  insideProject,
  lineOf,
  loadParsers,
  locateMarker,
  preview,
} from './source'
import type { Issue, TextEdit } from './types'

const IMPACT: Record<string, string> = {
  'image-alt': 'critical',
  'area-alt': 'critical',
  'input-image-alt': 'critical',
  'button-name': 'critical',
  'link-name': 'serious',
  tabindex: 'serious',
  'frame-title': 'serious',
  'empty-heading': 'minor',
}

const ENGLISH: Record<string, { description: string; help: string }> = {
  'image-alt': {
    description: 'Ensure <img> elements have alternative text or a role of none or presentation',
    help: 'Images must have alternative text',
  },
  'button-name': {
    description: 'Ensure buttons have discernible text',
    help: 'Buttons must have discernible text',
  },
  'link-name': {
    description: 'Ensure links have discernible text',
    help: 'Links must have discernible text',
  },
  tabindex: {
    description: 'Ensure tabindex attribute values are not greater than 0',
    help: 'Elements should not have tabindex greater than zero',
  },
  'frame-title': {
    description: 'Ensure <iframe> and <frame> elements have an accessible name',
    help: 'Frames must have an accessible name',
  },
  'empty-heading': {
    description: 'Ensure headings have discernible text',
    help: 'Headings should not be empty',
  },
  'area-alt': {
    description: 'Ensure <area> elements of image maps have alternative text',
    help: 'Active <area> elements must have alternative text',
  },
  'input-image-alt': {
    description: 'Ensure <input type="image"> elements have alternative text',
    help: 'Image buttons must have alternative text',
  },
}

export interface StaticFileError {
  file?: string
  message: string
}

export interface StaticAudit {
  issues: Issue[]
  errors: StaticFileError[]
  files: Record<string, string>
}

interface SfcNode {
  type?: number
  tag?: string
  tagType?: number
  content?: string
  props?: SfcProp[]
  children?: SfcNode[]
  loc?: { start: { offset: number }; end: { offset: number } }
}

interface SfcProp {
  type?: number
  name?: string
  value?: { content?: string } | null
  arg?: { content?: string; isStatic?: boolean } | null
}

type Content = 'text' | 'empty' | 'dynamic' | 'opaque'
type AttrKind = 'missing' | 'static' | 'dynamic' | 'bare'

interface AttrState {
  kind: AttrKind
  value: string
  boolean?: boolean
}

interface Decision {
  ruleId: string
  kind: 'manual' | 'quick' | 'ambiguous'
  reason?: string
}

type Parsers = NonNullable<ReturnType<typeof loadParsers>>

export function listVueFiles(directory: string): string[] {
  const root = path.resolve(directory)
  const found: string[] = []
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if ((EXCLUDED_DIR_NAMES as readonly string[]).includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile() && entry.name.endsWith('.vue')) found.push(full)
    }
  }
  visit(root)
  return found.sort()
}

export function analyzeVueFiles(projectRoot: string, files: string[], locale: 'ru' | 'en' = 'en'): StaticAudit {
  const root = path.resolve(projectRoot)
  const parsers = loadParsers(root)
  if (!parsers) return { issues: [], errors: [{ message: 'NO_VUE_COMPILER' }], files: {} }
  const issues: Issue[] = []
  const errors: StaticFileError[] = []
  const snapshots: Record<string, string> = {}
  const cache: Record<string, string> = {}
  const seen = new Set<string>()
  for (const input of files) {
    const resolved = path.normalize(path.resolve(root, input))
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      analyzeOne(root, resolved, parsers, cache, snapshots, issues, errors, locale)
    } catch (error) {
      errors.push({ file: resolved, message: error instanceof Error ? error.message : 'READ_FAILED' })
    }
  }
  return { issues: sortIssues(issues), errors, files: snapshots }
}

function analyzeOne(
  projectRoot: string,
  file: string,
  parsers: Parsers,
  cache: Record<string, string>,
  snapshots: Record<string, string>,
  issues: Issue[],
  errors: StaticFileError[],
  locale: 'ru' | 'en',
): void {
  if (!insideProject(projectRoot, file)) {
    errors.push({ file, message: 'OUTSIDE_PROJECT' })
    return
  }
  if (!file.endsWith('.vue')) {
    errors.push({ file, message: 'NOT_VUE' })
    return
  }
  let source = ''
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    errors.push({ file, message: 'READ_FAILED' })
    return
  }
  snapshots[file] = source
  cache[file] = source
  const parsed = parsers.parse(source, { filename: file })
  const template = parsed.descriptor.template
  if (!template) return
  if (template.lang && template.lang !== 'html') {
    errors.push({ file, message: 'UNSUPPORTED_TEMPLATE_LANG' })
    return
  }
  const parseError = parsed.errors?.find((item) => item.message)
  if (parseError?.message) {
    errors.push({ file, message: `PARSE_FAILED ${parseError.message}` })
    return
  }
  const root = template.ast as SfcNode | undefined
  if (!root) return
  const scripts = [parsed.descriptor.script?.content ?? '', parsed.descriptor.scriptSetup?.content ?? ''].filter((item) => item.length > 0)
  const visit = (node: SfcNode) => {
    if (node.type === parsers.element && node.loc && node.tag) {
      const decisions = node.tagType === parsers.native
        ? decide(node, root, parsers)
        : node.tagType === parsers.component
          ? decideLibrary(node, root, parsers, resolveLibraryTag(projectRoot, file, node.tag, scripts))
          : []
      for (const decision of decisions) {
        const issue = materialize(projectRoot, file, node, root, decision, parsers, cache, locale)
        if (issue) issues.push(issue)
        else errors.push({ file, message: 'MAPPING_FAILED' })
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
}

function decideLibrary(node: SfcNode, root: SfcNode, parsers: Parsers, match: LibraryMatch | null): Decision[] {
  if (!match) return []
  const decisions: Decision[] = []
  if (match.kind === 'image' && match.library === 'vuetify') {
    const alt = requiredAttr(node, 'alt', 'image-alt', parsers)
    if (alt) decisions.push(alt)
  }
  if (match.kind === 'button') {
    const name = libraryName(node, root, parsers, match)
    if (name) decisions.push(name)
    if (match.forwardsTabindex) {
      const tab = tabindexDecision(node, parsers)
      if (tab) decisions.push(tab)
    }
  }
  return decisions
}

function libraryName(node: SfcNode, root: SfcNode, parsers: Parsers, match: LibraryMatch): Decision | null {
  const ruleId = linkedComponent(node, parsers, match.library) ? 'link-name' : 'button-name'
  if (readAttr(node, 'aria-label', parsers).kind === 'bare') return ambiguous(ruleId, 'bare-bind')
  const named = libraryAccessibleName(node, root, parsers, match)
  if (named === 'yes') return null
  if (named === 'no') return { ruleId, kind: 'manual' }
  return ambiguous(ruleId, named)
}

function linkedComponent(node: SfcNode, parsers: Parsers, library: LibraryId): boolean {
  const href = readAttr(node, 'href', parsers)
  const to = readAttr(node, 'to', parsers)
  if (library === 'quasar') {
    if (href.kind === 'static' || href.kind === 'dynamic') return true
    if (to.kind === 'dynamic') return true
    return to.kind === 'static' && to.value.trim().length > 0
  }
  return truthyLink(href) || truthyLink(to)
}

function truthyLink(attr: AttrState): boolean {
  if (attr.kind === 'dynamic') return true
  return attr.kind === 'static' && attr.value.trim().length > 0
}

function libraryAccessibleName(
  node: SfcNode,
  root: SfcNode,
  parsers: Parsers,
  match: LibraryMatch,
): 'yes' | 'no' | 'bare-bind' | 'dynamic-attribute' | 'dynamic-content' | 'opaque-content' | 'unresolved-label' {
  const aria = readAttr(node, 'aria-label', parsers)
  if (aria.kind === 'bare') return 'bare-bind'
  if (aria.kind === 'dynamic') return 'dynamic-attribute'
  if (aria.kind === 'static' && aria.value.trim()) return 'yes'
  const labelledBy = readAttr(node, 'aria-labelledby', parsers)
  if (labelledBy.kind === 'bare') return 'bare-bind'
  if (labelledBy.kind === 'dynamic') return 'dynamic-attribute'
  if (labelledBy.kind === 'static') {
    const ids = labelledBy.value.split(/\s+/).filter(Boolean)
    if (ids.length > 0) return ids.every((id) => idText(root, id, parsers) === 'text') ? 'yes' : 'unresolved-label'
  }
  if (hasDirective(node, 'html', parsers)) return 'opaque-content'
  const slot = defaultSlot(node, parsers)
  const named = match.library === 'vuetify'
    ? vuetifyName(node, parsers, slot)
    : match.library === 'quasar'
      ? quasarName(node, parsers, slot)
      : nuxtName(node, parsers, slot)
  if (named !== 'no') return named
  const title = readAttr(node, 'title', parsers)
  if (title.kind === 'bare') return 'bare-bind'
  if (title.kind === 'dynamic') return 'dynamic-attribute'
  if (title.kind === 'static' && title.value.trim()) return 'yes'
  return 'no'
}

function vuetifyName(node: SfcNode, parsers: Parsers, slot: SlotContent): NameState {
  const fromSlot = providedSlot(slot)
  if (fromSlot) return fromSlot
  const icon = readAttr(node, 'icon', parsers)
  const text = readAttr(node, 'text', parsers)
  if (icon.kind === 'bare') return 'bare-bind'
  if (icon.kind === 'dynamic') {
    if (text.kind === 'bare') return 'bare-bind'
    if (text.kind === 'dynamic' || visibleProp(text)) return 'dynamic-attribute'
    return 'no'
  }
  if (icon.kind === 'static' && !icon.boolean && icon.value.trim()) return 'no'
  if (text.kind === 'bare') return 'bare-bind'
  if (text.kind === 'dynamic') return 'dynamic-attribute'
  return visibleProp(text) ? 'yes' : 'no'
}

function quasarName(node: SfcNode, parsers: Parsers, slot: SlotContent): NameState {
  if (slot.kind === 'text') return 'yes'
  const label = readAttr(node, 'label', parsers)
  if (label.kind === 'bare') return 'bare-bind'
  if (label.kind === 'dynamic') return 'dynamic-attribute'
  if (visibleProp(label)) return 'yes'
  if (slot.kind === 'dynamic') return 'dynamic-content'
  if (slot.kind === 'opaque') return 'opaque-content'
  return 'no'
}

function nuxtName(node: SfcNode, parsers: Parsers, slot: SlotContent): NameState {
  const fromSlot = providedSlot(slot)
  if (fromSlot) return fromSlot
  const label = readAttr(node, 'label', parsers)
  if (label.kind === 'bare') return 'bare-bind'
  if (label.kind === 'dynamic') return 'dynamic-attribute'
  return visibleProp(label) ? 'yes' : 'no'
}

function providedSlot(slot: SlotContent): NameState | null {
  if (!slot.provided) return null
  if (slot.kind === 'text') return 'yes'
  if (slot.kind === 'dynamic') return 'dynamic-content'
  if (slot.kind === 'opaque') return 'opaque-content'
  return 'no'
}

function visibleProp(attr: AttrState): boolean {
  if (attr.kind !== 'static') return false
  if (attr.boolean) return true
  return attr.value.trim().length > 0
}

interface SlotContent {
  provided: boolean
  kind: Content
}

type NameState = 'yes' | 'no' | 'bare-bind' | 'dynamic-attribute' | 'dynamic-content' | 'opaque-content'

function defaultSlot(node: SfcNode, parsers: Parsers): SlotContent {
  let provided = false
  let kind: Content = 'empty'
  for (const child of node.children ?? []) {
    if (namedSlot(child, parsers) || child.type === parsers.comment) continue
    if (child.type === parsers.text && !child.content?.trim()) continue
    provided = true
    kind = mergeContent(kind, childKind(child, parsers))
  }
  return { provided, kind }
}

function namedSlot(node: SfcNode, parsers: Parsers): boolean {
  if (node.type !== parsers.element) return false
  const slot = (node.props ?? []).find((prop) => prop.type === parsers.directive && prop.name === 'slot')
  const arg = slot?.arg?.content
  return Boolean(arg && arg !== 'default')
}

function decide(node: SfcNode, root: SfcNode, parsers: Parsers): Decision[] {
  const decisions: Decision[] = []
  const alt = altDecision(node, parsers)
  if (alt) decisions.push(alt)
  const name = nameDecision(node, root, parsers)
  if (name) decisions.push(name)
  const tab = tabindexDecision(node, parsers)
  if (tab) decisions.push(tab)
  return decisions
}

function altDecision(node: SfcNode, parsers: Parsers): Decision | null {
  const ruleId = altRule(node, parsers)
  if (!ruleId) return null
  const role = readAttr(node, 'role', parsers)
  if (role.kind === 'bare') return ambiguous(ruleId, 'bare-bind')
  if (role.kind === 'dynamic') return ambiguous(ruleId, 'dynamic-attribute')
  if (role.kind === 'static' && ['presentation', 'none'].includes(role.value.trim().toLowerCase())) return null
  return requiredAttr(node, 'alt', ruleId, parsers)
}

function altRule(node: SfcNode, parsers: Parsers): string | null {
  if (node.tag === 'img') return 'image-alt'
  if (node.tag === 'area') {
    const href = readAttr(node, 'href', parsers)
    return href.kind === 'missing' ? null : 'area-alt'
  }
  if (node.tag === 'input') {
    const type = readAttr(node, 'type', parsers)
    return type.kind === 'static' && type.value.toLowerCase() === 'image' ? 'input-image-alt' : null
  }
  return null
}

function requiredAttr(node: SfcNode, name: string, ruleId: string, parsers: Parsers): Decision | null {
  const attr = readAttr(node, name, parsers)
  if (attr.kind === 'bare') return ambiguous(ruleId, 'bare-bind')
  if (attr.kind === 'dynamic') return ambiguous(ruleId, 'dynamic-attribute')
  if (attr.kind === 'static') return null
  return { ruleId, kind: 'manual' }
}

function nameDecision(node: SfcNode, root: SfcNode, parsers: Parsers): Decision | null {
  const ruleId = nameRule(node, parsers)
  if (!ruleId) return null
  const named = accessibleName(node, root, parsers)
  if (named === 'yes') return null
  if (named === 'no') return { ruleId, kind: 'manual' }
  return ambiguous(ruleId, named)
}

function nameRule(node: SfcNode, parsers: Parsers): string | null {
  if (node.tag === 'button') return 'button-name'
  if (node.tag === 'iframe') return 'frame-title'
  if (node.tag && /^h[1-6]$/.test(node.tag)) return 'empty-heading'
  if (node.tag === 'a') {
    const href = readAttr(node, 'href', parsers)
    return href.kind === 'missing' ? null : 'link-name'
  }
  return null
}

function accessibleName(node: SfcNode, root: SfcNode, parsers: Parsers): 'yes' | 'no' | 'bare-bind' | 'dynamic-attribute' | 'dynamic-content' | 'opaque-content' | 'unresolved-label' {
  const label = readAttr(node, 'aria-label', parsers)
  if (label.kind === 'bare') return 'bare-bind'
  if (label.kind === 'dynamic') return 'dynamic-attribute'
  if (label.kind === 'static' && label.value.trim()) return 'yes'
  const labelledBy = readAttr(node, 'aria-labelledby', parsers)
  if (labelledBy.kind === 'bare') return 'bare-bind'
  if (labelledBy.kind === 'dynamic') return 'dynamic-attribute'
  if (labelledBy.kind === 'static') {
    const ids = labelledBy.value.split(/\s+/).filter(Boolean)
    if (ids.length > 0) {
      return ids.every((id) => idText(root, id, parsers) === 'text') ? 'yes' : 'unresolved-label'
    }
  }
  const content = contentKind(node, parsers)
  if (content === 'text') return 'yes'
  if (content === 'dynamic') return 'dynamic-content'
  if (content === 'opaque') return 'opaque-content'
  const title = readAttr(node, 'title', parsers)
  if (title.kind === 'bare') return 'bare-bind'
  if (title.kind === 'dynamic') return 'dynamic-attribute'
  if (title.kind === 'static' && title.value.trim()) return 'yes'
  return 'no'
}

function tabindexDecision(node: SfcNode, parsers: Parsers): Decision | null {
  const attr = readAttr(node, 'tabindex', parsers)
  if (attr.kind === 'missing') return null
  if (attr.kind === 'bare') return ambiguous('tabindex', 'bare-bind')
  if (attr.kind === 'dynamic') return ambiguous('tabindex', 'dynamic-attribute')
  const numeric = Number(attr.value.trim())
  if (!Number.isInteger(numeric) || numeric <= 0) return null
  return { ruleId: 'tabindex', kind: 'quick' }
}

function materialize(
  projectRoot: string,
  file: string,
  node: SfcNode,
  root: SfcNode,
  decision: Decision,
  parsers: Parsers,
  cache: Record<string, string>,
  locale: 'ru' | 'en',
): Issue | null {
  const loc = node.loc
  if (!loc) return null
  const located = locateMarker(
    projectRoot,
    `${loc.start.offset}:${loc.end.offset}:${encodeURIComponent(file)}`,
    parsers,
    cache,
  )
  if (!located) return null
  let kind = decision.kind
  let reason = decision.reason
  let edits: TextEdit[] = []
  if (located.repeated) {
    kind = 'ambiguous'
    reason = 'repeated-source'
  } else if (kind === 'quick') {
    const built = buildQuickEdit(located, decision.ruleId, [])
    if ('reason' in built) {
      kind = 'ambiguous'
      reason = built.reason
    } else {
      edits = built.edits
      if (!preview(located.text, located.start, edits)) {
        kind = 'ambiguous'
        reason = 'no-insert-point'
        edits = []
      }
    }
  } else if (kind === 'manual' && isSingleRoot(root, node, parsers)) {
    kind = 'ambiguous'
    reason = 'fallthrough'
  }
  const text = ruleText(decision.ruleId, locale)
  const view = edits.length > 0 ? preview(located.text, located.start, edits) : null
  return {
    id: `static:${decision.ruleId}:${located.file}:${located.start}`,
    ruleId: decision.ruleId,
    impact: IMPACT[decision.ruleId] ?? null,
    description: text.description,
    help: text.help,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.14/${decision.ruleId}`,
    failureSummary: '',
    tab: kind,
    reason,
    file: located.file,
    start: located.start,
    end: located.end,
    line: lineOf(located.source, located.start),
    sourceText: located.text,
    domHtml: '',
    before: view?.before,
    after: view?.after,
    edits,
  }
}

function isSingleRoot(root: SfcNode, node: SfcNode, parsers: Parsers): boolean {
  const meaningful = (root.children ?? []).filter((child) => {
    if (child.type === parsers.comment) return false
    if (child.type === parsers.text) return Boolean(child.content?.trim())
    return true
  })
  return meaningful.length === 1 && meaningful[0] === node
}

function contentKind(node: SfcNode, parsers: Parsers): Content {
  if (hasDirective(node, 'html', parsers)) return 'opaque'
  let result: Content = 'empty'
  for (const child of node.children ?? []) {
    result = mergeContent(result, childKind(child, parsers))
  }
  return result
}

function childKind(node: SfcNode, parsers: Parsers): Content {
  if (node.type === parsers.text) return node.content?.trim() ? 'text' : 'empty'
  if (node.type === parsers.comment) return 'empty'
  if (node.type === parsers.interpolation) return 'dynamic'
  if (node.type !== parsers.element) return 'opaque'
  if (node.tagType === parsers.component || node.tagType === parsers.slot) return 'opaque'
  return contentKind(node, parsers)
}

function mergeContent(left: Content, right: Content): Content {
  if (left === 'text' || right === 'text') return 'text'
  if (left === 'opaque' || right === 'opaque') return 'opaque'
  if (left === 'dynamic' || right === 'dynamic') return 'dynamic'
  return 'empty'
}

function idText(root: SfcNode, id: string, parsers: Parsers): Content | 'missing' | 'duplicate' {
  const found: Content[] = []
  const visit = (node: SfcNode) => {
    if (node.type === parsers.element) {
      const own = readAttr(node, 'id', parsers)
      if (own.kind === 'static' && own.value === id) found.push(contentKind(node, parsers))
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  if (found.length !== 1) return found.length === 0 ? 'missing' : 'duplicate'
  return found[0] ?? 'missing'
}

function readAttr(node: SfcNode, name: string, parsers: Parsers): AttrState {
  const props = node.props ?? []
  if (props.some((prop) => prop.type === parsers.directive && prop.name === 'bind' && (!prop.arg || prop.arg.isStatic === false))) {
    return { kind: 'bare', value: '' }
  }
  if (props.some((prop) => prop.type === parsers.directive && prop.name === 'bind' && prop.arg?.content === name)) {
    return { kind: 'dynamic', value: '' }
  }
  const found = props.find((prop) => prop.type === parsers.attribute && prop.name?.toLowerCase() === name.toLowerCase())
  if (!found) return { kind: 'missing', value: '' }
  if (!found.value) return { kind: 'static', value: '', boolean: true }
  return { kind: 'static', value: found.value.content ?? '' }
}

function hasDirective(node: SfcNode, name: string, parsers: Parsers): boolean {
  return (node.props ?? []).some((prop) => prop.type === parsers.directive && prop.name === name)
}

function ambiguous(ruleId: string, reason: string): Decision {
  return { ruleId, kind: 'ambiguous', reason }
}

function ruleText(ruleId: string, locale: 'ru' | 'en'): { description: string; help: string } {
  const english = ENGLISH[ruleId] ?? { description: ruleId, help: ruleId }
  if (locale !== 'ru') return english
  const translated = russianRules()?.[ruleId]
  if (translated?.description && translated.help) {
    return { description: translated.description, help: translated.help }
  }
  return english
}

let russian: Record<string, { description?: string; help?: string }> | null | undefined

function russianRules(): Record<string, { description?: string; help?: string }> | null {
  if (russian !== undefined) return russian
  try {
    const axe = createRequire(__filename).resolve('axe-core')
    const file = path.join(path.dirname(axe), 'locales', 'ru.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { rules?: Record<string, { description?: string; help?: string }> }
    russian = parsed.rules ?? null
  } catch {
    russian = null
  }
  return russian
}

function sortIssues(issues: Issue[]): Issue[] {
  const rank: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 }
  return [...issues].sort((left, right) => {
    const impact = (rank[left.impact ?? ''] ?? 4) - (rank[right.impact ?? ''] ?? 4)
    if (impact !== 0) return impact
    const file = (left.file ?? '').localeCompare(right.file ?? '')
    if (file !== 0) return file
    return (left.start ?? 0) - (right.start ?? 0)
  })
}

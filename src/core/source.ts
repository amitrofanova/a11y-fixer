import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { AxeCheck, TextEdit } from './types'

const QUICK_RULES = new Set([
  'scrollable-region-focusable',
  'tabindex',
  'no-autoplay-audio',
  'aria-prohibited-attr',
  'aria-hidden-body',
  'meta-viewport',
  'meta-viewport-large',
])

export function isQuickRule(ruleId: string): boolean {
  return QUICK_RULES.has(ruleId)
}

export const MANUAL_RULES = new Set([
  'image-alt',
  'area-alt',
  'input-image-alt',
  'object-alt',
  'svg-img-alt',
  'role-img-alt',
  'image-redundant-alt',
  'button-name',
  'input-button-name',
  'link-name',
  'select-name',
  'summary-name',
  'aria-command-name',
  'aria-dialog-name',
  'aria-input-field-name',
  'aria-meter-name',
  'aria-progressbar-name',
  'aria-toggle-field-name',
  'aria-tooltip-name',
  'aria-tab-name',
  'aria-treeitem-name',
  'label',
  'document-title',
  'empty-heading',
  'frame-title',
  'html-has-lang',
  'html-lang-valid',
  'valid-lang',
  'autocomplete-valid',
  'video-caption',
  'audio-caption',
])

interface VueLoc {
  start: { offset: number }
  end: { offset: number }
}

interface VueProp {
  type: number
  name?: string
  loc: VueLoc
  value?: { content: string; loc: VueLoc } | null
  arg?: { content?: string; isStatic?: boolean } | null
}

interface VueNode {
  type: number
  tag?: string
  tagType?: number
  props?: VueProp[]
  children?: VueNode[]
  loc: VueLoc
}

interface BabelFile {
  program: { body: unknown[] }
}

interface Parsers {
  parse: (source: string, options: { filename: string }) => {
    descriptor: {
      template?: { ast?: VueNode; lang?: string } | null
      script?: { content?: string } | null
      scriptSetup?: { content?: string } | null
    }
    errors?: Array<{ message?: string }>
  }
  babelParse: (source: string, options: { sourceType: 'module'; plugins: string[] }) => BabelFile
  element: number
  attribute: number
  directive: number
  native: number
  text: number
  comment: number
  interpolation: number
  component: number
  slot: number
  template: number
}

export interface Prepared {
  file: string
  start: number
  end: number
  text: string
  repeated: boolean
  source: string
  attributeType: number
  directiveType: number
  node?: VueNode
  html?: HtmlTag
}

interface HtmlAttr {
  name: string
  value: string | null
  valueStart: number
  valueEnd: number
  rawStart: number
  rawEnd: number
}

interface HtmlTag {
  name: string
  tagStart: number
  tagEnd: number
  attrs: HtmlAttr[]
}

export function loadParsers(projectRoot: string): Parsers | null {
  try {
    const require = createRequire(path.join(projectRoot, 'package.json'))
    const core = require('@vue/compiler-core') as {
      NodeTypes?: { ELEMENT?: number; ATTRIBUTE?: number; DIRECTIVE?: number; TEXT?: number; COMMENT?: number; INTERPOLATION?: number }
      ElementTypes?: { ELEMENT?: number; COMPONENT?: number; SLOT?: number; TEMPLATE?: number }
    }
    const sfc = require('@vue/compiler-sfc') as {
      parse: Parsers['parse']
      babelParse: Parsers['babelParse']
    }
    return {
      parse: sfc.parse,
      babelParse: (source, options) => sfc.babelParse(source, options),
      element: core.NodeTypes?.ELEMENT ?? 1,
      attribute: core.NodeTypes?.ATTRIBUTE ?? 6,
      directive: core.NodeTypes?.DIRECTIVE ?? 7,
      native: core.ElementTypes?.ELEMENT ?? 0,
      text: core.NodeTypes?.TEXT ?? 2,
      comment: core.NodeTypes?.COMMENT ?? 3,
      interpolation: core.NodeTypes?.INTERPOLATION ?? 5,
      component: core.ElementTypes?.COMPONENT ?? 1,
      slot: core.ElementTypes?.SLOT ?? 2,
      template: core.ElementTypes?.TEMPLATE ?? 3,
    }
  } catch {
    return null
  }
}

export function readProjectFile(file: string, cache: Record<string, string>): string {
  const normalized = path.normalize(file)
  if (cache[normalized] === undefined) {
    cache[normalized] = fs.readFileSync(normalized, 'utf8')
  }
  return cache[normalized]
}

export function lineOf(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

export function insideProject(projectRoot: string, file: string): boolean {
  const root = path.resolve(projectRoot)
  const resolved = path.resolve(file)
  return resolved === root || resolved.startsWith(root + path.sep)
}

export function locateMarker(
  projectRoot: string,
  marker: string | null,
  parsers: Parsers | null,
  cache: Record<string, string>,
): Prepared | null {
  if (!marker || !parsers) return null
  const match = /^(\d+):(\d+):(.*)$/.exec(marker)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const filename = path.normalize(decodeURIComponent(match[3]))
  if (!insideProject(projectRoot, filename) || !fs.existsSync(filename)) return null
  const source = readProjectFile(filename, cache)
  const text = source.slice(start, end)
  if (!text.startsWith('<')) return null
  const parsed = parsers.parse(source, { filename })
  const found = findElement(parsed.descriptor.template?.ast, parsers.element, start, end)
  if (!found) return null
  return {
    file: filename,
    start,
    end,
    text,
    repeated: hasFor(found.node, parsers.directive) || found.ancestors.some((item) => hasFor(item, parsers.directive)),
    source,
    attributeType: parsers.attribute,
    directiveType: parsers.directive,
    node: found.node,
  }
}

export function locateHtmlFallback(
  projectRoot: string,
  ruleId: string,
  tag: string,
  cache: Record<string, string>,
): Prepared | null {
  const file = path.join(projectRoot, 'index.html')
  if (!fs.existsSync(file)) return null
  const source = readProjectFile(file, cache)
  if (ruleId === 'meta-viewport' || ruleId === 'meta-viewport-large') {
    const tags = findTags(source, 'meta').filter((item) =>
      item.attrs.some((attr) => attr.name.toLowerCase() === 'name' && attr.value?.toLowerCase() === 'viewport'),
    )
    if (tags.length !== 1) return null
    return htmlPrepared(file, source, tags[0])
  }
  if (ruleId === 'aria-hidden-body' || tag === 'BODY') {
    const tags = findTags(source, 'body')
    if (tags.length !== 1) return null
    return htmlPrepared(file, source, tags[0])
  }
  if (ruleId === 'html-has-lang' || ruleId === 'html-lang-valid' || (ruleId === 'valid-lang' && tag === 'HTML')) {
    const tags = findTags(source, 'html')
    if (tags.length !== 1) return null
    return htmlPrepared(file, source, tags[0])
  }
  if (ruleId === 'document-title' || tag === 'TITLE') {
    const tags = findTags(source, 'title')
    if (tags.length !== 1) return null
    return htmlPrepared(file, source, tags[0])
  }
  return null
}

export function buildQuickEdit(
  located: Prepared,
  ruleId: string,
  checks: AxeCheck[],
): { edits: TextEdit[] } | { reason: string } {
  if (located.repeated) return { reason: 'repeated-source' }
  if (ruleId === 'scrollable-region-focusable' && located.node) {
    return one(insertAttribute(located, 'tabindex', '0'))
  }
  if (ruleId === 'tabindex' && located.node) {
    const attr = attributes(located.node, located.attributeType).find((prop) => prop.name === 'tabindex')
    const blocked = bindingBlocker(located.node, located.directiveType, ['tabindex'])
    if (blocked) return { reason: blocked }
    if (!attr?.value) return { reason: 'no-attribute' }
    const numeric = Number(attr.value.content)
    if (!Number.isInteger(numeric) || numeric <= 0) return { reason: 'unsafe-value' }
    const range = quotedValueRange(located.source, attr.value.loc.start.offset, attr.value.loc.end.offset)
    return {
      edits: [{
        file: located.file,
        start: range.start,
        end: range.end,
        insert: '0',
      }],
    }
  }
  if (ruleId === 'no-autoplay-audio' && located.node) {
    return one(deleteAttribute(located, 'autoplay'))
  }
  if (ruleId === 'aria-prohibited-attr' && located.node) {
    const names = prohibitedNames(checks)
    if (names.length === 0) return { reason: 'no-attribute' }
    const edits: TextEdit[] = []
    for (const name of names) {
      const result = deleteAttribute(located, name)
      if ('reason' in result) return result
      edits.push(result)
    }
    return { edits }
  }
  if (ruleId === 'aria-hidden-body') {
    return one(located.node ? deleteAttribute(located, 'aria-hidden') : deleteHtmlAttribute(located, 'aria-hidden'))
  }
  if (ruleId === 'meta-viewport' || ruleId === 'meta-viewport-large') {
    return one(replaceViewport(located))
  }
  return { reason: 'unsupported-rule' }
}

export function rewriteViewportContent(value: string): string | null {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  let changed = false
  const kept: string[] = []
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=')
    const key = rawKey?.trim().toLowerCase()
    const setting = rawValue?.trim().toLowerCase()
    const scalable = setting === undefined ? Number.NaN : Number(setting)
    if (key === 'user-scalable' && (setting === 'no' || (Number.isFinite(scalable) && scalable < 1))) {
      changed = true
      continue
    }
    if (key === 'maximum-scale' && Number.isFinite(scalable) && scalable < 5) {
      changed = true
      continue
    }
    kept.push(part.trim())
  }
  if (!changed) return null
  return kept.join(', ')
}

export function resolveRange(
  text: string,
  hintStart: number,
  sourceText: string | undefined,
): { start: number; end: number } | null {
  if (!sourceText) return null
  if (text.slice(hintStart, hintStart + sourceText.length) === sourceText) {
    return { start: hintStart, end: hintStart + sourceText.length }
  }
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(sourceText, from)
    if (at < 0) break
    const distance = Math.abs(at - hintStart)
    if (distance < bestDistance) {
      best = at
      bestDistance = distance
    }
    from = at + sourceText.length
  }
  if (best < 0) return null
  return { start: best, end: best + sourceText.length }
}

export function applyTextEdits(source: string, edits: TextEdit[]): string | null {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end)
  for (let index = 0; index < ordered.length; index += 1) {
    for (let other = index + 1; other < ordered.length; other += 1) {
      if (overlaps(ordered[index], ordered[other])) return null
    }
  }
  let next = source
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > next.length) return null
    next = next.slice(0, edit.start) + edit.insert + next.slice(edit.end)
  }
  return next
}

export function preview(sourceText: string, elementStart: number, edits: TextEdit[]): { before: string; after: string } | null {
  const local = edits.map((edit) => ({
    ...edit,
    start: edit.start - elementStart,
    end: edit.end - elementStart,
  }))
  const after = applyTextEdits(sourceText, local)
  if (after == null) return null
  return { before: sourceText, after }
}

function one(result: TextEdit | { reason: string }): { edits: TextEdit[] } | { reason: string } {
  if ('reason' in result) return result
  return { edits: [result] }
}

function findElement(
  node: VueNode | undefined,
  elementType: number,
  start: number,
  end: number,
  ancestors: VueNode[] = [],
): { node: VueNode; ancestors: VueNode[] } | null {
  if (!node) return null
  if (node.type === elementType && node.loc.start.offset === start && node.loc.end.offset === end) {
    return { node, ancestors }
  }
  const next = node.type === elementType ? [...ancestors, node] : ancestors
  for (const child of node.children ?? []) {
    const found = findElement(child, elementType, start, end, next)
    if (found) return found
  }
  return null
}

function hasFor(node: VueNode, directiveType: number): boolean {
  return (node.props ?? []).some((prop) => prop.type === directiveType && prop.name === 'for')
}

function attributes(node: VueNode, attributeType: number): VueProp[] {
  return (node.props ?? []).filter((prop) => prop.type === attributeType && prop.name)
}

function bindingBlocker(node: VueNode, directiveType: number, names: string[]): string | null {
  const directives = (node.props ?? []).filter((prop) => prop.type === directiveType && prop.name === 'bind')
  if (directives.some((prop) => !prop.arg || prop.arg.isStatic === false)) return 'bare-bind'
  if (directives.some((prop) => names.includes(prop.arg?.content ?? ''))) return 'dynamic-attribute'
  return null
}

function openingTagInsertAt(source: string, node: VueNode): number | null {
  const start = node.loc.start.offset
  const limit = node.loc.end.offset
  let quote: string | null = null
  for (let index = start + 1; index < limit; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character !== '>') continue
    let insertAt = index
    if (source[index - 1] === '/') insertAt -= 1
    if (!source.slice(start, insertAt).startsWith(`<${node.tag ?? ''}`)) return null
    return insertAt
  }
  return null
}

function insertAttribute(located: Prepared, name: string, value: string): TextEdit | { reason: string } {
  if (!located.node) return { reason: 'no-insert-point' }
  if (!isSafeToken(name) || !isSafeToken(value)) return { reason: 'unsafe-value' }
  if (attributes(located.node, located.attributeType).some((prop) => prop.name === name)) return { reason: 'attribute-present' }
  const blocked = bindingBlocker(located.node, located.directiveType, [name])
  if (blocked) return { reason: blocked }
  const insertAt = openingTagInsertAt(located.source, located.node)
  if (insertAt == null || insertAt < located.start || insertAt > located.end) return { reason: 'no-insert-point' }
  return { file: located.file, start: insertAt, end: insertAt, insert: ` ${name}="${value}"` }
}

function deleteAttribute(located: Prepared, name: string): TextEdit | { reason: string } {
  if (!located.node) return deleteHtmlAttribute(located, name)
  const blocked = bindingBlocker(located.node, located.directiveType, [name])
  if (blocked) return { reason: blocked }
  const attr = attributes(located.node, located.attributeType).find((prop) => prop.name === name)
  if (!attr) return { reason: 'no-attribute' }
  let start = attr.loc.start.offset
  const end = attr.loc.end.offset
  if (located.source[start - 1] === ' ' || located.source[start - 1] === '\t') start -= 1
  if (start < located.start || end > located.end) return { reason: 'no-attribute' }
  return { file: located.file, start, end, insert: '' }
}

function deleteHtmlAttribute(located: Prepared, name: string): TextEdit | { reason: string } {
  const attr = located.html?.attrs.find((item) => item.name.toLowerCase() === name.toLowerCase())
  if (!attr) return { reason: 'no-attribute' }
  let start = attr.rawStart
  const end = attr.rawEnd
  if (located.source[start - 1] === ' ' || located.source[start - 1] === '\t') start -= 1
  return { file: located.file, start, end, insert: '' }
}

function replaceViewport(located: Prepared): TextEdit | { reason: string } {
  const attr = located.html?.attrs.find((item) => item.name.toLowerCase() === 'content')
  if (!attr || attr.value == null) return { reason: 'no-attribute' }
  const next = rewriteViewportContent(attr.value)
  if (next == null) return { reason: 'no-attribute' }
  if (next.includes('"') || next.includes('\n')) return { reason: 'unsafe-value' }
  return { file: located.file, start: attr.valueStart, end: attr.valueEnd, insert: next }
}

function quotedValueRange(source: string, start: number, end: number): { start: number; end: number } {
  const raw = source.slice(start, end)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return { start: start + 1, end: end - 1 }
  }
  return { start, end }
}

function prohibitedNames(checks: AxeCheck[]): string[] {
  for (const check of checks) {
    const data = check.data
    if (!data || typeof data !== 'object' || !('prohibited' in data)) continue
    const names = (data as { prohibited?: unknown }).prohibited
    if (!Array.isArray(names)) continue
    return names.filter((name): name is string => typeof name === 'string' && isSafeToken(name))
  }
  return []
}

function isSafeToken(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f"'`=<>\s]/.test(value)
}

function overlaps(left: TextEdit, right: TextEdit): boolean {
  return left.start < right.end && right.start < left.end
}

function htmlPrepared(file: string, source: string, tag: HtmlTag): Prepared {
  return {
    file,
    start: tag.tagStart,
    end: tag.tagEnd,
    text: source.slice(tag.tagStart, tag.tagEnd),
    repeated: false,
    source,
    attributeType: 6,
    directiveType: 7,
    html: tag,
  }
}

function findTags(source: string, name: string): HtmlTag[] {
  const found: HtmlTag[] = []
  let index = 0
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      index = end < 0 ? source.length : end + 3
      continue
    }
    if (source[index] === '<') {
      const tag = readTag(source, index)
      if (tag) {
        if (tag.name.toLowerCase() === name.toLowerCase()) found.push(tag)
        index = tag.tagEnd
        continue
      }
    }
    index += 1
  }
  return found
}

function readTag(source: string, start: number): HtmlTag | null {
  if (source[start] !== '<' || source[start + 1] === '/' || source[start + 1] === '!') return null
  let index = start + 1
  while (index < source.length && /[A-Za-z0-9:-]/.test(source[index])) index += 1
  const name = source.slice(start + 1, index)
  if (!name) return null
  const attrs: HtmlAttr[] = []
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1
    if (source[index] === '>' || (source[index] === '/' && source[index + 1] === '>')) {
      return { name, tagStart: start, tagEnd: source[index] === '/' ? index + 2 : index + 1, attrs }
    }
    const rawStart = index
    while (index < source.length && /[^\s=/>]/.test(source[index])) index += 1
    const attrName = source.slice(rawStart, index)
    if (!attrName) return null
    while (index < source.length && /\s/.test(source[index])) index += 1
    let value: string | null = null
    let valueStart = index
    let valueEnd = index
    if (source[index] === '=') {
      index += 1
      while (index < source.length && /\s/.test(source[index])) index += 1
      const quote = source[index]
      if (quote === '"' || quote === "'") {
        index += 1
        valueStart = index
        while (index < source.length && source[index] !== quote) index += 1
        valueEnd = index
        value = source.slice(valueStart, valueEnd)
        if (index < source.length) index += 1
      } else {
        valueStart = index
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1
        valueEnd = index
        value = source.slice(valueStart, valueEnd)
      }
    }
    attrs.push({ name: attrName, value, valueStart, valueEnd, rawStart, rawEnd: index })
  }
  return null
}

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ElementTypes, NodeTypes } from '@vue/compiler-core'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const root = path.dirname(fileURLToPath(import.meta.url))
const appPath = path.join(root, 'src', 'App.vue')
const childPath = path.join(root, 'src', 'ChildButton.vue')
const cacheDir = path.join(root, '.vite-cache-edit')
const SOURCE_ATTR = 'data-a11y-source-id'
const SUPPORTED_RULES = new Map([
  ['button-name', 'aria-label'],
  ['image-alt', 'alt'],
])

const checks = []

function check(name, pass, details) {
  checks.push({ name, pass, ...(details ? { details } : {}) })
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function escapeAttribute(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (/[\u0000-\u001f]/.test(value)) return null
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
}

function directives(node) {
  return (node.props ?? []).filter((prop) => prop.type === NodeTypes.DIRECTIVE)
}

function attributes(node) {
  return (node.props ?? []).filter((prop) => prop.type === NodeTypes.ATTRIBUTE)
}

function staticClasses(node) {
  const attribute = attributes(node).find((item) => item.name === 'class')
  return attribute?.value?.content.split(/\s+/).filter(Boolean) ?? []
}

function hasFor(node) {
  return directives(node).some((directive) => directive.name === 'for')
}

function nameSignals(node) {
  const signals = new Set()
  const walk = (current) => {
    if (current.type === NodeTypes.INTERPOLATION) signals.add('dynamic-text')
    if (current.type === NodeTypes.TEXT && current.content.trim()) {
      signals.add('visible-text')
    }
    if (current.type !== NodeTypes.ELEMENT) return
    if (directives(current).some((directive) => directive.name === 'html')) {
      signals.add('v-html')
    }
    const hidden = attributes(current).find((item) => item.name === 'aria-hidden')
    const hiddenBinding = directives(current).some(
      (directive) =>
        directive.name === 'bind' &&
        directive.arg?.isStatic &&
        directive.arg.content === 'aria-hidden',
    )
    if (hiddenBinding) signals.add('dynamic-hidden')
    if (hidden && (hidden.value == null || hidden.value.content === 'true')) return
    for (const child of current.children ?? []) walk(child)
  }
  for (const child of node.children ?? []) walk(child)
  return [...signals]
}

function classify(node, ancestors, attribute) {
  const blockers = []
  if (node.tagType !== ElementTypes.ELEMENT) return ['not-native']
  const tags = attribute === 'aria-label' ? ['button'] : attribute === 'alt' ? ['img'] : []
  if (!tags.includes(node.tag)) blockers.push('unsupported-tag')
  if ([node, ...ancestors].some(hasFor)) blockers.push('repeated-source')
  if (attributes(node).some((item) => item.name === attribute)) {
    blockers.push('attribute-present')
  }
  const bindings = directives(node).filter((directive) => directive.name === 'bind')
  if (bindings.some((directive) => !directive.arg || !directive.arg.isStatic)) {
    blockers.push('bare-bind')
  }
  if (
    bindings.some(
      (directive) => directive.arg?.isStatic && directive.arg.content === attribute,
    )
  ) {
    blockers.push('dynamic-attribute')
  }
  if (directives(node).some((directive) => directive.name === 'html')) {
    blockers.push('v-html')
  }
  if (attribute === 'aria-label') {
    if (
      attributes(node).some(
        (item) => item.name === 'title' || item.name === 'aria-labelledby',
      )
    ) {
      blockers.push('existing-name')
    }
    blockers.push(...nameSignals(node))
  }
  return blockers
}

function openingTagInsertAt(source, node) {
  const start = node.loc.start.offset
  const limit = node.loc.end.offset
  let quote = null
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
    const opened = source.slice(start, insertAt)
    if (!opened.startsWith(`<${node.tag}`)) return null
    return insertAt
  }
  return null
}

function indexElements(source, filename) {
  const parsed = parse(source, { filename })
  const elements = []
  const walk = (node, ancestors) => {
    if (node.type === NodeTypes.ELEMENT) elements.push({ node, ancestors })
    const next =
      node.type === NodeTypes.ELEMENT ? [...ancestors, node] : ancestors
    for (const child of node.children ?? []) walk(child, next)
  }
  if (parsed.descriptor.template?.ast) walk(parsed.descriptor.template.ast, [])
  return { parsed, elements }
}

function locate(source, filename, start, end) {
  const indexed = indexElements(source, filename)
  const found = indexed.elements.find(
    (item) =>
      item.node.loc.start.offset === start && item.node.loc.end.offset === end,
  )
  return found ? { ...found, descriptor: indexed.parsed.descriptor } : null
}

function planEdits(source, filename, requests) {
  const counts = new Map()
  for (const request of requests) {
    const key = `${request.start}:${request.end}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const edits = []
  const skipped = []
  const seen = new Set()
  for (const request of requests) {
    const key = `${request.start}:${request.end}:${request.attribute}`
    if (seen.has(key)) continue
    seen.add(key)
    const located = locate(source, filename, request.start, request.end)
    if (!located) {
      skipped.push({ ...request, blockers: ['unmapped'] })
      continue
    }
    const blockers = []
    if ((counts.get(`${request.start}:${request.end}`) ?? 0) > 1) {
      blockers.push('multiple-instances')
    }
    blockers.push(...classify(located.node, located.ancestors, request.attribute))
    const escaped = blockers.length === 0 ? escapeAttribute(request.value) : null
    if (blockers.length === 0 && !escaped) blockers.push('needs-value')
    if (blockers.length > 0) {
      skipped.push({
        attribute: request.attribute,
        className: staticClasses(located.node).join(' '),
        blockers,
      })
      continue
    }
    const insertAt = openingTagInsertAt(source, located.node)
    if (insertAt == null) {
      skipped.push({
        attribute: request.attribute,
        className: staticClasses(located.node).join(' '),
        blockers: ['no-insert-point'],
      })
      continue
    }
    edits.push({
      baselineHash: hash(source),
      nodeStart: located.node.loc.start.offset,
      nodeEnd: located.node.loc.end.offset,
      nodeText: source.slice(
        located.node.loc.start.offset,
        located.node.loc.end.offset,
      ),
      insertAt,
      insertion: ` ${request.attribute}="${escaped}"`,
      attribute: request.attribute,
      className: staticClasses(located.node).join(' '),
    })
  }
  return { edits, skipped }
}

function applyEdits(source, edits, { requireHash }) {
  if (edits.length === 0) return { ok: true, source, applied: [] }
  if (requireHash && edits.some((edit) => edit.baselineHash !== hash(source))) {
    return { ok: false, reason: 'stale-file' }
  }
  if (
    edits.some(
      (edit) => source.slice(edit.nodeStart, edit.nodeEnd) !== edit.nodeText,
    )
  ) {
    return { ok: false, reason: 'stale-node' }
  }
  for (let index = 0; index < edits.length; index += 1) {
    for (let other = index + 1; other < edits.length; other += 1) {
      const left = edits[index]
      const right = edits[other]
      const rangesOverlap =
        left.nodeStart < right.nodeEnd && right.nodeStart < left.nodeEnd
      if (rangesOverlap || left.insertAt === right.insertAt) {
        return { ok: false, reason: 'overlap' }
      }
    }
  }
  let next = source
  const ordered = [...edits].sort((left, right) => right.insertAt - left.insertAt)
  for (const edit of ordered) {
    next = next.slice(0, edit.insertAt) + edit.insertion + next.slice(edit.insertAt)
  }
  return { ok: true, source: next, applied: ordered }
}

function stripInsertions(source, edits) {
  let next = source
  const ordered = [...edits].sort((left, right) => right.insertAt - left.insertAt)
  for (const edit of ordered) {
    const index = next.lastIndexOf(edit.insertion)
    if (index < 0) return null
    next = next.slice(0, index) + next.slice(index + edit.insertion.length)
  }
  return next
}

function attributeValue(source, filename, className, attribute) {
  const { elements } = indexElements(source, filename)
  const found = elements.find((item) => staticClasses(item.node).includes(className))
  const attr = found && attributes(found.node).find((item) => item.name === attribute)
  return attr ? (attr.value?.content ?? '') : null
}

function requestFor(source, filename, className, attribute, value, instances = 1) {
  const { elements } = indexElements(source, filename)
  const found = elements.find((item) => staticClasses(item.node).includes(className))
  if (!found) throw new Error(`В фикстуре нет .${className}`)
  return Array.from({ length: instances }, () => ({
    start: found.node.loc.start.offset,
    end: found.node.loc.end.offset,
    attribute,
    value,
  }))
}

function flattenPlugins(plugins, out = []) {
  for (const plugin of plugins ?? []) {
    if (!plugin) continue
    if (Array.isArray(plugin)) flattenPlugins(plugin, out)
    else out.push(plugin)
  }
  return out
}

function sourceIdPlugin() {
  const transform = (node, context) => {
    if (node.type !== NodeTypes.ELEMENT || node.tagType !== ElementTypes.ELEMENT) return
    const marker = `${node.loc.start.offset}:${node.loc.end.offset}:${encodeURIComponent(context.filename)}`
    if (attributes(node).some((item) => item.name === SOURCE_ATTR)) return
    node.props.push({
      type: NodeTypes.ATTRIBUTE,
      name: SOURCE_ATTR,
      nameLoc: node.loc,
      value: { type: NodeTypes.TEXT, content: marker, loc: node.loc },
      loc: node.loc,
    })
  }
  return {
    name: 'a11y-source-id-spike',
    enforce: 'pre',
    config(config) {
      const vuePlugin = flattenPlugins(config.plugins).find(
        (plugin) => plugin?.name === 'vite:vue',
      )
      if (!vuePlugin?.api?.options) {
        throw new Error('vite:vue api.options недоступен')
      }
      const options = vuePlugin.api.options
      const template = (options.template ??= {})
      const compilerOptions = (template.compilerOptions ??= {})
      const existing = compilerOptions.nodeTransforms ?? []
      compilerOptions.nodeTransforms = [...existing, transform]
    },
  }
}

async function launchBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/home/user/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    '/opt/google/chrome/chrome',
    '/opt/chromium-gost/chrome',
  ].filter(Boolean)
  const errors = []
  for (const executablePath of candidates) {
    try {
      return {
        browser: await chromium.launch({
          executablePath,
          headless: true,
          args: ['--disable-dev-shm-usage'],
        }),
        executablePath,
      }
    } catch (error) {
      errors.push(`${executablePath}: ${error.message.split('\n')[0]}`)
    }
  }
  throw new Error(errors.join('\n'))
}

function decodeMarker(marker, source) {
  const match = /^(\d+):(\d+):(.*)$/.exec(marker ?? '')
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  return {
    start,
    end,
    filename: decodeURIComponent(match[3]),
    text: source.slice(start, end),
  }
}

async function auditPage(page) {
  return page.evaluate(async () => {
    const result = await window.axe.run(document, {
      resultTypes: ['violations'],
      elementRef: true,
    })
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        html: node.html,
        marker: node.element?.getAttribute('data-a11y-source-id') ?? null,
        className: node.element?.getAttribute('class') ?? '',
        tag: node.element?.tagName ?? '',
      })),
    }))
  })
}

const original = fs.readFileSync(appPath, 'utf8')
const originalChild = fs.readFileSync(childPath, 'utf8')
const filename = appPath

const iconPlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'icon', 'aria-label', 'Search'),
)
const imagePlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'missing', 'alt', 'Photo'),
)
const combined = planEdits(original, filename, [
  ...requestFor(original, filename, 'icon', 'aria-label', 'Search'),
  ...requestFor(original, filename, 'missing', 'alt', 'Photo'),
])
const repeatPlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'repeat', 'aria-label', 'Row', 3),
)
const visiblePlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'a', 'aria-label', 'Letter'),
)
const namedPlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'named', 'aria-label', 'Name'),
)
const labelledPlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'labelled', 'aria-label', 'Name'),
)
const decorativePlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'decorative', 'alt', 'Photo'),
)
const dynamicClassPlan = planEdits(
  original,
  filename,
  requestFor(original, filename, 'dynamic', 'aria-label', 'Dynamic'),
)

check('icon accepts confirmed label', iconPlan.edits.length === 1 && iconPlan.skipped.length === 0)
check('image accepts confirmed alt', imagePlan.edits.length === 1 && imagePlan.skipped.length === 0)
check('repeated instances are refused', repeatPlan.edits.length === 0 && repeatPlan.skipped[0]?.blockers.includes('multiple-instances') && repeatPlan.skipped[0]?.blockers.includes('repeated-source'))
check('visible text blocks invented name', visiblePlan.edits.length === 0 && visiblePlan.skipped[0]?.blockers.includes('visible-text'))
check('bound aria-label blocks rewrite', namedPlan.edits.length === 0 && namedPlan.skipped[0]?.blockers.includes('dynamic-attribute'))
check('existing aria-label blocks second label', labelledPlan.edits.length === 0 && labelledPlan.skipped[0]?.blockers.includes('attribute-present'))
check('empty alt is treated as already chosen', decorativePlan.edits.length === 0 && decorativePlan.skipped[0]?.blockers.includes('attribute-present'))
check('dynamic class alone does not block another attribute', dynamicClassPlan.skipped[0]?.blockers.includes('visible-text') && !dynamicClassPlan.skipped[0]?.blockers.includes('dynamic-attribute'))

const applied = applyEdits(original, combined.edits, { requireHash: true })
check('batch applies', applied.ok === true)
check(
  'batch is only the two insertions',
  applied.ok && stripInsertions(applied.source, combined.edits) === original,
)
check(
  'script text stays at the same place',
  applied.ok &&
    original.slice(0, original.indexOf('<template>')) ===
      applied.source.slice(0, applied.source.indexOf('<template>')),
)
const rereadIcon = applied.ok
  ? attributeValue(applied.source, filename, 'icon', 'aria-label')
  : null
const rereadImage = applied.ok
  ? attributeValue(applied.source, filename, 'missing', 'alt')
  : null
check('reparsed button keeps the confirmed label', rereadIcon === 'Search')
check('reparsed image keeps the confirmed alt', rereadImage === 'Photo')
const compiled = applied.ok
  ? compileTemplate({
      id: 'edit-probe',
      filename,
      source: parse(applied.source, { filename }).descriptor.template.content,
    })
  : { errors: ['not-applied'] }
check('edited template compiles', compiled.errors.length === 0, compiled.errors)

const second = applied.ok
  ? planEdits(applied.source, filename, [
      ...requestFor(applied.source, filename, 'icon', 'aria-label', 'Search'),
      ...requestFor(applied.source, filename, 'missing', 'alt', 'Photo'),
    ])
  : { edits: [null], skipped: [] }
check('second plan finds the attributes already present', second.edits.length === 0 && second.skipped.every((item) => item.blockers.includes('attribute-present')))

const stale = applyEdits(`${original}\n`, combined.edits, { requireHash: true })
check('changed file is refused', stale.ok === false && stale.reason === 'stale-file')
const shifted = `\n${original}`
const shiftedApply = applyEdits(shifted, combined.edits, { requireHash: false })
check('node moved by an earlier insertion is refused', shiftedApply.ok === false && shiftedApply.reason === 'stale-node')
const appended = `${original}\n<!-- later -->\n`
const appendedApply = applyEdits(appended, combined.edits, { requireHash: false })
check(
  'later addition can be preserved by a node check',
  appendedApply.ok === true &&
    appendedApply.source.endsWith('<!-- later -->\n') &&
    stripInsertions(appendedApply.source, combined.edits) === appended,
)
const editor = applyEdits(
  original.replace('const kind = \'dyn\'', 'const kind = \'dyn\' '),
  combined.edits,
  { requireHash: true },
)
check('editor buffer differing from the audit is refused', editor.ok === false && editor.reason === 'stale-file')

const overlap = combined.edits[0]
  ? applyEdits(
      original,
      [combined.edits[0], { ...combined.edits[0], insertion: ' data-probe="1"' }],
      { requireHash: true },
    )
  : { ok: false, reason: 'missing-edit' }
check('two writes to one node are refused unless merged', overlap.ok === false && overlap.reason === 'overlap')

const compareSource = '<template><button class="compare" v-if="count > 0"></button></template>\n'
const comparePlan = planEdits(
  compareSource,
  'Compare.vue',
  requestFor(compareSource, 'Compare.vue', 'compare', 'aria-label', 'Compare'),
)
const compareApplied = applyEdits(compareSource, comparePlan.edits, { requireHash: true })
check(
  'greater-than inside a directive stays in the directive',
  compareApplied.ok === true &&
    compareApplied.source.includes('v-if="count > 0" aria-label="Compare"'),
)

const quoteSource = '<template><button class="quote"></button></template>\n'
const quoteValue = 'Tom & "Jerry"'
const quotePlan = planEdits(
  quoteSource,
  'Quote.vue',
  requestFor(quoteSource, 'Quote.vue', 'quote', 'aria-label', quoteValue),
)
const quoteApplied = applyEdits(quoteSource, quotePlan.edits, { requireHash: true })
check(
  'quoted value round-trips through the parser',
  quoteApplied.ok === true &&
    attributeValue(quoteApplied.source, 'Quote.vue', 'quote', 'aria-label') === quoteValue,
)
check('newline in a value is refused', escapeAttribute('a\nb') == null)

const multiline = `<template>
  <button
    class="save"
    type="button"
  ></button>
  <img
    class="shot"
    src="/a.png"
  />
</template>
`
const multilinePlan = planEdits(multiline, 'Multi.vue', [
  ...requestFor(multiline, 'Multi.vue', 'save', 'aria-label', 'Save'),
  ...requestFor(multiline, 'Multi.vue', 'shot', 'alt', 'Shot'),
])
const multilineApplied = applyEdits(multiline, multilinePlan.edits, { requireHash: true })
check(
  'multiline tags keep their line breaks',
  multilineApplied.ok === true &&
    stripInsertions(multilineApplied.source, multilinePlan.edits) === multiline &&
    multilineApplied.source.includes('/>') &&
    attributeValue(multilineApplied.source, 'Multi.vue', 'save', 'aria-label') === 'Save' &&
    attributeValue(multilineApplied.source, 'Multi.vue', 'shot', 'alt') === 'Shot',
)

const hiddenSource = `<template><button class="glyph"><span aria-hidden="true">*</span></button></template>\n`
const hiddenPlan = planEdits(
  hiddenSource,
  'Hidden.vue',
  requestFor(hiddenSource, 'Hidden.vue', 'glyph', 'aria-label', 'Поиск'),
)
const hiddenApplied = applyEdits(hiddenSource, hiddenPlan.edits, { requireHash: true })
check(
  'text inside aria-hidden does not count as a visible name',
  hiddenPlan.edits.length === 1 &&
    hiddenApplied.ok === true &&
    attributeValue(hiddenApplied.source, 'Hidden.vue', 'glyph', 'aria-label') === 'Поиск',
)

const htmlSource = '<template><button class="html" v-html="fragment"></button></template>\n'
const htmlPlan = planEdits(
  htmlSource,
  'Html.vue',
  requestFor(htmlSource, 'Html.vue', 'html', 'aria-label', 'Html'),
)
check('v-html blocks the edit', htmlPlan.edits.length === 0 && htmlPlan.skipped[0]?.blockers.includes('v-html'))

let server
let browser
let dirty = false
const runtime = {}

try {
  if (checks.some((item) => !item.pass)) {
    throw new Error('Проверки текста не прошли, файл проекта не изменялся.')
  }
  fs.rmSync(cacheDir, { recursive: true, force: true })
  server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    cacheDir,
    clearScreen: false,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      open: false,
      allowedHosts: ['127.0.0.1', 'localhost'],
    },
    plugins: [sourceIdPlugin()],
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error('Сервер не ограничился loopback.')
  }
  const url = `http://127.0.0.1:${address.port}/`
  const launched = await launchBrowser()
  browser = launched.browser
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  const axePath = require.resolve('axe-core')
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('button.icon', { state: 'attached', timeout: 10000 })
  await page.addScriptTag({ path: axePath })
  const before = await auditPage(page)
  const flagged = before.flatMap((violation) =>
    SUPPORTED_RULES.has(violation.id)
      ? violation.nodes.map((node) => ({
          rule: violation.id,
          attribute: SUPPORTED_RULES.get(violation.id),
          ...node,
        }))
      : [],
  )
  const requests = []
  for (const item of flagged) {
    const decoded = decodeMarker(item.marker, original)
    if (!decoded) continue
    const value = item.className.split(/\s+/).includes('icon')
      ? 'Search'
      : item.className.split(/\s+/).includes('missing')
        ? 'Photo'
        : null
    requests.push({
      start: decoded.start,
      end: decoded.end,
      attribute: item.attribute,
      value,
    })
  }
  const planned = planEdits(original, filename, requests)
  const written = applyEdits(original, planned.edits, { requireHash: true })
  runtime.before = before.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => ({
        className: node.className,
        marker: node.marker,
        html: node.html,
    })),
  }))
  runtime.skipped = planned.skipped
  runtime.requestCount = requests.length
  if (!written.ok) throw new Error(`Правка для браузера отклонена: ${written.reason}`)
  if (!written.source.includes('aria-label="Search"') || !written.source.includes('alt="Photo"')) {
    throw new Error(`План не собрал ожидаемые правки: ${JSON.stringify(planned.skipped)}`)
  }
  fs.writeFileSync(appPath, written.source)
  dirty = true
  const deadline = Date.now() + 8000
  let recompiled = false
  while (Date.now() < deadline) {
    const moduleText = await fetch(new URL('/src/App.vue', url)).then((response) => response.text())
    if (moduleText.includes('aria-label') && moduleText.includes('Photo')) {
      recompiled = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!recompiled) throw new Error('Vite не перекомпилировал изменённый компонент.')
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 })
  await page.waitForSelector('button.icon[aria-label="Search"]', {
    state: 'attached',
    timeout: 10000,
  })
  await page.addScriptTag({ path: axePath })
  const after = await auditPage(page)
  const dom = await page.evaluate(() => ({
    icon: document.querySelector('button.icon')?.getAttribute('aria-label'),
    missing: document.querySelector('img.missing')?.getAttribute('alt'),
    plain: document.querySelector('button.a')?.getAttribute('aria-label'),
    decorative: document.querySelector('img.decorative')?.getAttribute('alt'),
    named: document.querySelector('button.named')?.getAttribute('aria-label'),
    labelled: document.querySelector('button.labelled')?.getAttribute('aria-label'),
    repeat: [...document.querySelectorAll('button.repeat')].map((element) =>
      element.getAttribute('aria-label'),
    ),
    markers: {
      icon: document.querySelector('button.icon')?.getAttribute('data-a11y-source-id'),
      missing: document.querySelector('img.missing')?.getAttribute('data-a11y-source-id'),
      plain: document.querySelector('button.a')?.getAttribute('data-a11y-source-id'),
      repeat: document.querySelector('button.repeat')?.getAttribute('data-a11y-source-id'),
    },
  }))
  const editedDisk = fs.readFileSync(appPath, 'utf8')
  const iconText = decodeMarker(dom.markers.icon, editedDisk)?.text
  const missingText = decodeMarker(dom.markers.missing, editedDisk)?.text
  const plainText = decodeMarker(dom.markers.plain, editedDisk)?.text
  const repeatText = decodeMarker(dom.markers.repeat, editedDisk)?.text
  const rules = (report) => new Set(report.map((violation) => violation.id))
  runtime.url = url
  runtime.browser = launched.executablePath
  runtime.pageErrors = pageErrors
  runtime.before = before.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.className || node.tag),
  }))
  runtime.after = after.map((violation) => ({
    id: violation.id,
    nodes: violation.nodes.map((node) => node.className || node.tag),
  }))
  runtime.skipped = planned.skipped
  runtime.previews = planned.edits.map((edit) => ({
    className: edit.className,
    before: edit.nodeText,
    after: edit.nodeText.slice(0, edit.insertAt - edit.nodeStart) + edit.insertion + edit.nodeText.slice(edit.insertAt - edit.nodeStart),
  }))
  check('axe found the empty button before the edit', flagged.some((item) => item.rule === 'button-name' && item.className === 'icon'))
  check('axe found the image without alt before the edit', flagged.some((item) => item.rule === 'image-alt' && item.className === 'missing'))
  check('axe did not ask to rename the visible button', !flagged.some((item) => item.className === 'a'))
  check('dom received only the confirmed label', dom.icon === 'Search' && dom.missing === 'Photo' && dom.plain == null)
  check('neighbouring names stayed untouched', dom.decorative === '' && dom.named === 'dyn' && dom.labelled === 'Close' && dom.repeat.every((value) => value == null))
  check('new source markers cover the edited tags', iconText?.includes('aria-label="Search"') && missingText?.includes('alt="Photo"') && plainText === '<button class="a">A</button>')
  check('repeated button was not rewritten', repeatText?.includes('class="repeat"') && !repeatText?.includes('aria-label'))
  check('targeted violations are gone', !after.some((violation) => violation.id === 'image-alt') && !after.some((violation) => violation.nodes.some((node) => node.className === 'icon')))
  check('repeated violation remains', after.some((violation) => violation.id === 'button-name' && violation.nodes.some((node) => node.className === 'repeat')))
  check('edit introduced no new rule', [...rules(after)].every((rule) => rules(before).has(rule)))
  check('browser reported no page errors', pageErrors.length === 0, pageErrors)
} catch (error) {
  runtime.error = String(error?.stack || error)
  check('runtime', false, runtime.error)
} finally {
  if (dirty) fs.writeFileSync(appPath, original)
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
}

check('project file restored', fs.readFileSync(appPath, 'utf8') === original)
check('child component stayed untouched', fs.readFileSync(childPath, 'utf8') === originalChild)

const report = {
  passed: checks.every((item) => item.pass),
  checks,
  runtime,
}
fs.writeFileSync(path.join(root, 'edit-results.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
if (!report.passed) process.exitCode = 1

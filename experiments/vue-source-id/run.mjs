import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const ELEMENT = 1
const TEXT = 2
const ATTRIBUTE = 6
const NATIVE = 0
const SOURCE_ATTR = 'data-a11y-source-id'

const root = path.dirname(fileURLToPath(import.meta.url))
const cacheDir = path.join(root, '.vite-cache')
const sourceFiles = [
  'index.html',
  'vite.config.js',
  'src/main.ts',
  'src/App.vue',
  'src/ChildButton.vue',
].map((file) => path.join(root, file))

const calls = []
const notes = []

function hashFiles() {
  return Object.fromEntries(
    sourceFiles.map((file) => [
      path.relative(root, file),
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]),
  )
}

function flattenPlugins(plugins, out = []) {
  for (const plugin of plugins ?? []) {
    if (!plugin) continue
    if (Array.isArray(plugin)) flattenPlugins(plugin, out)
    else out.push(plugin)
  }
  return out
}

function addAttribute(node, name, content) {
  const exists = node.props?.some(
    (prop) => prop.type === ATTRIBUTE && prop.name === name,
  )
  if (exists) return
  node.props.push({
    type: ATTRIBUTE,
    name,
    nameLoc: node.loc,
    value: {
      type: TEXT,
      content,
      loc: node.loc,
    },
    loc: node.loc,
  })
}

function sourceIdTransform(node, context) {
  if (node.type !== ELEMENT || node.tagType !== NATIVE) return
  const start = node.loc?.start?.offset
  const end = node.loc?.end?.offset
  calls.push({
    filename: context.filename,
    tag: node.tag,
    start,
    end,
  })
  addAttribute(
    node,
    SOURCE_ATTR,
    `${start}:${end}:${encodeURIComponent(context.filename)}`,
  )
}

function instrumentPlugin() {
  let vuePluginVersion = null
  return {
    plugin: {
      name: 'a11y-source-id-spike',
      enforce: 'pre',
      config(config) {
        const vuePlugin = flattenPlugins(config.plugins).find(
          (plugin) => plugin?.name === 'vite:vue',
        )
        if (!vuePlugin?.api?.options) {
          throw new Error(
            'Совместимый vite:vue с api.options не найден. Инструментирование не включено.',
          )
        }
        vuePluginVersion = vuePlugin.api.version ?? null
        const options = vuePlugin.api.options
        const template = (options.template ??= {})
        const compilerOptions = (template.compilerOptions ??= {})
        const existing = compilerOptions.nodeTransforms ?? []
        if (!existing.includes(sourceIdTransform)) {
          compilerOptions.nodeTransforms = [...existing, sourceIdTransform]
        }
        notes.push(`vite:vue ${vuePluginVersion ?? 'unknown'}`)
        notes.push(`user transforms before append: ${existing.length}`)
      },
    },
    version: () => vuePluginVersion,
  }
}

function inspectMarker(value) {
  const match = /^(\d+):(\d+):([^:]*)$/.exec(value ?? '')
  if (!match) return { ok: false, reason: 'marker format', value }
  const start = Number(match[1])
  const end = Number(match[2])
  const filename = decodeURIComponent(match[3])
  if (!Number.isInteger(start) || !Number.isInteger(end) || !filename) {
    return { ok: false, reason: 'marker values', value }
  }
  let source
  try {
    source = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    return { ok: false, reason: 'file read', filename, message: error.message }
  }
  const text = source.slice(start, end)
  return {
    ok: text.startsWith('<'),
    filename: path.relative(root, filename),
    start,
    end,
    text,
  }
}

function groupByMarker(elements) {
  const groups = new Map()
  for (const element of elements) {
    const list = groups.get(element.marker) ?? []
    list.push(element.className)
    groups.set(element.marker, list)
  }
  return [...groups.entries()].map(([marker, classNames]) => ({
    marker,
    classNames,
    count: classNames.length,
  }))
}

const browserCandidates = [
  process.env.CHROME_PATH,
  '/home/user/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
  '/usr/bin/chromium-gost',
].filter(Boolean)

async function launchBrowser() {
  const errors = []
  for (const executablePath of browserCandidates) {
    try {
      const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--disable-dev-shm-usage'],
      })
      return { browser, executablePath }
    } catch (error) {
      errors.push(`${executablePath}: ${error.message.split('\n')[0]}`)
    }
  }
  throw new Error(`Браузер не запустился.\n${errors.join('\n')}`)
}

const before = hashFiles()
const instrument = instrumentPlugin()
let server
let browser
let page

try {
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
    plugins: [instrument.plugin],
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') {
    throw new Error('Dev-сервер не сообщил локальный порт.')
  }
  if (address.address !== '127.0.0.1') {
    throw new Error(`Сервер слушает не loopback: ${address.address}`)
  }
  const url = `http://127.0.0.1:${address.port}/`

  const indexResponse = await fetch(url)
  const indexHtml = await indexResponse.text()
  const appModuleResponse = await fetch(new URL('/src/App.vue', url))
  const appModule = await appModuleResponse.text()
  const childModuleResponse = await fetch(new URL('/src/ChildButton.vue', url))
  const childModule = await childModuleResponse.text()

  const launched = await launchBrowser()
  browser = launched.browser
  page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForSelector('button.child', { timeout: 10000 })

  const dom = await page.evaluate((attribute) => {
    const read = (element) => ({
      tag: element.tagName,
      className: element.className,
      marker: element.getAttribute(attribute),
      userTransform: element.getAttribute('data-user-transform'),
      text: element.textContent?.trim() ?? '',
    })
    return {
      main: read(document.querySelector('main')),
      buttons: [...document.querySelectorAll('button')].map(read),
    }
  }, SOURCE_ATTR)

  const inspectedButtons = dom.buttons.map((button) => ({
    ...button,
    source: inspectMarker(button.marker),
  }))
  const loopButtons = inspectedButtons.filter((button) =>
    button.className.split(/\s+/).includes('loop'),
  )
  const childButton = inspectedButtons.find((button) =>
    button.className.split(/\s+/).includes('child'),
  )
  const buttonA = inspectedButtons.find((button) => button.className === 'a')
  const buttonB = inspectedButtons.find((button) => button.className === 'b')
  const conditional = inspectedButtons.find(
    (button) => button.className === 'conditional',
  )
  const dynamic = inspectedButtons.find((button) =>
    button.className.split(/\s+/).includes('dynamic'),
  )

  const checks = {
    serverStartedOnLoopback: true,
    transformCalled: calls.length > 0,
    userTransformPreserved: dom.main?.userTransform === 'yes',
    mainHasSourceId: inspectMarker(dom.main?.marker).ok === true,
    everyButtonMapsToSource: inspectedButtons.every((button) => button.source.ok),
    distinctStaticButtons: buttonA?.marker && buttonA.marker !== buttonB?.marker,
    repeatedLoopSharesOneNode:
      loopButtons.length === 3 &&
      new Set(loopButtons.map((button) => button.marker)).size === 1,
    conditionalRenderedWithSource: conditional?.source.ok === true,
    dynamicAttributeKeepsSource: dynamic?.source.ok === true,
    childPointsAtChildFile:
      childButton?.source.ok === true &&
      childButton.source.filename === 'src/ChildButton.vue',
    shellHtmlHasNoMarker: !indexHtml.includes(SOURCE_ATTR),
    appModuleContainsMarker: appModule.includes(SOURCE_ATTR),
    childModuleContainsMarker: childModule.includes(SOURCE_ATTR),
    noPageErrors: pageErrors.length === 0,
  }

  await browser.close()
  browser = undefined
  await server.close()
  server = undefined

  const after = hashFiles()
  checks.sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after)
  checks.defaultViteCacheAbsent = !fs.existsSync(path.join(root, 'node_modules', '.vite'))
  checks.cacheRedirected = fs.existsSync(cacheDir)

  const report = {
    passed: Object.values(checks).every(Boolean),
    url,
    browser: launched.executablePath,
    vuePluginVersion: instrument.version(),
    notes,
    calls,
    checks,
    dom,
    sources: inspectedButtons.map((button) => ({
      className: button.className,
      file: button.source.filename,
      range: [button.source.start, button.source.end],
      text: button.source.text,
    })),
    loopGroups: groupByMarker(loopButtons),
    moduleStatus: {
      index: indexResponse.status,
      app: appModuleResponse.status,
      child: childModuleResponse.status,
    },
    pageErrors,
    host: os.hostname(),
  }

  fs.writeFileSync(
    path.join(root, 'results.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await page?.close().catch(() => {})
  await browser?.close().catch(() => {})
  await server?.close().catch(() => {})
}

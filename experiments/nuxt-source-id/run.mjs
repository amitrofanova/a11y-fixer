import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const fixtureDir = path.join(here, 'fixture')
const instrumentPath = path.join(repoRoot, 'out', 'core', 'instrument.js')
const versions = [
  ['nuxt3', '3.21.11'],
  ['nuxt4', '4.6.4'],
]

const { chromium } = require('playwright-core')

async function main() {
  if (!fs.existsSync(instrumentPath)) {
    throw new Error('Сначала соберите расширение: npm run compile')
  }
  const chrome = chromeExecutable()
  if (!chrome) throw new Error('NO_CHROME')
  await Promise.all(versions.map(([name, version]) => install(path.join(here, 'work', name), version)))
  const results = []
  for (const [name, version] of versions) {
    results.push(await runVersion(name, version, chrome))
  }
  const output = {
    instrument: path.relative(repoRoot, instrumentPath),
    results,
  }
  fs.writeFileSync(path.join(here, 'results.json'), `${JSON.stringify(output, null, 2)}\n`)
  for (const result of results) {
    console.log(`${result.version}: ${result.ok ? 'passed' : 'failed'}`)
    if (!result.ok) console.log(result.errors.join('\n'))
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1
}

async function runVersion(name, version, chrome) {
  const project = path.join(here, 'work', name)
  const notesPath = path.join(project, 'a11y-notes.json')
  const result = {
    version,
    ok: false,
    errors: [],
    notes: null,
    installed: {},
    ssr: {},
    dom: {},
    closed: false,
  }
  let child
  let logs = []
  let port = 0
  try {
    copyFixture(project)
    fs.rmSync(path.join(project, '.nuxt'), { recursive: true, force: true })
    fs.rmSync(notesPath, { force: true })
    result.installed = installedVersions(project)
    port = await freePort()
    const started = startNuxt(project, version, port, notesPath)
    child = started.child
    logs = started.logs
    const served = await waitForUrl(child, logs, port)
    port = served.port
    const html = await waitForHtml(served.url, child, logs)
    const button = firstTag(html.body, 'button')
    const widget = firstTag(html.body, 'my-widget')
    result.ssr = {
      status: html.status,
      hasSourceId: html.body.includes('data-a11y-source-id'),
      hasUserAttr: html.body.includes('data-poc-user'),
      button,
      widget,
    }
    if (fs.existsSync(notesPath)) result.notes = JSON.parse(fs.readFileSync(notesPath, 'utf8'))
    else result.errors.push('instrument module did not run')
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ['--disable-dev-shm-usage'],
    })
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      const pageLogs = []
      page.on('console', (message) => pageLogs.push(message.text()))
      page.on('pageerror', (error) => pageLogs.push(String(error)))
      await page.goto(served.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForSelector('#poc button', { timeout: 20000 })
      const elements = await page.locator('[data-a11y-source-id]').evaluateAll((nodes) => nodes.map((node) => ({
        tag: node.tagName,
        marker: node.getAttribute('data-a11y-source-id'),
        user: node.getAttribute('data-poc-user'),
      })))
      const widgetCount = await page.locator('my-widget').count()
      result.dom = {
        widgetCount,
        elements: elements.map((element) => ({ ...element, source: inspectMarker(project, element.marker) })),
        logs: pageLogs,
      }
      assertResult(result)
    } finally {
      await browser.close()
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.stack || error.message : String(error))
    result.serverLog = logs.join('').slice(-5000)
  } finally {
    await stopChild(child)
    if (port) {
      result.closed = await waitUntilClosed(port)
      if (!result.closed) result.errors.push('server still listens after close')
    }
  }
  result.ok = result.errors.length === 0 && result.closed
  return result
}

function startNuxt(project, version, port, notesPath) {
  const bin = path.join(project, 'node_modules', 'nuxt', 'bin', 'nuxt.mjs')
  const args = [bin, 'dev', '--host', '127.0.0.1', '--port', String(port), '--no-fork']
  if (version.startsWith('4.')) args.push('--no-tui')
  const logs = []
  const child = spawn(process.execPath, args, {
    cwd: project,
    detached: true,
    env: {
      ...process.env,
      A11Y_PORT: String(port),
      A11Y_INSTRUMENT: instrumentPath,
      A11Y_NOTES: notesPath,
      NUXT_TELEMETRY_DISABLED: '1',
      BROWSER: 'none',
    },
  })
  const push = (chunk) => {
    logs.push(String(chunk))
    const text = logs.join('')
    if (text.length > 30000) logs.splice(0, logs.length, text.slice(-20000))
  }
  child.stdout?.on('data', push)
  child.stderr?.on('data', push)
  return { child, logs }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    child.kill('SIGINT')
  }
  if (await waitExit(child, 8000)) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  await waitExit(child, 3000)
}

function waitExit(child, ms) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function waitForUrl(child, logs, fallbackPort) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Nuxt exited ${child.exitCode}\n${logs.join('').slice(-4000)}`)
    }
    const match = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(logs.join(''))
    if (match) return { url: `http://127.0.0.1:${match[1]}/`, port: Number(match[1]) }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return { url: `http://127.0.0.1:${fallbackPort}/`, port: fallbackPort }
}

function assertResult(result) {
  const errors = result.errors
  if (result.notes?.mappingEnabled === false) errors.push('vite:vue api.options was not available')
  if (!result.ssr.hasSourceId) errors.push('SSR HTML has no data-a11y-source-id')
  if (!result.ssr.hasUserAttr) errors.push('SSR HTML has no data-poc-user')
  if (!result.ssr.button?.includes('data-a11y-source-id') || !result.ssr.button?.includes('data-poc-user')) {
    errors.push('SSR button lost one of the transforms')
  }
  if (!result.ssr.widget) errors.push('SSR HTML has no my-widget')
  const button = result.dom.elements.find((element) => element.tag === 'BUTTON')
  if (!button?.source?.ok || !button.source.file.endsWith(`${path.sep}components${path.sep}Panel.vue`)) {
    errors.push('button marker does not point at components/Panel.vue')
  } else if (!button.source.text.startsWith('<button')) {
    errors.push('button slice does not start with <button')
  }
  if (button?.user !== '1') errors.push('user nodeTransform was replaced')
  if (result.dom.widgetCount < 1) errors.push('my-widget is missing after hydration')
  const logs = result.dom.logs.join('\n')
  if (/hydration/i.test(logs)) errors.push('hydration warning')
  if (logs.includes('Failed to resolve component: my-widget')) errors.push('isCustomElement was overwritten')
  const domMarker = button?.marker
  if (domMarker && result.ssr.button && !result.ssr.button.includes(domMarker)) {
    errors.push('SSR and client source ids differ')
  }
}

async function install(project, version) {
  fs.mkdirSync(project, { recursive: true })
  copyFixture(project)
  const installed = path.join(project, 'node_modules', 'nuxt', 'package.json')
  const current = fs.existsSync(installed) ? JSON.parse(fs.readFileSync(installed, 'utf8')).version : ''
  fs.writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({
    name: 'a11y-nuxt-poc',
    private: true,
    type: 'module',
    dependencies: { nuxt: version },
  }, null, 2)}\n`)
  if (current === version) return
  await runCommand('npm', ['install', '--no-fund', '--no-audit'], project)
}

function copyFixture(project) {
  for (const relative of ['app.vue', 'nuxt.config.mjs', 'a11y-module.mjs', 'components/Panel.vue']) {
    const target = path.join(project, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(fixtureDir, relative), target)
  }
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: process.env })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

function installedVersions(project) {
  return {
    nuxt: packageVersion(project, 'nuxt'),
    vue: packageVersion(project, 'vue'),
    pluginVue: packageVersion(project, '@vitejs/plugin-vue'),
  }
}

function packageVersion(project, name) {
  try {
    const require = createRequire(path.join(project, 'node_modules', 'nuxt', 'package.json'))
    const file = require.resolve(`${name}/package.json`)
    return JSON.parse(fs.readFileSync(file, 'utf8')).version
  } catch {
    return null
  }
}

function inspectMarker(project, value) {
  const match = /^(\d+):(\d+):(.*)$/.exec(value ?? '')
  if (!match) return { ok: false, file: '', text: '' }
  const start = Number(match[1])
  const end = Number(match[2])
  const filename = path.normalize(decodeURIComponent(match[3]))
  if (!filename.startsWith(project + path.sep)) return { ok: false, file: filename, text: '' }
  const source = fs.readFileSync(filename, 'utf8')
  const text = source.slice(start, end)
  return {
    ok: text.startsWith('<'),
    file: filename,
    text,
  }
}

function firstTag(html, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html)
  return match ? match[0] : ''
}

async function waitForHtml(url, child, logs) {
  let last = ''
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Nuxt exited ${child.exitCode}\n${logs.join('').slice(-4000)}`)
    }
    try {
      const response = await fetch(url)
      const body = await response.text()
      if (response.ok && body.includes('<button')) return { status: response.status, body }
      last = `status ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Nuxt did not serve the page: ${last}\n${logs.join('').slice(-4000)}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitUntilClosed(port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await portOpen(port))) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const finish = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
}

function chromeExecutable() {
  const found = [
    process.env.CHROME_PATH,
    '/opt/google/chrome/chrome',
    '/opt/chromium-gost/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium-gost',
  ].find((item) => item && fs.existsSync(item))
  if (found) return found
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright')
  if (!fs.existsSync(cache)) return ''
  for (const entry of fs.readdirSync(cache)) {
    const chrome = path.join(cache, entry, 'chrome-linux64', 'chrome')
    if (fs.existsSync(chrome)) return chrome
  }
  return ''
}

await main()

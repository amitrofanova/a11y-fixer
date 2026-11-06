import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = process.argv[2]
const port = Number(process.argv[3])
const modulePath = process.env.A11Y_MODULE
const notesPath = process.env.A11Y_NOTES

const nuxtPackage = path.join(projectRoot, 'node_modules', 'nuxt', 'package.json')
if (!fs.existsSync(nuxtPackage) || !modulePath) {
  console.log('A11Y_FAIL NO_NUXT')
  process.exit(1)
}

const nuxtRequire = createRequire(nuxtPackage)
const nuxt = await import(pathToFileURL(path.join(projectRoot, 'node_modules', 'nuxt', 'dist', 'index.mjs')).href)
const kit = await import(pathToFileURL(nuxtRequire.resolve('@nuxt/kit')).href)
const cliRequire = createRequire(nuxtRequire.resolve('@nuxt/cli'))
const { listen } = await import(pathToFileURL(cliRequire.resolve('listhen')).href)

process.env.NODE_ENV = 'development'
const loaded = await nuxt.loadNuxt({
  cwd: projectRoot,
  dev: true,
  ready: false,
  overrides: {
    dev: true,
    devtools: { enabled: false },
  },
})
if (!Array.isArray(loaded.options.modules)) loaded.options.modules = []
loaded.options.modules.push(modulePath)

const state = {
  handler(request, response) {
    response.statusCode = 503
    response.end('starting')
  },
}
const listener = await listen((request, response) => state.handler(request, response), {
  port,
  hostname: '127.0.0.1',
  showURL: false,
  clipboard: false,
  open: false,
  qr: false,
  public: false,
})

let closed = false
async function shutdown() {
  if (closed) return
  closed = true
  await loaded.close().catch(() => undefined)
  await listener.close().catch(() => undefined)
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0))
})

try {
  await loaded.ready()
  const address = listener.address
  if (!address || address.address !== '127.0.0.1') {
    console.log('A11Y_FAIL NO_PORT')
    await shutdown()
    process.exit(1)
  }
  const actualPort = address.port
  loaded.options.devServer ||= {}
  loaded.options.devServer.host = '127.0.0.1'
  loaded.options.devServer.port = actualPort
  loaded.options.devServer.https = false
  loaded.options.devServer.url = baseUrl(actualPort, loaded.options.app?.baseURL)
  await loaded.hooks.callHook('listen', listener.server, listener)
  await kit.buildNuxt(loaded)
  state.handler = await nodeHandler(loaded.server, nuxtRequire)
  const notes = readNotes(notesPath)
  console.log(`A11Y_MAPPING ${notes.mappingEnabled === false ? '0' : '1'}`)
  console.log(`A11Y_READY ${loaded.options.devServer.url}`)
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error)
  await shutdown()
  process.exit(1)
}

function baseUrl(actualPort, base) {
  const suffix = typeof base === 'string' && base !== '/' ? base.replace(/^\//, '') : ''
  return new URL(suffix, `http://127.0.0.1:${actualPort}/`).href
}

function readNotes(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { mappingEnabled: false }
  }
}

async function nodeHandler(server, require) {
  if (server && typeof server.handler === 'function') return server.handler
  if (server && typeof server.fetch === 'function') {
    const { toNodeHandler } = await import(pathToFileURL(require.resolve('srvx/node')).href)
    return toNodeHandler(server.fetch)
  }
  if (server && server.app) {
    const { toNodeListener } = await import(pathToFileURL(require.resolve('h3')).href)
    return toNodeListener(server.app)
  }
  throw new Error('Nitro server has not been initialized.')
}

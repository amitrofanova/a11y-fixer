import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { instrumentPlugin } from './instrument'

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']

interface RunningServer {
  listen(): Promise<void>
  close(): Promise<void>
  httpServer: { address(): { address?: string; port: number } | string | null } | null
  moduleGraph?: { invalidateAll?: () => void }
}

export interface AppHandle {
  kind: 'vite' | 'nuxt'
  url: string
  mappingEnabled: boolean
  readySelector: string
  documentShell: boolean
  navigationTimeout: number
  invalidate(): void
  close(): Promise<void>
}

export function findViteConfig(projectRoot: string): string | null {
  for (const name of CONFIG_NAMES) {
    const file = path.join(projectRoot, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

export async function startViteApp(projectRoot: string, configFile: string): Promise<AppHandle> {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  const vitePath = require.resolve('vite')
  const vite = await importEsm<{
    createServer: (config: Record<string, unknown>) => Promise<RunningServer>
  }>(pathToFileURL(vitePath).href)
  let mappingEnabled = true
  const server = await vite.createServer({
    root: projectRoot,
    configFile,
    cacheDir: path.join(os.tmpdir(), 'a11y-fixer', hash(projectRoot)),
    clearScreen: false,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      open: false,
      allowedHosts: ['127.0.0.1', 'localhost'],
    },
    plugins: [instrumentPlugin(() => {
      mappingEnabled = false
    })],
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    await server.close()
    throw new Error('NO_PORT')
  }
  return {
    kind: 'vite',
    url: `http://127.0.0.1:${address.port}/`,
    mappingEnabled,
    readySelector: '#app',
    documentShell: true,
    navigationTimeout: 20000,
    invalidate() {
      server.moduleGraph?.invalidateAll?.()
    },
    close() {
      return server.close()
    },
  }
}

function importEsm<T>(specifier: string): Promise<T> {
  const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<T>
  return load(specifier)
}

function hash(value: string): string {
  let result = 0
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result.toString(16)
}

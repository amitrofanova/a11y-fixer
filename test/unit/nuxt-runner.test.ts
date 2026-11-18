import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { repoRootFrom } from '../support/repo'

const runner = path.join(repoRootFrom(__dirname), 'media', 'nuxt-runner.mjs')

test('a Nuxt install without @nuxt/cli listens through listhen from nitropack', async () => {
  const project = scaffold({ cli: false })
  try {
    const result = await run(project.root)
    assert.match(result.stdout, /A11Y_LISTHEN nitro/, result.stderr)
    assert.match(result.stdout, /A11Y_READY http:\/\/127\.0\.0\.1:40123\//, result.stderr)
    assert.equal(result.code, 0, result.stderr)
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true })
  }
})

test('listhen is taken from @nuxt/cli when that package is installed', async () => {
  const project = scaffold({ cli: true })
  try {
    const result = await run(project.root)
    assert.match(result.stdout, /A11Y_LISTHEN cli/, result.stderr)
    assert.match(result.stdout, /A11Y_READY http:\/\/127\.0\.0\.1:40123\//, result.stderr)
    assert.equal(result.code, 0, result.stderr)
  } finally {
    fs.rmSync(project.root, { recursive: true, force: true })
  }
})

function scaffold(options: { cli: boolean }): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-nuxt-runner-'))
  writeFile(path.join(root, 'node_modules', 'nuxt', 'package.json'), JSON.stringify({ name: 'nuxt' }))
  writeFile(path.join(root, 'node_modules', 'nuxt', 'dist', 'index.mjs'), `
    export async function loadNuxt() {
      return {
        options: { app: { baseURL: '/' } },
        hooks: { async callHook() {} },
        server: {},
        async ready() {},
        async close() {},
      }
    }
  `)
  writePackage(path.join(root, 'node_modules', '@nuxt', 'kit'), '@nuxt/kit', `
    export async function buildNuxt(nuxt) {
      nuxt.server.handler = (_request, response) => response.end('ok')
    }
  `)
  writePackage(path.join(root, 'node_modules', 'nuxi'), 'nuxi', 'export {}\n')
  writePackage(path.join(root, 'node_modules', 'nitropack'), 'nitropack', 'export {}\n')
  writeFile(path.join(root, 'node_modules', 'nitropack', 'package.json'), JSON.stringify({
    name: 'nitropack',
    type: 'module',
    exports: { './package.json': './package.json' },
  }))
  writePackage(
    path.join(root, 'node_modules', 'nitropack', 'node_modules', 'listhen'),
    'listhen',
    listenSource('nitro'),
  )
  if (options.cli) {
    writePackage(path.join(root, 'node_modules', '@nuxt', 'cli'), '@nuxt/cli', 'export {}\n')
    writePackage(
      path.join(root, 'node_modules', '@nuxt', 'cli', 'node_modules', 'listhen'),
      'listhen',
      listenSource('cli'),
    )
  }
  return { root }
}

function listenSource(marker: string): string {
  return `
    const timer = setInterval(() => {}, 1000)
    export async function listen() {
      console.log('A11Y_LISTHEN ${marker}')
      return {
        address: { address: '127.0.0.1', port: 40123 },
        server: {},
        async close() { clearInterval(timer) },
      }
    }
  `
}

function writePackage(dir: string, name: string, source: string) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name,
    type: 'module',
    exports: { '.': './index.mjs' },
  }))
  writeFile(path.join(dir, 'index.mjs'), source)
}

function writeFile(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

function run(projectRoot: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, projectRoot, '9'], {
      env: { ...process.env, A11Y_MODULE: runner },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`runner timed out\n${stdout}\n${stderr}`))
    }, 10000)
    const finish = (error?: Error, value?: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (value) resolve(value)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('A11Y_READY')) child.kill('SIGINT')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => finish(undefined, { stdout, stderr, code }))
  })
}

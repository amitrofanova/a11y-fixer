import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { AppHandle } from './viteHost'

export async function startNuxtApp(projectRoot: string): Promise<AppHandle> {
  const runner = path.join(__dirname, '..', '..', 'media', 'nuxt-runner.mjs')
  const moduleSource = path.join(__dirname, '..', '..', 'media', 'a11y-nuxt-module.mjs')
  const moduleDir = path.join(projectRoot, 'node_modules', '.a11y-fixer')
  const moduleFile = path.join(moduleDir, 'module.mjs')
  const notesFile = path.join(os.tmpdir(), 'a11y-fixer', `${hash(projectRoot)}-nuxt.json`)
  fs.mkdirSync(moduleDir, { recursive: true })
  fs.mkdirSync(path.dirname(notesFile), { recursive: true })
  fs.copyFileSync(moduleSource, moduleFile)
  fs.rmSync(notesFile, { force: true })
  const port = await freePort()
  const logs: string[] = []
  const child = spawn(process.execPath, [runner, projectRoot, String(port)], {
    cwd: projectRoot,
    detached: true,
    env: {
      ...process.env,
      A11Y_INSTRUMENT: path.join(__dirname, 'instrument.js'),
      A11Y_MODULE: moduleFile,
      A11Y_NOTES: notesFile,
      NUXT_TELEMETRY_DISABLED: '1',
      BROWSER: 'none',
    },
  })
  const stop = async () => {
    if (child.exitCode !== null) return
    try {
      process.kill(-child.pid!, 'SIGINT')
    } catch {
      child.kill('SIGINT')
    }
    if (await waitExit(child, 8000)) return
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    await waitExit(child, 3000)
  }
  try {
    const ready = await waitForReady(child, logs)
    let mappingEnabled = ready.mapping
    try {
      const notes = JSON.parse(fs.readFileSync(notesFile, 'utf8')) as { mappingEnabled?: boolean }
      if (notes.mappingEnabled === false) mappingEnabled = false
    } catch {
      mappingEnabled = ready.mapping
    }
    return {
      kind: 'nuxt',
      url: ready.url,
      mappingEnabled,
      readySelector: '#__nuxt',
      documentShell: false,
      navigationTimeout: 60000,
      invalidate() {
        return undefined
      },
      async close() {
        await stop()
        fs.rmSync(moduleDir, { recursive: true, force: true })
        fs.rmSync(notesFile, { force: true })
      },
    }
  } catch (error) {
    await stop()
    fs.rmSync(moduleDir, { recursive: true, force: true })
    fs.rmSync(notesFile, { force: true })
    if (error instanceof Error && (error.message === 'NO_NUXT' || error.message === 'NO_PORT')) throw error
    const detail = logs.join('').replace(/\u001b\[[0-9;]*m/g, '').trim()
    throw new Error(detail.slice(-2000) || (error instanceof Error ? error.message : 'NUXT_EXIT'))
  }
}

function waitForReady(child: ChildProcess, logs: string[]): Promise<{ url: string; mapping: boolean }> {
  return new Promise((resolve, reject) => {
    let url = ''
    let mapping: boolean | null = null
    let done = false
    const finish = (error: Error | null, value?: { url: string; mapping: boolean }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (value) resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('NUXT_TIMEOUT')), 180000)
    const consider = () => {
      const text = logs.join('').replace(/\u001b\[[0-9;]*m/g, '')
      const failed = /A11Y_FAIL\s+(\S+)/.exec(text)
      if (failed) {
        finish(new Error(failed[1]))
        return
      }
      const mapped = /A11Y_MAPPING\s+([01])/.exec(text)
      const ready = /A11Y_READY\s+(\S+)/.exec(text)
      if (mapped) mapping = mapped[1] === '1'
      if (ready) url = ready[1]
      if (url && mapping !== null) finish(null, { url, mapping })
    }
    const push = (chunk: Buffer | string) => {
      logs.push(String(chunk))
      let size = 0
      for (const item of logs) size += item.length
      while (size > 200000 && logs.length > 1) size -= logs.shift()?.length ?? 0
      consider()
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (!done) finish(new Error(logs.join('').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-2000) || `NUXT_EXIT ${code ?? ''}`))
    })
  })
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode !== null), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function freePort(): Promise<number> {
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

function hash(value: string): string {
  let result = 0
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result.toString(16)
}

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import type { Session } from '../../src/core/audit'
import type { AuditOutcome } from '../../src/core/types'
import { copyProject } from '../support/copyProject'
import { loadProduct } from '../support/product'
import { repoRootFrom } from '../support/repo'

const audit = loadProduct<{
  auditProject(session: Session, locale: 'ru' | 'en'): Promise<AuditOutcome>
  closeSession(session: Session): Promise<void>
}>('core/audit.js')

const ownedFiles = ['package.json', 'nuxt.config.mjs', 'app.vue', 'components/Panel.vue']

test('the Nuxt 3 product runner audits a child component and leaves its sources unchanged', async () => {
  const fixture = path.join(repoRootFrom(__dirname), 'fixtures', 'nuxt-app')
  await ensureNuxt(fixture)
  fs.rmSync(path.join(fixture, 'node_modules', '.a11y-fixer'), { recursive: true, force: true })
  const project = copyProject(fixture, 'a11y-nuxt-')
  const before = readOwned(project.root)
  const session: Session = { projectRoot: project.root, mappingEnabled: true }
  let port = 0
  try {
    const outcome = await audit.auditProject(session, 'ru')
    port = Number(new URL(outcome.url).port)
    assert.ok(port > 0)
    assert.equal(outcome.mappingEnabled, true)

    const panel = path.join(project.root, 'components', 'Panel.vue')
    const tabindex = outcome.issues.find((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')
    assert.ok(tabindex?.file, 'tabindex quick fix was not found')
    assert.equal(path.resolve(tabindex.file), path.resolve(panel))
    assert.equal(tabindex.sourceText?.startsWith('<button'), true)
    assert.equal(tabindex.sourceText?.includes('tabindex="3"'), true)

    const empty = outcome.issues.find((issue) => (
      issue.ruleId === 'button-name'
      && issue.tab === 'manual'
      && (issue.sourceText ?? '').includes('class="empty"')
    ))
    assert.ok(empty, 'empty button was not left for a manual fix')
    assert.deepEqual(empty.edits, [])

    const repeated = outcome.issues.find((issue) => issue.tab === 'ambiguous' && (issue.sourceText ?? '').includes('v-for'))
    assert.ok(repeated, 'v-for button was not classified as ambiguous')
    assert.deepEqual(repeated.edits, [])

    for (const issue of outcome.issues) {
      for (const edit of issue.edits) {
        assert.equal(/alt=|aria-label/.test(edit.insert), false, `${issue.ruleId} invented accessible text`)
      }
    }
  } finally {
    try {
      await audit.closeSession(session)
      if (port > 0) assert.equal(await waitUntilClosed(port), true, 'Nuxt server still listens after close')
      assert.equal(fs.existsSync(path.join(project.root, 'node_modules', '.a11y-fixer')), false)
      assert.deepEqual(readOwned(project.root), before)
    } finally {
      project.cleanup()
    }
  }
})

async function ensureNuxt(fixture: string): Promise<void> {
  const installedPath = path.join(fixture, 'node_modules', 'nuxt', 'package.json')
  if (!fs.existsSync(installedPath)) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-audit', '--no-fund'], { cwd: fixture, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install exited with ${code ?? 'unknown'}`))
      })
    })
  }
  const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8')) as { version?: string }
  assert.equal(installed.version, '3.21.11')
}

function readOwned(root: string): Record<string, string> {
  return Object.fromEntries(ownedFiles.map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]))
}

function waitUntilClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let attempts = 0
    const check = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const finish = (open: boolean) => {
        socket.removeAllListeners()
        socket.destroy()
        if (!open) {
          resolve(true)
          return
        }
        attempts += 1
        if (attempts >= 20) resolve(false)
        else setTimeout(check, 100)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    }
    check()
  })
}

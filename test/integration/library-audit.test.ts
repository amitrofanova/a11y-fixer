import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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

test('a Vuetify icon button maps to the component tag and a named button does not', async () => {
  await auditLibrary('vuetify', '3.13.7', 'vuetify', '<VBtn icon="mdi-menu"')
})

test('a Quasar icon button maps to the component tag and a named button does not', async () => {
  await auditLibrary('quasar', '2.35.5', 'quasar', '<q-btn icon="menu"')
})

test('a Nuxt UI icon button maps to the component tag and a named button does not', async () => {
  await auditLibrary('nuxt-ui', '4.12.2', '@nuxt/ui', '<UButton icon="i-lucide-search"')
})

async function auditLibrary(directory: string, version: string, packageName: string, source: string): Promise<void> {
  const fixture = path.join(repoRootFrom(__dirname), 'fixtures', 'libraries', directory)
  await ensureInstalled(fixture, packageName, version)
  const before = hashes(fixture)
  const project = copyProject(fixture, `a11y-${directory}-`)
  const app = path.join(project.root, 'src', 'App.vue')
  const session: Session = { projectRoot: project.root, mappingEnabled: true }
  let port = 0
  try {
    const outcome = await audit.auditProject(session, 'ru')
    port = Number(new URL(outcome.url).port)
    assert.equal(outcome.mappingEnabled, true)
    const icon = outcome.issues.find((issue) => (
      issue.ruleId === 'button-name'
      && issue.tab === 'manual'
      && (issue.sourceText ?? '').includes(source)
    ))
    assert.ok(icon?.file, `${directory} icon button was not mapped to a manual button-name`)
    assert.equal(path.resolve(icon.file), path.resolve(app))
    assert.equal(icon.sourceText?.startsWith('<'), true)
    assert.equal(fs.readFileSync(icon.file, 'utf8').slice(icon.start, icon.end), icon.sourceText)
    assert.deepEqual(icon.edits, [])
    assert.equal(outcome.issues.some((issue) => (
      issue.ruleId === 'button-name'
      && (issue.sourceText ?? '').includes('Сохранить')
    )), false)
    for (const issue of outcome.issues) {
      for (const edit of issue.edits) {
        assert.equal(/alt=|aria-label/.test(edit.insert), false)
      }
    }
  } finally {
    try {
      await audit.closeSession(session)
      if (port > 0) assert.equal(await waitUntilClosed(port), true, `${directory} server still listens after close`)
    } finally {
      project.cleanup()
      assert.deepEqual(hashes(fixture), before)
    }
  }
}

async function ensureInstalled(fixture: string, packageName: string, version: string): Promise<void> {
  const installedPath = path.join(fixture, 'node_modules', ...packageName.split('/'), 'package.json')
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
  assert.equal(installed.version, version)
}

function hashes(root: string): Record<string, string> {
  const found: Record<string, string> = {}
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) {
        found[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      }
    }
  }
  visit(root)
  return found
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

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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

test('no browser candidate fails before the dev server starts', async () => {
  const demo = path.join(repoRootFrom(__dirname), 'demo')
  const project = copyProject(demo, 'a11y-no-chrome-')
  const session: Session = { projectRoot: project.root, mappingEnabled: true, chromePaths: [] }
  try {
    await assert.rejects(
      () => audit.auditProject(session, 'en'),
      (error: unknown) => error instanceof Error && error.message === 'NO_CHROME',
    )
    assert.equal(session.app, undefined)
    assert.equal(session.url, undefined)
    assert.equal(session.browser, undefined)
  } finally {
    await audit.closeSession(session)
    project.cleanup()
  }
})

test('a failed browser launch closes the app that was already prepared', async () => {
  let closed = false
  const session = {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-bad-browser-')),
    mappingEnabled: true,
    chromePaths: ['/bin/ls'],
    url: 'http://127.0.0.1:9/',
    app: {
      kind: 'vite' as const,
      url: 'http://127.0.0.1:9/',
      mappingEnabled: true,
      readySelector: '#app',
      documentShell: true,
      navigationTimeout: 1000,
      invalidate() { return undefined },
      async close() { closed = true },
    },
  } as Session
  try {
    await assert.rejects(
      () => audit.auditProject(session, 'en'),
      (error: unknown) => error instanceof Error && error.message === 'NO_CHROME',
    )
    assert.equal(closed, true)
    assert.equal(session.app, undefined)
    assert.equal(session.browser, undefined)
    assert.equal(session.page, undefined)
  } finally {
    await audit.closeSession(session)
    fs.rmSync(session.projectRoot, { recursive: true, force: true })
  }
})

test('a Nuxt config without the nuxt package fails and removes the temporary module', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-no-nuxt-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
  fs.writeFileSync(path.join(root, 'nuxt.config.mjs'), 'export default { devtools: { enabled: false } }\n')
  const session: Session = { projectRoot: root, mappingEnabled: true }
  try {
    await assert.rejects(
      () => audit.auditProject(session, 'en'),
      (error: unknown) => error instanceof Error && error.message === 'NO_NUXT',
    )
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.a11y-fixer')), false)
    assert.equal(session.app, undefined)
  } finally {
    await audit.closeSession(session)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

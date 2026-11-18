import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditProject, closeSession, collectFindings, findChrome, type Session } from '../../src/core/audit'

test('findChrome keeps an existing executable and the Playwright cache layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-chrome-'))
  const cache = path.join(root, 'cache')
  const cached = path.join(cache, 'chromium-test', 'chrome-linux64', 'chrome')
  const decoy = path.join(cache, 'chromium-test', 'chrome')
  const direct = path.join(root, 'browser')
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  fs.writeFileSync(cached, '')
  fs.writeFileSync(decoy, '')
  fs.writeFileSync(direct, '')
  try {
    const found = findChrome({
      paths: [path.join(root, 'missing'), direct],
      cacheDir: cache,
    })
    assert.ok(found.includes(direct))
    assert.ok(found.includes(cached))
    assert.equal(found.includes(decoy), false)
    assert.equal(found.includes(path.join(root, 'missing')), false)
    assert.deepEqual(findChrome({ paths: [], cacheDir: root }), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a project without Vite or Nuxt config fails before a browser starts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-no-config-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
  const session: Session = { projectRoot: root, mappingEnabled: true, chromePaths: ['/bin/ls'] }
  try {
    await assert.rejects(
      () => auditProject(session, 'en'),
      (error: unknown) => error instanceof Error && error.message === 'NO_VITE_CONFIG',
    )
    assert.equal(session.app, undefined)
    assert.equal(session.browser, undefined)
    assert.equal(session.page, undefined)
  } finally {
    await closeSession(session)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('axe results are not reported as an empty audit when axe is absent', async () => {
  await assert.rejects(
    () => collectFindings({ locale: null, attribute: 'data-a11y-source-id' }),
    (error: unknown) => error instanceof Error && error.message === 'AXE_MISSING',
  )
})

test('closeSession releases the page, browser, and app when one close fails', async () => {
  const order: string[] = []
  const session = {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-close-')),
    mappingEnabled: true,
    url: 'http://127.0.0.1:9/',
    page: { async close() { throw new Error('page') } },
    browser: { async close() { order.push('browser') } },
    app: {
      kind: 'vite' as const,
      url: 'http://127.0.0.1:9/',
      mappingEnabled: true,
      readySelector: '#app',
      documentShell: true,
      navigationTimeout: 1000,
      invalidate() { return undefined },
      async close() { order.push('app') },
    },
  } as unknown as Session
  try {
    await closeSession(session)
    assert.deepEqual(order, ['browser', 'app'])
    assert.equal(session.page, undefined)
    assert.equal(session.browser, undefined)
    assert.equal(session.app, undefined)
    assert.equal(session.url, undefined)
  } finally {
    fs.rmSync(session.projectRoot, { recursive: true, force: true })
  }
})

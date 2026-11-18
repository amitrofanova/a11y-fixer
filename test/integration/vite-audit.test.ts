import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import type { ApplyPlan } from '../../src/core/apply'
import type { Session } from '../../src/core/audit'
import type { AuditOutcome, Issue } from '../../src/core/types'
import { copyProject } from '../support/copyProject'
import { loadProduct } from '../support/product'
import { repoRootFrom } from '../support/repo'

const audit = loadProduct<{
  auditProject(session: Session, locale: 'ru' | 'en'): Promise<AuditOutcome>
  closeSession(session: Session): Promise<void>
}>('core/audit.js')

const apply = loadProduct<{
  planApply(request: {
    workspaceRoot: string
    projectRoot: string
    auditScope?: string | null
    snapshots: Record<string, string>
    current: Record<string, string>
    edits: Issue['edits']
  }): ApplyPlan
  plannedWrites(plan: ApplyPlan): Array<{ file: string; next: string }>
  presentIssues(issues: Issue[], scope: { workspaceRoot: string; projectRoot: string; target: string | null }): {
    visible: Issue[]
    outOfScope: Issue[]
    unmapped: Issue[]
  }
  workspaceReplacements(plan: ApplyPlan): unknown[]
}>('core/apply.js')

test('the Vite demo audit keeps the current quick, manual, and ambiguous results', async () => {
  const repo = repoRootFrom(__dirname)
  const demo = path.join(repo, 'demo')
  const before = demoHashes(demo)
  const project = copyProject(demo, 'a11y-vite-')
  const originals = {
    app: fs.readFileSync(path.join(project.root, 'src', 'App.vue'), 'utf8'),
    html: fs.readFileSync(path.join(project.root, 'index.html'), 'utf8'),
  }
  assert.match(originals.app, /tabindex="3"/)
  assert.match(originals.app, /class="empty"/)
  assert.match(originals.app, /class="photo"/)
  assert.match(originals.app, /v-for="row in rows"/)
  assert.match(originals.html, /user-scalable=no/)
  const session: Session = { projectRoot: project.root, mappingEnabled: true }
  const restore = () => {
    fs.writeFileSync(path.join(project.root, 'src', 'App.vue'), originals.app)
    fs.writeFileSync(path.join(project.root, 'index.html'), originals.html)
  }
  let port = 0
  try {
    await folderScenario(session)
    port = Number(new URL(session.url ?? '').port)
    restore()
    await batchScenario(session)
    restore()
    await sequentialScenario(session)
    restore()
    await formatterScenario(session)
  } finally {
    try {
      await audit.closeSession(session)
      if (port > 0) assert.equal(await waitUntilClosed(port), true, 'Vite server still listens after close')
    } finally {
      project.cleanup()
      assert.deepEqual(demoHashes(demo), before)
    }
  }
})

test('a native button in a child SFC maps to that child file', async () => {
  const repo = repoRootFrom(__dirname)
  const demo = path.join(repo, 'demo')
  const before = demoHashes(demo)
  const project = copyProject(demo, 'a11y-vite-child-')
  const app = path.join(project.root, 'src', 'App.vue')
  const child = path.join(project.root, 'src', 'ChildButton.vue')
  fs.writeFileSync(app, `<script setup lang="ts">
import ChildButton from './ChildButton.vue'
</script>

<template>
  <ChildButton />
</template>
`)
  fs.writeFileSync(child, `<template>
  <button tabindex="3">Дальше</button>
</template>
`)
  const session: Session = { projectRoot: project.root, mappingEnabled: true }
  try {
    const outcome = await audit.auditProject(session, 'ru')
    const issue = outcome.issues.find((item) => item.ruleId === 'tabindex' && item.tab === 'quick')
    assert.ok(issue?.file, 'child button did not produce a tabindex quick fix')
    assert.equal(path.resolve(issue.file), path.resolve(child))
    assert.equal(issue.sourceText?.startsWith('<button'), true)
    assert.equal(issue.sourceText?.includes('tabindex="3"'), true)
    assert.equal(issue.sourceText?.includes('Дальше'), true)
    assert.equal(fs.readFileSync(issue.file, 'utf8').slice(issue.start, issue.end), issue.sourceText)
    assert.equal(outcome.issues.some((item) => item.ruleId === 'tabindex' && item.file && path.resolve(item.file) === path.resolve(app)), false)
  } finally {
    try {
      await audit.closeSession(session)
    } finally {
      project.cleanup()
      assert.deepEqual(demoHashes(demo), before)
    }
  }
})

async function folderScenario(session: Session): Promise<void> {
  const projectRoot = session.projectRoot
  const src = path.join(projectRoot, 'src')
  const outcome = await audit.auditProject(session, 'ru')
  assert.match(outcome.url, /^http:\/\/127\.0\.0\.1:\d+\//)
  assert.ok(outcome.issues.some((issue) => issue.helpUrl.includes('dequeuniversity.com/rules/axe/4.14/')))
  assertMapped(outcome.issues)
  const presented = apply.presentIssues(outcome.issues, { workspaceRoot: projectRoot, projectRoot, target: src })
  assert.equal(
    presented.visible.some((issue) => issue.file && path.resolve(issue.file) === path.resolve(projectRoot, 'index.html')),
    false,
    'index.html leaked into the src folder scope',
  )
  assert.equal(
    presented.visible.some((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick'),
    true,
    'folder scope dropped the in-folder tabindex fix',
  )
  assert.ok(presented.outOfScope.length > 0, 'folder scope hid out-of-scope issues instead of counting them')
  assert.ok(presented.unmapped.length > 0, 'folder scope dropped unmapped issues instead of listing them aside')
  assert.equal(presented.visible.some((issue) => !issue.file), false, 'unmapped issues leaked into folder tabs')
  const htmlIssue = outcome.issues.find((issue) => issue.tab === 'quick' && issue.file && path.resolve(issue.file) === path.resolve(projectRoot, 'index.html'))
  assert.ok(htmlIssue?.file, 'no quick fix in index.html')
  const htmlBefore = fs.readFileSync(htmlIssue.file, 'utf8')
  const denied = apply.planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    auditScope: src,
    snapshots: outcome.files,
    current: { [htmlIssue.file]: htmlBefore },
    edits: htmlIssue.edits,
  })
  assertDenied(denied, 'OUTSIDE_SCOPE')
  assert.equal(fs.readFileSync(htmlIssue.file, 'utf8'), htmlBefore)
  const tab = presented.visible.find((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')
  assert.ok(tab?.file, 'no tabindex issue inside src')
  const allowed = apply.planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    auditScope: src,
    snapshots: outcome.files,
    current: { [tab.file]: fs.readFileSync(tab.file, 'utf8') },
    edits: tab.edits,
  })
  assert.equal(allowed.ok, true, allowed.ok ? '' : `in-folder quick fix denied: ${allowed.reason}`)
  assert.ok(apply.workspaceReplacements(allowed).length > 0, 'in-folder quick fix produced no replacements')
  const appFile = path.join(projectRoot, 'src', 'App.vue')
  const filePresented = apply.presentIssues(outcome.issues, { workspaceRoot: projectRoot, projectRoot, target: appFile })
  assert.equal(
    filePresented.visible.some((issue) => issue.file && path.resolve(issue.file) !== path.resolve(appFile)),
    false,
    'file scope leaked issues from other files',
  )
  assert.equal(
    filePresented.visible.some((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick'),
    true,
    'file scope dropped the tabindex fix',
  )
}

async function batchScenario(session: Session): Promise<void> {
  const projectRoot = session.projectRoot
  const first = await audit.auditProject(session, 'ru')
  expectInitial(first.issues)
  applyQuick(projectRoot, first.files, first.issues)
  const app = fs.readFileSync(path.join(projectRoot, 'src/App.vue'), 'utf8')
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')
  assert.equal(app.includes('<button tabindex="0">Дальше</button>'), true, 'tabindex was not rewritten')
  assert.equal(app.includes('tabindex="3"'), false, 'tabindex was not rewritten')
  const scroller = app.match(/<div class="scroller"[^>]*>/)
  assert.equal(scroller?.[0].includes('tabindex="0"'), true, 'scroller was not made focusable')
  assert.equal(app.includes('aria-label'), false, 'prohibited aria-label remained')
  if (first.issues.some((issue) => issue.ruleId === 'no-autoplay-audio' && issue.tab === 'quick')) {
    assert.equal(app.includes('autoplay'), false, 'autoplay remained')
  }
  assert.equal(html.includes('user-scalable') || html.includes('maximum-scale'), false, 'viewport restriction remained')
  assert.equal(app.includes('<button class="empty"></button>'), true, 'manual button was rewritten in the batch')
  assert.equal(app.includes('v-for="row in rows"'), true, 'v-for button was rewritten in the batch')
  const second = await audit.auditProject(session, 'ru')
  assertNoQuick(second.issues)
  expect(second.issues, 'button-name', 'manual', 'class="empty"')
  expect(second.issues, 'button-name', 'ambiguous', 'v-for')
}

async function sequentialScenario(session: Session): Promise<void> {
  let outcome = await audit.auditProject(session, 'ru')
  expectInitial(outcome.issues)
  let guard = 0
  while (outcome.issues.some((issue) => issue.tab === 'quick')) {
    guard += 1
    assert.ok(guard <= 12, 'sequential fixes did not finish')
    assertFreshRanges(outcome.issues)
    const next = outcome.issues.find((issue) => issue.tab === 'quick')
    if (!next) break
    writeIssue(session.projectRoot, outcome, next)
    outcome = await audit.auditProject(session, 'ru')
  }
  assertFreshRanges(outcome.issues)
  assertNoQuick(outcome.issues)
  expect(outcome.issues, 'button-name', 'manual', 'class="empty"')
  expect(outcome.issues, 'image-alt', 'manual', 'class="photo"')
  expect(outcome.issues, 'button-name', 'ambiguous', 'v-for')
  const app = fs.readFileSync(path.join(session.projectRoot, 'src/App.vue'), 'utf8')
  assert.equal(app.includes('<button class="empty"></button>'), true, 'manual button changed during sequential fixes')
  assert.equal(app.includes('v-for="row in rows"'), true, 'v-for changed during sequential fixes')
  assert.equal(app.includes('alt='), false, 'an alt was invented during sequential fixes')
}

async function formatterScenario(session: Session): Promise<void> {
  const outcome = await audit.auditProject(session, 'ru')
  const tabindex = outcome.issues.find((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')
  const scroller = outcome.issues.find((issue) => issue.ruleId === 'scrollable-region-focusable' && issue.tab === 'quick')
  assert.ok(tabindex && scroller?.sourceText && scroller.start !== undefined && scroller.end !== undefined, 'formatter scenario is missing the tabindex or scroller issue')
  if (!tabindex || !scroller?.sourceText || scroller.start === undefined || scroller.end === undefined) return
  writeIssue(session.projectRoot, outcome, tabindex)
  const appPath = path.join(session.projectRoot, 'src/App.vue')
  const current = fs.readFileSync(appPath, 'utf8')
  const compact = '    <button tabindex="0">Дальше</button>\n'
  const formattedButton = '    <button\n      tabindex="0"\n    >\n      Дальше\n    </button>\n'
  assert.equal(current.includes(compact), true, 'could not find the fixed button to reformat')
  const formatted = current.replace(compact, formattedButton)
  fs.writeFileSync(appPath, formatted)
  const remembered = formatted.slice(scroller.start, scroller.end)
  assert.equal(/^<div\b/.test(remembered), false, 'expected the remembered range to capture the previous tag after formatting')
  const fresh = await audit.auditProject(session, 'ru')
  assertFreshRanges(fresh.issues)
  const freshScroller = fresh.issues.find((issue) => issue.ruleId === 'scrollable-region-focusable' && issue.tab === 'quick')
  assert.equal(freshScroller?.sourceText?.startsWith('<div'), true, 're-audit did not recover the scroller tag')
  if (!freshScroller) return
  writeIssue(session.projectRoot, fresh, freshScroller)
  const written = fs.readFileSync(appPath, 'utf8')
  const tag = written.match(/<div class="scroller"[^>]*>/)
  assert.equal(tag?.[0].includes('tabindex="0"'), true, 'scroller fix did not apply after formatting')
  assert.equal(written.includes('<button class="empty"></button>'), true, 'manual button changed after the formatted fix')
  assert.equal(written.includes('v-for="row in rows"'), true, 'v-for changed after the formatted fix')
}

function writeIssue(projectRoot: string, outcome: AuditOutcome, issue: Issue): void {
  commit(planIssue(projectRoot, outcome, issue), issue.ruleId)
}

function applyQuick(projectRoot: string, files: Record<string, string>, issues: Issue[]): void {
  const edits = issues.filter((issue) => issue.tab === 'quick').flatMap((issue) => issue.edits)
  const current: Record<string, string> = {}
  for (const edit of edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = files[edit.file] ?? files[file] ?? fs.readFileSync(file, 'utf8')
  }
  commit(apply.planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    snapshots: files,
    current,
    edits,
  }), 'batch')
}

function planIssue(projectRoot: string, outcome: AuditOutcome, issue: Issue) {
  const current: Record<string, string> = {}
  for (const edit of issue.edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = fs.readFileSync(file, 'utf8')
  }
  return apply.planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    snapshots: outcome.files,
    current,
    edits: issue.edits,
  })
}

function commit(plan: ApplyPlan, label: string): void {
  assert.equal(plan.ok, true, plan.ok ? '' : `${label}: ${plan.reason}`)
  if (!plan.ok) return
  assert.ok(apply.workspaceReplacements(plan).length > 0, `${label}: no workspace replacements`)
  for (const item of apply.plannedWrites(plan)) fs.writeFileSync(item.file, item.next)
}

function assertDenied(plan: ApplyPlan, reason: 'OUTSIDE_SCOPE'): void {
  assert.equal(plan.ok, false)
  if (plan.ok) return
  assert.equal(plan.reason, reason)
  assert.equal(apply.workspaceReplacements(plan).length, 0)
}

function assertFreshRanges(issues: Issue[]): void {
  for (const issue of issues) {
    if (!issue.sourceText) continue
    assert.equal(/^<[A-Za-z]/.test(issue.sourceText), true, `${issue.ruleId} range does not start at a tag: ${JSON.stringify(issue.sourceText.slice(0, 48))}`)
  }
}

function assertNoQuick(issues: Issue[]): void {
  for (const rule of ['tabindex', 'scrollable-region-focusable', 'aria-prohibited-attr', 'meta-viewport', 'no-autoplay-audio']) {
    assert.equal(issues.some((issue) => issue.ruleId === rule && issue.tab === 'quick'), false, `${rule} is still a quick fix after applying edits`)
  }
}

function expectInitial(issues: Issue[]): void {
  expect(issues, 'tabindex', 'quick', 'tabindex="3"')
  expect(issues, 'scrollable-region-focusable', 'quick', 'scroller')
  expect(issues, 'aria-prohibited-attr', 'quick', 'aria-label')
  expect(issues, 'meta-viewport', 'quick', 'user-scalable')
  expect(issues, 'button-name', 'manual', 'class="empty"')
  expect(issues, 'image-alt', 'manual', 'class="photo"')
  expect(issues, 'button-name', 'ambiguous', 'v-for')
}

function expect(issues: Issue[], ruleId: string, tab: Issue['tab'], sourceIncludes: string): void {
  const found = issues.find((issue) => issue.ruleId === ruleId && issue.tab === tab && (issue.sourceText ?? '').includes(sourceIncludes))
  assert.ok(found, `missing ${tab} ${ruleId} containing ${sourceIncludes}`)
}

function demoHashes(demo: string): Record<string, string> {
  return {
    app: hashFile(path.join(demo, 'src', 'App.vue')),
    html: hashFile(path.join(demo, 'index.html')),
  }
}

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertMapped(issues: Issue[]): void {
  for (const issue of issues) {
    if (!issue.file || issue.start === undefined || issue.end === undefined || !issue.sourceText) {
      assert.equal(issue.edits.length, 0, issue.ruleId)
      continue
    }
    const text = fs.readFileSync(issue.file, 'utf8')
    assert.equal(text.slice(issue.start, issue.end), issue.sourceText, issue.ruleId)
    assert.equal(issue.sourceText.startsWith('<'), true, issue.ruleId)
  }
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

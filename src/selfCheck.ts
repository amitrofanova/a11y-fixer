import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditProject, closeSession, type Session } from './core/audit'
import { candidatePaths, planPageRoute, scanProjectLinks } from './core/nuxtRoute'
import { planApply, plannedWrites, presentIssues, workspaceReplacements } from './core/apply'
import { resolveRange } from './core/source'
import type { AuditOutcome, Issue } from './core/types'

const appFixture = `<script setup lang="ts">
const rows = [1, 2, 3]
</script>

<template>
  <main>
    <button tabindex="3">Дальше</button>
    <button class="empty"></button>
    <img class="photo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" />
    <div class="scroller">
      <p>Текст для прокрутки. Текст для прокрутки. Текст для прокрутки. Текст для прокрутки.</p>
      <p>Вторая строка длиннее области и остаётся за её нижней границей, поэтому регион нужно прокручивать.</p>
      <p>Третья строка тоже нужна, чтобы высота содержимого была больше высоты области.</p>
      <p>Четвёртая строка закрепляет прокрутку даже на широком окне.</p>
    </div>
    <div role="presentation" aria-label="Скрытая подпись"></div>
    <button v-for="row in rows" :key="row" class="row"></button>
    <p id="dup">Первый</p>
    <p id="dup">Второй</p>
    <audio autoplay loop src="/silence.wav"></audio>
  </main>
</template>

<style>
.scroller {
  width: 220px;
  height: 48px;
  overflow: auto;
}
</style>
`

const htmlFixture = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <title>Демо A11y Fixer</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`

async function main(): Promise<void> {
  assertThreeCharacterShift()
  routeScenario()
  const projectRoot = path.resolve(__dirname, '..', 'demo')
  const appPath = path.join(projectRoot, 'src', 'App.vue')
  const htmlPath = path.join(projectRoot, 'index.html')
  const restore = () => {
    fs.writeFileSync(appPath, appFixture)
    fs.writeFileSync(htmlPath, htmlFixture)
  }
  restore()
  policyScenario(projectRoot)
  const session: Session = { projectRoot, mappingEnabled: true }
  try {
    await folderScenario(session)
    restore()
    await batchScenario(session)
    restore()
    await sequentialScenario(session)
    restore()
    await formatterScenario(session)
    console.log('self-check passed')
  } finally {
    restore()
    await closeSession(session)
  }
}

function policyScenario(projectRoot: string): void {
  const a = path.join(projectRoot, '.a11y-policy-a.txt')
  const b = path.join(projectRoot, '.a11y-policy-b.txt')
  const snapshotA = '<div></div>\n'
  const snapshotB = '<span></span>\n'
  fs.writeFileSync(a, snapshotA)
  fs.writeFileSync(b, snapshotB)
  const workspaceRoot = projectRoot
  const snapshots = { [a]: snapshotA, [b]: snapshotB }
  try {
    const okSingle = planApply({
      workspaceRoot,
      projectRoot,
      snapshots,
      current: { [a]: snapshotA, [b]: snapshotB },
      edits: [{ file: a, start: 4, end: 4, insert: ' class="ok"' }],
    })
    if (!okSingle.ok) fail(`single denied: ${okSingle.reason}`)
    if (plannedWrites(okSingle)[0]?.next !== '<div class="ok"></div>\n') fail('single next text is wrong')
    if (workspaceReplacements(okSingle).length === 0) fail('ok plan produced no workspace replacements')
    unchanged(a, snapshotA, 'single')
    unchanged(b, snapshotB, 'single')

    const okBatch = planApply({
      workspaceRoot,
      projectRoot,
      snapshots,
      current: { [a]: snapshotA, [b]: snapshotB },
      edits: [
        { file: a, start: 4, end: 4, insert: ' class="ok"' },
        { file: a, start: 4, end: 4, insert: ' class="ok"' },
        { file: b, start: 1, end: 5, insert: 'p' },
      ],
    })
    if (!okBatch.ok) fail(`batch denied: ${okBatch.reason}`)
    if (plannedWrites(okBatch).length !== 2) fail('batch should touch two files')
    unchanged(a, snapshotA, 'batch')
    unchanged(b, snapshotB, 'batch')

    const stale = planApply({
      workspaceRoot,
      projectRoot,
      snapshots,
      current: { [a]: `${snapshotA} `, [b]: snapshotB },
      edits: [{ file: a, start: 4, end: 4, insert: 'x' }],
    })
    assertDenied(stale, 'STALE', a, snapshotA)

    const overlap = planApply({
      workspaceRoot,
      projectRoot,
      snapshots,
      current: { [a]: snapshotA, [b]: snapshotB },
      edits: [
        { file: a, start: 0, end: 5, insert: 'aaaaa' },
        { file: a, start: 3, end: 8, insert: 'bbbb' },
      ],
    })
    assertDenied(overlap, 'OVERLAP', a, snapshotA)

    const adjacent = planApply({
      workspaceRoot,
      projectRoot,
      snapshots,
      current: { [a]: snapshotA, [b]: snapshotB },
      edits: [
        { file: a, start: 0, end: 2, insert: 'ab' },
        { file: a, start: 2, end: 4, insert: 'cd' },
      ],
    })
    if (!adjacent.ok) fail(`adjacent denied: ${adjacent.reason}`)

    const outside = path.join(os.tmpdir(), 'a11y-fixer-outside.vue')
    const foreign = planApply({
      workspaceRoot,
      projectRoot,
      snapshots: { [outside]: '<div></div>' },
      current: { [outside]: '<div></div>' },
      edits: [{ file: outside, start: 0, end: 5, insert: 'span' }],
    })
    assertDenied(foreign, 'OUTSIDE_WORKSPACE')

    const excluded = path.join(projectRoot, 'node_modules', 'fake.vue')
    const blocked = planApply({
      workspaceRoot,
      projectRoot,
      snapshots: { [excluded]: '<div></div>' },
      current: { [excluded]: '<div></div>' },
      edits: [{ file: excluded, start: 0, end: 5, insert: 'span' }],
    })
    assertDenied(blocked, 'OUTSIDE_SCOPE')

    const scoped = planApply({
      workspaceRoot,
      projectRoot,
      auditScope: path.join(projectRoot, 'src'),
      snapshots,
      current: { [a]: snapshotA, [b]: snapshotB },
      edits: [{ file: a, start: 4, end: 4, insert: 'x' }],
    })
    assertDenied(scoped, 'OUTSIDE_SCOPE', a, snapshotA)
  } finally {
    fs.rmSync(a, { force: true })
    fs.rmSync(b, { force: true })
  }
}

async function folderScenario(session: Session): Promise<void> {
  const projectRoot = session.projectRoot
  const src = path.join(projectRoot, 'src')
  const outcome = await auditProject(session, 'ru')
  const presented = presentIssues(outcome.issues, { workspaceRoot: projectRoot, projectRoot, target: src })
  if (presented.visible.some((issue) => issue.file && path.resolve(issue.file) === path.resolve(projectRoot, 'index.html'))) {
    fail('index.html leaked into the src folder scope')
  }
  if (!presented.visible.some((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')) {
    fail('folder scope dropped the in-folder tabindex fix')
  }
  if (presented.outOfScope.length === 0) fail('folder scope hid out-of-scope issues instead of counting them')
  if (presented.unmapped.length === 0) fail('folder scope dropped unmapped issues instead of listing them aside')
  if (presented.visible.some((issue) => !issue.file)) fail('unmapped issues leaked into folder tabs')
  const htmlIssue = outcome.issues.find((issue) => issue.tab === 'quick' && issue.file && path.resolve(issue.file) === path.resolve(projectRoot, 'index.html'))
  if (!htmlIssue?.file) fail('no quick fix in index.html')
  const htmlBefore = fs.readFileSync(htmlIssue.file, 'utf8')
  const denied = planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    auditScope: src,
    snapshots: outcome.files,
    current: { [htmlIssue.file]: htmlBefore },
    edits: htmlIssue.edits,
  })
  assertDenied(denied, 'OUTSIDE_SCOPE', htmlIssue.file, htmlBefore)
  const tab = presented.visible.find((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')
  if (!tab?.file) fail('no tabindex issue inside src')
  const allowed = planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    auditScope: src,
    snapshots: outcome.files,
    current: { [tab.file]: fs.readFileSync(tab.file, 'utf8') },
    edits: tab.edits,
  })
  if (!allowed.ok) fail(`in-folder quick fix denied: ${allowed.reason}`)
  if (workspaceReplacements(allowed).length === 0) fail('in-folder quick fix produced no replacements')
  const appFile = path.join(projectRoot, 'src', 'App.vue')
  const filePresented = presentIssues(outcome.issues, { workspaceRoot: projectRoot, projectRoot, target: appFile })
  if (filePresented.visible.some((issue) => issue.file && path.resolve(issue.file) !== path.resolve(appFile))) {
    fail('file scope leaked issues from other files')
  }
  if (!filePresented.visible.some((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')) {
    fail('file scope dropped the tabindex fix')
  }
}

async function batchScenario(session: Session): Promise<void> {
  const projectRoot = session.projectRoot
  const first = await auditProject(session, 'ru')
  summarize('batch-first', first.issues)
  expectInitial(first.issues)
  applyQuick(projectRoot, first.files, first.issues)
  const app = fs.readFileSync(path.join(projectRoot, 'src/App.vue'), 'utf8')
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')
  if (!app.includes('<button tabindex="0">Дальше</button>') || app.includes('tabindex="3"')) fail('tabindex was not rewritten')
  const scroller = app.match(/<div class="scroller"[^>]*>/)
  if (!scroller?.[0].includes('tabindex="0"')) fail('scroller was not made focusable')
  if (app.includes('aria-label')) fail('prohibited aria-label remained')
  if (first.issues.some((issue) => issue.ruleId === 'no-autoplay-audio' && issue.tab === 'quick') && app.includes('autoplay')) {
    fail('autoplay remained')
  }
  if (html.includes('user-scalable') || html.includes('maximum-scale')) fail('viewport restriction remained')
  if (!app.includes('<button class="empty"></button>')) fail('manual button was rewritten in the batch')
  if (!app.includes('v-for="row in rows"')) fail('v-for button was rewritten in the batch')
  const second = await auditProject(session, 'ru')
  summarize('batch-second', second.issues)
  assertNoQuick(second.issues)
  expect(second.issues, 'button-name', 'manual', 'class="empty"')
  expect(second.issues, 'button-name', 'ambiguous', 'v-for')
}

async function sequentialScenario(session: Session): Promise<void> {
  let outcome = await auditProject(session, 'ru')
  summarize('sequential-first', outcome.issues)
  expectInitial(outcome.issues)
  let guard = 0
  while (outcome.issues.some((issue) => issue.tab === 'quick')) {
    guard += 1
    if (guard > 12) fail('sequential fixes did not finish')
    assertFreshRanges(outcome.issues)
    const next = outcome.issues.find((issue) => issue.tab === 'quick')
    if (!next) break
    writeIssue(session.projectRoot, outcome, next)
    outcome = await auditProject(session, 'ru')
  }
  summarize('sequential-last', outcome.issues)
  assertFreshRanges(outcome.issues)
  assertNoQuick(outcome.issues)
  expect(outcome.issues, 'button-name', 'manual', 'class="empty"')
  expect(outcome.issues, 'image-alt', 'manual', 'class="photo"')
  expect(outcome.issues, 'button-name', 'ambiguous', 'v-for')
  const app = fs.readFileSync(path.join(session.projectRoot, 'src/App.vue'), 'utf8')
  if (!app.includes('<button class="empty"></button>')) fail('manual button changed during sequential fixes')
  if (!app.includes('v-for="row in rows"')) fail('v-for changed during sequential fixes')
  if (app.includes('alt=')) fail('an alt was invented during sequential fixes')
}

async function formatterScenario(session: Session): Promise<void> {
  const outcome = await auditProject(session, 'ru')
  const tabindex = outcome.issues.find((issue) => issue.ruleId === 'tabindex' && issue.tab === 'quick')
  const scroller = outcome.issues.find((issue) => issue.ruleId === 'scrollable-region-focusable' && issue.tab === 'quick')
  if (!tabindex || !scroller?.sourceText || scroller.start === undefined || scroller.end === undefined) {
    fail('formatter scenario is missing the tabindex or scroller issue')
  }
  writeIssue(session.projectRoot, outcome, tabindex)
  const appPath = path.join(session.projectRoot, 'src/App.vue')
  const current = fs.readFileSync(appPath, 'utf8')
  const compact = '    <button tabindex="0">Дальше</button>\n'
  const formattedButton = '    <button\n      tabindex="0"\n    >\n      Дальше\n    </button>\n'
  if (!current.includes(compact)) fail('could not find the fixed button to reformat')
  const formatted = current.replace(compact, formattedButton)
  fs.writeFileSync(appPath, formatted)
  const remembered = formatted.slice(scroller.start, scroller.end)
  if (/^<div\b/.test(remembered)) fail('expected the remembered range to capture the previous tag after formatting')
  const fresh = await auditProject(session, 'ru')
  assertFreshRanges(fresh.issues)
  const freshScroller = fresh.issues.find((issue) => issue.ruleId === 'scrollable-region-focusable' && issue.tab === 'quick')
  if (!freshScroller?.sourceText?.startsWith('<div')) fail('re-audit did not recover the scroller tag')
  writeIssue(session.projectRoot, fresh, freshScroller)
  const written = fs.readFileSync(appPath, 'utf8')
  const tag = written.match(/<div class="scroller"[^>]*>/)
  if (!tag?.[0].includes('tabindex="0"')) fail('scroller fix did not apply after formatting')
  if (!written.includes('<button class="empty"></button>')) fail('manual button changed after the formatted fix')
  if (!written.includes('v-for="row in rows"')) fail('v-for changed after the formatted fix')
}

function writeIssue(projectRoot: string, outcome: AuditOutcome, issue: Issue): void {
  commit(planIssue(projectRoot, outcome, issue), issue.ruleId)
}

function applyQuick(projectRoot: string, files: Record<string, string>, issues: Issue[]): Record<string, string> {
  const edits = issues.filter((issue) => issue.tab === 'quick').flatMap((issue) => issue.edits)
  const current: Record<string, string> = {}
  for (const edit of edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = files[edit.file] ?? files[file] ?? fs.readFileSync(file, 'utf8')
  }
  const plan = planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    snapshots: files,
    current,
    edits,
  })
  commit(plan, 'batch')
  const next = { ...files }
  for (const item of plannedWrites(plan)) next[item.file] = item.next
  return next
}

function planIssue(projectRoot: string, outcome: AuditOutcome, issue: Issue, folder: string | null = null) {
  const current: Record<string, string> = {}
  for (const edit of issue.edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = fs.readFileSync(file, 'utf8')
  }
  return planApply({
    workspaceRoot: projectRoot,
    projectRoot,
    auditScope: folder,
    snapshots: outcome.files,
    current,
    edits: issue.edits,
  })
}

function commit(plan: ReturnType<typeof planApply>, label: string): void {
  if (!plan.ok) fail(`${label}: ${plan.reason}`)
  if (workspaceReplacements(plan).length === 0) fail(`${label}: no workspace replacements`)
  for (const item of plannedWrites(plan)) fs.writeFileSync(item.file, item.next)
}

function assertDenied(
  plan: ReturnType<typeof planApply>,
  reason: 'STALE' | 'OVERLAP' | 'OUTSIDE_WORKSPACE' | 'OUTSIDE_SCOPE',
  file?: string,
  expected?: string,
): void {
  if (plan.ok || plan.reason !== reason) fail(`expected ${reason}, got ${JSON.stringify(plan)}`)
  if (workspaceReplacements(plan).length !== 0) fail(`${reason} leaked workspace replacements`)
  if (file && expected !== undefined) unchanged(file, expected, reason)
}

function unchanged(file: string, expected: string, label: string): void {
  if (fs.readFileSync(file, 'utf8') !== expected) fail(`${label} changed ${file}`)
}

function assertThreeCharacterShift(): void {
  const element = '<button class="empty"></button>'
  const text = `on>${element}`
  const resolved = resolveRange(text, 0, element)
  if (!resolved || text.slice(resolved.start, resolved.end) !== element || text[resolved.start] !== '<') {
    fail('a 3-character left shift was not snapped back to the tag')
  }
  const already = resolveRange(element, 0, element)
  if (!already || already.start !== 0) fail('an exact range was moved')
}

function assertFreshRanges(issues: Issue[]): void {
  for (const issue of issues) {
    if (!issue.sourceText) continue
    if (!/^<[A-Za-z]/.test(issue.sourceText)) {
      fail(`${issue.ruleId} range does not start at a tag: ${JSON.stringify(issue.sourceText.slice(0, 48))}`)
    }
  }
}

function assertNoQuick(issues: Issue[]): void {
  for (const rule of ['tabindex', 'scrollable-region-focusable', 'aria-prohibited-attr', 'meta-viewport', 'no-autoplay-audio']) {
    if (issues.some((issue) => issue.ruleId === rule && issue.tab === 'quick')) {
      fail(`${rule} is still a quick fix after applying edits`)
    }
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
  if (!found) fail(`missing ${tab} ${ruleId} containing ${sourceIncludes}`)
}

function routeScenario(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-routes-'))
  try {
    const about = planPageRoute(root, path.join(root, 'pages', 'about.vue'))
    if (!about || about.dynamic || about.staticPath !== '/about') fail('static page route')
    const nested = planPageRoute(root, path.join(root, 'pages', 'blog', 'index.vue'))
    if (!nested || nested.staticPath !== '/blog') fail('index page route')
    const grouped = planPageRoute(root, path.join(root, 'app', 'pages', '(site)', 'pricing.vue'))
    if (!grouped || grouped.staticPath !== '/pricing') fail('route group')
    const dotted = planPageRoute(root, path.join(root, 'pages', 'users.edit.vue'))
    if (!dotted || dotted.staticPath !== '/users/edit') fail('dotted page route')
    const user = planPageRoute(root, path.join(root, 'pages', 'users', '[id].vue'))
    if (!user?.dynamic || user.parentPath !== '/users' || user.staticPath !== null) fail('dynamic page route')
    if (!user.matches('/users/42') || user.matches('/users') || user.matches('/users/42/edit')) fail('dynamic match')
    const post = planPageRoute(root, path.join(root, 'pages', 'users', '[id]', 'posts', '[post].vue'))
    if (!post?.matches('/users/7/posts/3') || post.parentPath !== '/users') fail('nested dynamic route')
    const docs = planPageRoute(root, path.join(root, 'pages', 'docs', '[...slug].vue'))
    if (!docs?.matches('/docs/a/b') || docs.matches('/docs')) fail('catch-all route')
    const optional = planPageRoute(root, path.join(root, 'pages', '[[id]].vue'))
    if (!optional?.matches('/') || !optional.matches('/abc')) fail('optional param')
    const links = candidatePaths(['/users/42', 'https://example.com/users/9', '/about', '/users/42/'], 'http://127.0.0.1:3000/users', 'http://127.0.0.1:3000/', user)
    if (links.join(',') !== '/users/42') fail('candidate links')
    const file = path.join(root, 'pages', 'Profile.vue')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '<template><p><NuxtLink to="/users/15">Профиль</NuxtLink></p></template>\n')
    const scanned = scanProjectLinks(root, user)
    if (!scanned.includes('/users/15')) fail('static link scan')
    if (planPageRoute(root, path.join(root, 'components', 'Button.vue'))) fail('component is not a page')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function summarize(label: string, issues: Issue[]): void {
  console.log(label)
  for (const issue of issues) {
    console.log(`- ${issue.tab}\t${issue.impact ?? '-'}\t${issue.ruleId}\t${issue.reason ?? ''}\t${(issue.sourceText ?? issue.domHtml).replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}

function fail(message: string): never {
  throw new Error(message)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

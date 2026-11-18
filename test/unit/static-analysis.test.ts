import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planApply } from '../../src/core/apply'
import { analyzeVueFiles, listVueFiles } from '../../src/core/static'
import type { Issue } from '../../src/core/types'
import { createVueProject } from '../support/vueProject'
import { repoRootFrom } from '../support/repo'

const fixturesDir = path.join(repoRootFrom(__dirname), 'fixtures', 'static')

test('static analysis finds only source-certain Vue issues and keeps unsafe cases unfixed', () => {
  const files = Object.fromEntries(
    fs.readdirSync(fixturesDir)
      .filter((name) => name.endsWith('.vue'))
      .map((name) => [name, fs.readFileSync(path.join(fixturesDir, name), 'utf8')]),
  )
  const project = createVueProject(files)
  try {
    const result = analyzeVueFiles(project.root, Object.keys(files).map((name) => path.join(project.root, name)), 'ru')
    assert.deepEqual(
      result.errors.map((error) => `${path.basename(error.file ?? '')}:${error.message.split(' ')[0]}`).sort(),
      ['broken.vue:PARSE_FAILED', 'pug.vue:UNSUPPORTED_TEMPLATE_LANG'],
    )
    assert.equal(result.issues.some((issue) => issue.file?.endsWith('broken.vue')), false)
    assert.equal(result.issues.some((issue) => issue.file?.endsWith('pug.vue')), false)

    expectIssue(result.issues, 'missing-alt.vue', {
      ruleId: 'image-alt',
      tab: 'manual',
      source: '<img src="/a.png"',
    })
    assert.equal(result.issues.filter((issue) => issue.file?.endsWith('missing-alt.vue')).length, 1)
    expectIssue(result.issues, 'bound-alt.vue', {
      ruleId: 'image-alt',
      tab: 'ambiguous',
      reason: 'dynamic-attribute',
    })
    expectIssue(result.issues, 'bare-bind.vue', {
      ruleId: 'image-alt',
      tab: 'ambiguous',
      reason: 'bare-bind',
    })
    expectIssue(result.issues, 'root-img.vue', {
      ruleId: 'image-alt',
      tab: 'ambiguous',
      reason: 'fallthrough',
    })
    expectIssue(result.issues, 'empty-button.vue', {
      ruleId: 'button-name',
      tab: 'manual',
      source: '<button class="empty">',
    })
    expectIssue(result.issues, 'icon-button.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'opaque-content',
    })
    expectIssue(result.issues, 'slot-button.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'opaque-content',
    })
    expectIssue(result.issues, 'html-button.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'opaque-content',
    })
    expectIssue(result.issues, 'expr-button.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'dynamic-content',
    })
    expectIssue(result.issues, 'tabindex.vue', {
      ruleId: 'tabindex',
      tab: 'quick',
      source: '<div tabindex="3">',
    })
    expectIssue(result.issues, 'tabindex-root.vue', {
      ruleId: 'tabindex',
      tab: 'quick',
      source: '<div tabindex="3">',
    })
    expectIssue(result.issues, 'tabindex-bound.vue', {
      ruleId: 'tabindex',
      tab: 'ambiguous',
      reason: 'dynamic-attribute',
    })
    expectIssue(result.issues, 'button-tabindex.vue', {
      ruleId: 'button-name',
      tab: 'manual',
    })
    expectIssue(result.issues, 'button-tabindex.vue', {
      ruleId: 'tabindex',
      tab: 'quick',
    })
    expectIssue(result.issues, 'v-for-button.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'repeated-source',
    })
    expectIssue(result.issues, 'empty-link.vue', {
      ruleId: 'link-name',
      tab: 'manual',
      source: '<a href="/a">',
    })
    assert.equal(result.issues.filter((issue) => issue.file?.endsWith('empty-link.vue')).length, 1)
    expectIssue(result.issues, 'iframe.vue', {
      ruleId: 'frame-title',
      tab: 'manual',
      source: '<iframe',
    })
    expectIssue(result.issues, 'empty-heading.vue', {
      ruleId: 'empty-heading',
      tab: 'manual',
      source: '<h1',
    })
    expectIssue(result.issues, 'area.vue', {
      ruleId: 'area-alt',
      tab: 'manual',
      source: '<area',
    })
    expectIssue(result.issues, 'unresolved-label.vue', {
      ruleId: 'button-name',
      tab: 'ambiguous',
      reason: 'unresolved-label',
    })
    expectIssue(result.issues, 'whitespace-button.vue', {
      ruleId: 'button-name',
      tab: 'manual',
      source: '<button>',
    })

    for (const name of [
      'decorative-alt.vue',
      'named-button.vue',
      'text-link.vue',
      'iframe-titled.vue',
      'text-heading.vue',
      'library.vue',
      'labelled-by.vue',
      'titled-button.vue',
      'unlabeled-input.vue',
      'custom-directive.vue',
    ]) {
      assert.equal(result.issues.some((issue) => issue.file?.endsWith(name)), false, name)
    }

    const manual = result.issues.find((issue) => issue.file?.endsWith('missing-alt.vue'))
    assert.ok(manual)
    assert.deepEqual(manual.edits, [])
    assert.equal(manual.help, 'Изображения должны иметь альтернативный текст')
    assert.match(manual.helpUrl, /dequeuniversity\.com\/rules\/axe\/4\.14\/image-alt/)
    assert.equal(manual.impact, 'critical')
    assert.equal(manual.sourceText?.startsWith('<img'), true)
    assert.equal(manual.line, 3)

    const tabindex = result.issues.find((issue) => issue.file?.endsWith('tabindex.vue') && issue.ruleId === 'tabindex')
    assert.ok(tabindex)
    assert.equal(tabindex.edits.length, 1)
    assert.equal(tabindex.edits[0]?.insert, '0')
    assert.equal(/alt=|aria-label/.test(tabindex.edits[0]?.insert ?? ''), false)
    const file = tabindex.file ?? ''
    const applied = planApply({
      workspaceRoot: project.root,
      projectRoot: project.root,
      snapshots: result.files,
      current: { [file]: result.files[file] ?? '' },
      edits: tabindex.edits,
    })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    assert.match(applied.files[file]?.next ?? '', /tabindex="0"/)
    assert.doesNotMatch(applied.files[file]?.next ?? '', /tabindex="3"/)

    const decoy = result.issues.find((issue) => issue.file?.endsWith('decoy.vue'))
    assert.ok(decoy?.sourceText && decoy.file)
    const decoySource = fs.readFileSync(decoy.file, 'utf8')
    assert.equal(decoy.start, decoySource.lastIndexOf(decoy.sourceText))
    assert.notEqual(decoy.start, decoySource.indexOf(decoy.sourceText))
  } finally {
    project.cleanup()
  }
})

test('one broken Vue file does not stop analysis of the next file', () => {
  const project = createVueProject({
    'broken.vue': '<template><button></template>\n',
    'ok.vue': '<template><main><img src="/a.png" /></main></template>\n',
  })
  try {
    const result = analyzeVueFiles(project.root, [
      path.join(project.root, 'broken.vue'),
      path.join(project.root, 'ok.vue'),
    ])
    assert.equal(result.errors.length, 1)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0]?.ruleId, 'image-alt')
    assert.equal(result.issues[0]?.tab, 'manual')
    assert.equal(result.issues[0]?.file?.endsWith('ok.vue'), true)
  } finally {
    project.cleanup()
  }
})

test('static analysis does not require a Vite or Nuxt config and reports a missing compiler', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-no-vue-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{ "private": true }\n')
  fs.writeFileSync(path.join(root, 'App.vue'), '<template><img src="/a.png" /></template>\n')
  try {
    const result = analyzeVueFiles(root, [path.join(root, 'App.vue')])
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.errors.map((error) => error.message), ['NO_VUE_COMPILER'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('static analysis rejects files outside the project and non-Vue files without stopping', () => {
  const project = createVueProject({
    'App.vue': '<template><main><img src="/a.png" /></main></template>\n',
    'notes.txt': 'img\n',
  })
  try {
    const result = analyzeVueFiles(project.root, [
      path.join(os.tmpdir(), 'outside.vue'),
      path.join(project.root, 'notes.txt'),
      path.join(project.root, 'missing.vue'),
      path.join(project.root, 'App.vue'),
    ])
    assert.equal(result.errors.some((error) => error.message === 'OUTSIDE_PROJECT'), true)
    assert.equal(result.errors.some((error) => error.message === 'NOT_VUE'), true)
    assert.equal(result.errors.some((error) => error.message === 'READ_FAILED'), true)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0]?.ruleId, 'image-alt')
  } finally {
    project.cleanup()
  }
})

test('listVueFiles skips excluded directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-list-'))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'App.vue'), '<template></template>\n')
  fs.writeFileSync(path.join(root, 'node_modules', 'lib', 'Widget.vue'), '<template></template>\n')
  try {
    assert.deepEqual(listVueFiles(root), [path.join(root, 'src', 'App.vue')])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function expectIssue(
  issues: Issue[],
  fileName: string,
  expected: { ruleId: string; tab: Issue['tab']; reason?: string; source?: string },
): void {
  const found = issues.find((issue) => (
    issue.file?.endsWith(fileName)
    && issue.ruleId === expected.ruleId
    && issue.tab === expected.tab
    && (expected.reason === undefined || issue.reason === expected.reason)
    && (expected.source === undefined || (issue.sourceText ?? '').includes(expected.source))
  ))
  assert.ok(found, `${fileName} ${expected.tab} ${expected.ruleId} ${expected.reason ?? ''}`)
  assert.equal(found.edits.length > 0, expected.tab === 'quick')
  if (expected.tab !== 'quick') assert.deepEqual(found.edits, [])
  if (found.sourceText) assert.equal(found.sourceText.startsWith('<'), true)
}

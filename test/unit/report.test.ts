import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderAuditReport } from '../../src/core/report'
import type { AuditOutcome, Issue } from '../../src/core/types'

test('the report lists all three tabs and does not write project files', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-report-'))
  const outcome: AuditOutcome = {
    url: 'http://127.0.0.1:4173/',
    mappingEnabled: true,
    files: {},
    issues: [
      issue('quick', 'tabindex'),
      issue('manual', 'image-alt'),
      issue('ambiguous', 'color-contrast', 'unmapped'),
    ],
  }
  try {
    const before = fs.readdirSync(projectRoot)
    const report = renderAuditReport({
      outcome,
      projectRoot,
      language: 'ru',
      scope: null,
      excluded: ['node_modules', 'dist', 'build', '.git', '.nuxt', '.output'],
      visible: outcome.issues,
      outOfScope: [],
      unmapped: [],
    })
    assert.deepEqual(fs.readdirSync(projectRoot), before)
    assert.match(report.markdown, /## Быстрые правки/)
    assert.match(report.markdown, /## Ручные правки/)
    assert.match(report.markdown, /## Неоднозначные правки/)
    assert.match(report.markdown, /Отчёт сам файлы не меняет/)
    assert.doesNotMatch(report.markdown, /```json/)
    const data = JSON.parse(report.json) as { issues: Array<{ tab: string }> }
    assert.deepEqual(data.issues.map((item) => item.tab), ['quick', 'manual', 'ambiguous'])
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('the markdown and json reports follow the language, scope, and exclusions without offering fixes outside the scope', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-report-scope-'))
  const app = path.join(projectRoot, 'src', 'App.vue')
  const other = path.join(projectRoot, 'index.html')
  const outcome: AuditOutcome = {
    url: 'http://127.0.0.1:4173/src',
    mappingEnabled: true,
    files: {},
    issues: [
      {
        ...issue('quick', 'tabindex'),
        file: app,
        line: 4,
        help: 'Значение tabindex больше нуля',
        sourceText: '<button tabindex="3">',
        before: '<button tabindex="3">',
        after: '<button tabindex="0">',
        edits: [{ file: app, start: 18, end: 19, insert: '0' }],
      },
      {
        ...issue('quick', 'meta-viewport'),
        file: other,
        line: 1,
        edits: [{ file: other, start: 0, end: 0, insert: 'x' }],
      },
      issue('ambiguous', 'color-contrast', 'unmapped'),
    ],
  }
  try {
    const before = fs.readdirSync(projectRoot)
    const report = renderAuditReport({
      outcome,
      projectRoot,
      language: 'en',
      scope: 'src',
      excluded: ['coverage'],
      visible: outcome.issues.filter((item) => item.ruleId === 'tabindex'),
      outOfScope: outcome.issues.filter((item) => item.ruleId === 'meta-viewport'),
      unmapped: outcome.issues.filter((item) => item.ruleId === 'color-contrast'),
    })
    assert.deepEqual(fs.readdirSync(projectRoot), before)
    assert.match(report.markdown, /Scope: src/)
    assert.match(report.markdown, /Excluded directories: coverage/)
    assert.match(report.markdown, /not a WCAG conformance verdict/)
    assert.match(report.markdown, /## Quick fixes/)
    assert.match(report.markdown, /src\/App\.vue:4/)
    assert.match(report.markdown, /-<button tabindex="3">/)
    assert.match(report.markdown, /\+<button tabindex="0">/)
    assert.match(report.markdown, /## Outside scope/)
    assert.match(report.markdown, /not included in fixes/)
    assert.match(report.markdown, /## No source file/)
    const quick = report.markdown.split('## Outside scope')[0] ?? ''
    assert.doesNotMatch(quick, /meta-viewport/)
    const data = JSON.parse(report.json) as {
      version: number
      scope: string | null
      excluded: string[]
      issues: Array<{ ruleId: string; edits: unknown[] }>
      outOfScope: Array<{ ruleId: string; file: string | null }>
      unmapped: Array<{ ruleId: string; file: string | null }>
    }
    assert.equal(data.version, 1)
    assert.equal(data.scope, 'src')
    assert.deepEqual(data.excluded, ['coverage'])
    assert.deepEqual(data.issues.map((item) => item.ruleId), ['tabindex'])
    assert.equal(data.issues[0]?.edits.length, 1)
    assert.deepEqual(data.outOfScope.map((item) => item.ruleId), ['meta-viewport'])
    assert.equal(data.outOfScope[0]?.file, path.join('index.html'))
    assert.deepEqual(data.unmapped.map((item) => ({ ruleId: item.ruleId, file: item.file })), [
      { ruleId: 'color-contrast', file: null },
    ])
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

function issue(tab: Issue['tab'], ruleId: string, reason?: string): Issue {
  return {
    id: ruleId,
    ruleId,
    impact: 'serious',
    description: '',
    help: ruleId,
    helpUrl: '',
    failureSummary: '',
    tab,
    reason,
    domHtml: '<div>',
    edits: [],
  }
}

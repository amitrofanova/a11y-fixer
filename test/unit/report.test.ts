import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { renderReport } from '../../src/core/report'
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
    const report = renderReport(outcome, projectRoot)
    assert.deepEqual(fs.readdirSync(projectRoot), before)
    assert.match(report, /## Быстрые правки/)
    assert.match(report, /## Ручные правки/)
    assert.match(report, /## Неоднозначные правки/)
    assert.match(report, /Отчёт сам файлы не меняет/)
    assert.match(report, /```json/)
    assert.match(report, /"tab": "quick"/)
    assert.match(report, /"tab": "manual"/)
    assert.match(report, /"tab": "ambiguous"/)
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

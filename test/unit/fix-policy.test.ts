import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planApply, plannedWrites } from '../../src/core/apply'
import { finalizeIssues } from '../../src/core/classify'
import { messageText } from '../../src/i18n'
import type { Issue, TextEdit } from '../../src/core/types'

test('one unsafe edit rejects the whole package and leaves every file unchanged', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-unsafe-'))
  const safe = path.join(projectRoot, 'Button.vue')
  const named = path.join(projectRoot, 'Image.vue')
  const button = '<template><button tabindex="3">Дальше</button></template>\n'
  const image = '<template><div aria-label="x"></div></template>\n'
  fs.writeFileSync(safe, button)
  fs.writeFileSync(named, image)
  const snapshots = { [safe]: button, [named]: image }
  try {
    const refused = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current: snapshots,
      edits: [
        { file: safe, start: button.indexOf('3'), end: button.indexOf('3') + 1, insert: '0' },
        { file: named, start: image.indexOf('></div>'), end: image.indexOf('></div>'), insert: ' alt="Фото"' },
      ],
    })
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.reason, 'UNSAFE')
    assert.match(messageText('ru', 'unsafe'), /доступн/)
    assert.match(messageText('en', 'unsafe'), /accessible name/)
    assert.equal(plannedWrites(refused).length, 0)
    assert.equal(fs.readFileSync(safe, 'utf8'), button)
    assert.equal(fs.readFileSync(named, 'utf8'), image)

    const allowed = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current: snapshots,
      edits: [
        { file: safe, start: button.indexOf('3'), end: button.indexOf('3') + 1, insert: '0' },
        { file: safe, start: button.indexOf('>'), end: button.indexOf('>'), insert: ' tabindex="0"' },
        { file: named, start: image.indexOf(' aria-label'), end: image.indexOf('></div>'), insert: '' },
        { file: safe, start: 0, end: 0, insert: 'width=device-width, initial-scale=1' },
      ],
    })
    assert.equal(allowed.ok, true)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('a stale file rejects the rest of the package', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-stale-pack-'))
  const first = path.join(projectRoot, 'A.vue')
  const second = path.join(projectRoot, 'B.vue')
  const text = '<template><button tabindex="3"></button></template>\n'
  fs.writeFileSync(first, text)
  fs.writeFileSync(second, text)
  try {
    const plan = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots: { [first]: text, [second]: text },
      current: { [first]: `${text}\n`, [second]: text },
      edits: [
        { file: first, start: text.indexOf('3'), end: text.indexOf('3') + 1, insert: '0' },
        { file: second, start: text.indexOf('3'), end: text.indexOf('3') + 1, insert: '0' },
      ],
    })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.reason, 'STALE')
    assert.equal(plannedWrites(plan).length, 0)
    assert.equal(fs.readFileSync(second, 'utf8'), text)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('quick fixes that invent an accessible name are dropped and identical edits collapse', () => {
  const file = '/project/App.vue'
  const tabindex = quickIssue('tabindex', file, [{ file, start: 20, end: 21, insert: '0' }], '<button tabindex="3">', '<button tabindex="0">')
  const duplicate = quickIssue('tabindex', file, [{ file, start: 20, end: 21, insert: '0' }], '<button tabindex="3">', '<button tabindex="0">')
  const invented = quickIssue('image-alt', file, [{ file, start: 10, end: 10, insert: ' alt="Фото"' }], '<img src="/a.png" />', '<img alt="Фото" src="/a.png" />')
  const labelled = quickIssue('button-name', file, [{ file, start: 8, end: 8, insert: ' aria-label="Сохранить"' }])
  const described = quickIssue('button-name', file, [{ file, start: 8, end: 8, insert: ' aria-describedby="hint"' }])
  const titled = quickIssue('button-name', file, [{ file, start: 8, end: 8, insert: ' title="Меню"' }])
  const placeholder = quickIssue('label', file, [{ file, start: 8, end: 8, insert: ' placeholder="Имя"' }])
  const manual = quickIssue('button-name', file, [])
  manual.tab = 'manual'

  const issues = finalizeIssues([invented, tabindex, duplicate, labelled, described, titled, placeholder, manual])
  const quick = issues.filter((issue) => issue.tab === 'quick')
  assert.equal(quick.length, 1)
  assert.equal(quick[0]?.ruleId, 'tabindex')
  assert.equal(quick[0]?.before, '<button tabindex="3">')
  assert.equal(quick[0]?.after, '<button tabindex="0">')
  assert.equal(quick[0]?.edits[0]?.insert, '0')

  for (const rule of ['image-alt', 'button-name', 'label']) {
    const dropped = issues.filter((issue) => issue.ruleId === rule && issue.reason === 'unsafe-value')
    assert.equal(dropped.length, rule === 'button-name' ? 3 : 1, rule)
    for (const issue of dropped) {
      assert.equal(issue.tab, 'ambiguous')
      assert.deepEqual(issue.edits, [])
      assert.equal(issue.before, undefined)
      assert.equal(issue.after, undefined)
    }
  }
  assert.equal(issues.find((issue) => issue.tab === 'manual')?.edits.length, 0)
})

function quickIssue(ruleId: string, file: string, edits: TextEdit[], before?: string, after?: string): Issue {
  return {
    id: `${ruleId}:${file}:${edits[0]?.start ?? 0}`,
    ruleId,
    impact: 'serious',
    description: ruleId,
    help: ruleId,
    helpUrl: '',
    failureSummary: '',
    tab: 'quick',
    file,
    start: 0,
    end: 10,
    line: 1,
    sourceText: '<button>',
    domHtml: '',
    before,
    after,
    edits,
  }
}

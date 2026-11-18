import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { presentIssues } from '../../src/core/apply'
import type { Issue } from '../../src/core/types'

test('presentIssues separates the selected folder, other project files, and unmapped results', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-scope-'))
  const src = path.join(projectRoot, 'src')
  const app = path.join(src, 'App.vue')
  const html = path.join(projectRoot, 'index.html')
  fs.mkdirSync(src)
  fs.writeFileSync(app, '<template></template>\n')
  fs.writeFileSync(html, '<html></html>\n')
  try {
    const folder = presentIssues(
      [
        issue('tabindex', app),
        issue('meta-viewport', html),
        issue('region'),
      ],
      { workspaceRoot: projectRoot, projectRoot, target: src },
    )
    const wholeProject = presentIssues(
      [issue('region')],
      { workspaceRoot: projectRoot, projectRoot, target: null },
    )
    assert.deepEqual(folder.visible.map((item) => item.ruleId), ['tabindex'])
    assert.deepEqual(folder.outOfScope.map((item) => item.ruleId), ['meta-viewport'])
    assert.deepEqual(folder.unmapped.map((item) => item.ruleId), ['region'])
    assert.equal(folder.visible.some((item) => !item.file), false)
    assert.deepEqual(wholeProject.visible.map((item) => item.ruleId), ['region'])
    assert.equal(wholeProject.unmapped.length, 0)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

function issue(ruleId: string, file?: string): Issue {
  return {
    id: ruleId,
    ruleId,
    impact: 'serious',
    description: '',
    help: ruleId,
    helpUrl: '',
    failureSummary: '',
    tab: 'ambiguous',
    file,
    domHtml: `<${ruleId}>`,
    edits: [],
  }
}

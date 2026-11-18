import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planApply, presentIssues } from '../../src/core/apply'
import { EXCLUDED_DIR_NAMES, resolveExcludedDirectories } from '../../src/core/settings'
import { listVueFiles } from '../../src/core/static'
import type { Issue } from '../../src/core/types'
import { repoRootFrom } from '../support/repo'

test('an audit setting replaces the default directory list and drops names that are not one segment', () => {
  assert.deepEqual(resolveExcludedDirectories(undefined), [...EXCLUDED_DIR_NAMES])
  assert.deepEqual(resolveExcludedDirectories('node_modules'), [...EXCLUDED_DIR_NAMES])
  assert.deepEqual(resolveExcludedDirectories([]), [])
  assert.deepEqual(resolveExcludedDirectories([' coverage ', 'coverage', '', '.', '..', 'src/generated']), ['coverage'])
  assert.deepEqual(resolveExcludedDirectories(['src/generated', 4]), [...EXCLUDED_DIR_NAMES])
  assert.ok(resolveExcludedDirectories(undefined).includes('node_modules'))
  assert.ok(resolveExcludedDirectories(undefined).includes('.nuxt'))
})

test('a configured exclusion changes scope without moving the project root used to launch the app', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-exclude-'))
  const src = path.join(projectRoot, 'src')
  const app = path.join(src, 'App.vue')
  const generated = path.join(src, 'coverage', 'Widget.vue')
  const vendor = path.join(projectRoot, 'node_modules', 'lib', 'Vendor.vue')
  const text = '<template><div></div></template>\n'
  try {
    const presented = presentIssues(
      [issue('app', app), issue('generated', generated), issue('vendor', vendor), issue('loose')],
      { workspaceRoot: projectRoot, projectRoot, target: src, excluded: ['coverage'] },
    )
    assert.deepEqual(presented.visible.map((item) => item.ruleId), ['app'])
    assert.deepEqual(presented.outOfScope.map((item) => item.ruleId), ['generated', 'vendor'])
    assert.deepEqual(presented.unmapped.map((item) => item.ruleId), ['loose'])

    const open = presentIssues(
      [issue('vendor', vendor)],
      { workspaceRoot: projectRoot, projectRoot, target: null, excluded: [] },
    )
    assert.deepEqual(open.visible.map((item) => item.ruleId), ['vendor'])

    const blocked = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      auditScope: src,
      excluded: ['coverage'],
      snapshots: { [app]: text, [generated]: text },
      current: { [app]: text, [generated]: text },
      edits: [
        { file: app, start: 10, end: 10, insert: ' id="ok"' },
        { file: generated, start: 10, end: 10, insert: ' id="no"' },
      ],
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.reason, 'OUTSIDE_SCOPE')
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('listing Vue files uses the configured names and otherwise keeps the built-in list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-list-custom-'))
  const app = path.join(root, 'src', 'App.vue')
  const hidden = path.join(root, 'coverage', 'Hidden.vue')
  const vendor = path.join(root, 'node_modules', 'lib', 'Widget.vue')
  fs.mkdirSync(path.dirname(app), { recursive: true })
  fs.mkdirSync(path.dirname(hidden), { recursive: true })
  fs.mkdirSync(path.dirname(vendor), { recursive: true })
  fs.writeFileSync(app, '<template></template>\n')
  fs.writeFileSync(hidden, '<template></template>\n')
  fs.writeFileSync(vendor, '<template></template>\n')
  try {
    assert.deepEqual(listVueFiles(root, ['coverage']).sort(), [app, vendor].sort())
    assert.deepEqual(listVueFiles(root).sort(), [app, hidden].sort())
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the VS Code exclusion setting defaults to the built-in directory names', () => {
  const root = repoRootFrom(__dirname)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { type?: string; default?: string[] }> } }
  }
  const setting = pkg.contributes.configuration.properties['a11yFixer.excludeDirectories']
  assert.equal(setting.type, 'array')
  assert.deepEqual(setting.default, [...EXCLUDED_DIR_NAMES])
  const english = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>
  const russian = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.ru.json'), 'utf8')) as Record<string, string>
  assert.match(english['a11yFixer.excludeDirectories.description'], /node_modules/)
  assert.match(russian['a11yFixer.excludeDirectories.description'], /node_modules/)
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
    tab: 'quick',
    file,
    domHtml: `<${ruleId}>`,
    edits: file ? [{ file, start: 10, end: 10, insert: ' id="x"' }] : [],
  }
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planApply, presentIssues } from '../../src/core/apply'
import type { Issue } from '../../src/core/types'

test('a directory whose name only starts with the project name stays outside the workspace', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-prefix-'))
  const project = path.join(parent, 'app')
  const evil = path.join(parent, 'app-evil', 'Widget.vue')
  const text = '<div></div>\n'
  fs.mkdirSync(path.dirname(evil), { recursive: true })
  fs.mkdirSync(project)
  fs.writeFileSync(evil, text)
  try {
    const plan = planApply({
      workspaceRoot: project,
      projectRoot: project,
      snapshots: { [evil]: text },
      current: { [evil]: text },
      edits: [{ file: evil, start: 1, end: 4, insert: 'span' }],
    })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.reason, 'OUTSIDE_WORKSPACE')
    assert.equal(fs.readFileSync(evil, 'utf8'), text)
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('an excluded directory name does not hide a longer name or a vue file', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-segment-'))
  const backup = path.join(project, 'dist-backup', 'App.vue')
  const named = path.join(project, 'src', 'node_modules.vue')
  const blocked = path.join(project, 'dist', 'Built.vue')
  const issues = [entry('backup', backup), entry('named', named), entry('blocked', blocked)]
  try {
    const presented = presentIssues(issues, {
      workspaceRoot: project,
      projectRoot: project,
      target: null,
    })
    assert.deepEqual(presented.visible.map((item) => item.ruleId).sort(), ['backup', 'named'])
    assert.deepEqual(presented.outOfScope.map((item) => item.ruleId), ['blocked'])
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('an edit that does not fit the snapshot refuses the whole package', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-range-'))
  const kept = path.join(project, 'Kept.vue')
  const broken = path.join(project, 'Broken.vue')
  const text = '<div></div>\n'
  fs.writeFileSync(kept, text)
  fs.writeFileSync(broken, text)
  try {
    const plan = planApply({
      workspaceRoot: project,
      projectRoot: project,
      snapshots: { [kept]: text, [broken]: text },
      current: { [kept]: text, [broken]: text },
      edits: [
        { file: kept, start: 1, end: 4, insert: 'span' },
        { file: broken, start: 0, end: text.length + 5, insert: 'x' },
      ],
    })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.reason, 'OVERLAP')
    assert.equal(fs.readFileSync(kept, 'utf8'), text)
    assert.equal(fs.readFileSync(broken, 'utf8'), text)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('a symlink that leaves the project cannot receive a quick fix', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-link-'))
  const project = path.join(parent, 'app')
  const outside = path.join(parent, 'outside')
  const secret = path.join(outside, 'Secret.vue')
  const link = path.join(project, 'src', 'linked')
  const viaLink = path.join(link, 'Secret.vue')
  const text = '<div></div>\n'
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(secret, text)
  fs.symlinkSync(outside, link)
  try {
    const plan = planApply({
      workspaceRoot: project,
      projectRoot: project,
      snapshots: { [viaLink]: text },
      current: { [viaLink]: text },
      edits: [{ file: viaLink, start: 1, end: 4, insert: 'span' }],
    })
    assert.equal(plan.ok, false)
    if (plan.ok) return
    assert.equal(plan.reason, 'OUTSIDE_WORKSPACE')
    assert.equal(fs.readFileSync(secret, 'utf8'), text)
  } finally {
    fs.rmSync(parent, { recursive: true, force: true })
  }
})

test('a symlink that stays inside the project can still be edited', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-link-in-'))
  const real = path.join(project, 'src', 'App.vue')
  const link = path.join(project, 'alias.vue')
  const text = '<div></div>\n'
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, text)
  fs.symlinkSync(real, link)
  try {
    const plan = planApply({
      workspaceRoot: project,
      projectRoot: project,
      snapshots: { [link]: text },
      current: { [link]: text },
      edits: [{ file: link, start: 1, end: 4, insert: 'span' }],
    })
    assert.equal(plan.ok, true)
    if (!plan.ok) return
    const next = Object.values(plan.files)[0]?.next
    assert.equal(next, '<span></div>\n')
    assert.equal(fs.readFileSync(real, 'utf8'), text)
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

function entry(ruleId: string, file: string): Issue {
  return {
    id: ruleId,
    ruleId,
    impact: 'serious',
    description: '',
    help: ruleId,
    helpUrl: '',
    failureSummary: '',
    tab: 'manual',
    file,
    domHtml: '<div>',
    edits: [],
  }
}

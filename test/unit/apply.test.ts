import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { planApply, plannedWrites, workspaceReplacements } from '../../src/core/apply'

test('planApply deduplicates identical edits and keeps adjacent ranges', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-apply-'))
  const a = path.join(projectRoot, '.a11y-policy-a.txt')
  const b = path.join(projectRoot, '.a11y-policy-b.txt')
  const snapshotA = '<div></div>\n'
  const snapshotB = '<span></span>\n'
  fs.writeFileSync(a, snapshotA)
  fs.writeFileSync(b, snapshotB)
  const snapshots = { [a]: snapshotA, [b]: snapshotB }
  const current = { [a]: snapshotA, [b]: snapshotB }
  try {
    const single = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current,
      edits: [{ file: a, start: 4, end: 4, insert: ' class="ok"' }],
    })
    assert.equal(single.ok, true)
    if (!single.ok) return
    assert.equal(plannedWrites(single)[0]?.next, '<div class="ok"></div>\n')
    assert.ok(workspaceReplacements(single).length > 0)
    assert.equal(fs.readFileSync(a, 'utf8'), snapshotA)
    assert.equal(fs.readFileSync(b, 'utf8'), snapshotB)

    const batch = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current,
      edits: [
        { file: a, start: 4, end: 4, insert: ' class="ok"' },
        { file: a, start: 4, end: 4, insert: ' class="ok"' },
        { file: b, start: 1, end: 5, insert: 'p' },
      ],
    })
    assert.equal(batch.ok, true)
    if (!batch.ok) return
    assert.equal(plannedWrites(batch).length, 2)
    const fileA = plannedWrites(batch).find((item) => item.file === path.resolve(a))
    assert.equal(fileA?.next, '<div class="ok"></div>\n')
    assert.equal(fs.readFileSync(a, 'utf8'), snapshotA)
    assert.equal(fs.readFileSync(b, 'utf8'), snapshotB)

    const adjacent = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current,
      edits: [
        { file: a, start: 0, end: 2, insert: 'ab' },
        { file: a, start: 2, end: 4, insert: 'cd' },
      ],
    })
    assert.equal(adjacent.ok, true)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('planApply rejects a stale snapshot, an overlap, and paths outside the allowed roots', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-apply-'))
  const a = path.join(projectRoot, '.a11y-policy-a.txt')
  const b = path.join(projectRoot, '.a11y-policy-b.txt')
  const snapshotA = '<div></div>\n'
  const snapshotB = '<span></span>\n'
  fs.writeFileSync(a, snapshotA)
  fs.writeFileSync(b, snapshotB)
  const snapshots = { [a]: snapshotA, [b]: snapshotB }
  const current = { [a]: snapshotA, [b]: snapshotB }
  try {
    const stale = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current: { [a]: `${snapshotA} `, [b]: snapshotB },
      edits: [{ file: a, start: 4, end: 4, insert: 'x' }],
    })
    assertDenied(stale, 'STALE')
    assert.equal(fs.readFileSync(a, 'utf8'), snapshotA)

    const overlap = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots,
      current,
      edits: [
        { file: a, start: 0, end: 5, insert: 'aaaaa' },
        { file: a, start: 3, end: 8, insert: 'bbbb' },
      ],
    })
    assertDenied(overlap, 'OVERLAP')
    assert.equal(fs.readFileSync(a, 'utf8'), snapshotA)
    assert.equal(workspaceReplacements(overlap).length, 0)

    const outside = path.join(os.tmpdir(), 'a11y-fixer-outside.vue')
    const foreign = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      snapshots: { [outside]: '<div></div>' },
      current: { [outside]: '<div></div>' },
      edits: [{ file: outside, start: 0, end: 5, insert: 'span' }],
    })
    assertDenied(foreign, 'OUTSIDE_WORKSPACE')

    for (const name of ['node_modules', 'dist', 'build', '.git', '.nuxt', '.output']) {
      const excluded = path.join(projectRoot, name, 'Widget.vue')
      const blocked = planApply({
        workspaceRoot: projectRoot,
        projectRoot,
        snapshots: { [excluded]: '<div></div>' },
        current: { [excluded]: '<div></div>' },
        edits: [{ file: excluded, start: 0, end: 5, insert: 'span' }],
      })
      assertDenied(blocked, 'OUTSIDE_SCOPE')
    }

    const scoped = planApply({
      workspaceRoot: projectRoot,
      projectRoot,
      auditScope: path.join(projectRoot, 'src'),
      snapshots,
      current,
      edits: [{ file: a, start: 4, end: 4, insert: 'x' }],
    })
    assertDenied(scoped, 'OUTSIDE_SCOPE')
    assert.equal(fs.readFileSync(a, 'utf8'), snapshotA)
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
})

function assertDenied(plan: ReturnType<typeof planApply>, reason: 'STALE' | 'OVERLAP' | 'OUTSIDE_WORKSPACE' | 'OUTSIDE_SCOPE'): void {
  assert.equal(plan.ok, false)
  if (plan.ok) return
  assert.equal(plan.reason, reason)
  assert.equal(workspaceReplacements(plan).length, 0)
}

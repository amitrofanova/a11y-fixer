import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { classifyFindings } from '../../src/core/classify'
import { applyTextEdits, buildQuickEdit } from '../../src/core/source'
import type { Finding } from '../../src/core/types'
import { createVueProject, locateTag, markerFor } from '../support/vueProject'

test('a positive tabindex is replaced with 0', () => {
  const source = '<template>\n  <button tabindex="3">Дальше</button>\n</template>\n'
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const located = locateTag(project.root, file, 'button', 'tabindex="3"')
    const built = buildQuickEdit(located, 'tabindex', [])
    if ('reason' in built) assert.fail(built.reason)
    assert.equal(built.edits.length, 1)
    assert.equal(built.edits[0]?.insert, '0')
    const next = applyTextEdits(located.source, built.edits)
    assert.equal(next?.includes('tabindex="0"'), true)
    assert.equal(next?.includes('tabindex="3"'), false)
    assert.equal(next?.includes('alt='), false)
  } finally {
    project.cleanup()
  }
})

test('dynamic and missing attributes do not become quick fixes', () => {
  const cases = [
    {
      name: 'v-bind:tabindex',
      source: '<template><button :tabindex="count">Дальше</button></template>\n',
      reason: 'dynamic-attribute',
    },
    {
      name: 'bare v-bind',
      source: '<template><button v-bind="attrs" tabindex="3">Дальше</button></template>\n',
      reason: 'bare-bind',
    },
    {
      name: 'missing tabindex',
      source: '<template><button>Дальше</button></template>\n',
      reason: 'no-attribute',
    },
  ]
  for (const item of cases) {
    const project = createVueProject({ 'src/App.vue': item.source })
    const file = path.join(project.root, 'src/App.vue')
    try {
      const located = locateTag(project.root, file, 'button')
      const built = buildQuickEdit(located, 'tabindex', [])
      assert.equal('reason' in built ? built.reason : 'edited', item.reason, item.name)
      assert.equal('edits' in built, false, item.name)
      const issues = classifyFindings(project.root, [
        finding('tabindex', markerFor(file, located.start, located.end), 'BUTTON'),
      ], {})
      assert.equal(issues.length, 1, item.name)
      assert.equal(issues[0]?.tab, 'ambiguous', item.name)
      assert.equal(issues[0]?.reason, item.reason, item.name)
      assert.deepEqual(issues[0]?.edits, [], item.name)
    } finally {
      project.cleanup()
    }
  }
})

function finding(ruleId: string, marker: string, tag: string): Finding {
  return {
    ruleId,
    impact: 'serious',
    description: '',
    help: ruleId,
    helpUrl: '',
    failureSummary: '',
    html: `<${tag.toLowerCase()}>`,
    target: [tag.toLowerCase()],
    marker,
    tag,
    checks: [],
    incomplete: false,
  }
}

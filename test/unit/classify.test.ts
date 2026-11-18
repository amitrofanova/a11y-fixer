import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { classifyFindings } from '../../src/core/classify'
import type { Finding } from '../../src/core/types'
import { createVueProject, locateTag, markerFor } from '../support/vueProject'

test('manual rules keep a source range and do not invent text', () => {
  const source = `<template>
  <img class="photo" src="/photo.png" />
  <button class="empty"></button>
</template>
`
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const image = locateTag(project.root, file, 'img', 'class="photo"')
    const button = locateTag(project.root, file, 'button', 'class="empty"')
    const issues = classifyFindings(project.root, [
      finding('image-alt', markerFor(file, image.start, image.end), 'IMG'),
      finding('button-name', markerFor(file, button.start, button.end), 'BUTTON'),
    ], {})
    const alt = issues.find((issue) => issue.ruleId === 'image-alt')
    const name = issues.find((issue) => issue.ruleId === 'button-name')
    assert.equal(alt?.tab, 'manual')
    assert.equal(name?.tab, 'manual')
    assert.deepEqual(alt?.edits, [])
    assert.deepEqual(name?.edits, [])
    assert.equal(alt?.sourceText?.includes('alt='), false)
    assert.equal(name?.sourceText?.includes('aria-label'), false)
  } finally {
    project.cleanup()
  }
})

test('an unknown rule and an unmapped node stay ambiguous', () => {
  const source = '<template><button type="button">Дальше</button></template>\n'
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const button = locateTag(project.root, file, 'button')
    const issues = classifyFindings(project.root, [
      finding('color-contrast', markerFor(file, button.start, button.end), 'BUTTON'),
      finding('button-name', null, 'BUTTON'),
    ], {})
    const contrast = issues.find((issue) => issue.ruleId === 'color-contrast')
    const unmapped = issues.find((issue) => issue.reason === 'unmapped')
    assert.equal(contrast?.tab, 'ambiguous')
    assert.equal(contrast?.reason, 'unsupported-rule')
    assert.deepEqual(contrast?.edits, [])
    assert.equal(unmapped?.tab, 'ambiguous')
    assert.equal(unmapped?.file, undefined)
    assert.deepEqual(unmapped?.edits, [])
  } finally {
    project.cleanup()
  }
})

test('an incomplete non-quick result is omitted and repeated sources are not patched', () => {
  const source = `<template>
  <button v-for="row in rows" :key="row" class="row"></button>
</template>
`
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const button = locateTag(project.root, file, 'button', 'v-for')
    const marker = markerFor(file, button.start, button.end)
    const issues = classifyFindings(project.root, [
      finding('image-alt', marker, 'IMG', true),
      finding('button-name', marker, 'BUTTON'),
      finding('button-name', marker, 'BUTTON'),
    ], {})
    assert.equal(issues.some((issue) => issue.ruleId === 'image-alt'), false)
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.tab, 'ambiguous')
    assert.equal(issues[0]?.reason, 'multiple-instances')
    assert.equal(issues[0]?.sourceText?.includes('v-for'), true)
    assert.deepEqual(issues[0]?.edits, [])

    const once = classifyFindings(project.root, [
      finding('button-name', marker, 'BUTTON'),
    ], {})
    assert.equal(once[0]?.reason, 'repeated-source')
    assert.deepEqual(once[0]?.edits, [])
  } finally {
    project.cleanup()
  }
})

function finding(ruleId: string, marker: string | null, tag: string, incomplete = false): Finding {
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
    incomplete,
  }
}

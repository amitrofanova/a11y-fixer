import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadParsers, locateMarker } from '../../src/core/source'
import { createVueProject, locateTag, markerFor } from '../support/vueProject'

test('locateMarker accepts the AST range and rejects a similar string elsewhere', () => {
  const button = '<button tabindex="3">Дальше</button>'
  const source = `<script setup>\nconst sample = '${button}'\n</script>\n<template>\n  ${button}\n</template>\n`
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const located = locateTag(project.root, file, 'button', 'tabindex="3"')
    assert.equal(located.file, path.normalize(file))
    assert.equal(located.text, button)
    assert.equal(located.text, located.source.slice(located.start, located.end))
    assert.equal(located.text.startsWith('<'), true)
    assert.equal(located.repeated, false)

    const parsers = loadParsers(project.root)
    assert.ok(parsers)
    const decoyStart = source.indexOf(button)
    const decoy = locateMarker(project.root, markerFor(file, decoyStart, decoyStart + button.length), parsers, {})
    assert.equal(decoy, null)

    const outside = locateMarker(
      project.root,
      markerFor(path.join(os.tmpdir(), 'a11y-not-in-project.vue'), 0, button.length),
      parsers,
      {},
    )
    assert.equal(outside, null)
  } finally {
    project.cleanup()
  }
})

test('locateMarker marks a button inside v-for as repeated', () => {
  const source = `<template>
  <ul>
    <li v-for="row in rows" :key="row">
      <button tabindex="3">Дальше</button>
    </li>
  </ul>
</template>
`
  const project = createVueProject({ 'src/App.vue': source })
  const file = path.join(project.root, 'src/App.vue')
  try {
    const located = locateTag(project.root, file, 'button')
    assert.equal(located.repeated, true)
    assert.equal(located.text.startsWith('<button'), true)
  } finally {
    project.cleanup()
  }
})

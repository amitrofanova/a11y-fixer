import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRange, rewriteViewportContent } from '../../src/core/source'

test('viewport content drops zoom restrictions and keeps an already usable value', () => {
  assert.equal(
    rewriteViewportContent('width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
    'width=device-width, initial-scale=1',
  )
  assert.equal(rewriteViewportContent('maximum-scale=4'), '')
  assert.equal(rewriteViewportContent('width=device-width, maximum-scale=5'), null)
  assert.equal(rewriteViewportContent('width=device-width, initial-scale=1'), null)
})

test('resolveRange keeps an exact hit and snaps a shifted tag back to that tag', () => {
  const element = '<button class="empty"></button>'
  const shifted = resolveRange(`on>${element}`, 0, element)
  assert.ok(shifted)
  assert.equal(`on>${element}`.slice(shifted.start, shifted.end), element)
  assert.equal(`on>${element}`[shifted.start], '<')

  const exact = resolveRange(element, 0, element)
  assert.deepEqual(exact, { start: 0, end: element.length })
})

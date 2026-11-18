import assert from 'node:assert/strict'
import test from 'node:test'
import { languageOf, reasonText } from '../../src/i18n'

test('the interface language follows a Russian locale and falls back to English', () => {
  assert.equal(languageOf('ru'), 'ru')
  assert.equal(languageOf('ru-RU'), 'ru')
  assert.equal(languageOf('RU'), 'ru')
  assert.equal(languageOf('en'), 'en')
  assert.equal(languageOf('en-US'), 'en')
  assert.equal(languageOf('de'), 'en')
  assert.match(reasonText('ru', 'fallthrough'), /родител/)
  assert.match(reasonText('ru', 'dynamic-content'), /выражен/)
  assert.match(reasonText('ru', 'opaque-content'), /v-html/)
  assert.match(reasonText('ru', 'unresolved-label'), /статическ/)
  assert.match(reasonText('en', 'opaque-content'), /v-html/)
})

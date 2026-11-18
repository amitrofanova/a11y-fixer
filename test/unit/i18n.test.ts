import assert from 'node:assert/strict'
import test from 'node:test'
import { languageOf } from '../../src/i18n'

test('the interface language follows a Russian locale and falls back to English', () => {
  assert.equal(languageOf('ru'), 'ru')
  assert.equal(languageOf('ru-RU'), 'ru')
  assert.equal(languageOf('RU'), 'ru')
  assert.equal(languageOf('en'), 'en')
  assert.equal(languageOf('en-US'), 'en')
  assert.equal(languageOf('de'), 'en')
})

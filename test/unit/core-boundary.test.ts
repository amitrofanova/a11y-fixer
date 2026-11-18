import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { repoRootFrom } from '../support/repo'

test('core modules do not import the VS Code API', () => {
  const core = path.join(repoRootFrom(__dirname), 'src', 'core')
  const files = walk(core)
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /from ['"]vscode['"]/, file)
    assert.doesNotMatch(source, /require\(['"]vscode['"]\)/, file)
  }
})

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

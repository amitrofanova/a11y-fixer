import { createRequire } from 'node:module'
import path from 'node:path'
import { repoRootFrom } from './repo'

export function loadProduct<T>(compiledPath: string): T {
  const root = repoRootFrom(__dirname)
  const require = createRequire(path.join(root, 'package.json'))
  return require(path.join(root, 'out', compiledPath)) as T
}

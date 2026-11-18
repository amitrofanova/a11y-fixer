import fs from 'node:fs'
import path from 'node:path'

export function repoRootFrom(start: string): string {
  let dir = start
  while (true) {
    const pkgPath = path.join(dir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string }
        if (json.name === 'a11y-fixer') return dir
      } catch {
        // A directory can contain an unreadable package.json while the repo root is higher.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('repo root not found')
    dir = parent
  }
}

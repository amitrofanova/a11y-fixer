import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SKIPPED = new Set(['node_modules', 'dist', '.nuxt', '.output'])

export interface CopiedProject {
  root: string
  cleanup: () => void
}

export function copyProject(source: string, prefix: string): CopiedProject {
  const modules = path.join(source, 'node_modules')
  if (!fs.existsSync(modules)) throw new Error(`missing dependencies: ${modules}`)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.cpSync(source, root, {
    recursive: true,
    filter: (from) => {
      const relative = path.relative(source, from)
      if (!relative) return true
      return !SKIPPED.has(relative.split(path.sep)[0])
    },
  })
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir')
  return {
    root,
    cleanup() {
      const link = path.join(root, 'node_modules')
      if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadParsers, locateMarker, type Prepared } from '../../src/core/source'
import { repoRootFrom } from './repo'

interface AstNode {
  tag?: string
  loc?: { start: { offset: number }; end: { offset: number } }
  children?: AstNode[]
}

export interface VueProject {
  root: string
  cleanup: () => void
}

export function createVueProject(files: Record<string, string>): VueProject {
  const modules = path.join(repoRootFrom(__dirname), 'demo', 'node_modules')
  if (!fs.existsSync(path.join(modules, '@vue', 'compiler-sfc', 'package.json'))) {
    throw new Error('demo dependencies are missing. Run npm --prefix demo install')
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-vue-'))
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ name: 'a11y-vue-fixture', private: true })}\n`)
  fs.symlinkSync(modules, path.join(root, 'node_modules'), 'dir')
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return {
    root,
    cleanup() {
      fs.unlinkSync(path.join(root, 'node_modules'))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export function markerFor(file: string, start: number, end: number): string {
  return `${start}:${end}:${encodeURIComponent(file)}`
}

export function locateTag(projectRoot: string, file: string, tag: string, sourceIncludes?: string): Prepared {
  const parsers = loadParsers(projectRoot)
  if (!parsers) throw new Error('Vue compiler was not loaded from the fixture project')
  const source = fs.readFileSync(file, 'utf8')
  const ast = parsers.parse(source, { filename: file }).descriptor.template?.ast as AstNode | undefined
  const node = findTag(ast, tag, source, sourceIncludes)
  if (!node?.loc) throw new Error(`tag ${tag} was not found in the template AST`)
  const located = locateMarker(
    projectRoot,
    markerFor(file, node.loc.start.offset, node.loc.end.offset),
    parsers,
    {},
  )
  if (!located) throw new Error(`exact AST marker for ${tag} was rejected`)
  return located
}

function findTag(node: AstNode | undefined, tag: string, source: string, sourceIncludes?: string): AstNode | null {
  if (!node) return null
  if (node.tag === tag && node.loc) {
    const text = source.slice(node.loc.start.offset, node.loc.end.offset)
    if (!sourceIncludes || text.includes(sourceIncludes)) return node
  }
  for (const child of node.children ?? []) {
    const found = findTag(child, tag, source, sourceIncludes)
    if (found) return found
  }
  return null
}

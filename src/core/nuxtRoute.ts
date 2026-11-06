import fs from 'node:fs'
import path from 'node:path'
import { loadParsers } from './source'

const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', 'dist', 'build', '.git'])

type Token =
  | { kind: 'static'; text: string }
  | { kind: 'param'; optional: boolean }
  | { kind: 'catch'; optional: boolean }

export interface PagePlan {
  file: string
  dynamic: boolean
  staticPath: string | null
  parentPath: string
  matches(pathname: string): boolean
}

export function planPageRoute(projectRoot: string, target: string | null): PagePlan | null {
  if (!target || !target.endsWith('.vue')) return null
  const pagesDir = pagesDirectory(projectRoot, target)
  if (!pagesDir) return null
  const relative = path.relative(pagesDir, path.resolve(target))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  const tokens = routeTokens(relative)
  if (!tokens) return null
  const dynamic = tokens.some((token) => token.kind !== 'static')
  const staticTokens = leadingStatic(tokens)
  return {
    file: path.resolve(target),
    dynamic,
    staticPath: dynamic ? null : joinPath(tokens),
    parentPath: joinPath(staticTokens),
    matches(pathname: string) {
      return matchTokens(splitPath(pathname), tokens)
    },
  }
}

export function joinUrl(origin: string, routePath: string): string {
  const base = origin.endsWith('/') ? origin : `${origin}/`
  return new URL(routePath.replace(/^\//, ''), base).href
}

export function routePathname(pageUrl: string, origin: string): string {
  return stripBase(new URL(pageUrl).pathname, origin)
}

export function candidatePaths(hrefs: string[], current: string, origin: string, plan: PagePlan): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const href of hrefs) {
    const pathname = pathnameOf(href, current)
    if (!pathname) continue
    const route = stripBase(pathname, origin)
    if (!plan.matches(route) || seen.has(route)) continue
    seen.add(route)
    found.push(route)
  }
  return found
}

export function scanProjectLinks(projectRoot: string, plan: PagePlan): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  let read = 0
  const visit = (directory: string) => {
    if (found.length >= 20 || read >= 4000) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 20 || read >= 4000) return
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.vue')) continue
      read += 1
      let source = ''
      try {
        if (fs.statSync(full).size > 1024 * 1024) continue
        source = fs.readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const match of source.matchAll(/['"`](\/[^'"`\s?#]+)['"`]/g)) {
        const pathname = normalizePathname(match[1])
        if (!plan.matches(pathname) || seen.has(pathname)) continue
        seen.add(pathname)
        found.push(pathname)
      }
    }
  }
  visit(projectRoot)
  return found
}

export function markerFile(marker: string | null): string | null {
  const match = /^(\d+):(\d+):(.*)$/.exec(marker ?? '')
  if (!match) return null
  try {
    return path.normalize(decodeURIComponent(match[3]))
  } catch {
    return null
  }
}

export function requiresMarker(projectRoot: string, file: string): boolean {
  const parsers = loadParsers(projectRoot)
  if (!parsers) return true
  let source = ''
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    return true
  }
  const ast = parsers.parse(source, { filename: file }).descriptor.template?.ast as {
    type?: number
    tagType?: number
    children?: unknown[]
  } | undefined
  return hasNative(ast, parsers.element, parsers.native)
}

function hasNative(node: { type?: number; tagType?: number; children?: unknown[] } | undefined, element: number, native: number): boolean {
  if (!node) return false
  if (node.type === element && node.tagType === native) return true
  if (!Array.isArray(node.children)) return false
  return node.children.some((child) => hasNative(child as { type?: number; tagType?: number; children?: unknown[] }, element, native))
}

function pagesDirectory(projectRoot: string, file: string): string | null {
  const resolved = path.resolve(file)
  for (const relative of ['app/pages', 'pages']) {
    const dir = path.join(projectRoot, relative)
    if (resolved === dir || resolved.startsWith(dir + path.sep)) return dir
  }
  return null
}

function routeTokens(relative: string): Token[] | null {
  const parsed = path.parse(relative)
  if (parsed.ext !== '.vue') return null
  const directories = parsed.dir ? parsed.dir.split(path.sep) : []
  const tokens: Token[] = []
  for (const directory of directories) {
    for (const part of splitName(directory)) {
      const token = parseSegment(part)
      if (token) tokens.push(token)
    }
  }
  if (parsed.name !== 'index') {
    for (const part of splitName(parsed.name)) {
      const token = parseSegment(part)
      if (token) tokens.push(token)
    }
  }
  if (tokens.some((token, index) => token.kind === 'catch' && index !== tokens.length - 1)) return null
  return tokens
}

function splitName(name: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (const character of name) {
    if (character === '[') depth += 1
    if (character === ']') depth = Math.max(0, depth - 1)
    if (character === '.' && depth === 0) {
      if (current) parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current) parts.push(current)
  return parts
}

function parseSegment(segment: string): Token | null {
  if (segment.startsWith('(') && segment.endsWith(')')) return null
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) return { kind: 'catch', optional: true }
  if (/^\[\.\.\..+\]$/.test(segment)) return { kind: 'catch', optional: false }
  if (/^\[\[.+\]\]$/.test(segment)) return { kind: 'param', optional: true }
  if (/^\[.+\]$/.test(segment)) return { kind: 'param', optional: false }
  return { kind: 'static', text: segment }
}

function leadingStatic(tokens: Token[]): Token[] {
  const found: Token[] = []
  for (const token of tokens) {
    if (token.kind !== 'static') break
    found.push(token)
  }
  return found
}

function joinPath(tokens: Token[]): string {
  const staticTokens = tokens.filter((token): token is { kind: 'static'; text: string } => token.kind === 'static')
  if (staticTokens.length === 0) return '/'
  return `/${staticTokens.map((token) => token.text).join('/')}`
}

function splitPath(pathname: string): string[] {
  return normalizePathname(pathname).split('/').filter(Boolean)
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1)
  return pathname || '/'
}

function stripBase(pathname: string, base: string): string {
  const prefix = new URL(base).pathname.replace(/\/$/, '')
  let route = pathname
  if (prefix && (route === prefix || route.startsWith(`${prefix}/`))) route = route.slice(prefix.length) || '/'
  if (!route.startsWith('/')) route = `/${route}`
  return normalizePathname(route)
}

function pathnameOf(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    if (url.origin !== new URL(base).origin) return null
    return normalizePathname(url.pathname)
  } catch {
    return null
  }
}

function matchTokens(parts: string[], tokens: Token[], index = 0, partIndex = 0): boolean {
  if (index === tokens.length) return partIndex === parts.length
  const token = tokens[index]
  if (token.kind === 'catch') {
    if (!token.optional && partIndex >= parts.length) return false
    return index === tokens.length - 1
  }
  if (token.kind === 'param' && token.optional) {
    if (matchTokens(parts, tokens, index + 1, partIndex)) return true
    if (partIndex >= parts.length) return false
    return matchTokens(parts, tokens, index + 1, partIndex + 1)
  }
  if (partIndex >= parts.length) return false
  if (token.kind === 'static' && parts[partIndex] !== token.text) return false
  return matchTokens(parts, tokens, index + 1, partIndex + 1)
}

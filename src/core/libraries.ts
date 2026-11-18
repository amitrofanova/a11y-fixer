import fs from 'node:fs'
import path from 'node:path'
import { EXCLUDED_DIR_NAMES } from './apply'
import { loadParsers } from './source'

export type LibraryId = 'vuetify' | 'quasar' | 'nuxt-ui'

export interface LibraryMatch {
  library: LibraryId
  kind: 'button' | 'image'
  forwardsTabindex: boolean
}

const RELEASES: Record<LibraryId, { name: string; version: string }> = {
  vuetify: { name: 'vuetify', version: '3.13.7' },
  quasar: { name: 'quasar', version: '2.35.5' },
  'nuxt-ui': { name: '@nuxt/ui', version: '4.12.2' },
}

const CATALOG: Record<string, LibraryMatch> = {
  vbtn: { library: 'vuetify', kind: 'button', forwardsTabindex: true },
  vimg: { library: 'vuetify', kind: 'image', forwardsTabindex: false },
  qbtn: { library: 'quasar', kind: 'button', forwardsTabindex: true },
  qimg: { library: 'quasar', kind: 'image', forwardsTabindex: false },
  ubutton: { library: 'nuxt-ui', kind: 'button', forwardsTabindex: false },
}

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']
const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts']
const QUASAR_CONFIGS = ['quasar.config.ts', 'quasar.config.js', 'quasar.config.mjs', 'quasar.config.cjs']

interface Binding {
  library: LibraryId | null
  imported: string
}

interface BabelSpecifier {
  type?: string
  importKind?: string
  local?: { name?: string }
  imported?: { name?: string }
}

interface BabelStatement {
  type?: string
  importKind?: string
  source?: { value?: unknown }
  specifiers?: BabelSpecifier[]
}

const shadows = new Map<string, Map<string, string[]>>()
const compiled = new Map<string, { mtimeMs: number; match: (tag: string) => LibraryMatch | null }>()

export function resetLibraryScan(): void {
  shadows.clear()
  compiled.clear()
}

export function resolveLibraryTag(projectRoot: string, file: string, tag: string, scripts: string[]): LibraryMatch | null {
  const parsers = loadParsers(projectRoot)
  if (!parsers) return null
  const bindings = readBindings(scripts, parsers.babelParse)
  if (!bindings) return null
  return matchTag(projectRoot, file, tag, bindings)
}

export function libraryMatchForTemplateTag(filename: string, tag: string): boolean {
  const file = path.resolve(filename.split('?')[0] ?? filename)
  if (file.split(path.sep).includes('node_modules')) return false
  let stamp = 0
  try {
    stamp = fs.statSync(file).mtimeMs
  } catch {
    return false
  }
  const cached = compiled.get(file)
  const ready = cached && cached.mtimeMs === stamp ? cached : { mtimeMs: stamp, match: compileFile(file) }
  if (ready !== cached) compiled.set(file, ready)
  return ready.match(tag) !== null
}

function compileFile(file: string): (tag: string) => LibraryMatch | null {
  const root = nearestPackage(file)
  if (!root) return () => null
  const parsers = loadParsers(root)
  if (!parsers) return () => null
  let source = ''
  try {
    source = fs.readFileSync(file, 'utf8')
  } catch {
    return () => null
  }
  let scripts: string[]
  try {
    const parsed = parsers.parse(source, { filename: file })
    scripts = [parsed.descriptor.script?.content ?? '', parsed.descriptor.scriptSetup?.content ?? ''].filter((item) => item.length > 0)
  } catch {
    return () => null
  }
  const bindings = readBindings(scripts, parsers.babelParse)
  if (!bindings) return () => null
  return (tag) => matchTag(root, file, tag, bindings)
}

function matchTag(projectRoot: string, file: string, tag: string, bindings: Map<string, Binding>): LibraryMatch | null {
  const key = normalizeComponentName(tag)
  const binding = bindings.get(key)
  if (binding) {
    if (!binding.library) return null
    const spec = CATALOG[binding.imported]
    if (!spec || spec.library !== binding.library) return null
    return installed(projectRoot, spec.library) ? spec : null
  }
  const spec = CATALOG[key]
  if (!spec || !installed(projectRoot, spec.library)) return null
  if (shadowed(projectRoot, file, key)) return null
  if (!autoImported(projectRoot, spec.library) || !autoImportCaseAllows(projectRoot, spec.library, tag)) return null
  return spec
}

function readBindings(
  scripts: string[],
  parse: (source: string, options: { sourceType: 'module'; plugins: string[] }) => { program: { body: unknown[] } },
): Map<string, Binding> | null {
  const bindings = new Map<string, Binding>()
  for (const source of scripts) {
    let body: unknown[]
    try {
      body = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program.body
    } catch {
      return null
    }
    for (const item of body) {
      const statement = item as BabelStatement
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
      const importedFrom = statement.source?.value
      if (typeof importedFrom !== 'string') continue
      const library = libraryOfSource(importedFrom)
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.importKind === 'type' || specifier.type === 'ImportNamespaceSpecifier') continue
        const local = specifier.local?.name
        if (!local) continue
        const imported = specifier.type === 'ImportDefaultSpecifier'
          ? defaultImportedName(importedFrom)
          : specifier.imported?.name
        if (!imported) continue
        bindings.set(normalizeComponentName(local), { library, imported: normalizeComponentName(imported) })
      }
    }
  }
  return bindings
}

function libraryOfSource(source: string): LibraryId | null {
  if (source === 'vuetify' || source.startsWith('vuetify/')) return 'vuetify'
  if (source === 'quasar' || source.startsWith('quasar/')) return 'quasar'
  if (source === '@nuxt/ui' || source.startsWith('@nuxt/ui/')) return 'nuxt-ui'
  return null
}

function defaultImportedName(source: string): string {
  const base = source.split('/').pop() ?? ''
  return base.replace(/\.(vue|js|mjs|ts|tsx|jsx)$/i, '')
}

function installed(projectRoot: string, library: LibraryId): boolean {
  const release = RELEASES[library]
  const file = path.join(projectRoot, 'node_modules', ...release.name.split('/'), 'package.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }
    return parsed.version === release.version
  } catch {
    return false
  }
}

function autoImported(projectRoot: string, library: LibraryId): boolean {
  const vite = readConfigs(projectRoot, VITE_CONFIGS)
  const nuxt = readConfigs(projectRoot, NUXT_CONFIGS)
  if (library === 'vuetify') {
    if (vite.includes('vite-plugin-vuetify') && !/autoImport\s*:\s*false/.test(vite)) return true
    return nuxt.includes('vuetify-nuxt-module')
  }
  if (library === 'quasar') {
    if (vite.includes('@quasar/vite-plugin') && !/astAutoImport\s*:\s*false/.test(vite)) return true
    if (QUASAR_CONFIGS.some((name) => fs.existsSync(path.join(projectRoot, name)))) return true
    return nuxt.includes('nuxt-quasar-ui')
  }
  if (nuxt.includes('@nuxt/ui') && !/components\s*:\s*false/.test(nuxt)) return true
  return vite.includes('@nuxt/ui/vite') && !/components\s*:\s*false/.test(vite)
}

function autoImportCaseAllows(projectRoot: string, library: LibraryId, tag: string): boolean {
  if (library !== 'quasar') return true
  const vite = readConfigs(projectRoot, VITE_CONFIGS)
  const declared = /autoImportComponentCase\s*:\s*['"](kebab|pascal|combined)['"]/.exec(vite)?.[1]
  const mode = declared === 'kebab' || declared === 'pascal' || declared === 'combined'
    ? declared
    : vite.includes('@quasar/vite-plugin')
      ? 'kebab'
      : 'combined'
  const pascalForm = /[A-Z]/.test(tag) && !tag.includes('-')
  if (mode === 'combined') return true
  if (mode === 'pascal') return pascalForm
  return !pascalForm
}

function readConfigs(projectRoot: string, names: string[]): string {
  return names.map((name) => {
    try {
      return fs.readFileSync(path.join(projectRoot, name), 'utf8')
    } catch {
      return ''
    }
  }).join('\n')
}

function shadowed(projectRoot: string, file: string, key: string): boolean {
  const names = localComponents(projectRoot)
  const files = names.get(key) ?? []
  const current = path.resolve(file)
  return files.some((item) => path.resolve(item) !== current)
}

function localComponents(projectRoot: string): Map<string, string[]> {
  const root = path.resolve(projectRoot)
  const cached = shadows.get(root)
  if (cached) return cached
  const found = new Map<string, string[]>()
  const visit = (directory: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if ((EXCLUDED_DIR_NAMES as readonly string[]).includes(entry.name)) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.vue')) continue
      const stem = entry.name.slice(0, -'.vue'.length)
      const key = stem.toLowerCase() === 'index'
        ? normalizeComponentName(path.basename(directory))
        : normalizeComponentName(stem)
      const list = found.get(key) ?? []
      list.push(full)
      found.set(key, list)
    }
  }
  visit(root)
  shadows.set(root, found)
  return found
}

function nearestPackage(file: string): string | null {
  let directory = path.dirname(path.resolve(file))
  while (true) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function normalizeComponentName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

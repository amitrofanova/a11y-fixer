export const EXCLUDED_DIR_NAMES = ['node_modules', 'dist', 'build', '.git', '.nuxt', '.output'] as const

export function resolveExcludedDirectories(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [...EXCLUDED_DIR_NAMES]
  const names: string[] = []
  let valid = 0
  let invalid = 0
  for (const item of value) {
    if (typeof item !== 'string') {
      invalid += 1
      continue
    }
    const name = item.trim()
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      invalid += 1
      continue
    }
    valid += 1
    if (!names.includes(name)) names.push(name)
  }
  if (valid === 0 && invalid > 0) return [...EXCLUDED_DIR_NAMES]
  return names
}

export function excludedNames(configured?: readonly string[]): readonly string[] {
  return configured ?? EXCLUDED_DIR_NAMES
}

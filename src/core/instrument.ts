export const SOURCE_ATTR = 'data-a11y-source-id'

export function instrumentPlugin(onUnavailable: () => void) {
  const transform = (node: {
    type?: number
    tagType?: number
    loc?: { start: { offset: number }; end: { offset: number } }
    props?: Array<{ type?: number; name?: string }>
  }, context: { filename: string }) => {
    if (node.type !== 1 || node.tagType !== 0 || !node.loc) return
    const name = SOURCE_ATTR
    if (node.props?.some((prop) => prop.type === 6 && prop.name === name)) return
    node.props?.push({
      type: 6,
      name,
      nameLoc: node.loc,
      value: {
        type: 2,
        content: `${node.loc.start.offset}:${node.loc.end.offset}:${encodeURIComponent(context.filename)}`,
        loc: node.loc,
      },
      loc: node.loc,
    } as never)
  }
  return {
    name: 'a11y-fixer',
    enforce: 'pre' as const,
    config(config: { plugins?: unknown }) {
      const vuePlugin = flatten(config.plugins).find((plugin) => plugin?.name === 'vite:vue') as {
        api?: { options?: { template?: { compilerOptions?: { nodeTransforms?: unknown[] } } } }
      } | undefined
      if (!vuePlugin?.api?.options) {
        onUnavailable()
        return
      }
      const options = vuePlugin.api.options
      const template = (options.template ??= {})
      const compilerOptions = (template.compilerOptions ??= {})
      const existing = compilerOptions.nodeTransforms ?? []
      if (!existing.includes(transform)) compilerOptions.nodeTransforms = [...existing, transform]
    },
  }
}

export function flatten(plugins: unknown, out: Array<{ name?: string }> = []): Array<{ name?: string }> {
  if (!Array.isArray(plugins)) return out
  for (const plugin of plugins) {
    if (!plugin) continue
    if (Array.isArray(plugin)) flatten(plugin, out)
    else out.push(plugin as { name?: string })
  }
  return out
}

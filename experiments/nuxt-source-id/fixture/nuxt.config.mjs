const USER_ATTR = 'data-poc-user'

function userTransform(node) {
  if (node.type !== 1 || node.tagType !== 0) return
  node.props = node.props || []
  if (node.props.some((prop) => prop.type === 6 && prop.name === USER_ATTR)) return
  node.props.push({
    type: 6,
    name: USER_ATTR,
    nameLoc: node.loc,
    value: { type: 2, content: '1', loc: node.loc },
    loc: node.loc,
  })
}

export default {
  srcDir: '.',
  ssr: true,
  compatibilityDate: '2026-11-06',
  devtools: { enabled: false },
  devServer: {
    host: '127.0.0.1',
    port: Number(process.env.A11Y_PORT),
  },
  modules: ['./a11y-module.mjs'],
  vite: {
    vue: {
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'my-widget',
          nodeTransforms: [userTransform],
        },
      },
    },
  },
}

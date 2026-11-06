import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const ELEMENT = 1
const TEXT = 2
const ATTRIBUTE = 6

function addAttribute(node, name, content) {
  const exists = node.props?.some(
    (prop) => prop.type === ATTRIBUTE && prop.name === name,
  )
  if (exists) return
  node.props.push({
    type: ATTRIBUTE,
    name,
    nameLoc: node.loc,
    value: {
      type: TEXT,
      content,
      loc: node.loc,
    },
    loc: node.loc,
  })
}

export default defineConfig({
  plugins: [
    vue({
      template: {
        transformAssetUrls: false,
        compilerOptions: {
          nodeTransforms: [
            (node) => {
              if (node.type !== ELEMENT || node.tag !== 'main') return
              addAttribute(node, 'data-user-transform', 'yes')
            },
          ],
        },
      },
    }),
  ],
})

import fs from 'node:fs'
import { createRequire } from 'node:module'
import { defineNuxtModule } from '@nuxt/kit'

const require = createRequire(import.meta.url)
const { flatten, instrumentPlugin } = require(process.env.A11Y_INSTRUMENT)

function readNotes() {
  try {
    return JSON.parse(fs.readFileSync(process.env.A11Y_NOTES, 'utf8'))
  } catch {
    return { mappingEnabled: true, extends: [], viteEnvironmentApi: null }
  }
}

function writeNotes(notes) {
  fs.writeFileSync(process.env.A11Y_NOTES, JSON.stringify(notes))
}

export default defineNuxtModule({
  setup(_options, nuxt) {
    const notes = readNotes()
    notes.viteEnvironmentApi = Boolean(nuxt.options.experimental?.viteEnvironmentApi)
    writeNotes(notes)
    nuxt.hook('vite:extendConfig', (config) => {
      const current = readNotes()
      const plugins = config.plugins || (config.plugins = [])
      const flat = flatten(plugins)
      current.extends.push({
        vuePlugins: flat.filter((plugin) => plugin?.name === 'vite:vue').length,
      })
      writeNotes(current)
      if (flat.some((plugin) => plugin?.name === 'a11y-fixer')) return
      plugins.push(instrumentPlugin(() => {
        const next = readNotes()
        next.mappingEnabled = false
        writeNotes(next)
      }))
    })
  },
})

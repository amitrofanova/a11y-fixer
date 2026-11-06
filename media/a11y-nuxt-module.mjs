import fs from 'node:fs'
import { createRequire } from 'node:module'
import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  setup(_options, nuxt) {
    const instrumentPath = process.env.A11Y_INSTRUMENT
    const notesPath = process.env.A11Y_NOTES
    if (!instrumentPath || !notesPath) return
    const { flatten, instrumentPlugin } = createRequire(import.meta.url)(instrumentPath)
    const notes = readNotes(notesPath)
    notes.mappingEnabled = true
    writeNotes(notesPath, notes)
    nuxt.hook('vite:extendConfig', (config) => {
      const plugins = config.plugins || (config.plugins = [])
      const flat = flatten(plugins)
      if (flat.some((plugin) => plugin?.name === 'a11y-fixer')) return
      plugins.push(instrumentPlugin(() => {
        const next = readNotes(notesPath)
        next.mappingEnabled = false
        writeNotes(notesPath, next)
      }))
    })
  },
})

function readNotes(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { mappingEnabled: true }
  }
}

function writeNotes(file, notes) {
  fs.writeFileSync(file, JSON.stringify(notes))
}

import fs from 'node:fs'
import path from 'node:path'
import { findViteConfig } from './viteHost'

const NUXT_CONFIGS = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts', 'nuxt.config.cjs', 'nuxt.config.cts']

export interface DetectedProject {
  kind: 'vite' | 'nuxt'
  configFile: string
}

export function detectProject(projectRoot: string): DetectedProject | null {
  for (const name of NUXT_CONFIGS) {
    const file = path.join(projectRoot, name)
    if (fs.existsSync(file)) return { kind: 'nuxt', configFile: file }
  }
  const vite = findViteConfig(projectRoot)
  if (!vite) return null
  return { kind: 'vite', configFile: vite }
}

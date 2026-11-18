import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium, type Browser, type Page } from 'playwright-core'
import { classifyFindings } from './classify'
import { SOURCE_ATTR } from './instrument'
import { startNuxtApp } from './nuxtHost'
import { candidatePaths, joinUrl, markerFile, planPageRoute, requiresMarker, routePathname, scanProjectLinks } from './nuxtRoute'
import { detectProject } from './project'
import { startViteApp, type AppHandle } from './viteHost'
import type { AuditOutcome, Finding } from './types'

export { findViteConfig } from './viteHost'

export interface Session {
  projectRoot: string
  app?: AppHandle
  browser?: Browser
  page?: Page
  url?: string
  mappingEnabled: boolean
  auditTarget?: string | null
  chromePaths?: readonly string[]
}

export async function auditProject(session: Session, locale: 'ru' | 'en'): Promise<AuditOutcome> {
  if (!session.page && browserCandidates(session).length === 0) throw new Error('NO_CHROME')
  const app = await ensureApp(session)
  let page: Page
  try {
    page = await ensurePage(session)
  } catch (error) {
    await releaseApp(session)
    throw error
  }
  if (!session.url) throw new Error('NO_PORT')
  app.invalidate()
  await openTarget(session, page, app)
  await page.addScriptTag({ path: axePath() })
  const localeData = locale === 'ru' ? readAxeLocale() : null
  const findings = await page.evaluate(collectFindings, { locale: localeData, attribute: SOURCE_ATTR })
  const files: Record<string, string> = {}
  const issues = classifyFindings(session.projectRoot, findings, files, app.documentShell)
  return {
    url: page.url(),
    mappingEnabled: session.mappingEnabled,
    issues,
    files,
  }
}

export async function closeSession(session: Session): Promise<void> {
  await session.page?.close().catch(() => undefined)
  await session.browser?.close().catch(() => undefined)
  await session.app?.close().catch(() => undefined)
  session.page = undefined
  session.browser = undefined
  session.app = undefined
  session.url = undefined
  session.mappingEnabled = false
}

async function openApp(page: Page, url: string, readySelector: string, timeout: number): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      await page.waitForSelector(readySelector, { timeout })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  throw lastError
}

async function openTarget(session: Session, page: Page, app: AppHandle): Promise<void> {
  const plan = app.kind === 'nuxt' ? planPageRoute(session.projectRoot, session.auditTarget ?? null) : null
  const first = !plan
    ? app.url
    : joinUrl(app.url, plan.staticPath ?? plan.parentPath)
  await openApp(page, first, app.readySelector, app.navigationTimeout)
  if (!plan) return
  if (!plan.dynamic) {
    if (app.mappingEnabled) await assertRendered(session.projectRoot, page, plan.file)
    return
  }
  if (await acceptable(session.projectRoot, page, plan, app)) return
  const hrefs = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''))
  const candidates = [...candidatePaths(hrefs, page.url(), app.url, plan), ...scanProjectLinks(session.projectRoot, plan)]
  const seen = new Set<string>()
  let opened = false
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (seen.size > 8) break
    await openApp(page, joinUrl(app.url, candidate), app.readySelector, app.navigationTimeout)
    opened = true
    if (await acceptable(session.projectRoot, page, plan, app)) return
  }
  if (!opened) throw new Error('NO_ROUTE')
  throw new Error('PAGE_NOT_RENDERED')
}

async function acceptable(projectRoot: string, page: Page, plan: NonNullable<ReturnType<typeof planPageRoute>>, app: AppHandle): Promise<boolean> {
  if (!plan.matches(routePathname(page.url(), app.url))) return false
  if (!app.mappingEnabled || !requiresMarker(projectRoot, plan.file)) return true
  return pageShowsFile(page, plan.file)
}

async function assertRendered(projectRoot: string, page: Page, file: string): Promise<void> {
  if (!requiresMarker(projectRoot, file)) return
  if (!await pageShowsFile(page, file)) throw new Error('PAGE_NOT_RENDERED')
}

async function pageShowsFile(page: Page, file: string): Promise<boolean> {
  const markers = await page.locator(`[${SOURCE_ATTR}]`).evaluateAll((nodes, attribute) => {
    return nodes.map((node) => node.getAttribute(String(attribute)) ?? '')
  }, SOURCE_ATTR)
  const expected = path.resolve(file)
  return markers.some((marker) => {
    const found = markerFile(marker)
    return found !== null && path.resolve(found) === expected
  })
}

async function ensureApp(session: Session): Promise<AppHandle> {
  if (session.app) return session.app
  const detected = detectProject(session.projectRoot)
  if (!detected) throw new Error('NO_VITE_CONFIG')
  const app = detected.kind === 'nuxt'
    ? await startNuxtApp(session.projectRoot)
    : await startViteApp(session.projectRoot, detected.configFile)
  session.app = app
  session.url = app.url
  session.mappingEnabled = app.mappingEnabled
  return app
}

async function ensurePage(session: Session): Promise<Page> {
  if (session.page) return session.page
  const candidates = browserCandidates(session)
  if (candidates.length === 0) throw new Error('NO_CHROME')
  let browser: Browser | undefined
  for (const executablePath of candidates) {
    try {
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
      })
      break
    } catch {
      browser = undefined
    }
  }
  if (!browser) throw new Error('NO_CHROME')
  try {
    session.browser = browser
    session.page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    return session.page
  } catch (error) {
    await browser.close().catch(() => undefined)
    session.browser = undefined
    session.page = undefined
    throw error
  }
}

export function findChrome(overrides?: { paths?: Array<string | undefined>; cacheDir?: string }): string[] {
  const paths = overrides?.paths ?? [
    process.env.CHROME_PATH,
    '/opt/google/chrome/chrome',
    '/opt/chromium-gost/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium-gost',
  ]
  const found = paths.filter((item): item is string => typeof item === 'string' && item.length > 0 && fs.existsSync(item))
  const cache = overrides?.cacheDir ?? path.join(os.homedir(), '.cache', 'ms-playwright')
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      const chrome = path.join(cache, entry, 'chrome-linux64', 'chrome')
      if (fs.existsSync(chrome)) found.push(chrome)
    }
  }
  return found
}

function browserCandidates(session: Session): string[] {
  if (session.chromePaths) return session.chromePaths.filter((item) => fs.existsSync(item))
  return findChrome()
}

async function releaseApp(session: Session): Promise<void> {
  await session.app?.close().catch(() => undefined)
  session.app = undefined
  session.url = undefined
}

function axePath(): string {
  return createRequire(__filename).resolve('axe-core')
}

function readAxeLocale(): unknown {
  const file = path.join(path.dirname(axePath()), 'locales', 'ru.json')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
}

export function collectFindings(argument: { locale: unknown; attribute: string }): Promise<Finding[]> {
  const axe = (globalThis as { axe?: {
    configure: (options: { locale: unknown }) => void
    run: (context: unknown, options: unknown) => Promise<{
      violations: RawResult[]
      incomplete: RawResult[]
    }>
  } }).axe
  if (!axe) return Promise.reject(new Error('AXE_MISSING'))
  if (argument.locale) axe.configure({ locale: argument.locale })
  const pageDocument = (globalThis as { document?: never }).document
  if (!pageDocument) return Promise.resolve([])
  return axe.run(pageDocument, { resultTypes: ['violations', 'incomplete'], elementRef: true }).then((result) => {
    const pack = (list: RawResult[], incomplete: boolean): Finding[] => list.flatMap((rule) => rule.nodes.map((node) => ({
      ruleId: rule.id,
      impact: rule.impact,
      description: rule.description,
      help: rule.help,
      helpUrl: rule.helpUrl,
      failureSummary: node.failureSummary ?? '',
      html: node.html,
      target: (node.target ?? []).map((item) => String(item)),
      marker: node.element?.getAttribute(argument.attribute) ?? null,
      tag: node.element?.tagName ?? '',
      checks: [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])].map((check) => ({
        id: check.id,
        data: plain(check.data),
      })),
      incomplete,
    })))
    return [...pack(result.violations, false), ...pack(result.incomplete, true)]
  })

  function plain(data: unknown): unknown {
    try {
      return JSON.parse(JSON.stringify(data)) as unknown
    } catch {
      return null
    }
  }
}

interface RawResult {
  id: string
  impact: string | null
  description: string
  help: string
  helpUrl: string
  nodes: Array<{
    html: string
    target?: unknown[]
    failureSummary?: string
    element?: { getAttribute(name: string): string | null; tagName: string }
    any?: Array<{ id: string; data: unknown }>
    all?: Array<{ id: string; data: unknown }>
    none?: Array<{ id: string; data: unknown }>
  }>
}

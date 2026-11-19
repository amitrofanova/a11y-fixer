import fs from 'node:fs'
import path from 'node:path'
import { finalizeIssues } from './classify'
import { planPageRoute, type PagePlan } from './nuxtRoute'
import { insideProject } from './source'
import { listVueFiles, type StaticAudit } from './static'
import type { AuditOutcome, Issue } from './types'

export interface AuditVisitPlan {
  path: string
  file: string | null
  plan: PagePlan | null
}

export function isStrictPage(target: string | null, visits: readonly AuditVisitPlan[]): boolean {
  return Boolean(target?.endsWith('.vue') && visits.length === 1 && visits[0]?.plan)
}

export function auditVisits(
  projectRoot: string,
  target: string | null,
  excluded: readonly string[] | undefined,
  nuxt: boolean,
): AuditVisitPlan[] {
  if (!nuxt) return [rootVisit()]
  if (target && target.endsWith('.vue')) {
    const plan = planPageRoute(projectRoot, target)
    if (!plan) return [rootVisit()]
    return [visitFromPlan(plan)]
  }
  const plans = vueFilesForAudit(projectRoot, target, excluded)
    .map((file) => planPageRoute(projectRoot, file))
    .filter((plan): plan is PagePlan => plan !== null)
  const staticPlans = plans
    .filter((plan) => !plan.dynamic && plan.staticPath)
    .sort((left, right) => (left.staticPath ?? '').localeCompare(right.staticPath ?? ''))
  const dynamicPlans = plans.filter((plan) => plan.dynamic)
  const visits: AuditVisitPlan[] = []
  const seen = new Set<string>()
  const coversRoot = plans.some((plan) => plan.staticPath === '/' || plan.matches('/'))
  if (scopeIncludesAppRoot(projectRoot, target) && !coversRoot) {
    visits.push(rootVisit())
    seen.add('/')
  }
  for (const plan of staticPlans) {
    const route = plan.staticPath ?? '/'
    if (seen.has(route)) continue
    seen.add(route)
    visits.push(visitFromPlan(plan))
  }
  for (const plan of dynamicPlans) visits.push(visitFromPlan(plan))
  if (visits.length === 0) visits.push(rootVisit())
  return visits
}

function visitFromPlan(plan: PagePlan): AuditVisitPlan {
  return { path: plan.staticPath ?? plan.parentPath, file: plan.file, plan }
}

function rootVisit(): AuditVisitPlan {
  return { path: '/', file: null, plan: null }
}

function scopeIncludesAppRoot(projectRoot: string, target: string | null): boolean {
  if (!target) return true
  const resolved = path.resolve(target)
  return [path.join(projectRoot, 'pages'), path.join(projectRoot, 'app', 'pages')].some((dir) => path.resolve(dir) === resolved)
}

export function vueFilesForAudit(
  projectRoot: string,
  target: string | null,
  excluded?: readonly string[],
): string[] {
  const root = path.resolve(projectRoot)
  if (!target) return listVueFiles(root, excluded)
  const resolved = path.resolve(target)
  if (!fs.existsSync(resolved)) return []
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) return listVueFiles(resolved, excluded).filter((file) => insideProject(root, file))
  if (stat.isFile() && resolved.endsWith('.vue') && insideProject(root, resolved)) return [resolved]
  return []
}

export function mergeAudits(
  dynamic: AuditOutcome,
  staticAudit: StaticAudit,
  renderedMarkers: readonly string[],
): AuditOutcome {
  const rendered = new Set<string>()
  for (const marker of renderedMarkers) {
    const range = markerRange(marker)
    if (range) rendered.add(range)
  }
  const dynamicGroups = group(dynamic.issues.map((issue) => ({ ...issue, origin: issue.origin ?? 'dynamic' })))
  const staticGroups = group(staticAudit.issues.map((issue) => ({ ...issue, origin: 'static' as const })))
  const merged: Issue[] = []
  for (const [key, issues] of staticGroups) {
    const dynamicIssues = dynamicGroups.get(key)
    if (dynamicIssues) {
      merged.push(mergePair(collapse(dynamicIssues), collapse(issues)))
      dynamicGroups.delete(key)
      continue
    }
    const sample = issues[0]
    const range = sample ? issueRange(sample) : null
    if (range && rendered.has(range)) continue
    if (sample) merged.push(collapse(issues))
  }
  for (const issues of dynamicGroups.values()) merged.push(collapse(issues))
  return {
    url: dynamic.url,
    mappingEnabled: dynamic.mappingEnabled,
    issues: finalizeIssues(merged),
    files: { ...staticAudit.files, ...dynamic.files },
    errors: staticAudit.errors,
  }
}

function group(issues: Issue[]): Map<string, Issue[]> {
  const groups = new Map<string, Issue[]>()
  for (const issue of issues) {
    const key = groupKey(issue)
    const found = groups.get(key)
    if (found) found.push(issue)
    else groups.set(key, [issue])
  }
  return groups
}

function groupKey(issue: Issue): string {
  const range = issueRange(issue)
  if (!range) return `id:${issue.id}`
  return `${range}:${issue.ruleId}`
}

function issueRange(issue: Issue): string | null {
  if (!issue.file || issue.start === undefined || issue.end === undefined) return null
  return `${path.resolve(issue.file)}:${issue.start}:${issue.end}`
}

function markerRange(marker: string): string | null {
  const match = /^(\d+):(\d+):(.*)$/.exec(marker)
  if (!match) return null
  try {
    return `${path.resolve(decodeURIComponent(match[3]))}:${match[1]}:${match[2]}`
  } catch {
    return null
  }
}

function collapse(issues: Issue[]): Issue {
  const repeated = issues.find(isRepeated)
  if (!repeated) return issues[0]
  return {
    ...repeated,
    tab: 'ambiguous',
    edits: [],
    before: undefined,
    after: undefined,
  }
}

function mergePair(dynamic: Issue, source: Issue): Issue {
  if (isRepeated(dynamic) || isRepeated(source)) {
    const base = isRepeated(dynamic) ? dynamic : source
    return {
      ...base,
      origin: 'both',
      tab: 'ambiguous',
      edits: [],
      before: undefined,
      after: undefined,
      reason: isRepeated(dynamic) ? dynamic.reason : source.reason,
    }
  }
  return { ...dynamic, origin: 'both' }
}

function isRepeated(issue: Issue): boolean {
  return issue.reason === 'multiple-instances' || issue.reason === 'repeated-source'
}

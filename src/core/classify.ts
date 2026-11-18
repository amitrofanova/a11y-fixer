import path from 'node:path'
import type { Finding, Issue } from './types'
import { introducesAccessibleName } from './apply'
import {
  MANUAL_RULES,
  buildQuickEdit,
  isQuickRule,
  lineOf,
  loadParsers,
  locateHtmlFallback,
  locateMarker,
  preview,
} from './source'

const IMPACT_RANK: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
}

export function classifyFindings(
  projectRoot: string,
  findings: Finding[],
  cache: Record<string, string>,
  documentShell = true,
): Issue[] {
  const parsers = loadParsers(projectRoot)
  const counts = new Map<string, number>()
  for (const finding of findings) {
    const key = groupKey(finding)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const seen = new Set<string>()
  const issues: Issue[] = []
  for (const finding of findings) {
    if (finding.incomplete && !isQuickRule(finding.ruleId)) continue
    const key = groupKey(finding)
    if (seen.has(key)) continue
    seen.add(key)
    issues.push(classifyOne(projectRoot, finding, counts.get(key) ?? 1, parsers, cache, documentShell))
  }
  return finalizeIssues(issues)
}

export function finalizeIssues(issues: Issue[]): Issue[] {
  return dedupeQuick(sortIssues(issues.map(reviewIssue)))
}

function reviewIssue(issue: Issue): Issue {
  if (issue.tab !== 'quick') return issue
  if (!issue.edits.some((edit) => introducesAccessibleName(edit.insert))) return issue
  return {
    ...issue,
    tab: 'ambiguous',
    reason: 'unsafe-value',
    edits: [],
    before: undefined,
    after: undefined,
  }
}

function classifyOne(
  projectRoot: string,
  finding: Finding,
  count: number,
  parsers: ReturnType<typeof loadParsers>,
  cache: Record<string, string>,
  documentShell: boolean,
): Issue {
  const located = locateMarker(projectRoot, finding.marker, parsers, cache)
    ?? (documentShell ? locateHtmlFallback(projectRoot, finding.ruleId, finding.tag, cache) : null)
  const issue = blank(finding, located)
  if (!located) return { ...issue, tab: 'ambiguous', reason: 'unmapped' }
  if (count > 1) return { ...issue, tab: 'ambiguous', reason: 'multiple-instances' }
  if (located.repeated) return { ...issue, tab: 'ambiguous', reason: 'repeated-source' }
  if (isQuickRule(finding.ruleId)) {
    const built = buildQuickEdit(located, finding.ruleId, finding.checks)
    if ('reason' in built) return { ...issue, tab: 'ambiguous', reason: built.reason }
    const view = preview(located.text, located.start, built.edits)
    if (!view) return { ...issue, tab: 'ambiguous', reason: 'no-insert-point' }
    return { ...issue, tab: 'quick', edits: built.edits, before: view.before, after: view.after }
  }
  if (MANUAL_RULES.has(finding.ruleId)) return { ...issue, tab: 'manual' }
  return { ...issue, tab: 'ambiguous', reason: 'unsupported-rule' }
}

function blank(finding: Finding, located: { file: string; start: number; end: number; text: string; source: string } | null): Issue {
  const file = located?.file
  const start = located?.start
  return {
    id: `${finding.ruleId}:${file ?? 'dom'}:${start ?? finding.html}`,
    ruleId: finding.ruleId,
    impact: finding.impact,
    description: finding.description,
    help: finding.help,
    helpUrl: finding.helpUrl,
    failureSummary: finding.failureSummary,
    tab: 'ambiguous',
    file,
    start,
    end: located?.end,
    line: located ? lineOf(located.source, located.start) : undefined,
    sourceText: located?.text,
    domHtml: finding.html,
    edits: [],
  }
}

function sortIssues(issues: Issue[]): Issue[] {
  return [...issues].sort((left, right) => {
    const impact = rank(left.impact) - rank(right.impact)
    if (impact !== 0) return impact
    const file = (left.file ?? '').localeCompare(right.file ?? '')
    if (file !== 0) return file
    return (left.start ?? 0) - (right.start ?? 0)
  })
}

function dedupeQuick(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  const kept: Issue[] = []
  for (const issue of issues) {
    if (issue.tab !== 'quick') {
      kept.push(issue)
      continue
    }
    const key = issue.edits.map((edit) => `${edit.file}:${edit.start}:${edit.end}:${edit.insert}`).join('|')
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(issue)
  }
  return kept
}

function rank(impact: string | null): number {
  if (!impact) return 4
  return IMPACT_RANK[impact] ?? 4
}

function groupKey(finding: Finding): string {
  if (finding.marker) return `${finding.ruleId}:${finding.marker}`
  return `nomarker:${finding.ruleId}:${finding.target.join('|')}:${finding.html}`
}

export function relativeFile(projectRoot: string, file: string | undefined): string | undefined {
  if (!file) return undefined
  return path.relative(projectRoot, file)
}

import path from 'node:path'
import { applyTextEdits, insideProject } from './source'
import type { Issue, TextEdit } from './types'

export const EXCLUDED_DIR_NAMES = ['node_modules', 'dist', 'build', '.git', '.nuxt', '.output'] as const

export type ApplyReason = 'STALE' | 'OVERLAP' | 'OUTSIDE_WORKSPACE' | 'OUTSIDE_SCOPE'

export interface Scope {
  workspaceRoot: string
  projectRoot: string
  target: string | null
}

export interface ApplyRequest {
  workspaceRoot: string
  projectRoot: string
  auditScope?: string | null
  snapshots: Record<string, string>
  current: Record<string, string>
  edits: TextEdit[]
}

export interface FilePlan {
  file: string
  snapshot: string
  next: string
  edits: TextEdit[]
}

export type ApplyPlan =
  | { ok: true; files: Record<string, FilePlan> }
  | { ok: false; reason: ApplyReason }

export function planApply(request: ApplyRequest): ApplyPlan {
  const workspaceRoot = path.resolve(request.workspaceRoot)
  const projectRoot = path.resolve(request.projectRoot)
  const unique = uniqueEdits(request.edits)
  const byFile = new Map<string, TextEdit[]>()
  for (const edit of unique) {
    const file = path.resolve(projectRoot, edit.file)
    const list = byFile.get(file) ?? []
    list.push({ ...edit, file })
    byFile.set(file, list)
  }
  const files: Record<string, FilePlan> = {}
  for (const [file, edits] of byFile) {
    if (!insideProject(workspaceRoot, file) || !insideProject(projectRoot, file)) {
      return { ok: false, reason: 'OUTSIDE_WORKSPACE' }
    }
    if (!inAuditScope(file, {
      workspaceRoot,
      projectRoot,
      target: request.auditScope ?? null,
    })) {
      return { ok: false, reason: 'OUTSIDE_SCOPE' }
    }
    const snapshot = lookup(request.snapshots, file)
    const current = lookup(request.current, file)
    if (snapshot === undefined || current === undefined || current !== snapshot) {
      return { ok: false, reason: 'STALE' }
    }
    const next = applyTextEdits(snapshot, edits)
    if (next == null) return { ok: false, reason: 'OVERLAP' }
    files[file] = { file, snapshot, next, edits }
  }
  return { ok: true, files }
}

export function plannedWrites(plan: ApplyPlan): FilePlan[] {
  if (!plan.ok) return []
  return Object.values(plan.files)
}

export function workspaceReplacements(plan: ApplyPlan): TextEdit[] {
  if (!plan.ok) return []
  return plannedWrites(plan).flatMap((item) => item.edits)
}

export function inAuditScope(file: string, scope: Scope): boolean {
  const resolved = path.resolve(file)
  const workspaceRoot = path.resolve(scope.workspaceRoot)
  const projectRoot = path.resolve(scope.projectRoot)
  if (!insideProject(workspaceRoot, resolved) || !insideProject(projectRoot, resolved)) return false
  if (isExcludedPath(resolved, projectRoot)) return false
  const bound = path.resolve(scope.target ?? projectRoot)
  if (!insideProject(projectRoot, bound)) return false
  return insideProject(bound, resolved)
}

export function isExcludedPath(file: string, projectRoot: string): boolean {
  const root = path.resolve(projectRoot)
  const resolved = path.resolve(file)
  if (!insideProject(root, resolved)) return true
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true
  return relative.split(path.sep).some((part) => (EXCLUDED_DIR_NAMES as readonly string[]).includes(part))
}

export function resolveAuditTarget(projectRoot: string, target: string): string {
  const root = path.resolve(projectRoot)
  const resolved = path.resolve(target)
  if (!insideProject(root, resolved) || isExcludedPath(resolved, root)) {
    throw new Error('OUTSIDE_SCOPE')
  }
  return resolved
}

export function presentIssues(issues: Issue[], scope: Scope): {
  visible: Issue[]
  outOfScope: Issue[]
  unmapped: Issue[]
} {
  const visible: Issue[] = []
  const outOfScope: Issue[] = []
  const unmapped: Issue[] = []
  const folderMode = Boolean(scope.target)
  for (const issue of issues) {
    if (!issue.file) {
      if (folderMode) unmapped.push(issue)
      else visible.push(issue)
      continue
    }
    if (!inAuditScope(issue.file, scope)) {
      outOfScope.push(issue)
      continue
    }
    visible.push(issue)
  }
  return { visible, outOfScope, unmapped }
}

function uniqueEdits(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>()
  return edits.filter((edit) => {
    const key = `${path.resolve(edit.file)}:${edit.start}:${edit.end}:${edit.insert}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function lookup(map: Record<string, string>, file: string): string | undefined {
  if (map[file] !== undefined) return map[file]
  const resolved = path.resolve(file)
  if (map[resolved] !== undefined) return map[resolved]
  for (const [key, value] of Object.entries(map)) {
    if (path.resolve(key) === resolved) return value
  }
  return undefined
}

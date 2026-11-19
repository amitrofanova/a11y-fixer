import path from 'node:path'
import type { AuditOutcome, Issue, TextEdit } from './types'

export interface AuditReportRequest {
  outcome: AuditOutcome
  projectRoot: string
  language: 'ru' | 'en'
  scope: string | null
  excluded: readonly string[]
  visible: Issue[]
  outOfScope: Issue[]
  unmapped: Issue[]
}

export interface AuditReport {
  markdown: string
  json: string
}

const labels = {
  ru: {
    page: 'Страница',
    scope: 'Область',
    scopeProject: 'весь проект',
    excluded: 'Исключённые каталоги',
    notWcag: 'Результат этой проверки не является заключением о соответствии WCAG.',
    disclaimer: 'Быстрые правки ниже уже посчитаны и ждут подтверждения в редакторе. Отчёт сам файлы не меняет.',
    quick: 'Быстрые правки',
    manual: 'Ручные правки',
    ambiguous: 'Неоднозначные правки',
    outOfScope: 'Вне области',
    unmapped: 'Без файла',
    none: 'Нет.',
    notInFixes: 'Эти записи не входят в исправления.',
    reason: 'Причина',
    origin: 'Происхождение',
    fileErrors: 'Файлы без статического разбора',
    pages: 'Страницы',
    opened: 'открыта',
    skipped: 'не открыта',
    originLabel: {
      static: 'Найдено в исходнике',
      dynamic: 'Найдено на открытой странице',
      both: 'Найдено в исходнике и на открытой странице',
    },
  },
  en: {
    page: 'Page',
    scope: 'Scope',
    scopeProject: 'whole project',
    excluded: 'Excluded directories',
    notWcag: 'This check is not a WCAG conformance verdict.',
    disclaimer: 'The quick fixes below are already prepared and wait for confirmation in the editor. The report does not change files.',
    quick: 'Quick fixes',
    manual: 'Manual fixes',
    ambiguous: 'Ambiguous',
    outOfScope: 'Outside scope',
    unmapped: 'No source file',
    none: 'None.',
    notInFixes: 'These records are not included in fixes.',
    reason: 'Reason',
    origin: 'Origin',
    fileErrors: 'Files skipped by static analysis',
    pages: 'Pages',
    opened: 'opened',
    skipped: 'not opened',
    originLabel: {
      static: 'Found in source',
      dynamic: 'Found on the open page',
      both: 'Found in source and on the open page',
    },
  },
} as const

export function renderAuditReport(request: AuditReportRequest): AuditReport {
  const text = labels[request.language]
  const lines = [
    '# A11y Fixer',
    '',
    `${text.page}: ${request.outcome.url}`,
    `${text.scope}: ${request.scope ?? text.scopeProject}`,
    `${text.excluded}: ${request.excluded.join(', ')}`,
    '',
    text.notWcag,
    '',
    text.disclaimer,
    '',
  ]
  const groups: Array<[Issue['tab'], string, Issue[]]> = [
    ['quick', text.quick, request.visible.filter((issue) => issue.tab === 'quick')],
    ['manual', text.manual, request.visible.filter((issue) => issue.tab === 'manual')],
    ['ambiguous', text.ambiguous, request.visible.filter((issue) => issue.tab === 'ambiguous')],
  ]
  for (const [, title, issues] of groups) {
    lines.push(`## ${title}`, '')
    appendIssues(lines, issues, request.projectRoot, text, true)
  }
  lines.push(`## ${text.outOfScope}`, '', text.notInFixes, '')
  appendIssues(lines, request.outOfScope, request.projectRoot, text, false)
  lines.push(`## ${text.unmapped}`, '', text.notInFixes, '')
  appendIssues(lines, request.unmapped, request.projectRoot, text, false)
  const visits = request.outcome.visits ?? []
  if (visits.length > 0) {
    lines.push(`## ${text.pages}`, '')
    for (const visit of visits) {
      const state = visit.state === 'opened' ? text.opened : text.skipped
      const reason = visit.reason ? ` (${visit.reason})` : ''
      lines.push(`- \`${visit.path}\` — ${state}${reason}`, '')
    }
  }
  const errors = request.outcome.errors ?? []
  if (errors.length > 0) {
    lines.push(`## ${text.fileErrors}`, '')
    for (const error of errors) {
      const where = error.file ? `\`${path.relative(request.projectRoot, error.file)}\`` : text.scopeProject
      lines.push(`- ${where}: \`${error.message}\``, '')
    }
  }
  return {
    markdown: lines.join('\n'),
    json: `${JSON.stringify(reportData(request), null, 2)}\n`,
  }
}

function appendIssues(
  lines: string[],
  issues: Issue[],
  projectRoot: string,
  text: (typeof labels)[keyof typeof labels],
  allowDiff: boolean,
): void {
  if (issues.length === 0) {
    lines.push(text.none, '')
    return
  }
  for (const issue of issues) {
    lines.push(`### ${issue.ruleId} — ${issue.impact ?? 'n/a'}`, '')
    if (issue.help) lines.push(issue.help, '')
    if (issue.origin) lines.push(`${text.origin}: ${text.originLabel[issue.origin]}`, '')
    if (issue.file && issue.line) lines.push(`\`${path.relative(projectRoot, issue.file)}:${issue.line}\``, '')
    if (issue.reason) lines.push(`${text.reason}: \`${issue.reason}\``, '')
    if (issue.sourceText) lines.push('```html', issue.sourceText, '```', '')
    if (allowDiff && issue.before && issue.after && issue.before !== issue.after) {
      lines.push('```diff')
      for (const line of diffLines(issue.before, issue.after)) lines.push(line)
      lines.push('```', '')
    } else if (!issue.sourceText && issue.domHtml) {
      lines.push('```html', issue.domHtml, '```', '')
    }
  }
}

function diffLines(before: string, after: string): string[] {
  const result: string[] = []
  if (before) result.push(`-${before}`)
  if (after) result.push(`+${after}`)
  return result
}

function reportData(request: AuditReportRequest) {
  return {
    version: 1,
    url: request.outcome.url,
    mappingEnabled: request.outcome.mappingEnabled,
    scope: request.scope,
    excluded: [...request.excluded],
    issues: request.visible.map((issue) => describeIssue(issue, request.projectRoot)),
    outOfScope: request.outOfScope.map((issue) => describeIssue(issue, request.projectRoot)),
    unmapped: request.unmapped.map((issue) => describeIssue(issue, request.projectRoot)),
  }
}

function describeIssue(issue: Issue, projectRoot: string) {
  return {
    ruleId: issue.ruleId,
    impact: issue.impact,
    tab: issue.tab,
    origin: issue.origin ?? null,
    reason: issue.reason ?? null,
    help: issue.help,
    helpUrl: issue.helpUrl,
    file: issue.file ? path.relative(projectRoot, issue.file) : null,
    line: issue.line ?? null,
    source: issue.sourceText ?? null,
    dom: issue.domHtml,
    edits: issue.edits.map((edit: TextEdit) => ({
      file: path.relative(projectRoot, edit.file),
      start: edit.start,
      end: edit.end,
      insert: edit.insert,
    })),
  }
}

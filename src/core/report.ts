import path from 'node:path'
import type { AuditOutcome, Issue, TextEdit } from './types'

export function renderReport(outcome: AuditOutcome, projectRoot: string): string {
  const groups: Array<[Issue['tab'], string]> = [
    ['quick', 'Быстрые правки'],
    ['manual', 'Ручные правки'],
    ['ambiguous', 'Неоднозначные правки'],
  ]
  const lines = [
    '# A11y Fixer',
    '',
    `Страница: ${outcome.url}`,
    '',
    'Быстрые правки ниже уже посчитаны и ждут подтверждения в редакторе. Отчёт сам файлы не меняет.',
    '',
  ]
  for (const [tab, title] of groups) {
    lines.push(`## ${title}`, '')
    const issues = outcome.issues.filter((issue) => issue.tab === tab)
    if (issues.length === 0) {
      lines.push('Нет.', '')
      continue
    }
    for (const issue of issues) {
      lines.push(`### ${issue.ruleId} — ${issue.impact ?? 'n/a'}`, '')
      lines.push(issue.help, '')
      if (issue.file && issue.line) lines.push(`\`${path.relative(projectRoot, issue.file)}:${issue.line}\``, '')
      if (issue.reason) lines.push(`Причина: \`${issue.reason}\``, '')
      if (issue.sourceText) {
        lines.push('```html', issue.sourceText, '```', '')
      }
      if (issue.before && issue.after && issue.before !== issue.after) {
        lines.push('```diff')
        for (const line of diffLines(issue.before, issue.after)) lines.push(line)
        lines.push('```', '')
      } else if (!issue.sourceText && issue.domHtml) {
        lines.push('```html', issue.domHtml, '```', '')
      }
    }
  }
  lines.push('## Данные для агента', '', '```json')
  lines.push(JSON.stringify(agentData(outcome, projectRoot), null, 2))
  lines.push('```', '')
  return lines.join('\n')
}

function diffLines(before: string, after: string): string[] {
  const result: string[] = []
  if (before) result.push(`-${before}`)
  if (after) result.push(`+${after}`)
  return result
}

function agentData(outcome: AuditOutcome, projectRoot: string) {
  return {
    version: 1,
    url: outcome.url,
    mappingEnabled: outcome.mappingEnabled,
    issues: outcome.issues.map((issue) => ({
      ruleId: issue.ruleId,
      impact: issue.impact,
      tab: issue.tab,
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
    })),
  }
}

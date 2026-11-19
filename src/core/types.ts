export type Tab = 'quick' | 'manual' | 'ambiguous'

export type FindingOrigin = 'static' | 'dynamic' | 'both'

export interface TextEdit {
  file: string
  start: number
  end: number
  insert: string
}

export interface Issue {
  id: string
  ruleId: string
  impact: string | null
  description: string
  help: string
  helpUrl: string
  failureSummary: string
  tab: Tab
  origin?: FindingOrigin
  reason?: string
  file?: string
  start?: number
  end?: number
  line?: number
  sourceText?: string
  domHtml: string
  before?: string
  after?: string
  edits: TextEdit[]
}

export interface AuditFileError {
  file?: string
  message: string
}

export interface AuditedPage {
  path: string
  url: string
  file?: string
  state: 'opened' | 'skipped'
  reason?: string
}

export interface AuditOutcome {
  url: string
  mappingEnabled: boolean
  issues: Issue[]
  files: Record<string, string>
  errors?: AuditFileError[]
  cancelled?: boolean
  pageCount?: { done: number; total: number }
  visits?: AuditedPage[]
}

export interface AxeCheck {
  id: string
  data: unknown
}

export interface Finding {
  ruleId: string
  impact: string | null
  description: string
  help: string
  helpUrl: string
  failureSummary: string
  html: string
  target: string[]
  marker: string | null
  tag: string
  checks: AxeCheck[]
  incomplete: boolean
}

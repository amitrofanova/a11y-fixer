export type Tab = 'quick' | 'manual' | 'ambiguous'

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

export interface AuditOutcome {
  url: string
  mappingEnabled: boolean
  issues: Issue[]
  files: Record<string, string>
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

import * as vscode from 'vscode'
import type { Issue } from './core/types'
import { impactLabel, languageOf, reasonText, strings, type Language } from './i18n'

export interface ViewActions {
  pickScope(): void
  audit(): void
  auditProject(): void
  fix(id: string): void
  fixAll(): void
  fixAllRerun(): void
  report(): void
  reveal(id: string): void
  open(url: string): void
  cancel(): void
}

export interface PanelModel {
  started: boolean
  issues: Issue[]
  scopeKind: 'project' | 'folder' | 'file'
  scopePath: string
  outOfScope: Array<{
    id: string
    ruleId: string
    help: string
    file: string
    line: number
    canReveal: boolean
  }>
  unmapped: Array<{
    ruleId: string
    help: string
    dom: string
  }>
  pageUrl: string
  pageCount: { done: number; total: number }
  visits: Array<{
    path: string
    state: 'opened' | 'skipped'
    reason: string
    file: string
  }>
  fileErrors: Array<{
    file: string
    message: string
  }>
}

type Status = 'idle' | 'running' | 'ready' | 'error'

export class A11yViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined
  private status: Status = 'idle'
  private message = ''
  private model: PanelModel | undefined
  private language: Language = languageOf(vscode.env.language)

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: ViewActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const nonce = Math.random().toString(36).slice(2)
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'))
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'))
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = html(view.webview, nonce, script, style)
    view.webview.onDidReceiveMessage((message: { type?: string; id?: string; url?: string }) => {
      if (message.type === 'pickScope') this.actions.pickScope()
      if (message.type === 'audit') this.actions.audit()
      if (message.type === 'auditProject') this.actions.auditProject()
      if (message.type === 'fix' && message.id) this.actions.fix(message.id)
      if (message.type === 'fixAll') this.actions.fixAll()
      if (message.type === 'fixAllRerun') this.actions.fixAllRerun()
      if (message.type === 'report') this.actions.report()
      if (message.type === 'reveal' && message.id) this.actions.reveal(message.id)
      if (message.type === 'open' && message.url) this.actions.open(message.url)
      if (message.type === 'cancel') this.actions.cancel()
    })
    view.onDidDispose(() => {
      this.view = undefined
    })
    this.post()
  }

  setRunning(language: Language): void {
    this.language = language
    this.status = 'running'
    this.message = ''
    this.post()
  }

  show(model: PanelModel, language: Language, status: Status, message = ''): void {
    this.model = model
    this.language = language
    this.status = status
    this.message = message
    this.post()
  }

  private post(): void {
    if (!this.view) return
    const ui = strings(this.language)
    const model = this.model
    void this.view.webview.postMessage({
      status: this.status,
      message: this.message,
      language: this.language,
      ui,
      started: model?.started ?? false,
      scopeKind: model?.scopeKind ?? 'project',
      scopePath: model?.scopePath ?? '',
      outOfScope: model?.outOfScope ?? [],
      unmapped: model?.unmapped ?? [],
      pageUrl: model?.pageUrl ?? '',
      pageCount: model?.pageCount ?? { done: 0, total: 0 },
      visits: model?.visits ?? [],
      fileErrors: model?.fileErrors ?? [],
      issues: (model?.issues ?? []).map((issue) => ({
        id: issue.id,
        ruleId: issue.ruleId,
        impact: issue.impact ?? '',
        impactLabel: impactLabel(this.language, issue.impact),
        help: issue.help,
        description: issue.description,
        failureSummary: issue.failureSummary,
        helpUrl: issue.helpUrl,
        tab: issue.tab,
        file: issue.file ? vscode.workspace.asRelativePath(issue.file) : '',
        line: issue.line ?? 0,
        source: issue.sourceText ?? '',
        dom: issue.domHtml,
        before: issue.before ?? '',
        after: issue.after ?? '',
        reason: reasonText(this.language, issue.reason),
        origin: issue.origin ?? '',
        canReveal: issue.start !== undefined && Boolean(issue.file),
        canFix: issue.tab === 'quick' && issue.edits.length > 0,
      })),
    })
  }
}

function html(webview: vscode.Webview, nonce: string, script: vscode.Uri, style: vscode.Uri): string {
  const source = webview.cspSource
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source}; style-src ${source}; script-src 'nonce-${nonce}' ${source};" />
  <link rel="stylesheet" href="${style}" />
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`
}

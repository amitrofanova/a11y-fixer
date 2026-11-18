import * as vscode from 'vscode'
import fs from 'node:fs'
import path from 'node:path'
import { auditProject, closeSession, type Session } from './core/audit'
import { detectProject } from './core/project'
import {
  planApply,
  presentIssues,
  resolveAuditTarget,
  workspaceReplacements,
  type ApplyPlan,
  type Scope,
} from './core/apply'
import { resolveRange } from './core/source'
import { renderReport } from './core/report'
import type { AuditOutcome, Issue } from './core/types'
import { languageOf, messageText, type Language } from './i18n'
import { A11yViewProvider, type PanelModel } from './panel'

let session: Session | undefined
let outcome: AuditOutcome | undefined
let auditTarget: string | null | undefined
let provider: A11yViewProvider | undefined
let running: Promise<void> | undefined

export function activate(context: vscode.ExtensionContext): void {
  provider = new A11yViewProvider(context.extensionUri, {
    pickScope: () => enqueue('pickScope'),
    audit: () => enqueue('audit'),
    auditProject: () => enqueue('auditProject'),
    fix: (id) => enqueue('fix', id),
    fixAll: () => enqueue('fixAll'),
    fixAllRerun: () => enqueue('fixAllRerun'),
    report: () => enqueue('report'),
    reveal: (id) => reveal(id),
    open: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)) },
  })
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('a11yFixer.main', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('a11yFixer.pickScope', () => enqueue('pickScope')),
    vscode.commands.registerCommand('a11yFixer.audit', () => enqueue('audit')),
    vscode.commands.registerCommand('a11yFixer.auditProject', () => enqueue('auditProject')),
    vscode.commands.registerCommand('a11yFixer.auditTarget', (uri?: vscode.Uri) => enqueue('auditTarget', undefined, uri)),
  )
}

export async function deactivate(): Promise<void> {
  if (session) await closeSession(session)
}

function enqueue(action: string, id?: string, uri?: vscode.Uri): Promise<void> {
  const job = (running ?? Promise.resolve()).then(() => perform(action, id, uri))
  running = job.catch(() => undefined)
  return job
}

async function perform(action: string, id?: string, uri?: vscode.Uri): Promise<void> {
  const language = languageOf(vscode.env.language)
  const view = provider
  if (!view) return
  try {
    if (action === 'pickScope' || (action === 'audit' && auditTarget === undefined)) {
      const picked = await pickTarget(language)
      if (picked === 'cancelled') {
        view.show(panelModel(), language, outcome ? 'ready' : 'idle')
        return
      }
      auditTarget = picked
      action = 'audit'
    }
    if (action === 'auditTarget') {
      auditTarget = selectedTarget(uri)
      await vscode.commands.executeCommand('workbench.view.extension.a11yFixer')
      action = 'audit'
    }
    if (action === 'auditProject') {
      auditTarget = null
      action = 'audit'
    }
  } catch (error) {
    view.show(panelModel(), language, 'error', explain(error, language))
    return
  }
  view.show(panelModel(), language, 'running')
  try {
    if (action === 'audit') outcome = await audit(language)
    if (action === 'fix' && id) {
      const wrote = await applySelected(visibleIssues().filter((issue) => issue.id === id), language)
      if (wrote) outcome = await audit(language)
    }
    if (action === 'fixAll' || action === 'fixAllRerun') {
      const wrote = await applySelected(visibleIssues().filter((issue) => issue.tab === 'quick'), language)
      if (wrote) outcome = await audit(language)
    }
    if (action === 'report') await writeReport(language)
    view.show(panelModel(), language, 'ready')
  } catch (error) {
    view.show(panelModel(), language, 'error', explain(error, language))
  }
}

async function pickTarget(language: Language): Promise<string | null | 'cancelled'> {
  const root = projectRoot()
  if (!root || !detectProject(root)) throw new Error('NO_VITE_CONFIG')
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(root),
    openLabel: messageText(language, 'audit'),
    title: messageText(language, 'pickDialog'),
  })
  if (!picked?.[0]) return 'cancelled'
  return selectedTarget(picked[0])
}

async function audit(language: Language): Promise<AuditOutcome> {
  const root = projectRoot()
  if (!root || !detectProject(root)) throw new Error('NO_VITE_CONFIG')
  if (session && session.projectRoot !== root) {
    await closeSession(session)
    session = undefined
  }
  if (!session) session = { projectRoot: root, mappingEnabled: true }
  session.auditTarget = auditTarget ?? null
  const result = await auditProject(session, language)
  if (!result.mappingEnabled) {
    void vscode.window.showWarningMessage(messageText(language, 'mappingOff'))
  }
  return result
}

async function applySelected(issues: Issue[], language: Language): Promise<boolean> {
  if (!outcome) return false
  const root = projectRoot()
  if (!root) throw new Error('NO_VITE_CONFIG')
  const selected = issues.filter((issue) => issue.tab === 'quick' && issue.edits.length > 0)
  if (selected.length === 0) {
    void vscode.window.showInformationMessage(messageText(language, 'nothingToFix'))
    return false
  }
  const edits = selected.flatMap((issue) => issue.edits)
  const current: Record<string, string> = {}
  for (const edit of edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = await currentText(file)
  }
  const plan = planApply({
    workspaceRoot: root,
    projectRoot: root,
    auditScope: currentScope().target,
    snapshots: outcome.files,
    current,
    edits,
  })
  if (!plan.ok) throw new Error(plan.reason)
  if (workspaceReplacements(plan).length === 0) {
    void vscode.window.showInformationMessage(messageText(language, 'nothingToFix'))
    return false
  }
  await writePlan(plan)
  const applied = new Set(selected.map((issue) => issue.id))
  const touched = new Set(Object.keys(plan.files))
  outcome.issues = outcome.issues.flatMap((issue) => {
    if (applied.has(issue.id)) return []
    if (!issue.file || !touched.has(path.resolve(issue.file))) return [issue]
    return [{
      ...issue,
      tab: 'ambiguous' as const,
      reason: 'stale',
      edits: [],
      before: undefined,
      after: undefined,
      start: undefined,
      end: undefined,
      line: undefined,
      sourceText: undefined,
    }]
  })
  void vscode.window.showInformationMessage(messageText(language, 'applied'))
  return true
}

async function writePlan(plan: Extract<ApplyPlan, { ok: true }>): Promise<void> {
  const items = Object.values(plan.files)
  const documents: vscode.TextDocument[] = []
  for (const item of items) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file))
    if (document.getText() !== item.snapshot) throw new Error('STALE')
    documents.push(document)
  }
  const workspaceEdit = new vscode.WorkspaceEdit()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const document = documents[index]
    for (const edit of item.edits) {
      workspaceEdit.replace(
        document.uri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.insert,
      )
    }
  }
  if (workspaceEdit.size === 0) return
  if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('APPLY_FAILED')
  for (const document of documents) {
    if (!await document.save()) throw new Error('SAVE_FAILED')
    await settleDocument(document.uri.fsPath)
    const settled = await currentText(document.uri.fsPath)
    if (!outcome) continue
    outcome.files[document.uri.fsPath] = settled
    for (const key of Object.keys(outcome.files)) {
      if (path.resolve(key) === path.resolve(document.uri.fsPath)) outcome.files[key] = settled
    }
  }
}

async function writeReport(language: Language): Promise<void> {
  if (!outcome) return
  const root = projectRoot()
  if (!root) throw new Error('NO_VITE_CONFIG')
  const target = path.join(root, 'a11y-fixer-report.md')
  fs.writeFileSync(target, renderReport({ ...outcome, issues: visibleIssues() }, root))
  const document = await vscode.workspace.openTextDocument(target)
  await vscode.window.showTextDocument(document)
  void vscode.window.showInformationMessage(messageText(language, 'savedReport'))
}

async function reveal(id: string): Promise<void> {
  const found = outcome?.issues.find((item) => item.id === id)
  if (!found?.file || found.start === undefined || found.end === undefined) return
  const document = await vscode.workspace.openTextDocument(found.file)
  const text = document.getText()
  const resolved = resolveRange(text, found.start, found.sourceText)
  const startOffset = resolved?.start ?? found.start
  const endOffset = resolved?.end ?? Math.max(found.start, found.end)
  const editor = await vscode.window.showTextDocument(document)
  const start = document.positionAt(startOffset)
  const end = document.positionAt(endOffset)
  editor.selection = new vscode.Selection(start, end)
  editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter)
}

async function currentText(file: string): Promise<string> {
  const uri = vscode.Uri.file(file)
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath)
  if (open) return open.getText()
  return fs.readFileSync(file, 'utf8')
}

async function settleDocument(file: string): Promise<void> {
  let previous = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const editorText = await currentText(file)
    const disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (editorText === disk && editorText === previous) return
    previous = editorText
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

function selectedTarget(uri: vscode.Uri | undefined): string | null {
  const root = projectRoot()
  if (!root || !detectProject(root)) throw new Error('NO_VITE_CONFIG')
  if (!uri) throw new Error('NO_FOLDER')
  const resolved = resolveAuditTarget(root, uri.fsPath)
  if (!fs.existsSync(resolved)) throw new Error('NO_FOLDER')
  const stat = fs.statSync(resolved)
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('NO_FOLDER')
  if (resolved === path.resolve(root)) return null
  return resolved
}

function currentScope(): Scope {
  const root = projectRoot() ?? ''
  return {
    workspaceRoot: root,
    projectRoot: root,
    target: auditTarget === undefined ? null : auditTarget,
  }
}

function visibleIssues(): Issue[] {
  if (!outcome) return []
  return presentIssues(outcome.issues, currentScope()).visible
}

function panelModel(): PanelModel {
  const root = projectRoot() ?? ''
  const selected = auditTarget !== undefined
  const presented = presentIssues(outcome?.issues ?? [], currentScope())
  return {
    started: selected,
    issues: selected ? presented.visible : [],
    scopeKind: auditTarget ? (fs.existsSync(auditTarget) && fs.statSync(auditTarget).isFile() ? 'file' : 'folder') : 'project',
    scopePath: auditTarget && root ? vscode.workspace.asRelativePath(auditTarget, false) : '',
    outOfScope: selected ? presented.outOfScope.map((issue) => ({
      id: issue.id,
      ruleId: issue.ruleId,
      help: issue.help,
      file: issue.file && root ? vscode.workspace.asRelativePath(issue.file, false) : '',
      line: issue.line ?? 0,
      canReveal: issue.start !== undefined && Boolean(issue.file),
    })) : [],
    unmapped: selected ? presented.unmapped.map((issue) => ({
      ruleId: issue.ruleId,
      help: issue.help,
      dom: issue.domHtml,
    })) : [],
  }
}

function projectRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

function explain(error: unknown, language: Language): string {
  const code = error instanceof Error ? error.message : String(error)
  const known: Record<string, string> = {
    NO_VITE_CONFIG: 'noVite',
    NO_NUXT: 'noNuxt',
    NO_ROUTE: 'noRoute',
    PAGE_NOT_RENDERED: 'pageNotRendered',
    NO_CHROME: 'noChrome',
    AXE_MISSING: 'axeMissing',
    NO_PORT: 'noPort',
    NO_FOLDER: 'noFolder',
    STALE: 'stale',
    OVERLAP: 'overlap',
    OUTSIDE_WORKSPACE: 'outsideWorkspace',
    OUTSIDE_SCOPE: 'outsideScope',
    UNSAFE: 'unsafe',
    APPLY_FAILED: 'failed',
    SAVE_FAILED: 'failed',
  }
  return known[code] ? messageText(language, known[code]) : code
}

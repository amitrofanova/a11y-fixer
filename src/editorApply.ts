import * as vscode from 'vscode'
import fs from 'node:fs'
import path from 'node:path'
import { planApply, workspaceReplacements, type ApplyPlan, type ApplyReason } from './core/apply'
import type { TextEdit } from './core/types'

export interface EditorApplyRequest {
  confirmed: boolean
  workspaceRoot: string
  projectRoot: string
  auditScope: string | null
  snapshots: Record<string, string>
  edits: TextEdit[]
}

export interface EditorApplyEffects {
  invalidate?(files: Record<string, string>): void
  onWritten?(): void
  recheck?(): Promise<void>
}

export type EditorApplyResult =
  | { wrote: false; reason?: ApplyReason }
  | { wrote: true; files: Record<string, string> }

export async function applyConfirmedEdits(
  request: EditorApplyRequest,
  effects: EditorApplyEffects = {},
): Promise<EditorApplyResult> {
  if (request.confirmed !== true) return { wrote: false }
  const current: Record<string, string> = {}
  for (const edit of request.edits) {
    const file = path.resolve(edit.file)
    if (current[file] === undefined) current[file] = currentText(file)
  }
  const plan = planApply({
    workspaceRoot: request.workspaceRoot,
    projectRoot: request.projectRoot,
    auditScope: request.auditScope,
    snapshots: request.snapshots,
    current,
    edits: request.edits,
  })
  if (!plan.ok) return { wrote: false, reason: plan.reason }
  if (workspaceReplacements(plan).length === 0) return { wrote: false }
  const settled = await writePlan(plan)
  if (Object.keys(settled).length === 0) return { wrote: false }
  effects.invalidate?.(settled)
  effects.onWritten?.()
  await effects.recheck?.()
  return { wrote: true, files: settled }
}

async function writePlan(plan: Extract<ApplyPlan, { ok: true }>): Promise<Record<string, string>> {
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
    if (!item || !document) throw new Error('APPLY_FAILED')
    for (const edit of item.edits) {
      workspaceEdit.replace(
        document.uri,
        new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)),
        edit.insert,
      )
    }
  }
  if (workspaceEdit.size === 0) return {}
  if (!await vscode.workspace.applyEdit(workspaceEdit)) throw new Error('APPLY_FAILED')
  const settled: Record<string, string> = {}
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const document = documents[index]
    if (!item || !document) throw new Error('APPLY_FAILED')
    if (!await document.save()) throw new Error('SAVE_FAILED')
    await settleDocument(item.file)
    settled[item.file] = currentText(item.file)
  }
  return settled
}

function currentText(file: string): string {
  const uri = vscode.Uri.file(file)
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath)
  if (open) return open.getText()
  return fs.readFileSync(file, 'utf8')
}

async function settleDocument(file: string): Promise<void> {
  let previous = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const editorText = currentText(file)
    const disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (editorText === disk && editorText === previous) return
    previous = editorText
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'

type ApplyReason = 'STALE' | 'OVERLAP' | 'OUTSIDE_WORKSPACE' | 'OUTSIDE_SCOPE' | 'UNSAFE'

interface TextEdit {
  file: string
  start: number
  end: number
  insert: string
}

interface EditorRequest {
  confirmed: boolean
  workspaceRoot: string
  projectRoot: string
  auditScope: string | null
  snapshots: Record<string, string>
  edits: TextEdit[]
}

interface EditorEffects {
  invalidate?(files: Record<string, string>): void
  onWritten?(): void
  recheck?(): Promise<void>
}

type EditorResult =
  | { wrote: false; reason?: ApplyReason }
  | { wrote: true; files: Record<string, string> }

interface EditorApi {
  applyConfirmedEdits(request: EditorRequest, effects?: EditorEffects): Promise<EditorResult>
}

interface SeenEdit {
  file: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  newText: string
}

interface SeenCall {
  groups: Array<{ file: string; edits: SeenEdit[] }>
}

const BUTTON = '<template><button tabindex="3"></button></template>\n'
const BUTTON_FIXED = '<template><button tabindex="0"></button></template>\n'
const calls: SeenCall[] = []
let restoreApply: (() => void) | undefined

export async function run(): Promise<void> {
  const api = await loadApi()
  const root = workspaceRoot()
  installApplyWatch()
  const failures: string[] = []
  try {
    const cases: Array<[string, () => Promise<void>]> = [
      ['a confirmed tabindex edit is one WorkspaceEdit, then the file is saved and rechecked', () => confirmedReplace(api, root)],
      ['an edit inside the selected folder is saved', () => confirmedInsideFolder(api, root)],
      ['two files are one WorkspaceEdit and one recheck', () => confirmedBatch(api, root)],
      ['adjacent edits in one file are applied together', () => confirmedAdjacent(api, root)],
      ['identical edits are written once', () => confirmedDuplicate(api, root)],
      ['without confirmation nothing is opened or written', () => unconfirmed(api, root)],
      ['an unsaved buffer rejects the whole package', () => staleBuffer(api, root)],
      ['a disk change rejects the whole package', () => staleDisk(api, root)],
      ['overlapping ranges do not call WorkspaceEdit', () => overlap(api, root)],
      ['a folder scope rejects an edit outside that folder', () => folderScope(api, root)],
      ['a file scope rejects a sibling in the same package', () => fileScope(api, root)],
      ['an excluded directory rejects the package', () => excludedDirectory(api, root)],
      ['a path outside the workspace rejects the package', () => outsideWorkspace(api, root)],
      ['an accessible-name insert rejects the package', () => unsafe(api, root)],
      ['a failed recheck leaves the saved edit in place', () => recheckFails(api, root)],
      ['undo after a saved edit is observed and not required', () => undoProbe(api, root)],
    ]
    for (const [name, fn] of cases) {
      calls.length = 0
      console.log(`# ${name}`)
      try {
        await fn()
        console.log(`ok - ${name}`)
      } catch (error) {
        console.error(`not ok - ${name}`)
        console.error(error)
        failures.push(name)
      } finally {
        await cleanup()
      }
    }
  } finally {
    restoreApply?.()
  }
  if (failures.length > 0) throw new Error(`editor apply failed: ${failures.join('; ')}`)
}

async function confirmedReplace(api: EditorApi, root: string): Promise<void> {
  const file = writeFile(root, 'confirmed/Button.vue', BUTTON)
  const document = await openFile(file)
  const start = document.positionAt(BUTTON.indexOf('3'))
  const end = document.positionAt(BUTTON.indexOf('3') + 1)
  const seenDuring = textDuring(file)
  calls.length = 0
  const result = await api.applyConfirmedEdits(base(root, null, [file], [tabindex(file)]), seenDuring.hooks)
  assert.equal(result.wrote, true)
  assert.equal(document.getText(), BUTTON_FIXED)
  assert.equal(document.isDirty, false)
  assert.equal(fs.readFileSync(file, 'utf8'), BUTTON_FIXED)
  assert.equal(settled(result, file), BUTTON_FIXED)
  assert.deepEqual(seenDuring.order, ['invalidate', 'written', 'recheck'])
  assert.deepEqual(seenDuring.recheckText, [BUTTON_FIXED])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groups.length, 1)
  assert.equal(path.resolve(calls[0].groups[0].file), path.resolve(file))
  const edit = calls[0].groups[0].edits[0]
  assert.equal(calls[0].groups[0].edits.length, 1)
  assert.equal(edit.newText, '0')
  assert.equal(edit.startLine, start.line)
  assert.equal(edit.startCharacter, start.character)
  assert.equal(edit.endLine, end.line)
  assert.equal(edit.endCharacter, end.character)
  assert.notEqual(edit.newText, BUTTON_FIXED)
}

async function confirmedInsideFolder(api: EditorApi, root: string): Promise<void> {
  const file = writeFile(root, 'src/Inside.vue', BUTTON)
  const document = await openFile(file)
  calls.length = 0
  const result = await api.applyConfirmedEdits(
    base(root, path.join(root, 'src'), [file], [tabindex(file)]),
    textDuring(file).hooks,
  )
  assert.equal(result.wrote, true)
  assert.equal(document.getText(), BUTTON_FIXED)
  assert.equal(fs.readFileSync(file, 'utf8'), BUTTON_FIXED)
  assert.equal(calls.length, 1)
}

async function confirmedBatch(api: EditorApi, root: string): Promise<void> {
  const first = writeFile(root, 'batch/A.vue', BUTTON)
  const second = writeFile(root, 'batch/B.vue', BUTTON)
  await openFile(first)
  await openFile(second)
  const during = textDuring(first)
  calls.length = 0
  const result = await api.applyConfirmedEdits(base(root, null, [first, second], [tabindex(first), tabindex(second)]), during.hooks)
  assert.equal(result.wrote, true)
  assert.equal(fs.readFileSync(first, 'utf8'), BUTTON_FIXED)
  assert.equal(fs.readFileSync(second, 'utf8'), BUTTON_FIXED)
  assert.equal(during.order.filter((step) => step === 'recheck').length, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groups.length, 2)
  const edited = new Set(calls[0].groups.map((group) => path.resolve(group.file)))
  assert.ok(edited.has(path.resolve(first)))
  assert.ok(edited.has(path.resolve(second)))
  for (const group of calls[0].groups) {
    assert.equal(group.edits.length, 1)
    assert.equal(group.edits[0].newText, '0')
  }
}

async function confirmedAdjacent(api: EditorApi, root: string): Promise<void> {
  const source = '<div></div>\n'
  const file = writeFile(root, 'adjacent/Widget.vue', source)
  calls.length = 0
  const result = await api.applyConfirmedEdits(base(root, null, [file], [
    { file, start: 0, end: 2, insert: 'ab' },
    { file, start: 2, end: 4, insert: 'cd' },
  ], { [file]: source }), textDuring(file).hooks)
  assert.equal(result.wrote, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcd></div>\n')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groups.length, 1)
  assert.deepEqual(calls[0].groups[0].edits.map((edit) => edit.newText).sort(), ['ab', 'cd'])
}

async function confirmedDuplicate(api: EditorApi, root: string): Promise<void> {
  const file = writeFile(root, 'duplicate/Button.vue', BUTTON)
  calls.length = 0
  const edit = tabindex(file)
  const result = await api.applyConfirmedEdits(base(root, null, [file], [edit, { ...edit }]), textDuring(file).hooks)
  assert.equal(result.wrote, true)
  assert.equal(fs.readFileSync(file, 'utf8'), BUTTON_FIXED)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].groups[0].edits.length, 1)
  assert.equal(calls[0].groups[0].edits[0].newText, '0')
}

async function unconfirmed(api: EditorApi, root: string): Promise<void> {
  const missing = path.join(root, 'missing-confirm.vue')
  calls.length = 0
  const during = textDuring(missing)
  const result = await api.applyConfirmedEdits({
    confirmed: false,
    workspaceRoot: root,
    projectRoot: root,
    auditScope: null,
    snapshots: {},
    edits: [{ file: missing, start: 0, end: 0, insert: 'x' }],
  }, during.hooks)
  assert.equal(result.wrote, false)
  if (result.wrote) return
  assert.equal(result.reason, undefined)
  assert.equal(fs.existsSync(missing), false)
  assert.deepEqual(during.order, [])
  assert.equal(calls.length, 0)
}

async function staleBuffer(api: EditorApi, root: string): Promise<void> {
  const first = writeFile(root, 'stale-buffer/A.vue', BUTTON)
  const second = writeFile(root, 'stale-buffer/B.vue', BUTTON)
  const dirty = await openFile(second)
  const edited = await vscode.window.showTextDocument(dirty)
  const changed = await edited.edit((builder) => builder.insert(new vscode.Position(0, 0), 'X'))
  assert.equal(changed, true)
  await refuse(api, base(root, null, [first, second], [tabindex(first), tabindex(second)]), 'STALE', [
    [first, BUTTON],
    [second, BUTTON],
  ], [[dirty, `X${BUTTON}`]])
}

async function staleDisk(api: EditorApi, root: string): Promise<void> {
  const first = writeFile(root, 'stale-disk/A.vue', BUTTON)
  const second = writeFile(root, 'stale-disk/B.vue', BUTTON)
  fs.writeFileSync(second, `${BUTTON}\n`)
  await refuse(api, base(root, null, [first, second], [tabindex(first), tabindex(second)]), 'STALE', [
    [first, BUTTON],
    [second, `${BUTTON}\n`],
  ])
}

async function overlap(api: EditorApi, root: string): Promise<void> {
  const first = writeFile(root, 'overlap/A.vue', BUTTON)
  const second = writeFile(root, 'overlap/B.vue', BUTTON)
  await refuse(api, base(root, null, [first, second], [
    { file: first, start: 0, end: 5, insert: 'aaaaa' },
    { file: first, start: 3, end: 8, insert: 'bbbb' },
    tabindex(second),
  ]), 'OVERLAP', [
    [first, BUTTON],
    [second, BUTTON],
  ])
}

async function folderScope(api: EditorApi, root: string): Promise<void> {
  const inside = writeFile(root, 'src/App.vue', BUTTON)
  const outside = writeFile(root, 'index.html', BUTTON)
  await refuse(api, base(root, path.join(root, 'src'), [inside, outside], [tabindex(inside), tabindex(outside)]), 'OUTSIDE_SCOPE', [
    [inside, BUTTON],
    [outside, BUTTON],
  ])
}

async function fileScope(api: EditorApi, root: string): Promise<void> {
  const target = writeFile(root, 'src/App.vue', BUTTON)
  const sibling = writeFile(root, 'src/Other.vue', BUTTON)
  await refuse(api, base(root, target, [target, sibling], [tabindex(target), tabindex(sibling)]), 'OUTSIDE_SCOPE', [
    [target, BUTTON],
    [sibling, BUTTON],
  ])
}

async function excludedDirectory(api: EditorApi, root: string): Promise<void> {
  const banned = writeFile(root, 'node_modules/Widget.vue', BUTTON)
  const allowed = writeFile(root, 'src/App.vue', BUTTON)
  await refuse(api, base(root, null, [banned, allowed], [tabindex(banned), tabindex(allowed)]), 'OUTSIDE_SCOPE', [
    [banned, BUTTON],
    [allowed, BUTTON],
  ])
}

async function outsideWorkspace(api: EditorApi, root: string): Promise<void> {
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-foreign-'))
  try {
    const foreign = path.join(foreignDir, 'Widget.vue')
    fs.writeFileSync(foreign, BUTTON)
    const inside = writeFile(root, 'src/App.vue', BUTTON)
    await refuse(api, base(root, null, [foreign, inside], [tabindex(foreign), tabindex(inside)]), 'OUTSIDE_WORKSPACE', [
      [foreign, BUTTON],
      [inside, BUTTON],
    ])
  } finally {
    fs.rmSync(foreignDir, { recursive: true, force: true })
  }
}

async function unsafe(api: EditorApi, root: string): Promise<void> {
  const imageText = '<template><img src="photo.png"></template>\n'
  const button = writeFile(root, 'unsafe/Button.vue', BUTTON)
  const image = writeFile(root, 'unsafe/Image.vue', imageText)
  const at = imageText.indexOf('>')
  await refuse(api, base(root, null, [button, image], [
    tabindex(button),
    { file: image, start: at, end: at, insert: ' alt="Фото"' },
  ], { [button]: BUTTON, [image]: imageText }), 'UNSAFE', [
    [button, BUTTON],
    [image, '<template><img src="photo.png"></template>\n'],
  ])
}

async function recheckFails(api: EditorApi, root: string): Promise<void> {
  const file = writeFile(root, 'recheck/Button.vue', BUTTON)
  const order: string[] = []
  calls.length = 0
  await assert.rejects(() => api.applyConfirmedEdits(base(root, null, [file], [tabindex(file)]), {
    invalidate() {
      order.push('invalidate')
    },
    onWritten() {
      order.push('written')
    },
    async recheck() {
      order.push('recheck')
      throw new Error('AUDIT_FAILED')
    },
  }), /AUDIT_FAILED/)
  assert.equal(fs.readFileSync(file, 'utf8'), BUTTON_FIXED)
  assert.deepEqual(order, ['invalidate', 'written', 'recheck'])
  assert.equal(calls.length, 1)
}

async function undoProbe(api: EditorApi, root: string): Promise<void> {
  const single = writeFile(root, 'undo/Single.vue', BUTTON)
  const document = await openFile(single)
  calls.length = 0
  const singleResult = await api.applyConfirmedEdits(base(root, null, [single], [tabindex(single)]))
  assert.equal(singleResult.wrote, true)
  assert.equal(calls.length, 1)
  await vscode.window.showTextDocument(document)
  await vscode.commands.executeCommand('undo')
  console.log(`editor-undo single ${document.getText() === BUTTON ? 'reverted' : 'kept'}`)

  const first = writeFile(root, 'undo/A.vue', BUTTON)
  const second = writeFile(root, 'undo/B.vue', BUTTON)
  const firstDocument = await openFile(first)
  const secondDocument = await openFile(second)
  calls.length = 0
  const batch = await api.applyConfirmedEdits(base(root, null, [first, second], [tabindex(first), tabindex(second)]))
  assert.equal(batch.wrote, true)
  assert.equal(calls.length, 1)
  await vscode.window.showTextDocument(firstDocument)
  await vscode.commands.executeCommand('undo')
  const firstState = firstDocument.getText() === BUTTON ? 'reverted' : 'kept'
  const secondState = secondDocument.getText() === BUTTON ? 'reverted' : 'kept'
  console.log(`editor-undo batch ${path.basename(first)} ${firstState} ${path.basename(second)} ${secondState}`)
}

async function refuse(
  api: EditorApi,
  request: EditorRequest,
  reason: ApplyReason,
  files: Array<[string, string]>,
  buffers: Array<[vscode.TextDocument, string]> = [],
): Promise<void> {
  const during = textDuring(files[0]?.[0] ?? '')
  calls.length = 0
  const result = await api.applyConfirmedEdits(request, during.hooks)
  assert.equal(result.wrote, false)
  if (result.wrote) return
  assert.equal(result.reason, reason)
  assert.deepEqual(during.order, [])
  assert.equal(calls.length, 0)
  for (const [file, text] of files) assert.equal(fs.readFileSync(file, 'utf8'), text, file)
  for (const [document, text] of buffers) assert.equal(document.getText(), text)
}

function base(
  root: string,
  auditScope: string | null,
  files: string[],
  edits: TextEdit[],
  snapshots: Record<string, string> = {},
): EditorRequest {
  const recorded: Record<string, string> = {}
  for (const file of files) recorded[file] = snapshots[file] ?? BUTTON
  return {
    confirmed: true,
    workspaceRoot: root,
    projectRoot: root,
    auditScope,
    snapshots: recorded,
    edits,
  }
}

function tabindex(file: string): TextEdit {
  const start = BUTTON.indexOf('3')
  return { file, start, end: start + 1, insert: '0' }
}

function writeFile(root: string, relative: string, text: string): string {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

async function openFile(file: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(file)
  await vscode.window.showTextDocument(document, { preview: false })
  return document
}

function textDuring(file: string): { order: string[]; recheckText: string[]; hooks: EditorEffects } {
  const order: string[] = []
  const recheckText: string[] = []
  return {
    order,
    recheckText,
    hooks: {
      invalidate() {
        order.push('invalidate')
      },
      onWritten() {
        order.push('written')
      },
      async recheck() {
        order.push('recheck')
        if (file && fs.existsSync(file)) recheckText.push(fs.readFileSync(file, 'utf8'))
      },
    },
  }
}

function settled(result: EditorResult, file: string): string | undefined {
  if (!result.wrote) return undefined
  const resolved = path.resolve(file)
  for (const [key, value] of Object.entries(result.files)) {
    if (path.resolve(key) === resolved) return value
  }
  return undefined
}

async function loadApi(): Promise<EditorApi> {
  const extension = vscode.extensions.getExtension('a11y-fixer.a11y-fixer')
  if (!extension) {
    const ids = vscode.extensions.all.map((item) => item.id).join(', ')
    throw new Error(`A11y Fixer is not loaded in this window: ${ids}`)
  }
  const api = await extension.activate() as Partial<EditorApi> | undefined
  if (!api || typeof api.applyConfirmedEdits !== 'function') {
    throw new Error('the editor did not expose applyConfirmedEdits')
  }
  return api as EditorApi
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root) throw new Error('the test window has no workspace folder')
  return root
}

function installApplyWatch(): void {
  const workspace = vscode.workspace as unknown as {
    applyEdit: (edit: { entries?: () => Array<[vscode.Uri, vscode.TextEdit[]]> }, metadata?: unknown) => Thenable<boolean>
  }
  const original = workspace.applyEdit.bind(vscode.workspace)
  workspace.applyEdit = (edit, metadata) => {
    if (edit && typeof edit.entries === 'function') {
      calls.push({
        groups: edit.entries().map(([uri, edits]) => ({
          file: uri.fsPath,
          edits: edits.map((item) => ({
            file: uri.fsPath,
            startLine: item.range.start.line,
            startCharacter: item.range.start.character,
            endLine: item.range.end.line,
            endCharacter: item.range.end.character,
            newText: item.newText,
          })),
        })),
      })
    } else {
      calls.push({ groups: [] })
    }
    return original(edit, metadata)
  }
  restoreApply = () => {
    workspace.applyEdit = original
  }
}

async function cleanup(): Promise<void> {
  for (const document of [...vscode.workspace.textDocuments]) {
    if (!document.isDirty || document.uri.scheme !== 'file') continue
    await vscode.window.showTextDocument(document, { preview: false })
    await vscode.commands.executeCommand('workbench.action.files.revert')
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
}

const vscode = acquireVsCodeApi()
let state = {
  status: 'idle',
  message: '',
  ui: null,
  language: '',
  started: false,
  issues: [],
  scopeKind: 'project',
  scopePath: '',
  outOfScope: [],
  unmapped: [],
  pageUrl: '',
  pageCount: { done: 0, total: 0 },
  visits: [],
  fileErrors: [],
}
let tab = 'quick'
let selectedId = ''

window.addEventListener('message', (event) => {
  state = event.data
  render()
})

function render() {
  const root = document.getElementById('app')
  const ui = state.ui
  root.replaceChildren()
  if (!ui) return
  if (document.documentElement && state.language) document.documentElement.lang = state.language
  root.append(toolbar(ui))
  if (state.started && state.status !== 'idle' && state.status !== 'running') root.append(reportHint(ui))
  const status = el('div', `status ${state.status || 'idle'}`)
  status.setAttribute('role', 'status')
  status.textContent = statusText(ui)
  root.append(status)
  if (state.message) root.append(el('div', state.status === 'error' ? 'banner error' : 'banner', state.message))
  if (!state.started) {
    root.append(el('p', 'empty', ui.empty))
    return
  }
  root.append(scopeBar(ui))
  if (showProgress()) root.append(progress(ui))
  const many = state.pageCount?.total > 1
  if (state.pageUrl) {
    root.append(el('p', 'limit', `${many ? ui.pageLatest : ui.page}: ${state.pageUrl}`))
    root.append(el('p', 'limit', many ? ui.coverageMany : ui.coverage))
  }
  const skipped = (state.visits ?? []).filter((visit) => visit.state === 'skipped')
  if (skipped.length) root.append(skippedPages(ui, skipped))
  if (state.fileErrors?.length) root.append(fileErrors(ui))
  root.append(el('p', 'limit', ui.notWcag))
  if (state.outOfScope?.length || state.unmapped?.length) root.append(aside(ui))
  root.append(tabs(ui))
  const visible = state.issues.filter((issue) => issue.tab === tab)
  if (!visible.some((issue) => issue.id === selectedId)) selectedId = visible[0]?.id ?? ''
  const list = el('div', 'list')
  if (visible.length === 0) list.append(el('p', 'empty', ui[`${tab}Empty`]))
  for (const issue of visible) list.append(card(issue, ui, issue.id === selectedId))
  root.append(list)
  if (tab === 'quick' && state.issues.some((issue) => issue.canFix)) root.append(footer(ui))
}

function showProgress() {
  const count = state.pageCount
  if (!count || count.total <= 0) return false
  return state.status === 'running' || count.done < count.total
}

function statusText(ui) {
  if (state.status === 'running' && state.pageCount?.total > 0) return `${ui.auditing} ${progressLabel(ui)}`
  if (state.status === 'running') return ui.auditing
  if (state.status === 'ready') return ui.statusReady
  if (state.status === 'error') return ui.statusError
  return ui.statusIdle
}

function toolbar(ui) {
  const bar = el('div', 'toolbar')
  const running = state.status === 'running'
  if (!state.started) {
    const pick = button(ui.pickScope, () => vscode.postMessage({ type: 'pickScope' }))
    pick.classList.add('primary')
    pick.disabled = running
    bar.append(pick)
    const whole = button(ui.auditProject, () => vscode.postMessage({ type: 'auditProject' }))
    whole.disabled = running
    bar.append(whole)
    return bar
  }
  const check = button(running ? ui.auditing : ui.audit, () => vscode.postMessage({ type: 'audit' }))
  check.classList.add('primary')
  check.disabled = running
  bar.append(check)
  if (running) bar.append(button(ui.cancel, () => vscode.postMessage({ type: 'cancel' })))
  if (state.status !== 'idle') bar.append(reportButton(ui))
  const pick = button(ui.pickScope, () => vscode.postMessage({ type: 'pickScope' }))
  pick.disabled = running
  bar.append(pick)
  return bar
}

function reportButton(ui) {
  const item = button(ui.report, () => vscode.postMessage({ type: 'report' }))
  item.classList.add('report')
  item.disabled = state.status === 'running'
  if (state.status !== 'running') item.setAttribute('aria-describedby', 'report-hint')
  return item
}

function reportHint(ui) {
  const hint = el('p', 'hint', ui.reportNote)
  hint.setAttribute('id', 'report-hint')
  return hint
}

function scopeBar(ui) {
  const line = el('div', 'scope')
  if (state.scopePath) {
    line.append(el('span', '', `${ui.scopeFolder}: ${state.scopePath}`))
    const whole = button(ui.auditProject, () => vscode.postMessage({ type: 'auditProject' }))
    whole.disabled = state.status === 'running'
    line.append(whole)
  } else {
    line.append(el('span', '', ui.scopeProject))
  }
  return line
}

function aside(ui) {
  const box = el('div', 'aside')
  box.append(el('p', 'note', ui.notInFixes))
  if (state.outOfScope?.length) {
    box.append(el('div', 'note', `${ui.outOfScopeTitle} (${state.outOfScope.length})`))
    for (const item of state.outOfScope) {
      const row = el('div', 'aside-row')
      const label = item.file ? `${item.ruleId} · ${item.file}${item.line ? ':' + item.line : ''}` : item.ruleId
      row.append(el('span', '', label))
      if (item.canReveal) row.append(button(ui.reveal, () => vscode.postMessage({ type: 'reveal', id: item.id })))
      box.append(row)
    }
  }
  if (state.unmapped?.length) {
    box.append(el('div', 'note', `${ui.unmappedTitle} (${state.unmapped.length})`))
    for (const item of state.unmapped) {
      const row = el('div', 'aside-row')
      row.append(el('span', '', item.ruleId))
      if (item.dom) row.append(el('code', 'path', item.dom.replace(/\s+/g, ' ').slice(0, 80)))
      box.append(row)
    }
  }
  return box
}

function tabs(ui) {
  const bar = el('div', 'tabs')
  bar.setAttribute('role', 'tablist')
  for (const id of ['quick', 'manual', 'ambiguous']) {
    const count = state.issues.filter((issue) => issue.tab === id).length
    const item = button(`${ui[id]} (${count})`, () => {
      tab = id
      render()
    })
    item.setAttribute('role', 'tab')
    item.setAttribute('aria-selected', String(tab === id))
    bar.append(item)
  }
  return bar
}

function card(issue, ui, selected) {
  const box = el('article', 'card')
  const header = button('', () => {
    selectedId = issue.id
    render()
  })
  header.classList.add('row')
  if (selected) header.classList.add('selected')
  header.setAttribute('aria-expanded', String(selected))
  const title = issue.help || issue.ruleId
  header.append(el('span', 'title', title))
  const meta = el('span', 'meta')
  const place = issue.file ? (issue.line ? `${issue.file}:${issue.line}` : issue.file) : ''
  metaPart(meta, 'rule', issue.ruleId && issue.ruleId !== title ? issue.ruleId : '')
  metaPart(meta, `impact ${issue.impact || ''}`.trim(), issue.impactLabel)
  metaPart(meta, 'place', place)
  metaPart(meta, 'origin', originText(issue, ui, true))
  if (meta.textContent) {
    header.append(meta)
    header.setAttribute('aria-label', `${title}. ${meta.textContent}`)
  }
  box.append(header)
  if (selected) box.append(detail(issue, ui))
  return box
}

function metaPart(meta, className, text) {
  if (!text) return
  if (meta.children.length) meta.append(el('span', 'sep', ' · '))
  meta.append(el('span', className, text))
}

function originText(issue, ui, short) {
  const table = short ? ui?.originShort : ui?.origin
  if (!issue.origin || !table) return ''
  return table[issue.origin] || ''
}

function progress(ui) {
  const box = el('div', 'progress')
  const bar = el('progress', '')
  bar.max = state.pageCount.total
  bar.value = state.pageCount.done
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', String(state.pageCount.total))
  bar.setAttribute('aria-valuenow', String(state.pageCount.done))
  box.append(bar)
  box.append(el('p', 'limit', progressLabel(ui)))
  return box
}

function progressLabel(ui) {
  return ui.progressPattern
    .replace('{done}', String(state.pageCount.done))
    .replace('{total}', String(state.pageCount.total))
}

function skippedPages(ui, skipped) {
  const box = el('div', 'aside')
  box.append(el('div', 'note', `${ui.skippedPages} (${skipped.length})`))
  for (const visit of skipped) {
    const place = visit.file ? `${visit.path} · ${visit.file}` : visit.path
    const label = visit.reason ? `${place}: ${visit.reason}` : place
    box.append(el('div', 'aside-row', label))
  }
  return box
}

function fileErrors(ui) {
  const box = el('div', 'aside')
  box.append(el('div', 'note', ui.fileErrors))
  for (const error of state.fileErrors) {
    const label = error.file ? `${error.file}: ${error.message}` : error.message
    box.append(el('div', 'aside-row', label))
  }
  return box
}

function detail(issue, ui) {
  const box = el('div', 'detail')
  const origin = originText(issue, ui, false)
  if (origin) box.append(el('p', '', origin))
  if (issue.description) box.append(el('p', '', issue.description))
  if (issue.reason) box.append(el('p', '', issue.reason))
  if (issue.failureSummary) box.append(el('p', 'note', issue.failureSummary))
  const diff = Boolean(issue.canFix && (issue.before || issue.after))
  if (issue.source && !(diff && issue.source === issue.before)) {
    box.append(el('div', 'note', ui.source))
    box.append(el('pre', '', issue.source))
  }
  if (!issue.source && issue.dom) {
    box.append(el('div', 'note', ui.dom))
    box.append(el('pre', '', issue.dom))
  }
  if (diff) {
    if (issue.before) {
      box.append(el('div', 'note', ui.before))
      box.append(el('pre', 'before', issue.before))
    }
    if (issue.after) {
      box.append(el('div', 'note', ui.proposed))
      box.append(el('pre', 'after', issue.after))
    }
  }
  const actions = el('div', 'actions')
  if (issue.canReveal) actions.append(button(ui.reveal, () => vscode.postMessage({ type: 'reveal', id: issue.id })))
  if (issue.canFix) {
    const fix = button(ui.fix, () => vscode.postMessage({ type: 'fix', id: issue.id }))
    fix.classList.add('primary')
    fix.disabled = state.status === 'running'
    actions.append(fix)
  }
  if (issue.helpUrl) actions.append(button(ui.docs, () => vscode.postMessage({ type: 'open', url: issue.helpUrl })))
  box.append(actions)
  return box
}

function footer(ui) {
  const bar = el('div', 'footer')
  bar.append(el('p', 'note', ui.fixNote))
  const fixes = state.issues.some((issue) => issue.canFix)
  bar.append(action(ui.fixAll, 'fixAll', !fixes))
  const rerun = action(ui.fixAllRerun, 'fixAllRerun', !fixes)
  rerun.classList.add('primary')
  bar.append(rerun)
  return bar
}

function action(label, type, disabled) {
  const item = button(label, () => vscode.postMessage({ type }))
  item.disabled = disabled || state.status === 'running'
  return item
}

function button(label, onClick) {
  const item = el('button', '', label)
  item.type = 'button'
  item.addEventListener('click', onClick)
  return item
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

render()

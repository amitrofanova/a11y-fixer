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
  root.append(el('p', 'limit', ui.notWcag))
  if (state.outOfScope?.length || state.unmapped?.length) root.append(aside(ui))
  root.append(tabs(ui))
  const visible = state.issues.filter((issue) => issue.tab === tab)
  if (!visible.some((issue) => issue.id === selectedId)) selectedId = visible[0]?.id ?? ''
  const list = el('div', 'list')
  if (visible.length === 0) list.append(el('p', 'empty', ui[`${tab}Empty`]))
  for (const issue of visible) list.append(card(issue, ui, issue.id === selectedId))
  root.append(list)
  if (tab === 'quick') root.append(footer(ui))
}

function statusText(ui) {
  if (state.status === 'running') return ui.auditing
  if (state.status === 'ready') return ui.statusReady
  if (state.status === 'error') return ui.statusError
  return ui.statusIdle
}

function toolbar(ui) {
  const bar = el('div', 'toolbar')
  const pick = button(ui.pickScope, () => vscode.postMessage({ type: 'pickScope' }))
  pick.classList.add('primary')
  pick.disabled = state.status === 'running'
  bar.append(pick)
  if (state.started) {
    const check = button(state.status === 'running' ? ui.auditing : ui.audit, () => vscode.postMessage({ type: 'audit' }))
    check.disabled = state.status === 'running'
    bar.append(check)
  } else {
    const whole = button(ui.auditProject, () => vscode.postMessage({ type: 'auditProject' }))
    whole.disabled = state.status === 'running'
    bar.append(whole)
  }
  return bar
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
  const header = button(summary(issue), () => {
    selectedId = issue.id
    render()
  })
  header.classList.add('row')
  if (selected) header.classList.add('selected')
  header.setAttribute('aria-expanded', String(selected))
  box.append(header)
  if (selected) box.append(detail(issue, ui))
  return box
}

function summary(issue) {
  const place = issue.file ? (issue.line ? `${issue.file}:${issue.line}` : issue.file) : ''
  return [issue.ruleId, issue.impactLabel, place].filter(Boolean).join(' · ')
}

function detail(issue, ui) {
  const box = el('div', 'detail')
  if (issue.help) box.append(el('h3', '', issue.help))
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
  const fixes = state.issues.some((issue) => issue.canFix)
  bar.append(action(ui.fixAll, 'fixAll', !fixes))
  const rerun = action(ui.fixAllRerun, 'fixAllRerun', !fixes)
  rerun.classList.add('primary')
  bar.append(rerun)
  bar.append(action(ui.report, 'report', state.issues.length === 0))
  bar.append(el('span', 'note', ui.reportNote))
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

/* stet client — vanilla ES module, no dependencies */

const TOKEN = new URLSearchParams(location.search).get('t') || ''

const $ = id => document.getElementById(id)
const sidebar = $('sidebar')

const fileList = $('file-list')
const diffContainer = $('diff-container')
const emptyState = $('empty-state')

const state = {
  tab: 'work',            // 'work' | 'branch'
  view: 'unified',        // 'unified' | 'split'
  selected: null,         // { where, file }
  work: null,             // /api/state payload
  branch: null,           // /api/branch payload
  base: null,             // user-selected comparison base (null = server default)
  etag: null,
  navList: [],            // flattened [{where, file}] in sidebar order
  hunks: [],              // raw hunk text of the open diff
  hunkFocus: null         // focused hunk index, or null = file level
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api (path, body) {
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Stet-Token': TOKEN }
  }
  if (body) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.detail = data.detail
    throw err
  }
  return data
}

// ---------------------------------------------------------------------------
// Toasts + modal
// ---------------------------------------------------------------------------
function toast (msg, { error = false, detail } = {}) {
  const el = document.createElement('div')
  el.className = 'toast' + (error ? ' error' : '')
  el.textContent = msg
  if (detail) {
    const pre = document.createElement('pre')
    pre.textContent = detail
    el.appendChild(pre)
  }
  el.onclick = () => el.remove()
  $('toasts').appendChild(el)
  setTimeout(() => el.remove(), error ? 9000 : 3500)
}

function confirmModal (title, body, confirmLabel = 'Discard') {
  return new Promise(resolve => {
    $('modal-title').textContent = title
    $('modal-body').textContent = body
    $('modal-confirm').textContent = confirmLabel
    $('modal').hidden = false
    const done = ok => { $('modal').hidden = true; cleanup(); resolve(ok) }
    const onConfirm = () => done(true)
    const onCancel = () => done(false)
    const onKey = e => {
      if (e.key === 'Escape' || e.key === 'n') { e.preventDefault(); done(false) } else if (e.key === 'Enter' || e.key === 'y') { e.preventDefault(); done(true) }
      e.stopPropagation()
    }
    function cleanup () {
      $('modal-confirm').removeEventListener('click', onConfirm)
      $('modal-cancel').removeEventListener('click', onCancel)
      document.removeEventListener('keydown', onKey, true)
    }
    $('modal-confirm').addEventListener('click', onConfirm)
    $('modal-cancel').addEventListener('click', onCancel)
    document.addEventListener('keydown', onKey, true) // capture: shadow the global handler
  })
}

// ---------------------------------------------------------------------------
// Diff parsing — unified diff text → hunks with raw text preserved
// ---------------------------------------------------------------------------
function parseDiff (text) {
  const lines = text.split('\n')
  const hunks = []
  let cur = null
  let adds = 0
  let dels = 0

  for (const line of lines) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (m) {
      cur = {
        header: line,
        oldStart: Number(m[1]),
        newStart: Number(m[3]),
        context: m[5].trim(),
        lines: [],
        raw: [line]
      }
      hunks.push(cur)
      continue
    }
    if (!cur) continue // skip file header lines (diff --git, index, ---, +++)
    if (line.startsWith('+')) { cur.lines.push({ type: 'add', text: line.slice(1) }); cur.raw.push(line); adds++ } else if (line.startsWith('-')) { cur.lines.push({ type: 'del', text: line.slice(1) }); cur.raw.push(line); dels++ } else if (line.startsWith(' ')) { cur.lines.push({ type: 'ctx', text: line.slice(1) }); cur.raw.push(line) } else if (line.startsWith('\\')) { cur.lines.push({ type: 'meta', text: line }); cur.raw.push(line) }
    // anything else (e.g. trailing empty string from final \n) ends nothing — ignored
  }

  // assign line numbers
  for (const h of hunks) {
    let o = h.oldStart
    let n = h.newStart
    for (const l of h.lines) {
      if (l.type === 'ctx') { l.oldNo = o++; l.newNo = n++ } else if (l.type === 'del') { l.oldNo = o++ } else if (l.type === 'add') { l.newNo = n++ }
    }
  }
  return { hunks, adds, dels }
}

// ---------------------------------------------------------------------------
// Rendering — sidebar
// ---------------------------------------------------------------------------
const ICONS = {
  stage: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M7.25 14a.75.75 0 0 0 1.5 0V4.56l3.22 3.22a.75.75 0 1 0 1.06-1.06L8.53 2.22a.75.75 0 0 0-1.06 0L2.97 6.72a.75.75 0 0 0 1.06 1.06l3.22-3.22V14Z" transform="rotate(180 8 8)"/></svg>',
  unstage: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M7.25 14a.75.75 0 0 0 1.5 0V4.56l3.22 3.22a.75.75 0 1 0 1.06-1.06L8.53 2.22a.75.75 0 0 0-1.06 0L2.97 6.72a.75.75 0 0 0 1.06 1.06l3.22-3.22V14Z"/></svg>',
  discard: '<svg viewBox="0 0 16 16" width="13" height="13"><path fill="currentColor" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>'
}

function fileRow ({ entry, where, actions }) {
  const row = document.createElement('button')
  row.className = 'file-row'
  if (state.selected && state.selected.where === where && state.selected.file === entry.path) {
    row.classList.add('selected')
  }
  const st = entry.status === '?' ? '?' : entry.status
  const stClass = st === '?' ? 'questionmark' : st
  const label = entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path

  row.innerHTML = `
    <span class="status status-${stClass}">${st === '?' ? 'A' : st}</span>
    <span class="name" title="${escAttr(label)}"><bdi>${esc(label)}</bdi></span>
    <span class="row-actions"></span>`

  const actionsEl = row.querySelector('.row-actions')
  for (const a of actions) {
    const b = document.createElement('button')
    b.className = a.kind
    b.title = a.title
    b.innerHTML = ICONS[a.kind]
    b.onclick = ev => { ev.stopPropagation(); a.run() }
    actionsEl.appendChild(b)
  }
  row.onclick = () => selectFile(where, entry.path)
  return row
}

function group (title, entries, where, makeActions) {
  const frag = document.createDocumentFragment()
  const h = document.createElement('div')
  h.className = 'group-header'
  h.innerHTML = `${title} <span class="count">${entries.length}</span>`
  frag.appendChild(h)
  for (const e of entries) {
    frag.appendChild(fileRow({ entry: e, where, actions: makeActions(e) }))
  }
  return frag
}

function buildNavList () {
  state.navList = []
  if (state.tab === 'work') {
    const w = state.work
    if (!w) return
    for (const e of w.staged) state.navList.push({ where: 'staged', file: e.path })
    for (const e of w.unstaged) state.navList.push({ where: 'unstaged', file: e.path })
    for (const e of w.untracked) state.navList.push({ where: 'untracked', file: e.path })
  } else {
    for (const c of state.branch?.commits || []) state.navList.push({ where: 'commit', file: c.sha })
    for (const e of state.branch?.files || []) state.navList.push({ where: 'branch', file: e.path })
  }
}

function renderSidebar () {
  buildNavList()
  fileList.textContent = ''
  renderCommitPanel()
  if (state.tab === 'work') {
    const w = state.work
    if (!w) return
    const total = w.staged.length + w.unstaged.length + w.untracked.length
    if (total === 0) {
      fileList.innerHTML = '<div class="sidebar-empty">Working tree clean ✨</div>'
      return
    }
    if (w.staged.length) {
      fileList.appendChild(group('Staged', w.staged, 'staged', e => [
        { kind: 'unstage', title: 'Unstage file', run: () => fileAction('unstage', e.path) }
      ]))
    }
    if (w.unstaged.length) {
      fileList.appendChild(group('Changes', w.unstaged, 'unstaged', e => [
        { kind: 'stage', title: 'Stage file', run: () => fileAction('stage', e.path) },
        { kind: 'discard', title: 'Discard changes', run: () => discardFile(e.path, false) }
      ]))
    }
    if (w.untracked.length) {
      fileList.appendChild(group('Untracked', w.untracked, 'untracked', e => [
        { kind: 'stage', title: 'Stage file', run: () => fileAction('stage', e.path) },
        { kind: 'discard', title: 'Delete file', run: () => discardFile(e.path, true) }
      ]))
    }
  } else {
    const b = state.branch
    if (!b) return
    fileList.appendChild(baseSelector(b))
    if (!b.base) {
      fileList.insertAdjacentHTML('beforeend', '<div class="sidebar-empty">No base branch detected</div>')
      return
    }
    if (!b.commits.length && !b.files.length) {
      fileList.insertAdjacentHTML('beforeend', `<div class="sidebar-empty">No commits vs <b>${esc(b.base)}</b></div>`)
      return
    }
    if (b.commits.length) fileList.appendChild(commitGroup(b.commits))
    if (b.files.length) fileList.appendChild(group('Files changed', b.files, 'branch', () => []))
  }
}

function baseSelector (b) {
  const row = document.createElement('div')
  row.className = 'base-row'
  row.innerHTML = '<span>vs</span>'
  const sel = document.createElement('select')
  sel.title = 'comparison base'
  for (const ref of b.bases || []) {
    const opt = document.createElement('option')
    opt.value = ref
    opt.textContent = ref
    if (ref === b.base) opt.selected = true
    sel.appendChild(opt)
  }
  sel.onchange = async () => {
    state.base = sel.value
    state.selected = null
    await refresh()
  }
  sel.onkeydown = e => { if (e.key === 'Escape') sel.blur() }
  row.appendChild(sel)
  return row
}

function commitGroup (commits) {
  const frag = document.createDocumentFragment()
  const h = document.createElement('div')
  h.className = 'group-header'
  h.innerHTML = `Commits <span class="count">${commits.length}</span>`
  frag.appendChild(h)
  for (const c of commits) {
    const row = document.createElement('button')
    row.className = 'file-row commit-row'
    if (state.selected && state.selected.where === 'commit' && state.selected.file === c.sha) {
      row.classList.add('selected')
    }
    row.title = `${c.subject} — ${c.author}, ${c.date}`
    row.innerHTML = `<span class="sha">${esc(c.short)}</span><span class="name"><bdi>${esc(c.subject)}</bdi></span>`
    row.onclick = () => selectFile('commit', c.sha)
    frag.appendChild(row)
  }
  return frag
}

// ---------------------------------------------------------------------------
// Rendering — diff pane
// ---------------------------------------------------------------------------
function esc (s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
function escAttr (s) { return esc(s).replace(/"/g, '&quot;') }

async function selectFile (where, file) {
  state.selected = { where, file }
  renderSidebar()
  emptyState.hidden = true
  diffContainer.hidden = false
  diffContainer.innerHTML = '<div class="nodiff-note">Loading…</div>'
  try {
    if (where === 'commit') {
      const data = await api(`/api/commitdiff?sha=${encodeURIComponent(file)}`)
      renderCommit(data)
    } else {
      let url = `/api/diff?where=${encodeURIComponent(where)}&file=${encodeURIComponent(file)}`
      if (where === 'branch' && state.base) url += `&base=${encodeURIComponent(state.base)}`
      const data = await api(url)
      renderDiff(where, file, data)
    }
  } catch (e) {
    diffContainer.innerHTML = ''
    toast(`Failed to load diff: ${e.message}`, { error: true, detail: e.detail })
  }
}

// Split a multi-file patch into per-file chunks.
function splitDiff (text) {
  const files = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ')) {
      if (cur) files.push(cur)
      const m = line.match(/ b\/(.*)$/)
      cur = { path: m ? m[1] : line.replace(/^diff --(git|cc) /, ''), lines: [] }
    }
    if (cur) cur.lines.push(line)
  }
  if (cur) files.push(cur)
  return files.map(f => ({ path: f.path, text: f.lines.join('\n') }))
}

function renderCommit (data) {
  diffContainer.textContent = ''
  state.hunkFocus = null
  state.hunks = [] // read-only view: no hunk actions

  const meta = document.createElement('div')
  meta.className = 'commit-meta'
  meta.innerHTML = `
    <div class="subject"><span class="sha">${esc(data.short)}</span> ${esc(data.subject)}</div>
    <div class="byline">${esc(data.author)} · ${esc(data.date)}</div>
    ${data.body ? `<pre class="body">${esc(data.body)}</pre>` : ''}`
  diffContainer.appendChild(meta)

  const parts = splitDiff(data.diff)
  if (!parts.length) {
    diffContainer.insertAdjacentHTML('beforeend', '<div class="nodiff-note">Empty commit</div>')
    return
  }
  for (const p of parts) {
    const binary = /^Binary files .* differ$|^GIT binary patch$/m.test(p.text)
    const parsed = binary ? { hunks: [], adds: 0, dels: 0 } : parseDiff(p.text)
    diffContainer.appendChild(makeFileCard('commit', p.path, parsed, binary))
  }
}

function renderDiff (where, file, data) {
  diffContainer.textContent = ''
  state.hunkFocus = null
  const parsed = data.binary ? { hunks: [], adds: 0, dels: 0 } : parseDiff(data.diff)
  state.hunks = parsed.hunks.map(h => h.raw.join('\n') + '\n')
  diffContainer.appendChild(makeFileCard(where, file, parsed, data.binary))
}

function makeFileCard (where, file, parsed, binary) {
  const card = document.createElement('div')
  card.className = 'file-card'

  // --- header with file-level actions
  const header = document.createElement('div')
  header.className = 'file-header'
  header.innerHTML = `
    <span class="path">${esc(file)}</span>
    <span class="stats"><span class="plus">+${parsed.adds}</span> <span class="minus">−${parsed.dels}</span></span>
    <span class="spacer"></span>`
  for (const a of fileActionsFor(where, file)) {
    const b = document.createElement('button')
    b.className = 'btn' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : '')
    b.textContent = a.label
    b.onclick = a.run
    header.appendChild(b)
  }
  card.appendChild(header)

  // --- body
  if (binary) {
    card.insertAdjacentHTML('beforeend', '<div class="binary-note">Binary file — file-level actions only</div>')
  } else if (!parsed.hunks.length) {
    card.insertAdjacentHTML('beforeend', '<div class="nodiff-note">No textual changes (mode change or empty file)</div>')
  } else {
    for (const hunk of parsed.hunks) {
      card.appendChild(renderHunkHeader(where, file, hunk))
      card.appendChild(state.view === 'split' ? renderSplit(hunk) : renderUnified(hunk))
    }
  }
  return card
}

function fileActionsFor (where, file) {
  if (where === 'staged') {
    return [{ label: 'Unstage file', run: () => fileAction('unstage', file) }]
  }
  if (where === 'unstaged') {
    return [
      { label: 'Stage file', primary: true, run: () => fileAction('stage', file) },
      { label: 'Discard', danger: true, run: () => discardFile(file, false) }
    ]
  }
  if (where === 'untracked') {
    return [
      { label: 'Stage file', primary: true, run: () => fileAction('stage', file) },
      { label: 'Delete', danger: true, run: () => discardFile(file, true) }
    ]
  }
  return [] // branch tab: read-only
}

function renderHunkHeader (where, file, hunk) {
  const el = document.createElement('div')
  el.className = 'hunk-header'
  el.innerHTML = `<span class="range">${esc(hunk.header)}</span><span class="hunk-actions"></span>`
  const actions = el.querySelector('.hunk-actions')
  const raw = hunk.raw.join('\n') + '\n'

  const add = (label, op, danger) => {
    const b = document.createElement('button')
    b.className = 'btn' + (danger ? ' btn-danger' : '')
    b.textContent = label
    b.onclick = () => hunkAction(op, where, file, raw, danger)
    actions.appendChild(b)
  }
  if (where === 'unstaged') {
    add('Stage hunk', 'stage')
    add('Discard hunk', 'discard', true)
  } else if (where === 'staged') {
    add('Unstage hunk', 'unstage')
  }
  return el
}

function renderUnified (hunk) {
  const table = document.createElement('table')
  table.className = 'diff-table'
  const tbody = document.createElement('tbody')
  for (const l of hunk.lines) {
    const tr = document.createElement('tr')
    tr.className = l.type
    const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '
    tr.innerHTML = `
      <td class="lineno">${l.oldNo ?? ''}</td>
      <td class="lineno">${l.newNo ?? ''}</td>
      <td class="code"><span class="sign">${sign}</span>${esc(l.text)}</td>`
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

function renderSplit (hunk) {
  // pair deletion-runs with insertion-runs; mirror context lines
  const rows = []
  let i = 0
  const lines = hunk.lines.filter(l => l.type !== 'meta')
  while (i < lines.length) {
    const l = lines[i]
    if (l.type === 'ctx') {
      rows.push({ left: l, right: l })
      i++
    } else {
      const dels = []
      const adds = []
      while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++])
      while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++])
      const n = Math.max(dels.length, adds.length)
      for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null })
    }
  }

  const table = document.createElement('table')
  table.className = 'diff-table'
  const tbody = document.createElement('tbody')
  for (const r of rows) {
    const tr = document.createElement('tr')
    const lCls = r.left ? (r.left.type === 'del' ? 'del' : 'ctx') : 'empty'
    const rCls = r.right ? (r.right.type === 'add' ? 'add' : 'ctx') : 'empty'
    tr.innerHTML = `
      <td class="lineno ${lCls === 'del' ? 'num-del' : ''}">${r.left?.oldNo ?? ''}</td>
      <td class="code ${lCls === 'del' ? 'cell-del' : lCls === 'empty' ? 'cell-empty' : ''}">${r.left ? `<span class="sign">${r.left.type === 'del' ? '−' : ' '}</span>${esc(r.left.text)}` : ''}</td>
      <td class="lineno ${rCls === 'add' ? 'num-add' : ''}">${r.right?.newNo ?? ''}</td>
      <td class="code ${rCls === 'add' ? 'cell-add' : rCls === 'empty' ? 'cell-empty' : ''}">${r.right ? `<span class="sign">${r.right.type === 'add' ? '+' : ' '}</span>${esc(r.right.text)}` : ''}</td>`
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function fileAction (op, file) {
  await busy(async () => {
    await api(`/api/${op}`, { file })
    await refresh({ keepSelection: true })
  }, `${op} failed`)
}

async function discardFile (file, untracked) {
  const ok = await confirmModal(
    untracked ? 'Delete untracked file?' : 'Discard changes?',
    untracked
      ? `"${file}" is untracked — discarding will permanently delete the file from disk.`
      : `All unstaged changes in "${file}" will be permanently lost.`,
    untracked ? 'Delete file' : 'Discard'
  )
  if (!ok) return
  await busy(async () => {
    await api('/api/discard', { file, untracked })
    await refresh({ keepSelection: true })
  }, 'discard failed')
}

async function hunkAction (op, where, file, hunk, danger) {
  if (danger) {
    const ok = await confirmModal('Discard hunk?', `This hunk in "${file}" will be permanently lost.`)
    if (!ok) return
  }
  await busy(async () => {
    try {
      await api('/api/hunk', { op, where, file, hunk })
    } catch (e) {
      if (e.status === 409) toast('Hunk is stale — diff refreshed', { error: true })
      else throw e
    }
    await refresh({ keepSelection: true })
  }, `${op} hunk failed`)
}

async function busy (fn, errMsg) {
  document.body.classList.add('busy')
  try {
    await fn()
  } catch (e) {
    toast(`${errMsg}: ${e.message}`, { error: true, detail: e.detail })
  } finally {
    document.body.classList.remove('busy')
  }
}

// ---------------------------------------------------------------------------
// Commit panel
// ---------------------------------------------------------------------------
const commitPanel = $('commit-panel')
const subjectEl = $('commit-subject')
const bodyEl = $('commit-body')
const amendEl = $('commit-amend')
const commitBtn = $('commit-btn')

function renderCommitPanel () {
  commitPanel.hidden = state.tab !== 'work' || !state.work
  if (commitPanel.hidden) return
  const lc = state.work.lastCommit
  $('amend-info').textContent = lc ? `${lc.short} ${lc.subject}` : ''
  amendEl.disabled = !lc
  updateCommitButton()
}

function updateCommitButton () {
  const n = state.work ? state.work.staged.length : 0
  const amend = amendEl.checked
  commitBtn.textContent = amend
    ? 'Amend last commit'
    : n ? `Commit ${n} staged file${n > 1 ? 's' : ''}` : 'Commit'
  commitBtn.disabled = !subjectEl.value.trim() || (!n && !amend)

  const len = subjectEl.value.length
  const counter = $('subject-count')
  counter.textContent = len ? String(len) : ''
  counter.className = 'subject-count' + (len > 72 ? ' over' : len > 50 ? ' warn' : '')
  counter.title = len > 72 ? 'Subject over 72 chars' : len > 50 ? 'Subject over 50 chars — keep it short' : ''
}

async function doCommit () {
  const subject = subjectEl.value.trim()
  if (!subject || commitBtn.disabled) return
  const amend = amendEl.checked

  if (amend) {
    const b = state.work.branch
    const pushed = b.upstream && b.ahead === 0
    const ok = await confirmModal(
      'Amend last commit?',
      pushed
        ? 'The last commit appears to be pushed already — amending rewrites history and will require a force-push.'
        : 'The last commit will be replaced with the amended one.',
      'Amend'
    )
    if (!ok) return
  }

  await busy(async () => {
    const r = await api('/api/commit', { subject, body: bodyEl.value, amend })
    toast(`Committed ${r.short} — ${subject}`)
    subjectEl.value = ''
    bodyEl.value = ''
    amendEl.checked = false
    await refresh({ keepSelection: true })
  }, 'commit failed')
}

commitPanel.addEventListener('submit', e => { e.preventDefault(); doCommit() })
subjectEl.addEventListener('input', updateCommitButton)
amendEl.addEventListener('change', async () => {
  updateCommitButton()
  // prefill the last commit message when turning amend on into empty fields
  if (amendEl.checked && !subjectEl.value.trim() && !bodyEl.value.trim()) {
    try {
      const lc = await api('/api/lastcommit')
      subjectEl.value = lc.subject || ''
      bodyEl.value = lc.body || ''
      updateCommitButton()
    } catch {}
  }
})
for (const el of [subjectEl, bodyEl]) {
  el.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); doCommit() } else if (e.key === 'Escape') el.blur()
  })
}

// ---------------------------------------------------------------------------
// Refresh + polling
// ---------------------------------------------------------------------------
function whereStillExists () {
  const s = state.selected
  if (!s || !state.work) return false
  if (s.where === 'branch') return (state.branch?.files || []).some(f => f.path === s.file)
  if (s.where === 'commit') return (state.branch?.commits || []).some(c => c.sha === s.file)
  const list = { staged: state.work.staged, unstaged: state.work.unstaged, untracked: state.work.untracked }[s.where] || []
  return list.some(f => f.path === s.file)
}

async function refresh ({ keepSelection = false } = {}) {
  const branchUrl = '/api/branch' + (state.base ? `?base=${encodeURIComponent(state.base)}` : '')
  const [work, branch] = await Promise.all([api('/api/state'), api(branchUrl).catch(() => null)])
  state.work = work
  state.branch = branch

  $('repo-name').textContent = work.repo
  $('branch-chip').textContent = work.branch.head || 'detached'
  document.title = `stet — ${work.repo}`

  if (keepSelection && state.selected && whereStillExists()) {
    renderSidebar()
    await selectFile(state.selected.where, state.selected.file)
  } else {
    if (keepSelection) state.selected = null
    renderSidebar()
    if (!state.selected) {
      diffContainer.hidden = true
      diffContainer.textContent = ''
      emptyState.hidden = false
    }
  }
}

async function poll () {
  try {
    const { etag } = await api('/api/poll')
    if (state.etag && etag !== state.etag) await refresh({ keepSelection: true })
    state.etag = etag
  } catch { /* server gone or transient — keep trying */ }
}

// ---------------------------------------------------------------------------
// Top bar wiring
// ---------------------------------------------------------------------------
function setTab (tab) {
  state.tab = tab
  state.selected = null
  $('tab-work').classList.toggle('active', tab === 'work')
  $('tab-branch').classList.toggle('active', tab === 'branch')
  diffContainer.hidden = true
  diffContainer.textContent = ''
  emptyState.hidden = false
  renderSidebar()
}

function setView (view) {
  state.view = view
  $('view-unified').classList.toggle('active', view === 'unified')
  $('view-split').classList.toggle('active', view === 'split')
  if (state.selected) selectFile(state.selected.where, state.selected.file)
}

$('tab-work').onclick = () => setTab('work')
$('tab-branch').onclick = () => setTab('branch')
$('view-unified').onclick = () => setView('unified')
$('view-split').onclick = () => setView('split')
$('btn-refresh').onclick = () => refresh({ keepSelection: true })
$('btn-quit').onclick = async () => {
  const ok = await confirmModal('Quit stet?', 'The local server will shut down.', 'Quit')
  if (!ok) return
  try { await api('/api/quit', {}) } catch {}
  // message first — window.close() is best-effort (browsers may refuse)
  document.body.innerHTML = '<div class="empty-state" style="height:100vh"><p>stet server stopped — you can close this tab.</p></div>'
  window.close()
}

// ---------------------------------------------------------------------------
// Keyboard — vim-style bindings, ? for help
// ---------------------------------------------------------------------------
let pendingG = false
let pendingGTimer = null

function navIndex () {
  const s = state.selected
  if (!s) return -1
  return state.navList.findIndex(n => n.where === s.where && n.file === s.file)
}

function navTo (i) {
  if (!state.navList.length) return
  const n = state.navList[Math.max(0, Math.min(state.navList.length - 1, i))]
  selectFile(n.where, n.file)
  requestAnimationFrame(() => sidebar.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }))
}

function moveSelection (delta) {
  const i = navIndex()
  navTo(i === -1 ? (delta > 0 ? 0 : state.navList.length - 1) : i + delta)
}

function hunkHeaders () {
  return [...diffContainer.querySelectorAll('.hunk-header')]
}

function focusHunk (delta) {
  const headers = hunkHeaders()
  if (!headers.length) return
  let i = state.hunkFocus == null
    ? (delta > 0 ? 0 : headers.length - 1)
    : Math.max(0, Math.min(headers.length - 1, state.hunkFocus + delta))
  state.hunkFocus = i
  headers.forEach((h, k) => h.classList.toggle('focused', k === i))
  headers[i].scrollIntoView({ block: 'center' })
}

function clearHunkFocus () {
  state.hunkFocus = null
  hunkHeaders().forEach(h => h.classList.remove('focused'))
}

// stage / unstage / discard / toggle on current selection (hunk-aware)
function kbAction (intent) {
  const s = state.selected
  if (!s) return
  if (s.where === 'branch' || s.where === 'commit') { toast('Branch view is read-only'); return }
  const hunk = state.hunkFocus != null ? state.hunks[state.hunkFocus] : null

  let op = intent
  if (intent === 'toggle') op = s.where === 'staged' ? 'unstage' : 'stage'

  // validity per section
  if (op === 'stage' && s.where === 'staged') return
  if (op === 'unstage' && s.where !== 'staged') return
  if (op === 'discard' && s.where === 'staged') { toast('Unstage first, then discard'); return }

  if (hunk && s.where !== 'untracked') {
    if (op === 'discard') return hunkAction('discard', s.where, s.file, hunk, true)
    return hunkAction(op, s.where, s.file, hunk)
  }
  if (op === 'discard') return discardFile(s.file, s.where === 'untracked')
  return fileAction(op, s.file)
}

function toggleHelp (show) {
  const el = $('help')
  el.hidden = show === undefined ? !el.hidden : !show
}

$('help').addEventListener('click', e => { if (e.target === $('help')) toggleHelp(false) })

document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return
  if (!$('modal').hidden) return // confirm dialog owns the keyboard

  // help overlay: any close key
  if (!$('help').hidden) {
    if (e.key === 'Escape' || e.key === '?' || e.key === 'q') { e.preventDefault(); toggleHelp(false) }
    return
  }

  // Ctrl-d / Ctrl-u scrolling — the only chords we accept
  if (e.ctrlKey && (e.key === 'd' || e.key === 'u')) {
    e.preventDefault()
    $('main').scrollBy({ top: (e.key === 'd' ? 1 : -1) * $('main').clientHeight / 2, behavior: 'smooth' })
    return
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return

  // gg chord
  if (pendingG && e.key === 'g') {
    pendingG = false
    clearTimeout(pendingGTimer)
    e.preventDefault()
    navTo(0)
    return
  }
  pendingG = false

  switch (e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); moveSelection(1); break
    case 'k': case 'ArrowUp': e.preventDefault(); moveSelection(-1); break
    case 'g':
      pendingG = true
      pendingGTimer = setTimeout(() => { pendingG = false }, 600)
      break
    case 'G': e.preventDefault(); navTo(state.navList.length - 1); break
    case ']': e.preventDefault(); focusHunk(1); break
    case '[': e.preventDefault(); focusHunk(-1); break
    case 'Escape': clearHunkFocus(); break
    case 's': e.preventDefault(); kbAction('stage'); break
    case 'u': e.preventDefault(); kbAction('unstage'); break
    case ' ': e.preventDefault(); kbAction('toggle'); break
    case 'd': e.preventDefault(); kbAction('discard'); break
    case 'c':
      if (state.tab === 'work') { e.preventDefault(); subjectEl.focus() }
      break
    case 'b': {
      e.preventDefault()
      if (state.tab !== 'branch') setTab('branch')
      const sel = fileList.querySelector('.base-row select')
      if (sel) {
        sel.focus()
        if (sel.showPicker) { try { sel.showPicker() } catch {} }
      }
      break
    }
    case '1': setTab('work'); break
    case '2': setTab('branch'); break
    case 'Tab': e.preventDefault(); setTab(state.tab === 'work' ? 'branch' : 'work'); break
    case 'v': setView(state.view === 'unified' ? 'split' : 'unified'); break
    case 'r': refresh({ keepSelection: true }); break
    case 'q': $('btn-quit').click(); break
    case '?': e.preventDefault(); toggleHelp(true); break
  }
})

$('btn-help').onclick = () => toggleHelp()

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
refresh().catch(e => toast(`Failed to load: ${e.message}`, { error: true, detail: e.detail }))
setInterval(poll, 2000)

/**
 * renderer.js — the window's whole brain. It never touches Node; everything
 * goes through window.builder (see preload.cjs).
 */
const els = {
  urls: document.getElementById('urls'),
  parsed: document.getElementById('parsed'),
  concurrency: document.getElementById('concurrency'),
  smoke: document.getElementById('smoke'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  open: document.getElementById('open'),
  jobs: document.getElementById('jobs'),
  empty: document.getElementById('empty'),
  stats: document.getElementById('stats'),
  tagline: document.getElementById('tagline'),
  progress: document.getElementById('progress'),
  bar: document.getElementById('bar'),
  error: document.getElementById('error')
}

const state = { jobs: new Map(), openId: null, running: false, startedAt: 0 }

/* ── URL count ─────────────────────────────────────────────────────────── */
function countUrls(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && /^[a-z]+:\/\/[\w.-]+|[\w-]+\.[a-z]{2,}/i.test(l)).length
}

function refreshParsed() {
  const n = countUrls(els.urls.value)
  els.parsed.textContent = n === 0 ? 'nothing to build yet' : `${n} site${n === 1 ? '' : 's'} ready to build`
  if (!state.running) els.start.disabled = n === 0
}
els.urls.addEventListener('input', refreshParsed)

/* ── stats ─────────────────────────────────────────────────────────────── */
function renderStats(counts) {
  const c = counts || { total: 0, queued: 0, running: 0, testing: 0, done: 0, warn: 0, failed: 0, human: 0 }
  const active = c.running + c.testing
  const cells = [
    ['total', c.total, ''],
    ['active', active, active ? 'run' : ''],
    ['built', c.done + c.warn, 'ok'],
    ['failed', c.failed, c.failed ? 'bad' : '']
  ]
  if (c.human) cells.splice(1, 0, ['needs you', c.human, 'warn'])
  els.stats.innerHTML = cells
    .map(([label, value, cls]) => `<div class="chip ${cls}"><b>${value}</b>${label}</div>`)
    .join('')
  const finished = c.done + c.warn + c.failed
  els.bar.style.width = c.total ? `${Math.round((finished / c.total) * 100)}%` : '0%'
  els.progress.classList.toggle('active', active > 0)
  // One flag drives every "work is in flight" animation in styles.css — the
  // rail, the logo halo, the meter and the sweep across the job list.
  document.body.classList.toggle('busy', active > 0)
  if (els.tagline) {
    els.tagline.textContent = active
      ? `fetching ${active} of ${c.total} · ${finished} done`
      : c.total
        ? `batch over · ${c.done + c.warn} built, ${c.failed} failed`
        : 'paste sites · build them all at once'
  }
}

/* ── job rows ──────────────────────────────────────────────────────────── */
function hostOf(url) {
  try {
    const u = new URL(url)
    return { host: u.hostname.replace(/^www\./, ''), path: u.pathname === '/' ? '' : u.pathname }
  } catch {
    return { host: url, path: '' }
  }
}

const LABEL = {
  queued: 'queued',
  running: 'building',
  testing: 'verifying',
  done: 'built',
  warn: 'built · check failed',
  failed: 'failed'
}

function rowInner(job) {
  const { host, path } = hostOf(job.url)
  const checks = job.checks ? `${job.checks.passed}/${job.checks.total}` : '—'
  const secs = job.startedAt ? Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000) : null
  const tailCls = job.status === 'failed' ? 'bad' : job.status === 'done' ? 'ok' : ''
  const file = job.file ? job.file.split(/[\\/]/).pop() : ''
  const badge = job.needsHuman ? 'human' : job.status
  // A novel site builds fine and simply has nothing to read; say so instead of
  // letting the row look like a failed extraction.
  const label = job.needsHuman
    ? 'click the browser window'
    : job.textSite
      ? 'text site · no images'
      : LABEL[job.status] || job.status
  return `
    <span class="job-num">${job.id}</span>
    <span class="job-site" title="${job.url}">${host}<small${file ? ` class="job-file" data-file="${escapeHtml(job.file)}"` : ''}>${file || path || '/'}</small></span>
    <span><i class="badge ${badge}">${label}</i></span>
    <span class="job-checks">${checks}</span>
    <span class="job-time">${secs === null ? '' : secs + 's'}</span>
    <span class="job-last ${tailCls}">${escapeHtml(job.tail || job.error || '')}</span>
  `
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => a.id - b.id)
  els.empty.hidden = jobs.length > 0
  for (const job of jobs) {
    let row = document.getElementById('job-' + job.id)
    if (!row) {
      row = document.createElement('div')
      row.className = 'job-row'
      row.id = 'job-' + job.id
      row.addEventListener('click', () => toggleLog(job.id, row))
      els.jobs.appendChild(row)
    }
    row.innerHTML = rowInner(job)
    row.dataset.state = job.needsHuman ? 'human' : job.status
    // The checks column is a meter, not a number: --pct is how full it draws.
    row.style.setProperty('--pct', job.checks && job.checks.total ? `${Math.round((job.checks.passed / job.checks.total) * 100)}%` : '0%')
    row.classList.toggle('open', state.openId === job.id)
  }
}

/* a built row's filename opens Explorer at that file instead of toggling the log */
els.jobs.addEventListener(
  'click',
  (e) => {
    const chip = e.target.closest('.job-file')
    if (!chip) return
    e.stopPropagation()
    window.builder.reveal(chip.dataset.file)
  },
  true
)

async function toggleLog(id, row) {
  const existing = document.getElementById('log-' + id)
  document.querySelectorAll('.job-log').forEach((n) => n.remove())
  state.openId = state.openId === id ? null : id
  if (!existing && state.openId === id) {
    const lines = await window.builder.lines(id)
    const pre = document.createElement('pre')
    pre.className = 'job-log'
    pre.id = 'log-' + id
    pre.textContent = lines.join('\n') || '(no output yet)'
    row.after(pre)
    pre.scrollTop = pre.scrollHeight
    pre.addEventListener('click', (e) => e.stopPropagation())
  }
  renderJobs()
}

/* ── events from main ──────────────────────────────────────────────────── */
window.builder.onEvent(({ kind, payload, counts }) => {
  if (kind === 'job') {
    state.jobs.set(payload.id, payload)
    const log = document.getElementById('log-' + payload.id)
    if (log) {
      window.builder.lines(payload.id).then((lines) => {
        log.textContent = lines.join('\n')
        log.scrollTop = log.scrollHeight
      })
    }
  }
  if (kind === 'log' && state.openId === payload.id) {
    const log = document.getElementById('log-' + payload.id)
    if (log) {
      log.textContent += '\n' + payload.line
      log.scrollTop = log.scrollHeight
    }
  }
  if (kind === 'started') {
    state.running = true
    state.startedAt = Date.now()
    els.start.disabled = true
    els.stop.disabled = false
    els.error.hidden = true
  }
  if (kind === 'finished' || kind === 'fatal') {
    state.running = false
    els.start.disabled = false
    els.stop.disabled = true
    if (kind === 'fatal') showError(payload)
    refreshParsed()
  }
  renderJobs()
  renderStats(counts)
})

function showError(msg) {
  els.error.textContent = msg
  els.error.hidden = false
}

/* ── actions ───────────────────────────────────────────────────────────── */
els.start.addEventListener('click', async () => {
  els.error.hidden = true
  state.jobs.clear()
  els.jobs.innerHTML = ''
  state.openId = null
  const res = await window.builder.start(els.urls.value, Number(els.concurrency.value) || 20, els.smoke.checked)
  if (!res.ok) showError(res.error || 'Could not start')
})

els.stop.addEventListener('click', () => window.builder.stop())
els.open.addEventListener('click', () => window.builder.openOutput())

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !els.start.disabled) els.start.click()
})

/* keep elapsed times honest while a batch runs */
setInterval(() => {
  if (state.running) renderJobs()
}, 1000)

/* ── boot ──────────────────────────────────────────────────────────────── */
;(async () => {
  const limits = await window.builder.limits()
  els.concurrency.max = String(limits.max)
  els.concurrency.value = String(limits.defaultConcurrency)
  const snap = await window.builder.snapshot()
  for (const job of snap.jobs) state.jobs.set(job.id, job)
  renderJobs()
  renderStats(snap.counts)
  refreshParsed()
})()

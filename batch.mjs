/**
 * batch.mjs — build many sites at once, for the desktop app.
 *
 * The CLI builds one site per process, so it can just `console.log` and let the
 * smoke test print to the same terminal. A batch runs up to 30 of those at once,
 * which needs three things this module adds on top of auto-build.mjs:
 *
 *   1. per-job log routing (AsyncLocalStorage, so the CLI's console calls need
 *      no changes and each URL still gets its own private log),
 *   2. a worker pool capped at MAX_CONCURRENCY, plus a per-hostname gap inside
 *      auto-build so one site never sees 30 simultaneous requests,
 *   3. a separate, smaller pool for the live smoke tests.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { format } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { autoBuild, updateIndex, removeFromIndex } from './auto-build.mjs'
import { closeBrowser } from './browser-fetch.mjs'
import { isPublicHost } from './net-guard.mjs'
import { smokeResult } from './smoke-verdict.mjs'
import { nodeCommand } from './node-command.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const MAX_CONCURRENCY = 30
export const DEFAULT_CONCURRENCY = 20
const SMOKE_POOL_SIZE = 4
const MAX_LINES_KEPT = 400
const SMOKE_TIMEOUT_MS = 300_000
const ANSI = /\x1b\[[0-9;]*m/g

const store = new AsyncLocalStorage()

// Route console output to whichever job is running on this async chain.
const nativeConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
for (const method of Object.keys(nativeConsole)) {
  console[method] = (...args) => {
    const job = store.getStore()
    const line = format(...args).replace(ANSI, '')
    if (job) job.emit(line)
    else nativeConsole[method](...args)
  }
}

/** Turn pasted text into a clean, de-duplicated list of URLs (one per line). */
export function parseUrlList(text) {
  const out = []
  const seen = new Set()
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    let url
    try {
      url = new URL(/^[a-z]+:\/\//i.test(line) ? line : 'https://' + line)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol)) continue
    if (!isPublicHost(url.hostname)) continue
    const key = url.origin + url.pathname
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url.href)
  }
  return out
}

function makeSemaphore(limit) {
  let active = 0
  const queue = []
  function release() {
    active--
    const next = queue.shift()
    if (next) {
      active++
      next()
    }
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        const start = () =>
          fn().then(
            (v) => { release(); resolve(v) },
            (e) => { release(); reject(e) }
          )
        if (active < limit) { active++; start() } else queue.push(start)
      })
    }
  }
}

const DECORATIVE = /^[\s═╔╗╚╝║─|•·*=-]+$/

/** Last line worth showing in the table (skips box-drawing separators). */
function tailLine(job) {
  for (let i = job.lines.length - 1; i >= 0; i--) {
    const line = job.lines[i].trim()
    if (line && !DECORATIVE.test(line)) return line
  }
  return ''
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    // A job that already finished no longer needs anything from the user, even
    // if it asked for a click on the way.
    needsHuman: !!job.needsHuman && (job.status === 'running' || job.status === 'testing'),
    site: job.site,
    file: job.file,
    sha: job.sha,
    checks: job.checks,
    textSite: !!job.textSite,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    lineCount: job.lines.length,
    tail: tailLine(job)
  }
}

/**
 * Run the live smoke test for one built extension, streaming its output into
 * the owning job's log. Resolves with { passed, total, allOk }.
 */
function runSmoke(jsPath, sem) {
  return sem.run(
    () =>
      new Promise((resolve) => {
        const host = nodeCommand()
        const child = spawn(host.command, [join(__dirname, 'test-extension.mjs'), jsPath], {
          windowsHide: true,
          env: host.env
        })
        let buffer = ''
        let full = ''
        const onData = (chunk) => {
          const text = chunk.toString()
          full += text
          buffer += text
          let i
          while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i).replace(ANSI, '').trimEnd()
            buffer = buffer.slice(i + 1)
            if (line.trim() && !line.startsWith('VERDICT ')) store.getStore()?.emit(line)
          }
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        const killer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, SMOKE_TIMEOUT_MS)
        child.on('close', (code) => {
          clearTimeout(killer)
          if (buffer.trim() && !buffer.trim().startsWith('VERDICT ')) store.getStore()?.emit(buffer.trim())
          // The test's own report decides, not its exit status: Windows can
          // crash the runtime while it tears down a keep-alive socket after a
          // run where every check passed.
          resolve(smokeResult(full, code))
        })
        child.on('error', () => {
          clearTimeout(killer)
          resolve({ passed: 0, total: 0, allOk: false })
        })
      })
  )
}

/**
 * Start a batch. Returns { jobs, done, stop, lines }.
 *  - `done` resolves with the final public job list when the pool drains
 *  - `stop()` lets running jobs finish and never starts another
 *  - `lines(id)` returns the captured log for one job
 */
export function runBatch(urls, options = {}) {
  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(options.concurrency || DEFAULT_CONCURRENCY)))
  const smoke = options.smoke !== false
  const onEvent = options.onEvent || (() => {})

  const state = { stopped: false }
  const jobs = urls.map((url, i) => {
    const job = {
      id: i + 1,
      url,
      status: 'queued',
      site: '',
      file: '',
      sha: '',
      checks: null,
      error: '',
      startedAt: 0,
      endedAt: 0,
      lines: [],
      needsHuman: false,
      textSite: false,
      emit(line) {
        if (/CLICK THE BOX IN THE BROWSER WINDOW/.test(line)) job.needsHuman = true
        job.lines.push(line)
        if (job.lines.length > MAX_LINES_KEPT) job.lines.shift()
        onEvent('log', { id: job.id, line })
      }
    }
    return job
  })

  const smokeSem = makeSemaphore(SMOKE_POOL_SIZE)
  let cursor = 0

  async function worker() {
    while (!state.stopped) {
      const job = jobs[cursor++]
      if (!job) return
      job.status = 'running'
      job.startedAt = Date.now()
      onEvent('job', publicJob(job))
      try {
        const result = await store.run(job, () => autoBuild(job.url, { smokeTest: false }))
        job.site = result?.config?.name || ''
        job.file = result?.jsPath || ''
        job.sha = result?.hash || ''
        if (smoke && job.file) {
          job.status = 'testing'
          onEvent('job', publicJob(job))
          job.checks = await store.run(job, () => runSmoke(job.file, smokeSem))
          if (!job.checks.allOk && !job.checks.textOnly) {
            // One retry: one request failing at the far end looks exactly like a
            // broken extension, and pulling a working one out of the store is
            // worse than taking a few more seconds to be sure. A text-only
            // source is excluded — a second run reads the same prose.
            job.emit('↻ first test run failed — testing once more before deciding')
            const again = await store.run(job, () => runSmoke(job.file, smokeSem))
            if (again.allOk) job.checks = again
          }
        }
        if (job.checks && job.checks.textOnly) {
          job.textSite = true
          job.emit('📖 text-only source — its chapters are prose, not images, so a reader has nothing to show')
        }
        const verified = !!job.checks && job.checks.allOk
        if (result?.entry) {
          // Only a build that passed its live test belongs in index.json; a
          // failing rebuild also loses its older entry.
          if (verified) await updateIndex(result.entry)
          else await removeFromIndex(result.entry.packageId)
        }
        if (smoke && job.file && !job.checks) job.emit('❓ no test result — not added to the store index')
        job.status = verified ? 'done' : 'warn'
      } catch (err) {
        job.error = String((err && err.message) || err)
        job.emit('❌ ' + job.error)
        job.status = 'failed'
      }
      job.endedAt = Date.now()
      onEvent('job', publicJob(job))
    }
  }

  const done = Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker))
    .then(() => closeBrowser().catch(() => {}))
    .then(() => jobs.map(publicJob))

  return {
    concurrency,
    done,
    /** Live snapshot of every job's public state (statuses change as it runs). */
    live() {
      return jobs.map(publicJob)
    },
    stop() {
      state.stopped = true
    },
    lines(id) {
      const job = jobs.find((j) => j.id === id)
      return job ? job.lines.slice() : []
    }
  }
}

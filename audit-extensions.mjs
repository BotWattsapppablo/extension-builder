/**
 * audit-extensions.mjs — grade every built extension the way MihonPC uses it.
 *
 * The builder's per-site smoke test prints for a human; this runs the whole
 * output/ folder and turns the results into numbers, so "a lot of them don't
 * work" becomes "X% fail like this, Y% fail like that".
 *
 * Each extension gets its own child process, because the bridge session in
 * ext-sandbox is serial by design — same as the app.
 *
 * Usage:
 *   node audit-extensions.mjs                 # all of output/, 6 workers
 *   node audit-extensions.mjs --limit 40      # quick sample
 *   node audit-extensions.mjs --filter manga
 *   node audit-extensions.mjs --workers 10
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeSandbox, install, UA } from './ext-sandbox.mjs'
import { searchTerm } from './query-safety.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(HERE, 'output')
const AUDIT_DIR = join(HERE, '.audit')
const SELF = join(HERE, 'audit-extensions.mjs')

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name) => process.argv.includes('--' + name)

// A site that refuses plain requests is not a bug in the generated selectors:
// MihonPC will be refused too, so that extension cannot be fixed as generated.
const GATE_MARKERS = /cf_chl_opt|_cf_chl|cf-browser-verification/i
const GATE_TITLES = /just a moment|attention required|checking your browser|browser verification|verifying your browser|you have been blocked|access denied/i
const TIME_TAIL = /(just now|yesterday|today|\d+\s*(sec|min|hour|day|week|month|year)s?\s*ago)$/i

function short(msg) {
  return String(msg || '').replace(/\s+/g, ' ').slice(0, 140)
}

/** undici hides the real reason in e.cause — 'fetch failed' alone is useless. */
function explain(e) {
  const code = e && e.cause && (e.cause.code || e.cause.errno)
  return short((e && e.message ? e.message : String(e)) + (code ? ` (${code})` : ''))
}

// A socket that reset or stalled says more about our two hours of traffic than
// about the site, so those verdicts get one quiet retry before they are counted.
const TRANSPORT = /ECONNRESET|ECONNABORTED|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|socket hang up|timeout after|fetch failed/i
const GONE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH/i

function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    })
  ])
}

/** One extension, one report. Everything below must never throw past here. */
async function auditOne(jsPath, sandbox) {
  const require = createRequire(import.meta.url)
  const rec = { file: basename(jsPath), id: basename(jsPath).replace(/\.js$/i, ''), verdict: 'ok', issues: [], detail: '' }
  const reset = sandbox.reset

  // Fresh temp dir: require() caches by path, and ids are not unique enough to share one.
  const dir = mkdtempSync(join(tmpdir(), 'audit-ext-'))
  const cjs = join(dir, rec.id + '.cjs')
  try {
    cpSync(jsPath, cjs)
    var ext = require(cjs)
  } catch (e) {
    return { ...rec, verdict: 'load_error', detail: explain(e) }
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }

  const call = async (fn, ...a) => {
    if (typeof fn !== 'function') throw new Error('extension has no such method')
    reset()
    return await withTimeout(Promise.resolve().then(() => fn(...a)), 45_000)
  }
  const bail = (verdict, detail) => ({ ...rec, verdict, detail })

  // 1. browse
  let popular
  try {
    popular = await call(ext.getPopularManga, 1)
  } catch (e) {
    const gated = await probeGated(sandbox, ext.baseUrl)
    if (gated) return bail('blocked', explain(e))
    return bail(deadOrError(e), explain(e))
  }
  if (!Array.isArray(popular) || popular.length === 0) {
    if (await probeGated(sandbox, ext.baseUrl)) return bail('blocked', 'empty list behind a gate')
    return bail('no_popular', 'list is empty')
  }
  if (popular.some((m) => !m?.url || !m?.title)) return bail('no_popular', 'items missing url or title')

  // 2. page 2 — the "it only shows 20 comics" complaint
  try {
    const page2 = await call(ext.getPopularManga, 2)
    if (!Array.isArray(page2) || page2.length === 0) rec.issues.push('no_pagination')
    else if (repeats(popular, page2)) rec.issues.push('page2_repeats_page1')
  } catch (e) {
    rec.issues.push('page2_errors')
  }

  // 3. search must find something
  const term = searchTerm(popular[0].title)
  try {
    const found = await call(ext.searchManga, 1, term)
    if (!Array.isArray(found) || found.length === 0) rec.issues.push('search_empty')
  } catch (e) {
    rec.issues.push('search_errors')
  }

  // 4. details
  let details
  try {
    details = await call(ext.getMangaDetails, { ...popular[0] })
    if (!details?.title) rec.issues.push('no_title')
    if (!details?.description) rec.issues.push('no_description')
    if (!details?.thumbnailUrl) rec.issues.push('no_cover')
    if (!details?.status || details.status === 'unknown') rec.issues.push('status_unknown')
  } catch (e) {
    return bail('no_details', explain(e))
  }

  // 5. chapters
  let chapters
  try {
    chapters = await call(ext.getChapterList, details || popular[0])
  } catch (e) {
    return bail('no_chapters', explain(e))
  }
  if (!Array.isArray(chapters) || chapters.length === 0) return bail('no_chapters', 'list is empty')
  if (chapters.some((c) => !c?.url || !c?.name)) return bail('no_chapters', 'items missing url or name')
  if (chapters.length === 1 && /^chapter 1$/i.test(chapters[0].name)) rec.issues.push('chapter_fallback')
  else if (chapters.length < 3) rec.issues.push('few_chapters')
  if (chapters.some((c) => TIME_TAIL.test(String(c.name).trim()))) rec.issues.push('dirty_chapter_names')
  if (new Set(chapters.map((c) => c.name)).size !== chapters.length) rec.issues.push('dupe_chapter_names')

  // 6. pages — middle of the list, so both ends of a long chapter array get used
  const chapter = chapters[Math.floor(chapters.length / 2)]
  let pages
  try {
    pages = await call(ext.getPageList, chapter)
  } catch (e) {
    return bail('no_pages', explain(e))
  }
  if (!Array.isArray(pages) || pages.length === 0) return bail('no_pages', 'list is empty')
  const urls = pages.map((p) => (typeof p === 'string' ? p : p?.url))
  if (urls.some((u) => !/^https?:\/\//.test(String(u)))) return bail('no_pages', 'page url is not http')
  if (pages.length < 5) rec.issues.push('few_pages')
  if (pages.length > 300) rec.issues.push('too_many_pages')

  // 7. the image has to actually load with the headers the page asked for
  const first = pages[0]
  const imgUrl = typeof first === 'string' ? first : first.url
  const headers = typeof first === 'object' && first.headers ? first.headers : {}
  try {
    const res = await fetch(imgUrl, { headers: { 'User-Agent': UA, ...headers }, redirect: 'follow' })
    const ct = res.headers.get('content-type') || ''
    if (!res.ok) return bail('img_blocked', `HTTP ${res.status}`)
    if (!ct.startsWith('image')) return bail('img_blocked', `not an image (${ct.slice(0, 24)})`)
  } catch (e) {
    return bail('img_blocked', explain(e))
  }
  return { ...rec, detail: `${popular.length} list / ${chapters.length} ch / ${pages.length} pg` }
}

function deadOrError(e) {
  const m = explain(e)
  if (GONE.test(m)) return 'dead'
  if (TRANSPORT.test(m)) return 'transport'
  return 'browse_error'
}

async function probeGated(sandbox, baseUrl) {
  try {
    sandbox.reset()
    const res = await withTimeout(sandbox.http.request(String(baseUrl)), 20_000)
    if ([403, 429, 503].includes(res.status)) return true
    const head = String(res.text || '').slice(0, 20_000)
    return GATE_MARKERS.test(head) || GATE_TITLES.test(head)
  } catch {
    return false
  }
}

function repeats(a, b) {
  const titles = new Set(a.map((m) => m.title))
  return b.filter((m) => titles.has(m.title)).length >= Math.min(5, b.length)
}

// ── worker: audit a list file, print one JSON line per extension ────────────
async function runWorker(listFile) {
  const sandbox = makeSandbox()
  install(sandbox)
  for (const jsPath of readFileSync(listFile, 'utf8').split('\n').filter(Boolean)) {
    let rec
    try {
      rec = await auditOne(jsPath, sandbox)
    } catch (e) {
      rec = { id: basename(jsPath).replace(/\.js$/i, ''), verdict: 'audit_error', issues: [], detail: explain(e) }
    }
    process.stdout.write(JSON.stringify(rec) + '\n')
  }
  process.exit(0)
}

// ── parent: split the work, collect the lines, rank the failures ────────────
async function runParent() {
  const filter = String(arg('filter', '')).toLowerCase()
  let files = readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(OUTPUT_DIR, f))
  if (filter) files = files.filter((f) => f.toLowerCase().includes(filter))
  const limit = Number(arg('limit', 0))
  if (limit > 0) files = files.slice(0, limit)

  const workers = Math.max(1, Number(arg('workers', 6)))
  // round-robin: the same host rarely lands in two workers at once
  const buckets = Array.from({ length: workers }, () => [])
  files.forEach((f, i) => buckets[i % workers].push(f))

  mkdirSync(AUDIT_DIR, { recursive: true })
  const tmp = mkdtempSync(join(AUDIT_DIR, 'run-'))

  console.log(`\n🔎 auditing ${files.length} extensions with ${workers} workers…\n`)
  const records = []
  let done = 0
  const t0 = Date.now()

  await Promise.all(
    buckets.map(
      (bucket, i) =>
        new Promise((res, rej) => {
          if (bucket.length === 0) return res()
          const listFile = join(tmp, `list-${i}.txt`)
          writeFileSync(listFile, bucket.join('\n'))
          const child = spawn(process.execPath, [SELF, '--worker', listFile], { cwd: HERE, windowsHide: true })
          let buf = ''
          child.stdout.on('data', (chunk) => {
            buf += chunk
            let nl
            while ((nl = buf.indexOf('\n')) > -1) {
              const line = buf.slice(0, nl).trim()
              buf = buf.slice(nl + 1)
              if (!line.startsWith('{')) continue
              try {
                records.push(JSON.parse(line))
                done++
                if (done % 20 === 0) {
                  const rate = done / ((Date.now() - t0) / 1000)
                  const eta = Math.round((records.length ? (files.length - done) / rate : 0) / 60)
                  process.stdout.write(`\r   ${done}/${files.length} done · ~${eta} min left   `)
                }
              } catch {
                /* a stray line from an extension's own console.log */
              }
            }
          })
          child.stderr.on('data', (c) => process.stderr.write(String(c)))
          child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`worker ${i} exited ${code}`))))
        })
    )
  )
  console.log()

  const byVerdict = {}
  const issues = {}
  for (const r of records) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1
    for (const i of r.issues) issues[i.split(':')[0]] = (issues[i.split(':')[0]] || 0) + 1
  }
  const ok = byVerdict.ok || 0
  const pct = (n) => Math.round((n / records.length) * 100)

  console.log('════════════════════════════════════════════════════════════')
  console.log(`   ${ok}/${records.length} extensions fully work  (${pct(ok)}%)`)
  console.log('════════════════════════════════════════════════════════════')
  console.log('\n   verdict            count   share')
  for (const [v, c] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${v.padEnd(17)} ${String(c).padStart(5)}   ${pct(c)}%`)
  }
  console.log('\n   flaws inside the ones that do work')
  for (const [k, c] of Object.entries(issues).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(24)} ${String(c).padStart(5)}`)
  }

  const broken = records.filter((r) => r.verdict !== 'ok')
  writeFileSync(join(AUDIT_DIR, 'audit.json'), JSON.stringify({ at: new Date().toISOString(), total: records.length, ok, byVerdict, issues, records }, null, 1))
  writeFileSync(join(AUDIT_DIR, 'broken.tsv'), broken.map((r) => `${r.verdict}\t${r.id}\t${r.detail}`).join('\n') + '\n')
  console.log(`\n   everything: ${join(AUDIT_DIR, 'audit.json')}`)
  console.log(`   broken:     ${join(AUDIT_DIR, 'broken.tsv')}  (${broken.length})\n`)
}

if (flag('worker')) {
  runWorker(arg('worker', '')).catch((e) => {
    console.error('worker fatal: ' + e.message)
    process.exit(1)
  })
} else {
  runParent().catch((e) => {
    console.error('\n❌ ' + e.message)
    process.exit(1)
  })
}

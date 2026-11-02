/**
 * test-extension.mjs — End-to-end smoke test for a generated .js extension.
 *
 * It mocks the app's extension bridge (http + html + cache + prefs) with the
 * exact same semantics as src/main/extensions/{bridge,html-session}.ts, loads
 * the extension, and runs the whole pipeline against the LIVE site:
 *
 *   getPopularManga → getMangaDetails → getChapterList → getPageList
 *   (+ getLatestUpdates / searchManga when supported)
 *
 * Usage:
 *   node test-extension.mjs output/mangapill.js
 *   node test-extension.mjs output/mysite.js [--no-images]
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, install, UA } from './ext-sandbox.mjs'
import { searchTerm } from './query-safety.mjs'

const sandbox = makeSandbox()
install(sandbox)

// Session reset — mirrors bridge.resetSession() between invokes
const resetSession = sandbox.reset

// ── Load the extension (CommonJS) ───────────────────────────────────────────
const jsPath = resolve(process.argv[2] || '')
const noImages = process.argv.includes('--no-images')
if (!jsPath || !existsSync(jsPath)) {
  console.error('Usage: node test-extension.mjs <path/to/extension.js> [--no-images]')
  process.exit(1)
}

// Copy to a .cjs temp file so require() treats it as CommonJS
const tmpDir = mkdtempSync(join(tmpdir(), 'ext-test-'))
const cjsPath = join(tmpDir, basename(jsPath).replace(/\.js$/i, '') + '.cjs')
writeFileSync(cjsPath, readFileSync(jsPath, 'utf-8'))
const require = createRequire(import.meta.url)
const ext = require(cjsPath)

// ── Test runner ─────────────────────────────────────────────────────────────
const results = []
function report(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function fmt(item) {
  return `"${(item?.title || item?.name || '?').slice(0, 40)}"`
}

async function main() {
  console.log()
  console.log(`🧪 Testing extension: ${jsPath}`)
  console.log(`   id=${ext.id} name=${ext.name} lang=${ext.lang} baseUrl=${ext.baseUrl}`)
  console.log(`   supportsLatest=${ext.supportsLatest} isNsfw=${ext.isNsfw} apiVersion=${ext.apiVersion}`)
  console.log()

  // 1. Popular
  let popular = []
  try {
    resetSession()
    popular = await ext.getPopularManga(1)
    const ok = Array.isArray(popular) && popular.length > 0 && popular.every(m => m.url && m.title)
    report('getPopularManga(1)', ok, `${popular.length} manga, e.g. ${fmt(popular[0])}`)
  } catch (e) {
    report('getPopularManga(1)', false, e.message)
  }

  // 2. Latest (only if declared)
  if (ext.supportsLatest) {
    try {
      resetSession()
      const latest = await ext.getLatestUpdates(1)
      const ok = Array.isArray(latest) && latest.length > 0
      report('getLatestUpdates(1)', ok, `${latest.length} manga, e.g. ${fmt(latest[0])}`)
    } catch (e) {
      report('getLatestUpdates(1)', false, e.message)
    }
  }

  // 3. Search (with a term derived from the first popular title, else 'one piece')
  try {
    resetSession()
    const term = searchTerm(popular[0]?.title)
    const found = await ext.searchManga(1, term)
    const ok = Array.isArray(found) && found.length > 0
    report('searchManga(1, ...)', ok, `${found.length} results for "${term}"`)
  } catch (e) {
    report('searchManga(1, ...)', false, e.message)
  }

  // 4. Details + chapters + pages pipeline
  if (popular.length > 0) {
    const first = popular[0]
    let details = null
    try {
      resetSession()
      details = await ext.getMangaDetails({ ...first })
      const ok = details && details.title
      const people = [details?.author, details?.artist].filter(Boolean).join(' / ')
      report('getMangaDetails', ok, `${fmt(details)} status=${details?.status} genres=${details?.genres?.length ?? 0}${people ? ` | ${people}` : ''}`)
    } catch (e) {
      report('getMangaDetails', false, e.message)
    }

    let chapters = []
    try {
      resetSession()
      chapters = await ext.getChapterList(details || first)
      const ok = chapters.length > 0 && chapters.every(c => c.url && c.name)
      report('getChapterList', ok, `${chapters.length} chapters, first=${fmt(chapters[0])} last=${fmt(chapters[chapters.length - 1])}`)
    } catch (e) {
      report('getChapterList', false, e.message)
    }

    // A name that ends in a relative timestamp means the selector swallowed a
    // badge/date span ("Chapter 4Just now") — data the reader would show.
    if (chapters.length > 0) {
      const TIME_TAIL = /(just now|yesterday|today|\d+\s*(sec|min|hour|day|week|month|year)s?\s*ago)$/i
      const mangled = chapters.filter(c => TIME_TAIL.test(String(c.name).trim()))
      report(
        'chapter names clean',
        mangled.length === 0,
        mangled.length === 0 ? 'no badge/date text in names' : `${mangled.length} mangled, e.g. "${mangled[0].name}"`
      )
      const dupes = chapters.length - new Set(chapters.map(c => c.name)).size
      report('chapter names unique', dupes === 0, dupes === 0 ? `${chapters.length} distinct` : `${dupes} duplicates`)
    }

    if (chapters.length > 0 && !noImages) {
      const chapter = chapters[chapters.length - 1] // oldest chapter = most stable
      try {
        resetSession()
        const pages = await ext.getPageList(chapter)
        const ok = pages.length > 0 && pages.every(p => {
          const url = typeof p === 'string' ? p : p?.url
          return url && url.startsWith('http')
        })
        report('getPageList', ok, `${pages.length} pages`)
        // Prove the first image actually loads (with referer when needed)
        if (ok) {
          const firstPage = pages[0]
          const imgUrl = typeof firstPage === 'string' ? firstPage : firstPage.url
          const headers = typeof firstPage === 'object' && firstPage.headers ? firstPage.headers : {}
          try {
            const res = await fetch(imgUrl, { headers: { 'User-Agent': UA, ...headers } })
            report('image loads (CDN + referer)', res.ok, `HTTP ${res.status} ${imgUrl.slice(0, 80)}...`)
          } catch (e) {
            report('image loads (CDN + referer)', false, e.message)
          }
        }
      } catch (e) {
        report('getPageList', false, e.message)
      }
    }
  } else {
    report('pipeline (details/chapters/pages)', false, 'skipped — no popular manga found')
  }

  // ── Summary ──
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  console.log()
  console.log('═'.repeat(60))
  console.log(`   ${passed}/${results.length} checks passed${failed > 0 ? ` — ${failed} FAILED` : ' — ALL GOOD 🎉'}`)
  console.log('═'.repeat(60))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}\n`)
  process.exit(1)
})

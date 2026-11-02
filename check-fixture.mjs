/**
 * check-fixture.mjs — the assertions fixture-site.mjs exists to support.
 *
 *   node fixture-site.mjs &
 *   BUILDER_ALLOW_PRIVATE=1 BUILDER_NO_BROWSER=1 node auto-build.mjs http://127.0.0.1:4599
 *   node check-fixture.mjs output/127.js
 *
 * The smoke test walks a real extension the way the app does; this checks the
 * built one against the page counts and fields the fixture is known to serve.
 * It catches the failures a single-chapter smoke test cannot see: a reader that
 * returns only the markup-rendered images, a details panel that reads its own
 * "Status:" label as the status, and a chapter list that misses the <select>.
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { makeSandbox, install } from './ext-sandbox.mjs'

const EXPECTED_PAGES = {
  '/manga/ash-lantern/ch-1': 4, // 2 lazy <img> + 2 only in the script blob
  '/manga/ash-lantern/ch-2': 3, // 1 <img> + 2 inside data_job
  '/manga/ash-lantern/ch-3': 4, // plain markup
  '/manga/ash-lantern/ch-4': 3 // blob mixes the chapter with unrelated images
}

const sandbox = makeSandbox()
install(sandbox)

const jsPath = resolve(process.argv[2] || '')
if (!jsPath || !existsSync(jsPath)) {
  console.error('Usage: node check-fixture.mjs <path/to/extension.js>')
  process.exit(1)
}

const tmpDir = mkdtempSync(join(tmpdir(), 'fixture-check-'))
const cjsPath = join(tmpDir, basename(jsPath).replace(/\.js$/i, '') + '.cjs')
writeFileSync(cjsPath, readFileSync(jsPath, 'utf-8'))
const require = createRequire(import.meta.url)
const ext = require(cjsPath)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function invoke(fn, arg) {
  sandbox.reset()
  return await ext[fn](arg)
}

async function main() {
  console.log(`\n🔍 Fixture check: ${jsPath}\n`)

  const popular = await invoke('getPopularManga', 1)
  check('getPopularManga', popular.length >= 8, `${popular.length} cards`)

  const first = popular.find((m) => /ash lantern/i.test(m.title || '')) || popular[0]
  const details = await invoke('getMangaDetails', first)
  check('status read from the page', details.status === 'ongoing', `status=${details.status}`)
  check('genres read from the page', (details.genres || []).length >= 2, `genres=${(details.genres || []).join(', ') || 'none'}`)
  check('description is a synopsis', /lantern/i.test(details.description || ''), JSON.stringify((details.description || '').slice(0, 50)))

  const chapters = await invoke('getChapterList', details)
  check('getChapterList', chapters.length === 4, `${chapters.length} chapters`)

  for (const [path, want] of Object.entries(EXPECTED_PAGES)) {
    const chapter = chapters.find((c) => String(c.url).endsWith(path))
    if (!chapter) {
      check(`getPageList ${path}`, false, 'chapter not in the list')
      continue
    }
    const pages = await invoke('getPageList', chapter)
    const urls = pages.map((p) => p.url)
    const dupes = urls.length !== new Set(urls).size
    check(
      `getPageList ${path}`,
      pages.length === want && !dupes,
      `${pages.length}/${want} pages${dupes ? ' — DUPLICATES' : ''}`
    )
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} fixture checks passed`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}\n`)
  process.exitCode = 1
})

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
import { isEpisodeLabel } from './title-safety.mjs'
import { TEXT_SITE_MARK } from './text-safety.mjs'

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
const generatedSource = readFileSync(jsPath, 'utf-8')
writeFileSync(cjsPath, generatedSource)
const require = createRequire(import.meta.url)
const ext = require(cjsPath)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function invoke(fn, ...args) {
  sandbox.reset()
  return await ext[fn](...args)
}

async function main() {
  console.log(`\n🔍 Fixture check: ${jsPath}\n`)

  const popular = await invoke('getPopularManga', 1)
  check('getPopularManga', popular.length >= 8, `${popular.length} cards`)

  const first = popular.find((m) => /ash lantern/i.test(m.title || '')) || popular[0]
  const details = await invoke('getMangaDetails', first)
  check(
    'details title is the series, not the episode heading',
    /ash lantern/i.test(details.title || '') && !isEpisodeLabel(details.title),
    JSON.stringify(details.title)
  )
  check('status read from the page', details.status === 'ongoing', `status=${details.status}`)
  check('genres read from the page', (details.genres || []).length >= 2, `genres=${(details.genres || []).join(', ') || 'none'}`)
  check('description is a synopsis', /lantern/i.test(details.description || ''), JSON.stringify((details.description || '').slice(0, 50)))

  const chapters = await invoke('getChapterList', details)
  check('getChapterList', chapters.length === 5, `${chapters.length} chapters`)

  // Search: the endpoint this site offers indexes part of the catalogue, the
  // rest only shows up by walking the listing — and a query that matches
  // nothing must come back empty rather than throw.
  const indexed = await invoke('searchManga', 1, 'Ash Lantern')
  check('search finds a title the endpoint indexes', indexed.length >= 1, `${indexed.length} results`)
  const unindexed = await invoke('searchManga', 1, 'Glass Harbor')
  check('search finds a title the endpoint does not index', unindexed.length >= 1, `${unindexed.length} results`)
  const nonsense = await invoke('searchManga', 1, 'zzqx nothing here')
  check('a query with no match returns nothing, not an error', nonsense.length === 0, `${nonsense.length} results`)

  // Paging is what makes the walk reach past the first screen of the catalogue.
  const page2 = await invoke('getPopularManga', 2)
  const page1Urls = new Set(popular.map((m) => m.url))
  check('listing page 2 is a different page', page2.length > 0 && page2.every((m) => !page1Urls.has(m.url)), `${page2.length} cards`)

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

  // A chapter with no pictures but a page full of prose is a novel, not a lost
  // image list. The shipped extension has to name which of the two it found,
  // because "no readable images" alone reads like the builder's failure.
  const prose = chapters.find((c) => String(c.url).endsWith('/manga/ash-lantern/ch-0'))
  let proseSays = ''
  try {
    const found = await invoke('getPageList', prose)
    proseSays = `returned ${found.length} pages instead of naming the source`
  } catch (e) {
    proseSays = String(e.message || '')
  }
  check('the prose chapter is reported as text-only', proseSays.includes(TEXT_SITE_MARK), JSON.stringify(proseSays.slice(0, 90)))

  // The host answers every html call over an async bridge, so a call the template
  // forgot to await becomes a Promise that only explodes inside Yomi. A bare
  // `return html.load(x)` from an async function is the one safe shape: the
  // promise gets adopted. Anything else has to say `await`.
  const unawaited = generatedSource
    .split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /html\.(load|select|selectFirst|text|attr|selectText|selectAttr)\(/.test(line))
    .filter(({ line }) => !line.includes('await html.') && !/^\s*return html\.load\(/.test(line))
    .map(({ n, line }) => `${n}: ${line.trim().slice(0, 60)}`)
  check('every html call in the generated source is awaited', unawaited.length === 0, unawaited.join(' | '))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} fixture checks passed`)
  process.exitCode = failed.length ? 1 : 0
}

main().catch((err) => {
  console.error(`\n❌ Fatal: ${err.message}\n`)
  process.exitCode = 1
})

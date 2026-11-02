/**
 * test-app.mjs — drive the desktop app with a real window and prove it works.
 *
 * Launches app/ in Electron, pastes a few URLs (one reachable, two dead),
 * starts the batch with the keyboard shortcut, then checks what the window
 * actually shows: per-job rows, the progress bar, the clickable output file.
 * Screenshots land in app-proof.png.
 *
 *   node test-app.mjs
 */
import { _electron } from 'playwright'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const binary = (() => {
  for (const spec of ['electron', join(__dirname, '..', 'node_modules', 'electron')]) {
    try {
      const p = require(spec)
      if (typeof p === 'string' && existsSync(p)) return p
    } catch { /* try the next candidate */ }
  }
  return null
})()
if (!binary) {
  console.error('\nElectron was not found. Install it once with:  npm install --save-dev electron\n')
  process.exit(1)
}

const SITES = `https://mangapill.com
https://qoder-dead-1.invalid
https://qoder-dead-2.invalid`

// Start from a store index that does NOT list the test site, so "it appeared
// after a passing run" proves the publish-on-verified rule rather than history.
const INDEX = join(__dirname, 'output', 'index.json')
if (existsSync(INDEX)) {
  const idx = JSON.parse(readFileSync(INDEX, 'utf8'))
  idx.extensions = (idx.extensions || []).filter((e) => e.packageId !== 'mangapill')
  writeFileSync(INDEX, JSON.stringify(idx, null, 2), 'utf8')
}

const app = await _electron.launch({ executablePath: binary, args: [join(__dirname, 'app')], stdout: 'pipe', stderr: 'pipe' })
// An app that closes mid-batch takes its reason with it unless the main
// process's own output is kept.
const appOutput = []
for (const stream of [app.process()?.stdout, app.process()?.stderr]) {
  stream?.on('data', (b) => appOutput.push(String(b)))
}
const win = await app.firstWindow()
await win.waitForLoadState('domcontentloaded')

await win.locator('#urls').fill(SITES)
await win.locator('#concurrency').fill('3')
const winTitle = await win.title()
const h1 = await win.locator('.brand-text h1').textContent()
const namedOk = /Yomi Builder/.test(winTitle) && /Yomi Builder/.test(h1)
const logoPainted = await win.evaluate(() => {
  const img = document.querySelector('.logo')
  return !!img && img.tagName === 'IMG' && img.naturalWidth > 0
})
console.log(`${namedOk ? '✅' : '❌'} window and header read "Yomi Builder" (${JSON.stringify(winTitle)} / ${JSON.stringify(h1)})`)
console.log(`${logoPainted ? '✅' : '❌'} the header shows the app artwork (icon loaded)`)
console.log('parse hint:', (await win.locator('#parsed').textContent()).trim())

await win.locator('#urls').press('Control+Enter')
await win.waitForSelector('.job-row', { timeout: 30000 })

async function bail(msg, extraLines = []) {
  console.error(`❌ ${msg}`)
  for (const line of extraLines) console.error(`   ${line}`)
  const text = appOutput.join('')
  if (text.trim()) console.error('\n── app output ──\n' + text.slice(-2500))
  try { await app.close() } catch { /* already gone */ }
  process.exit(1)
}

const deadline = Date.now() + 240_000
let active = -1
while (Date.now() < deadline) {
  let chips
  try {
    chips = await win.locator('.chip').allTextContents()
  } catch {
    await bail('the app window closed while the batch was still running')
  }
  active = Number((chips.find((c) => /active/.test(c)) || '0').match(/^\s*(\d+)/)?.[1] ?? 0)
  if (active === 0) break
  await win.waitForTimeout(2000)
}
if (active !== 0) {
  // "did not drain" alone cannot be acted on: say which row is still open and
  // what its own log last said. A slow site and a deadlock look identical
  // otherwise.
  const stuck = await win.locator('.job-row').allTextContents()
  const stats = await win.locator('.chip').allTextContents()
  await win.locator('.job-row').first().click().catch(() => {})
  await win.waitForTimeout(400)
  const log = await win.locator('.job-log').textContent().catch(() => '')
  await bail('batch did not drain', [
    `stats: ${stats.join(' | ')}`,
    ...stuck.map((r) => `row: ${r.replace(/\s+/g, ' ').trim().slice(0, 220)}`),
    `last log lines: ${(log || '').split(/\r?\n/).slice(-6).join(' / ')}`
  ])
}

const rows = await win.locator('.job-row').allTextContents()
const stats = (await win.locator('.chip').allTextContents()).join(' | ')
const bar = await win.locator('#bar').evaluate((n) => n.style.width)
console.log('rows:', rows.length, '| stats:', stats, '| progress bar:', bar)
for (const r of rows) console.log('  ' + r.replace(/\s+/g, ' ').trim())

const WARN = 'built · check failed'
const done = rows.filter((r) => !r.includes(WARN) && /\bbuilt\b/.test(r)).length
const warn = rows.filter((r) => r.includes(WARN)).length
const failed = rows.filter((r) => !r.includes(WARN) && r.includes('failed')).length
const chip = await win.locator('.job-file').count()
const guarded = await win.evaluate(() => window.builder.reveal('C:/Windows/notepad.exe'))

await win.locator('.job-row').first().click()
await win.waitForTimeout(900)
const logOpen = (await win.locator('.job-log').count()) === 1
await win.screenshot({ path: join(__dirname, 'app-proof.png') })
await app.close()

const listed = JSON.parse(readFileSync(INDEX, 'utf8')).extensions
const published = listed.some((e) => e.packageId === 'mangapill')
const junkPublished = listed.some((e) => /qoder-dead/.test(e.packageId || ''))

console.log('\n── checks ──')
console.log(`${done === 1 && failed === 2 && warn === 0 ? '✅' : '❌'} one site verified, one row per URL (${done} built / ${warn} built-but-broken / ${failed} failed)`)
console.log(`${bar === '100%' ? '✅' : '❌'} progress bar reached 100%`)
console.log(`${chip >= 1 ? '✅' : '❌'} built rows show their output file name (${chip} chip(s))`)
console.log(`${guarded === false ? '✅' : '❌'} reveal() refuses paths outside output/`)
console.log(`${logOpen ? '✅' : '❌'} clicking a row opens that job's own log`)
console.log(`${published ? '✅' : '❌'} the verified extension was added back to index.json`)
console.log(`${!junkPublished ? '✅' : '❌'} failed builds stay out of index.json`)
process.exit(
  namedOk && logoPainted && done === 1 && failed === 2 && warn === 0 && bar === '100%' && chip >= 1 && guarded === false && logOpen && published && !junkPublished
    ? 0
    : 1
)

/**
 * browser-fetch.mjs — reach the sites plain HTTP cannot.
 *
 * Two classes of site refuse a CLI: bot gates (Cloudflare "Just a moment…",
 * HTTP 403/429/503) and pages whose content only exists after JavaScript runs.
 * This module renders such a page in a real browser and hands back the live
 * HTML, exactly like `fetchPage` does for the easy cases.
 *
 * Three things keep a Cloudflare gate from looping:
 *
 *   1. a genuine browser. Playwright's bundled Chromium is fingerprinted and
 *      rejected by some gates — you solve the checkbox and it asks again. If
 *      Chrome / Edge / Opera / Brave is installed, it is used instead
 *      (BUILDER_BROWSER=<path> forces one).
 *   2. no spoofed user agent. cf_clearance is hashed with the UA the browser
 *      really has; overriding it makes the cookie invalid on the next request,
 *      which is the classic "verify, refresh, verify again" loop.
 *   3. accurate gate detection. A page that merely embeds a Turnstile widget
 *      (login/search forms) is NOT a gate; treating it as one made the tool go
 *      on clicking after the site had already let us in.
 *
 * A fourth gate is not ours to pass: some sites challenge per path even after
 * letting a page through. Those get a short look, not 150 seconds of reloading —
 * see `clearedOrigins`.
 *
 * The profile is persistent (`.browser-profile…/`) so a human-only challenge is
 * solved once. Calls are serialised — one window at a time, however big the
 * batch — and the context must be closed with `closeBrowser()`.
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Cloudflare's own wording for "the site behind me is down" — no gate to pass. */
const ORIGIN_DOWN = /\b52[012]\b|connection timed out|origin error|web server is down|no route to host/i

/** Only ever present on a Cloudflare interstitial — never on a real page. */
const GATE_MARKERS = /cf_chl_opt|_cf_chl|cf-browser-verification|cf-chl-bypass/i
const GATE_TITLES =
  /just a moment|attention required|checking your browser|browser verification|verifying your browser|please wait|one moment|you have been blocked|access denied|error\s*403/i
/** A wall a human clicking cannot get past: Cloudflare refused, not testing. */
const HARD_BLOCK_TITLES = /attention required|you have been blocked|error\s*(10\d\d|403)/i

function titleOf(html) {
  const m = /<title[^>]*>([^<]{0,160})/i.exec(String(html || ''))
  return m ? m[1] : ''
}

/** True when a plain-HTTP response is a bot gate rather than a real answer. */
export function isBotBlocked(status, html) {
  if (status === 403 || status === 429 || status === 503) return true
  const head = String(html || '').slice(0, 20000)
  if (!head) return false
  if (GATE_MARKERS.test(head)) return true
  return GATE_TITLES.test(titleOf(head))
}

const CANDIDATE_BROWSERS = [
  ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  ['Chrome', 'C:\\Users\\%U%\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'],
  ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['Vivaldi', 'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe'],
  ['Opera GX', 'C:\\Users\\%U%\\AppData\\Local\\Programs\\Opera GX\\opera.exe'],
  ['Opera', 'C:\\Users\\%U%\\AppData\\Local\\Programs\\Opera\\opera.exe']
]

function realBrowser() {
  const override = process.env.BUILDER_BROWSER
  if (override && existsSync(override)) {
    const name = override.split(/[\\/]/).pop().replace(/\.exe$/i, '')
    return { label: name, path: override }
  }
  const user = process.env.USERNAME || process.env.USER || ''
  for (const [label, raw] of CANDIDATE_BROWSERS) {
    const path = raw.replace('%U%', user)
    if (path.includes('%U%')) continue
    if (existsSync(path)) return { label, path }
  }
  return null
}

let contextPromise = null
let announced = false

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync'
]

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

async function openWith(browser) {
  // A profile written by a different Chromium build is refused, so each browser
  // gets its own directory.
  const dir = join(__dirname, '.browser-profile' + (browser ? `-${slug(browser.label)}` : ''))
  return chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    // No userAgent override on purpose: the UA has to match the browser that is
    // really running, or Cloudflare voids the clearance it just handed us.
    args: LAUNCH_ARGS,
    ...(browser ? { executablePath: browser.path } : {})
  })
}

async function launch() {
  if (!contextPromise) {
    const browser = realBrowser()
    const attempts = browser ? [browser, null] : [null]
    contextPromise = (async () => {
      let lastError = null
      for (const candidate of attempts) {
        try {
          const context = await openWith(candidate)
          if (!announced) {
            announced = true
            console.log(`   🌐 browser window: ${candidate ? candidate.label : 'bundled Chromium'}${forced() ? ' (BUILDER_BROWSER)' : ''}`)
          }
          return context
        } catch (err) {
          lastError = err
          if (candidate) console.log(`   ⚠️  ${candidate.label} refused to start — falling back to bundled Chromium`)
        }
      }
      throw lastError || new Error('no browser could be started')
    })()
    contextPromise.catch(() => { contextPromise = null })
  }
  return contextPromise
}

const forced = () => process.env.BUILDER_BROWSER && existsSync(process.env.BUILDER_BROWSER)

/**
 * What is this live document? 'clear' = the real page, 'challenge' = a gate that
 * can be passed, 'blocked' = a gate that refuses us no matter what is clicked,
 * 'sparse' = nothing has rendered yet (JS page, or a gate that identifies itself
 * only by being empty). Checked in the page, so a site that merely embeds a
 * Turnstile widget on a login or search form is not mistaken for a gate.
 */
async function gateState(page) {
  let seen
  try {
    seen = await page.evaluate(() => ({
      title: document.title || '',
      markers: /cf_chl_opt|_cf_chl_rt|cf-chl-bypass/i.test(
        document.documentElement ? document.documentElement.innerHTML.slice(0, 20000) : ''
      ),
      text: document.body ? document.body.innerText.trim().length : 0,
      links: document.querySelectorAll('a[href]').length
    }))
  } catch {
    return 'clear' // mid-navigation; the next poll decides
  }
  if (HARD_BLOCK_TITLES.test(seen.title)) return 'blocked'
  if (ORIGIN_DOWN.test(seen.title)) return 'blocked'
  if (GATE_TITLES.test(seen.title) || seen.markers) return 'challenge'
  if (seen.text < 200 && seen.links < 5) return 'sparse'
  return 'clear'
}

/**
 * Click a Cloudflare Turnstile "Verify you are human" checkbox if one is present.
 * The widget lives in a cross-origin iframe; Playwright can still reach into it.
 */
async function clickTurnstile(page) {
  const frames = page.frames().filter((f) => /challenges\.cloudflare\.com/.test(f.url()))
  for (const frame of frames) {
    const strategies = [
      (fr) => fr.getByRole('checkbox').first(),
      (fr) => fr.locator('input[type="checkbox"]').first(),
      (fr) => fr.locator('label').first()
    ]
    for (const pick of strategies) {
      try {
        const loc = pick(frame)
        if ((await loc.count()) > 0) {
          await loc.click({ timeout: 3000 })
          return true
        }
      } catch {
        /* try the next strategy / frame */
      }
    }
  }
  return false
}

/**
 * Read the document HTML, retrying through a navigation: Cloudflare reloads the
 * page the moment a challenge is solved, and page.content() throws while that
 * swap is in flight.
 */
async function safeContent(page) {
  for (let i = 0; i < 12; i++) {
    try {
      return await page.content()
    } catch {
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(800)
    }
  }
  return ''
}

let renderLock = Promise.resolve()

/**
 * Origins this session has already rendered unguarded. A host that let one page
 * through and then challenges the next one is guarding path by path, and that
 * wall does not come down for waiting or clicking — measured on mangalik.net,
 * where the homepage answers and /latest-updates and /manga-lists/ both sit on
 * "Just a moment…" identically in a fresh tab and a reused one.
 */
const clearedOrigins = new Set()

/** Origins that proved the above, so their later URLs get one look, not a wait. */
const hostileGates = new Set()

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * Render `url` in a real browser and return { status, text, finalUrl, xhrJson }.
 * `xhrJson` is every JSON response the page's own scripts made while loading.
 */
export function fetchRendered(url, referer = '') {
  const run = renderLock.then(() => render(url, referer))
  renderLock = run.then(() => {}, () => {})
  return run
}

async function render(url, referer = '') {
  const context = await launch()
  const page = await context.newPage()
  // Interception is itself a bot signal, so only the target document is routed
  // and the gate's own requests are left completely alone.
  if (referer) {
    await page.route((target) => target.href === url, (route) =>
      route.continue({ headers: { ...route.request().headers(), referer } })
    )
  }
  const xhrJson = []
  page.on('response', (res) => {
    const ct = res.headers()['content-type'] || ''
    if (!ct.includes('json') || xhrJson.length >= 25) return
    res
      .text()
      .then((body) => xhrJson.push({ url: res.url(), body }))
      .catch(() => {})
  })

  let status = 0
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    status = res ? res.status() : 200
  } catch (err) {
    await page.close().catch(() => {})
    throw err
  }

  // A managed challenge clears by itself once the page's JS runs; an interactive
  // one needs its checkbox clicked — by us, or, when Cloudflare insists on a
  // real human, by the user in this window. Once the gate is gone we stop
  // touching the page: clicking again is what restarts the challenge.
  //
  // One case is never worth waiting for: this session already rendered a page
  // from the host and the next one is challenged anyway. Measured on
  // mangalik.net, whose homepage passes while /latest-updates and /manga-lists/
  // sit on "Just a moment…" identically in a fresh tab and a reused one. That
  // wall is per-path, and waiting 150s on it — once per URL, ten URLs a build —
  // is what looks to the user like an endless reload that builds nothing.
  const origin = originOf(url)
  const provedPerPath = hostileGates.has(origin)
  const patient = !provedPerPath && !clearedOrigins.has(origin)
  // First contact this session gets the full wait, because a human may still
  // have a box to click. A host that cleared one page and challenged the next
  // gets a short look; one that has already proved it does this gets barely one.
  const patienceMs = provedPerPath ? 5_000 : patient ? 150_000 : 20_000
  const deadline = Date.now() + patienceMs
  const maxReloads = patient ? 6 : 2
  const sparseDeadline = Date.now() + (patient ? 25_000 : 5_000)
  let clicked = false
  let askedHuman = false
  // Cloudflare reloads the page each time it re-issues a challenge. A handful of
  // reloads while still gated means this browser is being refused in a loop, and
  // waiting longer only wastes the batch.
  let navigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  const gatedFrom = navigations
  let outcome = 'clear'
  /** Name the one gate that is not ours to pass, and stop spending time on it. */
  const noteHostile = () => {
    hostileGates.add(origin)
    console.log('   🔒 this site guards page by page: it let one page through and is still')
    console.log('      challenging the rest, so no click or wait opens them. Read as-is.')
  }
  for (let i = 0; ; i++) {
    const gate = await gateState(page)
    if (gate === 'clear') break
    if (gate === 'sparse') {
      outcome = 'sparse'
      if (Date.now() > sparseDeadline) break
      await page.waitForTimeout(1500)
      continue
    }
    if (gate === 'blocked') {
      outcome = 'blocked'
      console.log('   ⛔ Cloudflare says this site is refusing us (or its server is down) — no click fixes that')
      break
    }
    if (Date.now() > deadline) {
      if (patient) {
        outcome = 'timeout'
        console.log('   ⏳ the gate never cleared — the page is being read as-is')
      } else {
        outcome = 'loop'
        noteHostile()
      }
      break
    }
    if (navigations - gatedFrom >= maxReloads) {
      outcome = 'loop'
      if (patient) {
        console.log('   🔁 the gate keeps re-issuing itself for this browser — giving up on it')
        console.log('      (open the site once in your own browser; if it lets you in,')
        console.log('       re-run the build — the profile may carry the clearance)')
      } else {
        noteHostile()
      }
      break
    }
    if (!clicked && (i === 1 || i === 8 || i === 16)) {
      clicked = await clickTurnstile(page)
      if (clicked) console.log('   🖱️  clicked "Verify you are human"')
    }
    if (patient && i >= 6 && !askedHuman) {
      askedHuman = true
      await page.bringToFront().catch(() => {})
      // One line: the app shows the newest log line as the job's status.
      console.log('   ☝️  CLICK THE BOX IN THE BROWSER WINDOW — Cloudflare wants a human, waiting 2½ min')
    }
    await page.waitForTimeout(1500)
  }

  // Remember that this host answered us. A challenge on its *next* page is then
  // proof of a per-path rule rather than a test we might yet pass.
  if (outcome === 'clear') clearedOrigins.add(origin)

  // A challenge page never goes idle — it is a script polling itself — so
  // waiting the full 30s for networkidle on a page we have already given up on
  // is the other half of the reload storm.
  await page.waitForLoadState('networkidle', patient ? undefined : { timeout: 3_000 }).catch(() => {})
  // Client-rendered lists mount after networkidle; give the islands a beat.
  if (outcome !== 'blocked') await page.waitForTimeout(patient ? 1200 : 300)

  const text = await safeContent(page)
  const finalUrl = page.url()

  // The status came from the first (gated) response. If the gate has since
  // cleared and real HTML is present, the page is genuinely a 200.
  if (status >= 400 && text.length > 2000 && !isBotBlocked(0, text)) status = 200
  // Cloudflare serves its "the origin didn't answer" page with its own status,
  // so report the site as unreachable rather than letting a 7 KB error page be
  // analyzed as if it were the catalogue.
  if (outcome === 'blocked' || (status < 400 && ORIGIN_DOWN.test(titleOf(text)) && text.length < 40_000)) {
    status = 522
  }

  await page.close().catch(() => {})
  return { status, text, finalUrl, xhrJson }
}

/** Close the shared browser. Safe to call when nothing was launched. */
export async function closeBrowser() {
  if (!contextPromise) return
  const context = await contextPromise
  contextPromise = null
  await context.close().catch(() => {})
}

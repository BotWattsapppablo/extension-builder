/**
 * auto-build.mjs — Fully automatic extension builder.
 *
 * Just give it a URL, it does EVERYTHING:
 *   1. Fetches the homepage
 *   2. Auto-detects all CSS selectors
 *   3. Follows a manga link → detects details + chapters selectors
 *   4. Follows a chapter link → detects reader image selectors
 *   5. Generates the .js extension + index.json
 *
 * Usage:
 *   node auto-build.mjs https://mangapill.com
 *   node auto-build.mjs https://manganato.com
 *   node auto-build.mjs https://mangakakalot.com
 */
import { load } from 'cheerio'
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchRendered, isBotBlocked, closeBrowser } from './browser-fetch.mjs'
import { safeQuery } from './query-safety.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, 'output')

/**
 * output/index.json is read-modify-write, so concurrent builds (the batch app
 * runs up to 30 at once) would otherwise clobber each other's entries. Chaining
 * every update onto one promise keeps the file consistent.
 */
let indexLock = Promise.resolve()
function updateIndex(entry) {
  const task = indexLock.then(async () => {
    const indexPath = join(OUTPUT_DIR, 'index.json')
    let index = { name: 'Extension Builder Output', apiVersion: 1, extensions: [] }
    if (existsSync(indexPath)) {
      try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch { /* fresh */ }
    }
    const i = index.extensions.findIndex(e => e.packageId === entry.packageId)
    if (i >= 0) index.extensions[i] = entry
    else index.extensions.push(entry)
    // MihonPC lists whatever this file says: an entry whose .js is gone would show
    // an extension that fails the moment the user clicks install.
    index.extensions = index.extensions.filter(e => e.file && existsSync(join(OUTPUT_DIR, e.file)))
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  })
  // A failed write must not wedge the queue for later jobs.
  indexLock = task.catch(() => {})
  return task
}

/**
 * Drop an extension from the store index. MihonPC's list is whatever index.json
 * says, so an extension that failed its test has to be taken back out of it —
 * otherwise the user installs a broken source and finds out by hand.
 */
function removeFromIndex(packageId) {
  const task = indexLock.then(async () => {
    const indexPath = join(OUTPUT_DIR, 'index.json')
    if (!existsSync(indexPath)) return
    let index
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf8'))
    } catch {
      return
    }
    const before = index.extensions.length
    index.extensions = (index.extensions || []).filter((e) => e.packageId !== packageId)
    if (index.extensions.length !== before) writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  })
  indexLock = task.catch(() => {})
  return task
}

// ── Fetch helper ────────────────────────────────────────────────────────────

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5'
}

/**
 * A batch runs up to 30 sites at once. Different sites can be hit in parallel,
 * but one site must not see 30 requests at a time — that is how you get the
 * whole machine blocked. Requests are queued per hostname.
 */
const HOST_MIN_GAP_MS = 350
const hostQueue = new Map()
function throttleHost(host, fn) {
  const prev = hostQueue.get(host) || Promise.resolve()
  const slot = prev.then(() => fn(), () => fn())
  const chain = slot.then(() => new Promise(r => setTimeout(r, HOST_MIN_GAP_MS)), () => new Promise(r => setTimeout(r, HOST_MIN_GAP_MS)))
  hostQueue.set(host, chain)
  chain.then(() => { if (hostQueue.get(host) === chain) hostQueue.delete(host) })
  return slot
}

async function plainFetch(url, referer = '') {
  const headers = { ...HTTP_HEADERS }
  if (referer) headers['Referer'] = referer
  return throttleHost(new URL(url).hostname, async () => {
    const res = await fetch(url, { headers, redirect: 'follow' })
    return { status: res.status, text: await res.text(), finalUrl: res.url }
  })
}

let browserAnnounced = false

/**
 * Plain HTTP first; when the site answers with a bot gate, render it in a real
 * browser instead. Gated sites are fetched through the browser from then on.
 */
async function fetchPage(url, referer = '') {
  let plain
  try {
    plain = await plainFetch(url, referer)
  } catch (err) {
    plain = { status: 0, text: '', finalUrl: url, error: err }
  }
  if (!isBotBlocked(plain.status, plain.text)) return plain
  // Batch repair runs unattended: a window per gated site, each needing a human
  // click, is worse than failing that site and reporting why.
  if (process.env.BUILDER_NO_BROWSER) return plain
  if (!browserAnnounced) {
    browserAnnounced = true
    console.log('   🌐 Bot gate on plain HTTP — opening a real browser window (it closes itself when the build ends)')
  }
  console.log(`   🌐 browser fetch ${url.slice(0, 70)}`)
  try {
    const rendered = await fetchRendered(url, referer)
    if (!isBotBlocked(rendered.status, rendered.text)) {
      return { status: rendered.status, text: rendered.text, finalUrl: rendered.finalUrl }
    }
    return rendered.status === 0 ? plain : rendered
  } catch (err) {
    console.log(`   ⚠️  browser fetch failed: ${err.message.slice(0, 120)}`)
    return plain
  }
}

function absolute(base, href) {
  if (!href || typeof href !== 'string') return ''
  if (href.startsWith('http')) return href
  try { return new URL(href, base).href } catch { return '' }
}

// ── Smart selector detection ────────────────────────────────────────────────

/**
 * Try selectors in order, return first one with matches.
 */
function bestSelector($, candidates, minMatches = 1) {
  for (const sel of candidates) {
    try {
      const matched = $(sel)
      if (matched.length >= minMatches) return { selector: sel, count: matched.length, el: matched }
    } catch { /* skip invalid selectors */ }
  }
  return null
}

/**
 * The detected "card" is sometimes just the thumb wrapper while the real card
 * (with the title caption) is its parent — e.g. hentaifox: .inner_thumb inside
 * div.thumb. Promote to the parent when it consistently contains cards AND
 * carries extra text (the caption).
 */
function promoteCardRoot($, selector) {
  let cards = []
  try { cards = $(selector).toArray().slice(0, 20) } catch { return null }
  if (cards.length < 3) return null

  // Most common parent tag+class
  const parentKeys = new Map()
  for (const card of cards) {
    const p = $(card).parent()
    if (!p.length) continue
    const tag = (p.prop('tagName') || '').toLowerCase()
    const cls = (p.attr('class') || '').split(/\s+/).filter(Boolean)[0]
    if (!cls) continue
    const key = `${tag}.${cls}`
    parentKeys.set(key, (parentKeys.get(key) || 0) + 1)
  }
  let bestKey = null
  let bestCount = 0
  for (const [k, v] of parentKeys) {
    if (v > bestCount) { bestKey = k; bestCount = v }
  }
  if (!bestKey || bestCount / cards.length < 0.8) return null

  try {
    const parents = $(bestKey)
    if (parents.length < cards.length) return null
    let containsCards = 0
    const sample = parents.toArray().slice(0, 20)
    for (const pEl of sample) {
      if ($(pEl).find(selector).length > 0) containsCards++
    }
    if (containsCards < sample.length * 0.8) return null
    // The parent must carry extra content (the caption)
    const cardTextLen = $(cards[0]).text().trim().length
    const parentTextLen = $(sample[0]).text().trim().length
    if (parentTextLen > cardTextLen + 3) return bestKey
  } catch { return null }
  return null
}

/**
 * Detect manga card containers on the homepage.
 */
function detectCards($, baseUrl) {
  // Strategy: find repeated link+image patterns that look like manga cards
  const cardCandidates = [
    'div.grid > div:has(a[href] img)',
    '.manga-card',
    '.manga-item',
    '.series-item',
    '.content-item',
    '.list-story-item',
    '.item:has(a[href] img)',
    'div[class*="item"]:has(a[href] img)',
    '.panel-content-genres .content-genres-item',
    '.genres-item-info',
    'ul.manga-list > li:has(a img)',
    'ul.truyen-list > li:has(a img)',
    'div.card:has(a[href] img)',
    'div.col:has(a[href] img)',
    'article:has(a[href] img)',
    '.search-story-item',
    '.story_item',
    '.itemupdate',
    'div.group:has(a[href] img)',
    '.novel-item',
    // Generic ul/li list cards (mangakakalot/mangahere style)
    'ul[class*="list"] > li:has(a[href] img)',
    'li:has(> a[href] > img)',
    'ul > li:has(a[href] img)',
    '.bsx',
    '.bs',
    '.utao',
    '.imgu',
    '.listupd .bs',
    '.listupd > div',
    // Very broad fallbacks
    'div:has(> a[href] > img):not(nav):not(header):not(footer)',
  ]

  // Try each candidate — pick the one with the highest density of manga-type
  // links (broad `:has(...)` selectors would otherwise accept section wrappers)
  let best = null
  for (const sel of cardCandidates) {
    try {
      const matches = $(sel)
      if (matches.length < 3) continue
      let cardsWithLink = 0
      matches.each((_, el) => {
        const links = $(el).find('a[href]').toArray()
        if (links.some(a => /\/(manga|title|comic|series|manhua|manhwa|webtoon|read|book|chapter|truyen|novel)\//i.test($(a).attr('href') || ''))) {
          cardsWithLink++
        }
      })
      const density = cardsWithLink / matches.length
      if (density < 0.5) continue
      const score = density * Math.min(matches.length, 60)
      if (!best || score > best.score) best = { selector: sel, count: matches.length, score }
    } catch { /* invalid selector */ }
  }
  if (best) {
    const promoted = promoteCardRoot($, best.selector)
    if (promoted) {
      try { return { selector: promoted, count: $(promoted).length } } catch { /* keep */ }
    }
    return { selector: best.selector, count: best.count }
  }

  // Last resort: find repeated structures with images and links
  // Group by parent class
  const parentMap = new Map()
  $('a[href]:has(img)').each((_, el) => {
    const $parent = $(el).parent()
    const parentClass = $parent.attr('class') || ''
    const parentTag = $parent.prop('tagName') || 'div'
    if (parentClass) {
      const key = parentClass.split(/\s+/)[0]
      const sel = `.${key}`
      parentMap.set(sel, (parentMap.get(sel) || 0) + 1)
    }
  })

  // Pick the most repeated parent
  let bestParent = null
  let bestCount = 0
  for (const [sel, count] of parentMap) {
    if (count > bestCount && count >= 3) {
      bestParent = sel
      bestCount = count
    }
  }

  if (bestParent) {
    const promoted = promoteCardRoot($, bestParent)
    if (promoted) {
      try { return { selector: promoted, count: $(promoted).length } } catch { /* keep */ }
    }
    return { selector: bestParent, count: bestCount }
  }
  return { selector: 'div:has(> a img)', count: 0 }
}

/**
 * Detect the link selector inside a card. Falls back to the first link whose
 * href is NOT a category/tag/nav link, and builds the selector from its path
 * (e.g. a[href*="/gallery/"]).
 */
function detectCardLink($, cardSelector, baseUrl) {
  const cards = $(cardSelector)
  if (!cards.length) return 'a'
  const card = cards.first()

  // A refined link selector has to work on most of the cards, not just once
  // inside the first one — a selector that silently matches nothing turns the
  // whole catalogue into an empty list at runtime.
  const usable = (sel) => {
    let hit = 0
    cards.each((_, el) => {
      if ($(el).find(sel).length > 0) hit++
    })
    return hit >= Math.max(2, Math.ceil(cards.length * 0.5))
  }

  // Look for manga-type links
  const mangaPatterns = [
    'a[href*="/manga/"]',
    'a[href*="/title/"]',
    'a[href*="/comic/"]',
    'a[href*="/series/"]',
    'a[href*="/truyen/"]',
    'a[href*="/read/"]',
    'a[href*="/novel/"]',
    'a[href*="/book/"]',
    'a[href*="/manhua/"]',
    'a[href*="/manhwa/"]',
    'a[href*="/gallery/"]',
  ]
  for (const sel of mangaPatterns) {
    if (card.find(sel).length > 0 && usable(sel)) return sel
  }

  // Fallback: first link that isn't a category/tag/nav/search link
  const isJunk = (href) => /\/(category|categories|genre|genres|tag|tags|parody|parodies|artist|artists|group|groups|character|characters|language|languages|search|page|user|profile)[\/?]/i.test(href) || href === '/' || href === '#'
  for (const a of card.find('a[href]').toArray()) {
    const href = $(a).attr('href') || ''
    if (!href || isJunk(href)) continue
    // pathname, not split('/'): an absolute href starts with "https:" and used
    // to yield the selector a[href*="/https:/"], which matches nothing at all.
    let first = ''
    try {
      first = new URL(href, baseUrl).pathname.split('/').filter(Boolean)[0] || ''
    } catch {
      continue
    }
    if (first === '' || /^https?:$/i.test(first)) continue
    const sel = `a[href*="/${first}/"]`
    if (usable(sel)) return sel
  }
  return 'a'
}

/**
 * Detect the title selector inside a card — scored across MANY cards so a
 * section-heading wrapper (e.g. h4 "New Chapters") can't win. The div inside
 * the content link is tried first (it's the title on most sites), and
 * rank-like text ("#248", "Ch. 12") is rejected.
 * Returns { selector, attrMode } — attrMode means the title lives in the
 * `title` attribute, not the text.
 */
function detectCardTitle($, cardSelector) {
  const cards = $(cardSelector).toArray().slice(0, 30)
  if (cards.length === 0) return { selector: 'a', attrMode: false }

  const isBadTitle = (t) =>
    t.length <= 1 || t.length > 200 ||
    /^(new chapters?|latest|popular|trending|updates|all|ongoing|completed)\b/i.test(t) ||
    /^#?\d+(\.\d+)?$/.test(t) || // bare number / rank badge
    /^ch(\.|apter)?\s*\d+/i.test(t) // "Ch.239" subtitle

  const candidates = [
    // Title inside the content link — the most common pattern
    'a[href*="/manga/"] div', 'a[href*="/title/"] div', 'a[href*="/comic/"] div',
    'a[href*="/series/"] div', 'a[href*="/read/"] div', 'a[href*="/book/"] div',
    'a[href*="/gallery/"] div',
    'a[href*="/manhua/"] div', 'a[href*="/manhwa/"] div', 'a[href*="/truyen/"] div',
    '[class*="item-title"] a', 'p[class*="item-title"] a',
    'h3.title', 'h3', 'h2', 'h5', 'h4',
    '.title', '.name', '.series-title',
    'div.font-black', 'div.font-bold', 'div.text-sm.font-bold',
    'span.title', 'p.title', '[class*="title"] a', '[class*="caption"] a',
    '.item-title', '.tt',
    { sel: 'a[title]', attrMode: 'title' },
    { sel: 'img[alt]', attrMode: 'alt' },
    'a'
  ]

  let best = null
  for (const cand of candidates) {
    const sel = typeof cand === 'string' ? cand : cand.sel
    const attrName = typeof cand === 'string' ? null : cand.attrMode
    let good = 0
    for (const card of cards) {
      let match = null
      try { match = $(card).find(sel).first() } catch { break }
      if (match.length === 0) continue
      const text = attrName ? (match.attr(attrName) || '') : match.text()
      const t = (text || '').trim()
      if (!isBadTitle(t)) good++
    }
    const ratio = good / cards.length
    if (!best || ratio > best.ratio) best = { selector: sel, attrMode: attrName, ratio }
    if (best.ratio >= 0.8) break
  }
  return best && best.ratio >= 0.25
    ? { selector: best.selector, attrMode: best.attrMode || false }
    : { selector: 'a', attrMode: false }
}

/**
 * Detect cover image inside a card.
 */
function detectCardCover($, cardSelector) {
  const card = $(cardSelector).first()
  if (!card.length) return { selector: 'img', attr: 'src' }

  if (card.find('img[data-src]').length > 0) return { selector: 'img[data-src]', attr: 'data-src' }
  if (card.find('img.lazyload').length > 0) {
    const img = card.find('img.lazyload').first()
    if (img.attr('data-src')) return { selector: 'img.lazyload', attr: 'data-src' }
    return { selector: 'img.lazyload', attr: 'src' }
  }
  if (card.find('img[data-lazy-src]').length > 0) return { selector: 'img', attr: 'data-lazy-src' }
  if (card.find('img[loading="lazy"]').length > 0) return { selector: 'img', attr: 'src' }
  if (card.find('img').length > 0) return { selector: 'img', attr: 'src' }
  return { selector: 'img', attr: 'src' }
}

/**
 * Get the first manga URL from the homepage for follow-up analysis.
 * Prefers links matching content-path patterns and never returns the
 * homepage itself (that poisoned the details detection on mangahere).
 */
function getFirstMangaUrl($, cardSelector, linkSelector, baseUrl) {
  const contentRe = /\/(manga|title|comic|series|manhua|manhwa|webtoon|read|book|truyen|novel)\//i
  const cards = $(cardSelector).toArray().slice(0, 10)
  for (const card of cards) {
    const links = $(card).find(linkSelector || 'a').toArray()
    // 1st pass: content-pattern links
    for (const a of links) {
      const href = absolute(baseUrl, $(a).attr('href') || '')
      if (href && contentRe.test(href)) return href
    }
    // 2nd pass: any link that's not the homepage
    for (const a of links) {
      const href = absolute(baseUrl, $(a).attr('href') || '')
      if (href && href !== baseUrl && href !== `${baseUrl}/`) return href
    }
  }
  return null
}

/**
 * Detect details page selectors from a manga page.
 */
function detectDetailsSelectors($) {
  // Title — h1/h2 first, then class-substring patterns for themed sites
  const titleCandidates = [
    'h1', 'h2.title', '.story-info-right h1', '.manga-info-text h1', '.post-title h1', '.entry-title',
    '[class*="title-font"]', 'span[class*="title"]', 'div[class*="title"] h1',
    'p[class*="title"] a', 'p[class*="title"]', '.title h1', '.title'
  ]
  let titleSel = 'h1'
  for (const sel of titleCandidates) {
    try {
      const m = $(sel)
      if (m.length > 0 && m.first().text().trim().length > 1 && !/^(ongoing|completed|hiatus)$/i.test(m.first().text().trim())) { titleSel = sel; break }
    } catch { /* skip */ }
  }

  // Description — specific IDs first (MangaKakalot-family sites reuse
  // `.description` for site-wide announcement banners), generic classes last.
  // Some themes render the synopsis client-side but leave it in a <meta> tag
  // or a prose wrapper, so those are candidates too (meta needs attr=content).
  const descCandidates = [
    { sel: '#noidungm', attr: '' }, { sel: '#contentBox', attr: '' }, { sel: '#story-disqus', attr: '' },
    { sel: '.manga-info-text .noidungm', attr: '' },
    { sel: '.description', attr: '' }, { sel: '.summary__content', attr: '' },
    { sel: 'div[class*="prose"]', attr: '' },
    { sel: '.panel-story-info-description', attr: '' }, { sel: 'div.mb-3 p', attr: '' },
    { sel: '.entry-content', attr: '' }, { sel: '.desc', attr: '' }, { sel: '.summary', attr: '' }, { sel: '#summary', attr: '' },
    { sel: 'div[class*="desc"]', attr: '' }, { sel: 'div[class*="synopsis"]', attr: '' }, { sel: '[class*="summary"]', attr: '' },
    { sel: '[class*="intro"]', attr: '' }, { sel: 'div[class*="content"] p', attr: '' },
    { sel: '.story-info-right .panel-story-info-description', attr: '' },
    { sel: 'meta[property="og:description"]', attr: 'content' },
    { sel: 'meta[name="description"]', attr: 'content' }
  ]
  let descSel = '.description'
  let descAttr = ''
  for (const c of descCandidates) {
    try {
      const m = $(c.sel)
      const t = m.length > 0 ? (c.attr ? (m.first().attr(c.attr) || '') : m.first().text()).trim() : ''
      // sane description: substantial but not a whole-page wrapper
      if (t.length > 10 && t.length < 3000) { descSel = c.sel; descAttr = c.attr; break }
    } catch { /* skip */ }
  }

  // Cover — scan every match of a candidate, not just the first: themes put
  // blurred banners and logos ahead of the real poster, and only a per-match
  // scan skips those. <meta og:image> and id/class hooks beat a bare `img`.
  let coverSel = 'img'
  let coverAttr = 'src'
  const coverCandidates = [
    { sel: 'img[id*="cover"]', attr: 'src' },
    { sel: 'meta[property="og:image"]', attr: 'content' },
    { sel: 'meta[name="og:image"]', attr: 'content' },
    { sel: '.info-image img', attr: 'src' },
    { sel: '.manga-info-pic img', attr: 'src' },
    { sel: 'img.summary_image', attr: 'src' },
    { sel: 'img[class*="cover"]', attr: 'src' },
    { sel: '[class*="cover"] img', attr: 'src' },
    { sel: 'img[class*="poster"]', attr: 'src' },
    { sel: '[class*="poster"] img', attr: 'src' },
    { sel: 'img[data-src]', attr: 'data-src' },
    { sel: '.thumb img', attr: 'src' },
    { sel: '.post-thumb img', attr: 'src' },
    { sel: '.book-cover img', attr: 'src' },
    { sel: 'img.cover', attr: 'src' },
    { sel: 'img', attr: 'src' },
  ]
  for (const c of coverCandidates) {
    try {
      const m = $(c.sel)
      for (let i = 0; i < m.length && i < 12; i++) {
        const src = m.eq(i).attr(c.attr) || ''
        if (src && !/logo|icon|avatar|banner|star|default-|placeholder/i.test(src)) { coverSel = c.sel; coverAttr = c.attr; break }
      }
      if (coverSel === c.sel) break
    } catch { /* skip */ }
  }

  // Status
  const statusCandidates = [
    '.status', '[class*="status"]', 'label:contains("Status") + div', '.info-status',
    '.manga-info-text li:contains("Status")', 'td:contains("Status") + td',
    'span:contains("Status")', '.post-status', '.summary-heading:contains("Status") + .summary-content',
    'span[class*="tip"]', 'li:contains("Status")', 'div:contains("Status")'
  ]
  let statusSel = '.status'
  for (const sel of statusCandidates) {
    try { if ($(sel).length > 0) { statusSel = sel; break } } catch { /* skip */ }
  }

  // Genres
  const genresCandidates = [
    '.genres a', '[class*="genre"] a', 'a[href*="genre"]', 'a[href*="category"]',
    '[class*="tag"] a', '.manga-info-text a[href*="genre"]', '.tag',
    '.genres-content a', 'a.a-h[href*="genre"]', '.info-genres a'
  ]
  let genresSel = '.tags a'
  for (const sel of genresCandidates) {
    try { if ($(sel).length >= 1) { genresSel = sel; break } } catch { /* skip */ }
  }

  // Author / Artist — content links first, then labelled text rows like
  // "Author(s) : Oda Eiichirou" (the extension strips the label after ':').
  // :contains is case-sensitive in cheerio, so try common capitalizations.
  const personLabelSel = (label) => [
    `a[href*="${label.toLowerCase()}"]`,
    `[class*="${label.toLowerCase()}"] a`,
    `td:contains("${label}") + td a`,
    `span:contains("${label}") + span`,
    `li:contains("${label}") a`,
    `[class*="${label.toLowerCase()}"] a`,
    `li:contains("${label}")`, `span:contains("${label}")`, `td:contains("${label}")`, `p:contains("${label}")`,
    `li:contains("${label.toLowerCase()}")`, `span:contains("${label.toLowerCase()}")`,
    `[class*="${label.toLowerCase()}"]`
  ]
  const personRowOk = (text, label) => {
    const t = (text || '').trim()
    if (t.length < 1 || t.length > 200) return false
    // either a bare name (link) or a labelled row starting with the label
    return new RegExp('^' + label, 'i').test(t) || !t.includes(':')
  }
  const detectPerson = (label) => {
    for (const sel of personLabelSel(label)) {
      try {
        const m = $(sel)
        if (m.length > 0 && personRowOk(m.first().text(), label)) return sel
      } catch { /* skip */ }
    }
    // "Artist" often labelled "Art" or "Art by" — try those for artist only
    if (label === 'Artist') {
      for (const sel of ['li:contains("Art by")', 'td:contains("Art")', 'span:contains("Art by")', 'p:contains("Art by")']) {
        try {
          const m = $(sel)
          if (m.length > 0 && /^(art(ist)?\s*(by)?\s*[:\-])/i.test((m.first().text() || '').trim())) return sel
        } catch { /* skip */ }
      }
    }
    return ''
  }

  const authorSel = detectPerson('Author')
  const artistSel = detectPerson('Artist')

  return { title: titleSel, description: descSel, descriptionAttr: descAttr, cover: coverSel, coverAttr, status: statusSel, genres: genresSel, author: authorSel, artist: artistSel }
}

/**
 * Chapter links often wrap the title AND a badge/date in sibling spans, so the
 * link's own text reads "Chapter 4Just now". Find the innermost element that
 * carries just the title, so the generated extension reads that instead.
 * Returns '' when the link text is already clean.
 */
function detectSelfLinkNameSelector($, listSelector) {
  const NAME_RE = /^(ch(apter)?|ep(isode)?|vol(ume)?|#)?[\s.\-]*\d/i
  let first
  try {
    first = $(listSelector).first()
  } catch {
    return ''
  }
  if (!first || first.length === 0) return ''
  const whole = first.text().replace(/\s+/g, ' ').trim()
  if (whole === '') return ''
  let best = ''
  first.find('*').each((_, el) => {
    if (best) return
    const $el = $(el)
    const t = $el.text().replace(/\s+/g, ' ').trim()
    if (t === '' || t === whole) return
    if (!NAME_RE.test(t)) return
    // innermost: no descendant repeats this exact text
    const repeats = $el.find('*').filter((_, d) => $(d).text().replace(/\s+/g, ' ').trim() === t)
    if (repeats.length > 0) return
    const tag = (el.tagName || '').toLowerCase()
    const cls = ($el.attr('class') || '').trim().split(/\s+/)[0]
    best = cls ? `${tag}.${cls}` : tag
  })
  return best
}

/**
 * Detect chapter list selectors from a manga page.
 * Strategy 1 (generic): find the container holding the most chapter-like
 * links — works on any theme without a hardcoded candidate.
 * Strategy 2: known selector patterns.
 */
function detectChapterSelectors($) {
  const CHAPTER_LINK_RE = /chapter|\/c\d|[\-\.]ch\d|\/chapters?\//i

  // 1) Generic container scan
  const containerCount = new Map()
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || ''
    if (!CHAPTER_LINK_RE.test(href)) return
    let p = $(a).parent()
    let registered = 0
    for (let depth = 0; depth < 6 && p.length && registered < 2; depth++) {
      const tag = (p.prop('tagName') || '').toLowerCase()
      const classes = (p.attr('class') || '').split(/\s+/).filter(Boolean)
      const id = p.attr('id')
      if (id || classes.length > 0) {
        const key = id ? `#${id}` : `${tag}.${classes[0]}`
        containerCount.set(key, (containerCount.get(key) || 0) + 1)
        registered++
      }
      p = p.parent()
    }
  })

  // Rank containers: density first, so a page-wide wrapper that also holds
  // buttons/novel links loses to the tight chapter list; among equally tight
  // containers the one with more chapter links wins (full list beats widgets).
  const ranked = []
  for (const [key] of containerCount) {
    try {
      const all = $(`${key} a[href]`)
      if (all.length < 3) continue
      let chapterLinks = 0
      all.each((_, el) => {
        if (CHAPTER_LINK_RE.test($(el).attr('href') || '')) chapterLinks++
      })
      if (chapterLinks >= 3 && chapterLinks / all.length >= 0.5) {
        ranked.push({ key, chapterLinks, total: all.length, density: chapterLinks / all.length })
      }
    } catch { /* invalid selector */ }
  }
  ranked.sort((x, y) => (y.density - x.density) || (y.chapterLinks - x.chapterLinks))
  const top = ranked[0]
  if (top) {
    return { list: `${top.key} a[href]`, link: '', name: detectSelfLinkNameSelector($, `${top.key} a[href]`), date: '', isSelfLink: true }
  }

  // 2) Known-pattern candidates
  const candidates = [
    { list: '#chapters a[href*="/chapter"]', link: 'self', name: 'self' },
    { list: '.chapter-list li', link: 'a', name: 'a' },
    { list: '.row-content-chapter li', link: 'a', name: 'a' },
    { list: 'ul.row-content-chapter li', link: 'a', name: 'a' },
    { list: '.chapter-list a', link: 'self', name: 'self' },
    { list: '#chapter a', link: 'self', name: 'self' },
    { list: '.chapters li', link: 'a', name: 'a' },
    { list: 'ul.chapters li', link: 'a', name: 'a' },
    { list: '.listing-chapters_wrap li', link: 'a', name: 'a' },
    { list: '.wp-manga-chapter', link: 'a', name: 'a' },
    { list: '.version-chap li', link: 'a', name: 'a' },
    { list: '.eph-num', link: 'a', name: 'a .chapternum' },
    { list: 'a[href*="/chapter"]', link: 'self', name: 'self' },
    { list: 'a[href*="/ch-"]', link: 'self', name: 'self' },
    { list: 'a[href*="/chapters/"]', link: 'self', name: 'self' },
  ]

  for (const c of candidates) {
    try {
      const matches = $(c.list)
      if (matches.length >= 1) {
        // Verify they have actual chapter-looking links
        let hasChapterLinks = false
        matches.each((_, el) => {
          const $el = $(el)
          const href = c.link === 'self' ? $el.attr('href') : $el.find('a').first().attr('href')
          if (href && href.match(/chapter|ch[\-\.\/]|\/\d+\/?$/i)) hasChapterLinks = true
        })
        if (hasChapterLinks || matches.length >= 3) {
          // Find date selector
          let dateSel = ''
          const firstItem = matches.first()
          const dateCandidates = ['.date', 'time', '.chapter-time', '.chapter-date', 'span.chapter-release-date', '.release-date']
          for (const ds of dateCandidates) {
            if (firstItem.find(ds).length > 0 || (c.link === 'self' && firstItem.parent().find(ds).length > 0)) {
              dateSel = ds
              break
            }
          }
          return { list: c.list, link: c.link === 'self' ? '' : c.link, name: c.link === 'self' ? detectSelfLinkNameSelector($, c.list) : c.name, date: dateSel, isSelfLink: c.link === 'self' }
        }
      }
    } catch { /* skip */ }
  }

  return { list: '.chapter-list li', link: 'a', name: 'a', date: '', isSelfLink: false }
}

/**
 * Detect reader page image selectors.
 */
function detectReaderSelectors($) {
  const candidates = [
    { sel: 'img.js-page[data-src]', attr: 'data-src' },
    { sel: 'img.js-page', attr: 'src' },
    { sel: '#reader img.page', attr: 'src' },
    { sel: '#reader img', attr: 'src' },
    { sel: 'img.wp-manga-chapter-img', attr: 'src' },
    { sel: '.reading-content img', attr: 'src' },
    { sel: '.container-chapter-reader img', attr: 'src' },
    { sel: '#readerarea img', attr: 'src' },
    { sel: '.page-container img', attr: 'src' },
    { sel: 'img.page-image', attr: 'src' },
    { sel: 'img[data-src]', attr: 'data-src' },
    { sel: '.viewer-cnt img', attr: 'src' },
    { sel: '#image-container img', attr: 'src' },
    { sel: 'img.img-responsive', attr: 'src' },
    { sel: '.chapter-content img', attr: 'src' },
  ]

  for (const c of candidates) {
    const matches = $(c.sel)
    if (matches.length >= 1) {
      // Verify images look like manga pages (not tiny icons)
      let validCount = 0
      matches.each((_, el) => {
        const src = $(el).attr(c.attr) || ''
        if (src && !/logo|icon|avatar|banner|star/i.test(src)) {
          validCount++
        }
      })
      if (validCount >= 1) return { images: c.sel, imageAttr: c.attr }
    }
  }

  return { images: 'img', imageAttr: 'src' }
}

/**
 * Href paths that point at content pages — never valid as listing pages.
 * (manga details, chapters, news articles, profiles, ...)
 */
const CONTENT_PATH_RE = /\/(manga|title|comic|series|manhua|manhwa|webtoon|read|reader|book|chapter|chapters|truyen|novel|news|blog|article|user|profile|genre|genres|tag|tags|search|parody|parodies|category|categories|artist|artists|group|groups|character|characters|language|languages|tag)(\/|$|\?)/i

function segMatches(href, words) {
  let segs = []
  try {
    segs = new URL(href).pathname.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  } catch { return false }
  return segs.some(seg => words.some(w => seg === w || seg.startsWith(w + '-') || seg.endsWith('-' + w) || seg === w + 's'))
}

/**
 * Detect search URL pattern.
 */
function detectSearchUrl($, baseUrl) {
  // Look for search forms
  const forms = $('form[action*="search"], form:has(input[name="q"]), form:has(input[name="query"]), form:has(input[name="keyword"]), form:has(input[name="s"]), form:has(input[name="search"])')
  if (forms.length > 0) {
    const form = forms.first()
    const action = form.attr('action') || '/search'
    const input = form.find('input[type="text"], input[type="search"], input[name="q"], input[name="query"], input[name="keyword"], input[name="s"], input[name="search"]').first()
    const paramName = input.attr('name') || 'q'
    const fullAction = absolute(baseUrl, action)
    return `${fullAction}${fullAction.includes('?') ? '&' : '?'}${paramName}={query}`
  }

  // Check if any search link exists on the page
  const searchLinks = $('a[href*="search"]')
  if (searchLinks.length > 0) {
    const href = absolute(baseUrl, searchLinks.first().attr('href') || '')
    if (href) {
      try {
        const u = new URL(href)
        return `${u.origin}${u.pathname === '/' ? '/search' : u.pathname}?q={query}`
      } catch { /* fallback */ }
    }
  }

  return `${baseUrl}/search?q={query}`
}

/**
 * Detect a popular-listing link — a site-internal URL whose PATH clearly says
 * popular/trending/top. Manga content links (e.g. "ousama-ranking") and news
 * pages never qualify — that was the bug where the tool picked
 * /manga/5764/ousama-ranking as the popular page.
 */
function detectPopularLink($, baseUrl) {
  const POP_WORDS = ['popular', 'trending', 'hot', 'top', 'ranking', 'browse', 'discover']
  let found = null
  $('a[href]').each((_, el) => {
    if (found) return false
    const href = absolute(baseUrl, $(el).attr('href'))
    if (!href || !href.startsWith(baseUrl)) return
    try {
      const u = new URL(href)
      if (u.pathname === '/' || u.pathname === '') return
      if (CONTENT_PATH_RE.test(u.pathname)) return
      if (segMatches(href, POP_WORDS)) { found = u.origin + u.pathname + u.search; return false }
    } catch { /* skip */ }
  })
  return found
}

/**
 * Detect a latest-updates listing link. News/blog/article pages do not count
 * (the old detector matched "/news/23/new-updates" via *new*).
 */
function detectLatestLink($, baseUrl) {
  const LATEST_WORDS = ['latest', 'recent', 'update', 'updates', 'newest', 'recently']
  let found = null
  $('a[href]').each((_, el) => {
    if (found) return false
    const href = absolute(baseUrl, $(el).attr('href'))
    if (!href || !href.startsWith(baseUrl)) return
    try {
      const u = new URL(href)
      if (u.pathname === '/' || u.pathname === '') return
      if (CONTENT_PATH_RE.test(u.pathname)) return
      if (/(news|blog|article)/i.test(u.pathname)) return
      if (segMatches(href, LATEST_WORDS)) { found = u.origin + u.pathname + u.search; return false }
    } catch { /* skip */ }
  })
  return found
}

/**
 * Fetch a listing URL and count how many card-selector hits it yields.
 * minCount guards against near-empty pages passing validation.
 * Returns the parsed page ($) so callers can reuse it.
 */
async function countCards(url, cardSelector, referer = '', minCount = 5) {
  try {
    const page = await fetchPage(url, referer)
    if (page.status >= 400) return { ok: false, count: 0, status: page.status, $: null }
    const $ = load(page.text)
    let count = 0
    try { count = $(cardSelector).length } catch { count = 0 }
    return { ok: count >= minCount, count, status: page.status, $ }
  } catch {
    return { ok: false, count: 0, status: 0, $: null }
  }
}

/**
 * Resolve the search URL by *testing* candidates with a real query —
 * the first variant that actually renders manga cards wins.
 *
 * Some themes (e.g. Astro "browse" catalogues) have no /search page at all: the
 * listing URL itself filters via ?search=/?q=. So the listing is tried as a
 * search base too. A param the site silently ignores returns the unfiltered
 * catalogue, which is not a search — `unfilteredLinks` (the listing's page-1
 * card links) lets us reject those.
 */
async function resolveSearchUrl(baseUrl, cardSelector, detectedSearch, listingUrl = null, unfilteredLinks = null, sampleQuery = null) {
  let searchBase = baseUrl + '/search'
  if (detectedSearch) {
    try {
      const u = new URL(detectedSearch.replace('{query}', 'x'))
      searchBase = u.origin + (u.pathname === '/' || u.pathname === '/x' ? '/search' : u.pathname)
    } catch { /* keep default */ }
  }
  const bases = [...new Set([searchBase, baseUrl + '/search', listingUrl].filter(Boolean))]
  const params = ['q', 'search', 'keyword', 'query', 's']
  // 'one piece' exists on most manga catalogues but not on manhwa-only ones, so
  // a second pass retries with a title we know the site actually carries.
  const queries = [...new Set(['one piece', safeQuery(sampleQuery)].filter(Boolean))]

  for (const testQuery of queries) {
    const q = encodeURIComponent(testQuery)
    for (const base of bases) {
      for (const param of params) {
        const candidate = `${base}${base.includes('?') ? '&' : '?'}${param}=${q}`
        const v = await countCards(candidate, cardSelector, baseUrl, 1)
        if (!v.ok) {
          console.log(`   🧪 search  ${candidate} → no cards (HTTP ${v.status})`)
          continue
        }
        if (unfilteredLinks && base === listingUrl) {
          const links = [...new Set(v.$(cardSelector).find('a[href]').map((_, el) => v.$(el).attr('href')).get())]
          if (links.length === unfilteredLinks.size && links.every((h) => unfilteredLinks.has(h))) {
            console.log(`   🧪 search  ${candidate} → ${v.count} cards but identical to unfiltered listing (param ignored)`)
            continue
          }
        }
        console.log(`   🧪 search  ${candidate} → OK (${v.count} cards)`)
        return `${base}${base.includes('?') ? '&' : '?'}${param}={query}`
      }
    }
  }
  return null
}

/**
 * Detect pagination on a listing page. Returns { type, param } or null.
 */
function detectPagination($page, listingUrl) {
  const seen = new Set()
  let found = null
  $page('a[href]').each((_, el) => {
    if (found) return false
    const href = $page(el).attr('href') || ''
    if (!href || seen.has(href)) return
    seen.add(href)
    if (!href.startsWith(listingUrl.split('?')[0]) && !href.startsWith('/')) return
    let m = /[?&](page|p)=(\d+)/i.exec(href)
    if (m && Number(m[2]) >= 2) { found = { type: 'query', param: m[1] }; return false }
    m = /\/page\/(\d+)/i.exec(href)
    if (m && Number(m[1]) >= 2) { found = { type: 'path' }; return false }
  })
  return found
}

/**
 * Build a listing URL for a given page number (or '{page}' template).
 * Uses a sentinel because URLSearchParams percent-encodes braces
 * ({page} → %7Bpage%7D) which broke pagination in generated extensions.
 */
const PAGE_SENTINEL = 'mihonPAGEplaceholder'
function withPage(url, pag, page) {
  if (!pag) return url
  try {
    const u = new URL(url)
    if (pag.type === 'query') {
      u.searchParams.set(pag.param, PAGE_SENTINEL)
      const out = u.origin + u.pathname + u.search
      return out.replace(PAGE_SENTINEL, String(page))
    }
    return (u.origin + u.pathname.replace(/\/$/, '')) + '/page/' + String(page) + u.search
  } catch { return url }
}

/**
 * Depth-first search for an array of chapter-like objects in a JSON payload.
 */
function findChapterArray(node, depth = 0) {
  if (depth > 5 || node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    if (node.length >= 3 && node[0] && typeof node[0] === 'object' && !Array.isArray(node[0])) {
      const item = node[0]
      const hasName = ['chapter_name', 'name', 'title', 'chapter_title'].some(k => typeof item[k] === 'string' && item[k].length > 0)
      const hasSlug = ['chapter_slug', 'slug', 'url', 'chapter_id', 'id', 'chapter_num', 'number'].some(k => item[k] !== undefined)
      if (hasName && hasSlug) return node
    }
    for (const item of node.slice(0, 5)) {
      const r = findChapterArray(item, depth + 1)
      if (r) return r
    }
    return null
  }
  for (const v of Object.values(node)) {
    const r = findChapterArray(v, depth + 1)
    if (r) return r
  }
  return null
}

/**
 * Some sites render only nav buttons server-side and load the real chapter
 * list from a JSON API. Probe the common patterns; return the relative API
 * path (with {slug}) when one works.
 */
async function probeChapterApi(baseUrl, mangaUrl) {
  let slug = ''
  try { slug = new URL(mangaUrl).pathname.split('/').filter(Boolean).pop() || '' } catch { return null }
  if (!slug || slug.length < 2) return null

  const candidates = [
    `/api/manga/${slug}/chapters`,
    `/api/comic/${slug}/chapters`,
    `/api/manga/${slug}/chapter-list`,
    `/api/chapter/list?manga=${slug}`,
  ]
  for (const path of candidates) {
    try {
      const res = await fetchPage(baseUrl + path, baseUrl + '/')
      if (res.status >= 400) continue
      let json
      try { json = JSON.parse(res.text) } catch { continue }
      const arr = findChapterArray(json)
      if (arr && arr.length >= 3) {
        let bestPath = path
        let bestCount = arr.length
        // Many chapter APIs cap the default page (e.g. 50) — a high `limit`
        // often returns the whole list. Keep whichever variant returns most.
        for (const limit of [2000, 5000]) {
          try {
            const res2 = await fetchPage(`${baseUrl + path}${path.includes('?') ? '&' : '?'}limit=${limit}`, baseUrl + '/')
            if (res2.status >= 400) continue
            const json2 = JSON.parse(res2.text)
            const arr2 = findChapterArray(json2)
            if (arr2 && arr2.length > bestCount) {
              bestPath = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}`
              bestCount = arr2.length
            }
          } catch { /* keep base path */ }
        }
        return { apiPath: bestPath.replace(slug, '{slug}'), count: bestCount }
      }
    } catch { /* next */ }
  }
  return null
}

/**
 * Check if the site needs a Referer for images.
 */
function detectNeedsReferer($) {
  // Sites that use data-src or lazy loading often need referer
  const lazyImages = $('img[data-src]').length
  return lazyImages > 5
}

/**
 * Crude NSFW heuristic — hostname/title/markers. Better true than wrongly
 * false (the app hides NSFW sources behind a setting; a wrong `false` would
 * surface adult content in a general browse).
 */
function detectNsfw(siteUrl, $home) {
  const hostname = (() => { try { return new URL(siteUrl).hostname.toLowerCase() } catch { return '' } })()
  if (/hentai|nsfw|porn|xxx|ecchi|doujin/.test(hostname)) return true
  const title = String($home('title').first().text() || '').toLowerCase()
  if (/hentai|nsfw|18\+|adults only/.test(title)) return true
  const bodyText = $home('body').text().slice(0, 4000).toLowerCase()
  if (/(18\+|adults? only|contains adult|mature content)/.test(bodyText)) return true
  return false
}

// ── Code generator ──────────────────────────────────────────────────────────

function generateCode(config) {
  const { id, name, lang, baseUrl, supportsLatest, isNsfw, version, needsReferer, selectors, urls, cardTitleAttr } = config
  const cleanBase = baseUrl.replace(/\/+$/, '')

  const refererBlock = needsReferer ? `
function imageRef(imgUrl) {
  if (!imgUrl) return undefined
  return { url: imgUrl, headers: { referer: BASE + '/' } }
}
` : ''

  const thumbExpr = needsReferer ? 'imageRef(thumb)' : 'thumb || undefined'
  const coverExpr = needsReferer ? 'imageRef(cover)' : 'cover || manga.thumbnailUrl'
  const pageExpr = needsReferer
    ? "{ url: absolute(String(src)), headers: { referer: BASE + '/' } }"
    : '{ url: absolute(String(src)) }'

  // URL expressions
  const pageGuard = config.singlePage ? '\n    if (page > 1) return []' : ''
  const homeUrl = `${cleanBase}/`
  const urlExpr = (u) => u === homeUrl
    ? `BASE + '/'`
    : u.includes('{page}')
      ? `\`${u.replace('{page}', '${page}')}\``
      : `'${u}'`

  // Multi-page listings need the base URL for page 1 — many sites 404 on
  // /page/1 (WordPress style) where page 1 IS the base listing.
  const pagedUrlExpr = (template, base) => template && template.includes('{page}')
    ? `(page <= 1 ? ${urlExpr(base || template.replace('/{page}', '').replace('{page}', ''))} : \`${template.replace('{page}', '${page}')}\`)`
    : (template ? urlExpr(template) : null)

  const popularUrl = pagedUrlExpr(urls.popular, urls.popularBase)

  const latestUrl = urls.latest
    ? pagedUrlExpr(urls.latest, urls.latestBase)
    : null

  const searchUrl = urls.search
    ? urls.search
      .replace(/\{page\}/g, '${page}')
      .replace(/\{query\}/g, '${encodeURIComponent(query)}')
    : null

  // Chapter list handling
  const chapterIsSelfLink = selectors.chapters.isSelfLink
  // Self-link rows read the title from an inner element when the link also
  // wraps badges/dates ("Chapter 4Just now"), else from the link text.
  const selfNameSel = (selectors.chapters.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const selfNameExpr = selfNameSel
    ? `String((await html.selectText(link, '${selfNameSel}'))[0] || '').trim() || String((await html.text(link)) || '').trim()`
    : `String((await html.text(link)) || '').trim()`
  let chapterListCode
  if (config.chapterApi) {
    // JSON API mode (site loads its chapter list via JS). Strategy:
    //   1) one request with a high `limit` — often returns the whole list
    //   2) if that's capped/failed → paginate with `offset` until exhausted
    const apiPath = config.chapterApi.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    chapterListCode = `  getChapterList: async function (manga) {
    var slug = String(manga.url || '').split('?')[0].split('/').filter(Boolean).pop() || ''
    var api = BASE + '${apiPath}'.replace('{slug}', encodeURIComponent(slug))
    var sep = api.indexOf('?') >= 0 ? '&' : '?'

    function extract(data) {
      var list = []
      if (data) {
        if (Array.isArray(data.chapters)) list = data.chapters
        else if (data.data && Array.isArray(data.data.chapters)) list = data.data.chapters
        else if (Array.isArray(data.data)) list = data.data
        else if (Array.isArray(data)) list = data
      }
      var out = []
      for (var i = 0; i < list.length; i++) {
        var ch = list[i] || {}
        var chSlug = ch.chapter_slug || ch.slug || ch.chapter_id || ch.id
        var chNum = (ch.chapter_num !== undefined && ch.chapter_num !== null) ? Number(ch.chapter_num) : ((ch.number !== undefined && ch.number !== null) ? Number(ch.number) : NaN)
        var chName = ch.chapter_name || ch.name || ch.title || (!isNaN(chNum) ? 'Chapter ' + chNum : '')
        var chUrl = ''
        if (typeof chSlug === 'string' && chSlug.indexOf('http') === 0) chUrl = chSlug
        else if (chSlug !== undefined && chSlug !== null && chSlug !== '') chUrl = BASE + '/manga/' + slug + '/' + chSlug
        if (chUrl === '' || !chName) continue
        out.push({
          url: chUrl,
          name: String(chName),
          chapterNumber: !isNaN(chNum) ? chNum : parseChapterNumber(String(chName)),
          dateUpload: ch.updated_at ? (Date.parse(ch.updated_at) || 0) : 0
        })
      }
      return out
    }

    var all = []
    var seen = {}
    function add(items) {
      for (var i = 0; i < items.length; i++) {
        var u = items[i].url
        if (u && !seen[u]) { seen[u] = 1; all.push(items[i]) }
      }
    }

    // 1) one-shot: ask for everything
    try {
      var res = await http.getJson(api + sep + 'limit=5000')
      if (res.status < 400) add(extract(res.json))
    } catch (e) { /* fall through to pagination */ }
    if (all.length > 50) return all

    // 2) capped or failed → paginate with offset from scratch
    all = []
    seen = {}
    var paramsOk = true
    for (var offset = 0; offset < 5000; offset += 50) {
      var res2
      try {
        res2 = await http.getJson(api + sep + 'offset=' + offset)
        if (res2.status >= 400) throw new Error('HTTP ' + res2.status)
      } catch (e) {
        if (offset === 0) paramsOk = false  // API rejects params — try bare once
        break
      }
      var batch = extract(res2.json)
      if (batch.length === 0) break
      var before = all.length
      add(batch)
      if (batch.length < 50) break
      if (all.length === before) break
    }
    if (all.length === 0 && !paramsOk) {
      try {
        var res3 = await http.getJson(api)
        if (res3.status < 400) all = extract(res3.json)
      } catch (e) { /* nothing worked */ }
    }
    if (all.length === 0) throw new Error('${name}: chapter API returned no chapters')
    return all
  }`
  } else if (chapterIsSelfLink) {
    chapterListCode = `  getChapterList: async function (manga) {
    var doc = await getHtml(absolute(manga.url))
    var links = await html.select(doc, '${selectors.chapters.list}')
    var out = []
    for (var i = 0; i < links.length; i++) {
      var link = links[i]
      var href = absolute(String(await html.attr(link, 'href') || ''))
      if (href === '') continue
      var chName = ${selfNameExpr}
      out.push({
        url: href,
        name: chName || 'Chapter ' + (links.length - i),
        chapterNumber: parseChapterNumber(chName)
      })
    }
    if (out.length === 0) {
      // One-shot gallery / single-chapter work: the manga URL IS the chapter
      out.push({ url: absolute(manga.url), name: 'Chapter 1', chapterNumber: 1 })
    }
    return out
  }`
  } else {
    chapterListCode = `  getChapterList: async function (manga) {
    var doc = await getHtml(absolute(manga.url))
    var rows = await html.select(doc, '${selectors.chapters.list}')
    var out = []
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var link = await html.selectFirst(row, '${selectors.chapters.link}')
      if (!link) continue
      var href = absolute(String(await html.attr(link, 'href') || ''))
      if (href === '') continue
      var chName = (await html.selectText(row, '${selectors.chapters.name}'))[0] || ''${selectors.chapters.date ? `
      var dateText = (await html.selectText(row, '${selectors.chapters.date}'))[0]` : ''}
      out.push({
        url: href,
        name: chName.trim() || 'Chapter ' + (rows.length - i),
        chapterNumber: parseChapterNumber(chName)${selectors.chapters.date ? ',\n        dateUpload: dateText ? Date.parse(dateText) || 0 : 0' : ''}
      })
    }
    if (out.length === 0) {
      // One-shot gallery / single-chapter work: the manga URL IS the chapter
      out.push({ url: absolute(manga.url), name: 'Chapter 1', chapterNumber: 1 })
    }
    return out
  }`
  }

  return `/**
 * ${name} — MihonPC extension (auto-generated)
 * Source: ${cleanBase}
 * Generated: ${new Date().toISOString()}
 */
'use strict'

var BASE = '${cleanBase}'
var CARD = '${selectors.card}'
${refererBlock}
function absolute(href) {
  if (typeof href !== 'string' || href === '') return ''
  if (href.startsWith('http')) return href
  if (href.startsWith('//')) return 'https:' + href
  return BASE + (href.startsWith('/') ? '' : '/') + href
}

function mapStatus(text) {
  var t = (text || '').toLowerCase()
  if (t.includes('ongoing') || t.includes('updating') || t.includes('publishing')) return 'ongoing'
  if (t.includes('complete') || t.includes('finished')) return 'completed'
  if (t.includes('cancel') || t.includes('discontinued')) return 'cancelled'
  if (t.includes('hiatus')) return 'on_hiatus'
  if (t.includes('licensed')) return 'licensed'
  return 'unknown'
}

function afterLabel(t) {
  t = String(t || '').trim()
  var i = t.indexOf(':')
  if (i > -1 && i < 30) t = t.slice(i + 1)
  return t.trim()
}

function parseChapterNumber(title) {
  var m = /(?:chapter|ch[\\-\\.\\s]?)\\s*([\\d.]+)/i.exec(title || '')
  return m ? Number(m[1]) : undefined
}

async function getHtml(pageUrl) {
  var res = await http.getText(pageUrl, { headers: { accept: 'text/html' } })
  if (res.status >= 400) throw new Error('${name}: HTTP ' + res.status + ' for ' + pageUrl)
  return html.load(res.text)
}

async function parseCards(doc) {
  var cards = await html.select(doc, CARD)
  var out = []
  var seen = {}
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i]
    var link = await html.selectFirst(card, '${selectors.cardLink}')
${selectors.cardLink && selectors.cardLink !== 'a' ? `    if (!link) link = await html.selectFirst(card, 'a')\n` : ''}    // A card that is itself the anchor: find() never returns the element it started from.
    if (!link && (await html.attr(card, 'href'))) link = card
    if (!link) continue
    var href = absolute(String(await html.attr(link, 'href') || ''))
    if (href === '' || seen[href]) continue
    var title = ${cardTitleAttr
      ? `String((await html.selectAttr(card, '${selectors.cardTitle}', '${config.cardTitleAttr}'))[0] || '')`
      : `(await html.selectText(card, '${selectors.cardTitle}'))[0] || ''`}
    if (title.trim() === '') {
      var titleAttr = await html.attr(link, 'title')
      if (titleAttr) title = String(titleAttr)
    }
    if (title.trim() === '') {
      var linkText = String(await html.text(link) || '').trim()
      if (linkText !== '') title = linkText
    }
    if (title.trim() === '') continue
    seen[href] = 1
    var thumb = (await html.selectAttr(card, '${selectors.cardCover.selector}', '${selectors.cardCover.attr}'))[0]
    out.push({
      url: href,
      title: title.trim(),
      thumbnailUrl: ${thumbExpr}
    })
  }
  return out
}

async function browsePopular(page) {
  if (typeof page === 'undefined') page = 1
  var doc = await getHtml(${popularUrl})
  return parseCards(doc)
}

module.exports = {
  id: '${id}',
  name: '${name}',
  lang: '${lang}',
  baseUrl: BASE,
  supportsLatest: ${supportsLatest},
  apiVersion: 1,
  isNsfw: ${isNsfw},
  version: '${version}',

  getPopularManga: async function (page) {
    if (typeof page === 'undefined') page = 1${pageGuard}
    return browsePopular(page)
  },
${supportsLatest && latestUrl ? `
  getLatestUpdates: async function (page) {
    if (typeof page === 'undefined') page = 1${pageGuard}
    var doc = await getHtml(${latestUrl})
    return parseCards(doc)
  },
` : ''}${searchUrl ? `
  searchManga: async function (page, query, filters) {
    if (typeof page === 'undefined') page = 1
    if (typeof query === 'undefined') query = ''${pageGuard}
    var doc = await getHtml(\`${searchUrl}\`)
    return parseCards(doc)
  },` : `
  searchManga: async function (page, query, filters) {
    if (typeof page === 'undefined') page = 1
    if (typeof query === 'undefined') query = ''${pageGuard}
    var q = String(query).toLowerCase()
    var out = []
    var seen = {}
    // No working search endpoint: walk the catalogue instead. One call may
    // load at most 3 documents (the bridge's per-call budget), so each search
    // page scans a block of 3 listing pages and the app's own paging walks on.
    for (var i = 0; i < 3; i++) {
      var cards = await browsePopular((page - 1) * 3 + i + 1)
      if (cards.length === 0) break
      for (var j = 0; j < cards.length; j++) {
        var m = cards[j]
        if (seen[m.url]) continue
        seen[m.url] = 1
        if (q === '' || String(m.title || '').toLowerCase().indexOf(q) !== -1) out.push(m)
      }
    }
    return out
  },`}

  getMangaDetails: async function (manga) {
    var doc = await getHtml(absolute(manga.url))
    var title = (await html.selectText(doc, '${selectors.details.title}'))[0]
    var description = ${selectors.details.descriptionAttr
      ? `(await html.selectAttr(doc, '${selectors.details.description.replace(/'/g, "\\'")}', '${selectors.details.descriptionAttr}'))[0]`
      : `(await html.selectText(doc, '${selectors.details.description.replace(/'/g, "\\'")}'))[0]`}
    var cover = (await html.selectAttr(doc, '${selectors.details.cover}', '${selectors.details.coverAttr}'))[0]
    var status = (await html.selectText(doc, '${selectors.details.status}'))[0]
    var genres = (await html.selectText(doc, '${selectors.details.genres}')).filter(Boolean)
${selectors.details.author ? `    var author = afterLabel((await html.selectText(doc, '${selectors.details.author.replace(/'/g, "\\'")}'))[0])\n` : ''}${selectors.details.artist ? `    var artist = afterLabel((await html.selectText(doc, '${selectors.details.artist.replace(/'/g, "\\'")}'))[0])\n` : ''}    return {
      url: manga.url,
      title: title ? title.trim() : manga.title,
      description: description ? description.trim() : undefined,
      thumbnailUrl: ${coverExpr},
      status: mapStatus(status),
      genres: genres.length > 0 ? genres : manga.genres${selectors.details.author ? ',\n      author: author || undefined' : ''}${selectors.details.artist ? ',\n      artist: artist || undefined' : ''}
    }
  },

${chapterListCode},

  getPageList: async function (chapter) {
    var doc = await getHtml(absolute(chapter.url))
    var srcs = await html.selectAttr(doc, '${selectors.reader.images}', '${selectors.reader.imageAttr}')
    var pages = []
    for (var i = 0; i < srcs.length; i++) {
      var src = srcs[i]
      if (!src) continue
      if (/logo|icon|avatar|banner|star/i.test(String(src))) continue
      pages.push(${pageExpr})
    }
    if (pages.length === 0) throw new Error('${name}: no readable images found in this chapter')
    return pages
  }
}
`
}

// ── MAIN ────────────────────────────────────────────────────────────────────

async function autoBuild(siteUrl, opts = {}) {
  const smokeTest = opts.smokeTest !== false
  const baseUrl = new URL(siteUrl).origin
  const siteName = new URL(siteUrl).hostname.replace('www.', '').split('.')[0]
  const displayName = siteName.charAt(0).toUpperCase() + siteName.slice(1)

  console.log()
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║      🧩 MihonPC Auto Extension Builder                  ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`🌐 Target: ${siteUrl}`)
  console.log()

  // ── Step 1: Fetch homepage ──────────────────────────────────────────
  console.log('📥 Step 1/4 — Fetching homepage...')
  const home = await fetchPage(siteUrl)
  if (home.status >= 400) throw new Error(`HTTP ${home.status} from ${siteUrl}`)
  // status 0 means the request never got an answer (dead domain, DNS, TLS).
  // Without this the build would "succeed" from an empty page and ship a junk extension.
  if (home.status === 0) throw new Error(`Could not reach ${siteUrl} — ${home.error?.cause?.code || home.error?.message || 'no response'}`)
  if (home.text.length < 200) throw new Error(`${siteUrl} answered with only ${home.text.length} bytes — nothing to analyze`)
  console.log(`   ✅ ${home.text.length.toLocaleString()} bytes fetched`)
  let $home = load(home.text)

  // ── Step 2: Detect homepage selectors ──────────────────────────────
  console.log('🔍 Step 2/4 — Detecting homepage selectors...')
  let cards = detectCards($home, baseUrl)
  if (cards.count === 0) {
    // Server HTML with no cards at all: the grid is mounted client-side.
    console.log('   🌐 No cards in server HTML — rendering homepage in a real browser (SPA?)')
    try {
      const rendered = await fetchRendered(siteUrl)
      if (!isBotBlocked(rendered.status, rendered.text)) {
        const $rendered = load(rendered.text)
        const renderedCards = detectCards($rendered, baseUrl)
        if (renderedCards.count > 0) {
          $home = $rendered
          cards = renderedCards
          console.log(`   ✅ browser render found ${renderedCards.count} cards`)
        }
      }
    } catch (err) {
      console.log(`   ⚠️  browser render failed: ${String(err.message).slice(0, 120)}`)
    }
  }
  const detectedSearch = detectSearchUrl($home, baseUrl)
  const detectedPopular = detectPopularLink($home, baseUrl)
  const detectedLatest = detectLatestLink($home, baseUrl)
  const needsReferer = detectNeedsReferer($home)

  console.log(`   📦 Cards:    "${cards.selector}" (${cards.count} found)`)
  console.log(`   🔒 Referer:  ${needsReferer ? 'Yes' : 'No'}`)

  // ── Validate listing URLs with real fetches (self-correcting) ──────
  console.log('🧪 Validating listing URLs with real fetches...')

  // Popular: detected link first, homepage as fallback
  let popular = null
  let popularPage$ = null
  for (const c of [...new Set([detectedPopular, baseUrl + '/'].filter(Boolean))]) {
    const v = await countCards(c, cards.selector, baseUrl + '/')
    console.log(`   🧪 popular  ${c} → ${v.ok ? `OK (${v.count} cards)` : `no cards (HTTP ${v.status})`}`)
    if (v.ok) { popular = c; popularPage$ = v.$; break }
  }
  if (!popular) popular = baseUrl + '/'

  // Latest: detected link, then common paths — only keep one that works
  let latest = null
  for (const c of [...new Set([detectedLatest, baseUrl + '/latest', baseUrl + '/latest-updates', baseUrl + '/recently-updated', baseUrl + '/updates'].filter(Boolean))]) {
    const v = await countCards(c, cards.selector, baseUrl + '/')
    console.log(`   🧪 latest   ${c} → ${v.ok ? `OK (${v.count} cards)` : `no cards (HTTP ${v.status})`}`)
    if (v.ok) { latest = c; break }
  }

  // Search: try param variants until one renders results. The listing URL is a
  // candidate base too, so hand over its page-1 card links to spot ignored params.
  const unfilteredLinks = popularPage$
    ? new Set(popularPage$(cards.selector).find('a[href]').map((_, el) => popularPage$(el).attr('href')).get())
    : null
  const sampleQuery = popularPage$
    ? String(
        popularPage$(cards.selector).first().find('h3, h2, .title, [class*="title"]').first().text() ||
        popularPage$(cards.selector).first().text() ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^A-Za-z]*/, '') // cards often lead with a rating like "9.3"
        .split(' ')
        .slice(0, 3)
        .join(' ')
    : ''
  const searchUrl = await resolveSearchUrl(baseUrl, cards.selector, detectedSearch, popular, unfilteredLinks, safeQuery(sampleQuery) || null)
  if (!searchUrl) console.log('   ⚠️  No working search endpoint → search walks the catalogue 3 listing pages per page (slow, and rare titles need scrolling)')

  // ── Re-detect cards on the validated popular page ──────────────────
  // (listing pages can use different markup than the homepage)
  let listingPage = $home
  let finalCards = cards
  let pagination = null
  if (popularPage$) {
    const popCards = detectCards(popularPage$, baseUrl)
    if (popCards.count >= 3 && popCards.count >= cards.count) {
      finalCards = popCards
      listingPage = popularPage$
      console.log(`   📦 Cards (popular page): "${popCards.selector}" (${popCards.count} found)`)
    }
    pagination = detectPagination(popularPage$, popular)
  }

  // Client-rendered pagination (Astro/React islands) leaves no <a href="?page=2">
  // in the server HTML, so anchor detection sees nothing. Probe the common URL
  // shapes and trust whichever one really returns a *different* set of cards.
  if (!pagination) {
    const p1Links = new Set(
      listingPage(finalCards.selector).find('a[href]').map((_, el) => listingPage(el).attr('href')).get()
    )
    for (const cand of [{ type: 'query', param: 'page' }, { type: 'path' }]) {
      const v = await countCards(withPage(popular, cand, 2), finalCards.selector, baseUrl + '/')
      if (!v.ok) continue
      const p2Links = v.$(finalCards.selector).find('a[href]').map((_, el) => v.$(el).attr('href')).get()
      const overlap = p2Links.filter((h) => p1Links.has(h)).length
      // Tolerate a few repeated cards (pinned/featured) but reject a page-2 that
      // is really page-1 again (site ignoring the param).
      if (p2Links.length >= 3 && overlap * 2 < p2Links.length) {
        pagination = cand
        console.log(`   📑 Pagination: no anchors in HTML, but ${cand.type === 'query' ? '?page=N' : '/page/N'} returns fresh cards`)
        break
      }
    }
  }

  // ── Pagination: verify page 2 actually renders before enabling ─────
  let singlePage = true
  let popularUrl = popular
  let latestUrl = latest
  if (pagination) {
    try {
      const v = await countCards(withPage(popular, pagination, 2), finalCards.selector, baseUrl + '/')
      if (v.ok) {
        singlePage = false
        popularUrl = withPage(popular, pagination, '{page}')
        if (latestUrl) latestUrl = withPage(latestUrl, pagination, '{page}')
        console.log(`   📑 Pagination: ${pagination.type === 'query' ? `?${pagination.param}=N` : '/page/N'} → multi-page OK`)
      } else {
        console.log('   📑 Pagination: page 2 renders no cards → single-page site')
      }
    } catch {
      console.log('   📑 Pagination: detection failed → single-page site')
    }
  } else {
    console.log('   📑 Pagination: none detected → single-page site')
  }

  // ── Card link/title/cover on the listing page we'll actually browse ─
  const cardLink = detectCardLink(listingPage, finalCards.selector, baseUrl)
  const cardTitleInfo = detectCardTitle(listingPage, finalCards.selector)
  const cardTitle = cardTitleInfo.selector
  const cardCover = detectCardCover(listingPage, finalCards.selector)
  console.log(`   🔗 Link:     "${cardLink}"`)
  console.log(`   📝 Title:    "${cardTitle}"${cardTitleInfo.attrMode ? ' [from title attr]' : ''}`)
  console.log(`   🖼️  Cover:    "${cardCover.selector}" [${cardCover.attr}]`)

  // ── Step 3: Follow a manga link → detect details + chapters ────────
  console.log('📖 Step 3/4 — Analyzing manga details page...')
  const firstMangaUrl = getFirstMangaUrl(listingPage, finalCards.selector, cardLink, baseUrl)

  let detailsSelectors = { title: 'h1', description: '.description', descriptionAttr: '', cover: 'img', coverAttr: 'src', status: '.status', genres: '.tags a', author: '', artist: '' }
  let chapterSelectors = { list: '.chapter-list li', link: 'a', name: 'a', date: '', isSelfLink: false }
  let readerSelectors = { images: 'img', imageAttr: 'src' }
  let chapterApi = null

  if (firstMangaUrl) {
    console.log(`   → Following: ${firstMangaUrl}`)
    try {
      const details = await fetchPage(firstMangaUrl, baseUrl + '/')
      if (details.status < 400) {
        const $details = load(details.text)
        detailsSelectors = detectDetailsSelectors($details)
        chapterSelectors = detectChapterSelectors($details)
        console.log(`   ✅ Title:       "${detailsSelectors.title}"`)
        console.log(`   ✅ Description: "${detailsSelectors.description}"`)
        console.log(`   ✅ Chapters:    "${chapterSelectors.list}" (link: "${chapterSelectors.link || 'self'}")`)
        console.log(`   ✅ Status:      "${detailsSelectors.status}"`)
        console.log(`   ✅ Genres:      "${detailsSelectors.genres}"`)
        if (detailsSelectors.author) console.log(`   ✅ Author:      "${detailsSelectors.author}"`)
        if (detailsSelectors.artist) console.log(`   ✅ Artist:      "${detailsSelectors.artist}"`)

        // Suspiciously small chapter list → the real one is probably loaded
        // from a JSON API. Probe the common patterns.
        let htmlChapterCount = 0
        try { htmlChapterCount = $details(chapterSelectors.list).length } catch { /* keep 0 */ }
        if (htmlChapterCount < 5) {
          console.log(`   ⚠️  Only ${htmlChapterCount} chapter entries in HTML — probing JSON APIs...`)
          const probe = await probeChapterApi(baseUrl, firstMangaUrl)
          if (probe) {
            chapterApi = probe.apiPath
            console.log(`   ✅ JSON chapter API: ${probe.apiPath} (${probe.count} chapters)`)
          } else {
            console.log('   ⚠️  No JSON API found — chapter list may be incomplete')
          }
        }

        // ── Step 4: Follow a chapter link → detect reader images ────
        console.log('📄 Step 4/4 — Analyzing reader page...')
        // Find a chapter URL — one-shot sites have none: the manga page IS
        // the reader, so detect there.
        let chapterUrl = null
        if (chapterSelectors.isSelfLink) {
          const chLinks = $details(chapterSelectors.list)
          if (chLinks.length > 0) {
            chapterUrl = absolute(baseUrl, chLinks.last().attr('href') || '')
          }
        } else {
          const chItems = $details(chapterSelectors.list)
          if (chItems.length > 0) {
            const lastItem = chItems.last()
            const chLink = lastItem.find(chapterSelectors.link || 'a').first()
            chapterUrl = absolute(baseUrl, chLink.attr('href') || '')
          }
        }
        if (!chapterUrl && htmlChapterCount < 5) {
          console.log('   ℹ️  No chapter pages — treating the manga page as the reader (one-shot work)')
          chapterUrl = firstMangaUrl
        }

        if (chapterUrl) {
          console.log(`   → Following: ${chapterUrl}`)
          try {
            const reader = await fetchPage(chapterUrl, firstMangaUrl)
            if (reader.status < 400) {
              const $reader = load(reader.text)
              readerSelectors = detectReaderSelectors($reader)
              const imgCount = $reader(readerSelectors.images).length
              console.log(`   ✅ Images: "${readerSelectors.images}" [${readerSelectors.imageAttr}] (${imgCount} on page)`)
              if (imgCount < 2) {
                console.log('   ⚠️  This reader loads ONE page image at a time — the')
                console.log('      generated extension may only show the first page per chapter.')
              }
            } else {
              console.log(`   ⚠️  Reader page returned HTTP ${reader.status}, using defaults`)
            }
          } catch (err) {
            console.log(`   ⚠️  Could not fetch reader page: ${err.message}`)
          }
        } else {
          console.log('   ⚠️  No chapter links found, using default reader selectors')
        }
      } else {
        console.log(`   ⚠️  Details page returned HTTP ${details.status}, using defaults`)
      }
    } catch (err) {
      console.log(`   ⚠️  Could not fetch details page: ${err.message}`)
    }
  } else {
    console.log('   ⚠️  No manga links found on homepage, using default selectors')
    console.log('📄 Step 4/4 — Skipped (no chapter links)')
  }

  // ── Build config & generate ──────────────────────────────────────────
  console.log()
  console.log('🔧 Generating extension...')

  const isNsfw = detectNsfw(siteUrl, $home)
  if (isNsfw) console.log('   🔞 NSFW markers detected → isNsfw: true')

  const config = {
    id: siteName,
    name: displayName,
    lang: 'en',
    baseUrl,
    supportsLatest: !!latestUrl,
    isNsfw,
    version: '1.0.0',
    needsReferer,
    singlePage,
    cardTitleAttr: cardTitleInfo.attrMode,
    chapterApi,
    selectors: {
      card: finalCards.selector,
      cardLink,
      cardTitle,
      cardCover,
      details: detailsSelectors,
      chapters: chapterSelectors,
      reader: readerSelectors,
    },
    urls: {
      popular: popularUrl,
      popularBase: popular,
      search: searchUrl,
      latest: latestUrl,
      latestBase: latest,
    }
  }

  const code = generateCode(config)
  const hash = createHash('sha256').update(code, 'utf8').digest('hex')

  // Save everything
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const jsPath = join(OUTPUT_DIR, `${siteName}.js`)
  writeFileSync(jsPath, code, 'utf-8')

  const configPath = join(OUTPUT_DIR, `${siteName}.config.json`)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

  // The store entry. It goes into index.json only once the extension has been
  // proven to work — see the smoke test below, or the batch's own test.
  const entry = {
    packageId: siteName,
    name: displayName,
    lang: 'en',
    version: '1.0.0',
    apiVersion: 1,
    isNsfw,
    file: `${siteName}.js`,
    sha256: hash,
    description: `${displayName} extension for MihonPC`
  }
  const indexPath = join(OUTPUT_DIR, 'index.json')

  console.log()
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  ✅  Extension generated successfully!                   ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log()
  console.log(`   📁 Extension:  ${jsPath}`)
  console.log(`   📁 Config:     ${configPath}`)
  console.log(`   📁 Index:      ${indexPath}`)
  console.log(`   🔑 SHA256:     ${hash}`)
  console.log()

  // The batch app runs the smoke test itself, in a pool of its own, so a batch
  // of 30 does not immediately fork 30 more live-site testers.
  if (!smokeTest) return { config, code, hash, jsPath, configPath, entry, tested: null }

  // ── Smoke-test the generated extension right away ───────────────────
  console.log('🧪 Running end-to-end smoke test (live site)...\n')
  const { spawnSync } = await import('node:child_process')
  const testRes = spawnSync(process.execPath, [join(__dirname, 'test-extension.mjs'), jsPath], {
    stdio: 'inherit',
    timeout: 180_000
  })
  if (testRes.status !== 0) {
    console.log()
    console.log('   ⚠️  The smoke test FAILED — this extension is NOT added to index.json.')
    console.log('      Fix output/' + siteName + '.config.json selectors, then rebuild:')
    console.log(`      node build-extension.mjs --config output/${siteName}.config.json`)
    await removeFromIndex(siteName)
    return { config, code, hash, jsPath, configPath, entry, tested: false }
  }

  await updateIndex(entry)
  console.log()
  console.log('   📋 Install in MihonPC:')
  console.log('      Browse → Extensions → Import local file → select the .js')
  if (isNsfw) {
    console.log('   🔞 NSFW source — enable "Show NSFW" in MihonPC settings if hidden.')
  }
  console.log()

  return { config, code, hash, jsPath, configPath, tested: true }
}

export { autoBuild, OUTPUT_DIR, updateIndex, removeFromIndex }

// ── CLI ─────────────────────────────────────────────────────────────────────
// Runs only when this file is the entry point; the batch app imports autoBuild.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {

const url = process.argv[2]
if (!url || url.startsWith('-')) {
  console.log(`
Usage: node auto-build.mjs <URL>

Examples:
  node auto-build.mjs https://mangapill.com
  node auto-build.mjs https://manganato.com
  node auto-build.mjs https://mangakakalot.com

The tool automatically:
  1. Fetches the homepage
  2. Detects card/link/title/cover selectors
  3. Follows a manga link to detect details + chapter selectors
  4. Follows a chapter link to detect reader image selectors
  5. Generates a ready-to-install .js extension
`)
  process.exit(0)
}

autoBuild(url)
  .then(result => {
    // A build that failed its own test is not a success, whatever it wrote.
    if (result && result.tested === false) process.exitCode = 1
  })
  .catch(err => {
    console.error(`\n❌ Error: ${err.message}\n`)
    process.exitCode = 1
  })
  .finally(() => closeBrowser().finally(() => process.exit(process.exitCode || 0)))

}

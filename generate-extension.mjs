/**
 * generate-extension.mjs — Generates a MihonPC .js extension from a site config.
 *
 * Takes a configuration object (selectors, URLs, patterns) and produces a
 * complete, ready-to-install extension file.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * Build the extension JS source code from a site configuration.
 * @param {object} config
 * @param {string} config.id            — Stable unique source id (e.g. 'my-manga-site')
 * @param {string} config.name          — Display name (e.g. 'My Manga Site')
 * @param {string} config.lang          — ISO 639-1 language code (e.g. 'en')
 * @param {string} config.baseUrl       — Site base URL (e.g. 'https://mangasite.com')
 * @param {boolean} config.supportsLatest — Whether the site has a latest/recent page
 * @param {boolean} config.isNsfw       — NSFW content flag
 * @param {string} config.version       — Extension version (e.g. '1.0.0')
 *
 * @param {object} config.selectors
 * @param {string} config.selectors.card         — CSS selector for manga cards
 * @param {string} config.selectors.cardLink     — CSS selector for link inside a card
 * @param {string} config.selectors.cardTitle    — CSS selector for title inside a card
 * @param {string} config.selectors.cardCover    — CSS selector for cover image inside a card
 * @param {string} config.selectors.coverAttr    — Attribute name for cover image src ('src' or 'data-src')
 *
 * @param {object} config.selectors.details
 * @param {string} config.selectors.details.title       — Title on details page
 * @param {string} config.selectors.details.description  — Description text
 * @param {string} config.selectors.details.cover        — Cover image selector
 * @param {string} config.selectors.details.coverAttr    — Attribute for cover src
 * @param {string} config.selectors.details.status       — Status text selector
 * @param {string} config.selectors.details.genres       — Genres links selector
 * @param {string} config.selectors.details.author       — Author selector
 *
 * @param {object} config.selectors.chapters
 * @param {string} config.selectors.chapters.list        — Chapter list items selector
 * @param {string} config.selectors.chapters.link        — Link inside a chapter item
 * @param {string} config.selectors.chapters.name        — Chapter name selector
 * @param {string} config.selectors.chapters.date        — Date selector (optional)
 *
 * @param {object} config.selectors.reader
 * @param {string} config.selectors.reader.images        — Reader page images selector
 * @param {string} config.selectors.reader.imageAttr     — Attribute for image src ('src' or 'data-src')
 *
 * @param {object} config.urls
 * @param {string} config.urls.popular       — Popular manga page URL pattern (use {page} placeholder)
 * @param {string} [config.urls.latest]      — Latest updates page URL pattern
 * @param {string} config.urls.search        — Search URL pattern (use {page} and {query} placeholders)
 *
 * @param {object} [config.headers]          — Custom headers to send with requests
 * @param {boolean} [config.needsReferer]    — Whether image requests need a Referer header
 *
 * @returns {string} The extension JS source code
 */
export function generateExtension(config) {
  const {
    id,
    name,
    lang = 'en',
    baseUrl,
    supportsLatest = false,
    isNsfw = false,
    version = '1.0.0',
    selectors,
    urls,
    headers = null,
    needsReferer = false
  } = config

  // Sanitize the base URL
  const cleanBase = baseUrl.replace(/\/+$/, '')

  const headersCode = headers
    ? `, { headers: ${JSON.stringify(headers)} }`
    : ", { headers: { accept: 'text/html' } }"

  const refererCode = needsReferer
    ? `
/** The CDN requires a Referer header — attach it to every image URL. */
function imageRef(imgUrl) {
  if (!imgUrl) return undefined
  return { url: imgUrl, headers: { referer: BASE + '/' } }
}
`
    : ''

  const thumbnailExpr = needsReferer ? 'imageRef(thumb)' : 'thumb || undefined'
  const detailsCoverExpr = needsReferer ? 'imageRef(cover)' : 'cover || manga.thumbnailUrl'
  const pageEntryExpr = needsReferer
    ? "{ url: absolute(String(src)), headers: { referer: BASE + '/' } }"
    : '{ url: absolute(String(src)) }'

  // Build the popular URL expression
  const popularUrlExpr = urls.popular.includes('{page}')
    ? `\`${urls.popular.replace('{page}', '${page}')}\``
    : `'${urls.popular}'`

  // Build the latest URL expression
  const latestUrlExpr = urls.latest
    ? urls.latest.includes('{page}')
      ? `\`${urls.latest.replace('{page}', '${page}')}\``
      : `'${urls.latest}'`
    : null

  // Build the search URL expression. A config may legitimately carry no search
  // URL (site has none, or it is bot-gated) — then search walks the catalogue.
  const searchUrlExpr = urls.search
    ? urls.search
        .replace('{page}', '${page}')
        .replace('{query}', '${encodeURIComponent(query)}')
    : null

  // Listing URL for an arbitrary page variable, for the catalogue-walk search.
  const pagedPopularExpr = (varName) =>
    urls.popular.includes('{page}')
      ? `(${varName} <= 1 ? '${urls.popularBase || urls.popular.replace('{page}', '1')}' : \`${urls.popular.replace('{page}', '${' + varName + '}')}\`)`
      : `'${urls.popular}'`

  // Generate the extension code
  const code = `/**
 * ${name} — MihonPC extension (auto-generated by Extension Builder)
 *
 * Source:  ${cleanBase}
 * Lang:   ${lang}
 * NSFW:   ${isNsfw}
 * Generated: ${new Date().toISOString()}
 */
'use strict'

const BASE = '${cleanBase}'
const CARD = '${selectors.card}'
${refererCode}
function absolute(href) {
  if (typeof href !== 'string' || href === '') return ''
  return href.startsWith('http') ? href : BASE + (href.startsWith('/') ? '' : '/') + href
}

function mapStatus(text) {
  const t = (text || '').toLowerCase()
  if (t.includes('ongoing') || t.includes('updating') || t.includes('publishing')) return 'ongoing'
  if (t.includes('complete') || t.includes('finished')) return 'completed'
  if (t.includes('cancel') || t.includes('discontinued')) return 'cancelled'
  if (t.includes('hiatus')) return 'on_hiatus'
  if (t.includes('licensed')) return 'licensed'
  return 'unknown'
}

function parseChapterNumber(title) {
  var m = /(?:chapter|ch\\.?)\\s*([\\d.]+)/i.exec(title || '')
  return m ? Number(m[1]) : undefined
}

async function getHtml(pageUrl) {
  var res = await http.getText(pageUrl${headersCode})
  if (res.status >= 400) throw new Error('${name}: HTTP ' + res.status + ' for ' + pageUrl)
  return html.load(res.text)
}

async function parseCards(doc) {
  var cards = await html.select(doc, CARD)
  var out = []
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i]
    var link = await html.selectFirst(card, '${selectors.cardLink}')
    if (!link) continue
    var href = absolute(String(await html.attr(link, 'href') || ''))
    if (href === '') continue
    var title = (await html.selectText(card, '${selectors.cardTitle}'))[0] || ''
    if (title.trim() === '') continue
    var thumb = (await html.selectAttr(card, '${selectors.cardCover}', '${selectors.coverAttr || 'src'}'))[0]
    out.push({
      url: href,
      title: title.trim(),
      thumbnailUrl: ${thumbnailExpr}
    })
  }
  return out
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
    if (typeof page === 'undefined') page = 1
    var doc = await getHtml(${popularUrlExpr})
    return parseCards(doc)
  },
${
  supportsLatest && latestUrlExpr
    ? `
  getLatestUpdates: async function (page) {
    if (typeof page === 'undefined') page = 1
    var doc = await getHtml(${latestUrlExpr})
    return parseCards(doc)
  },
`
    : ''
}
${
  searchUrlExpr
    ? `
  searchManga: async function (page, query, filters) {
    if (typeof page === 'undefined') page = 1
    if (typeof query === 'undefined') query = ''
    var doc = await getHtml(\`${searchUrlExpr}\`)
    return parseCards(doc)
  },`
    : `
  searchManga: async function (page, query, filters) {
    if (typeof page === 'undefined') page = 1
    if (typeof query === 'undefined') query = ''
    var q = String(query).toLowerCase()
    var out = []
    var seen = {}
    // No working search endpoint: walk the catalogue instead. One call may
    // load at most 3 documents (the bridge's per-call budget), so each search
    // page scans a block of 3 listing pages and the app's own paging walks on.
    for (var i = 0; i < 3; i++) {
      var n = (page - 1) * 3 + i + 1
      var doc = await getHtml(${pagedPopularExpr('n')})
      var cards = await parseCards(doc)
      if (cards.length === 0) break
      for (var j = 0; j < cards.length; j++) {
        var m = cards[j]
        if (seen[m.url]) continue
        seen[m.url] = 1
        if (q === '' || String(m.title || '').toLowerCase().indexOf(q) !== -1) out.push(m)
      }
    }
    return out
  },`
}

  getMangaDetails: async function (manga) {
    var doc = await getHtml(absolute(manga.url))
    var title = (await html.selectText(doc, '${selectors.details.title}'))[0]
    var description = ${selectors.details.descriptionAttr
      ? `(await html.selectAttr(doc, '${selectors.details.description}', '${selectors.details.descriptionAttr}'))[0]`
      : `(await html.selectText(doc, '${selectors.details.description}'))[0]`}
    var cover = (await html.selectAttr(doc, '${selectors.details.cover}', '${selectors.details.coverAttr || 'src'}'))[0]
    var status = (await html.selectText(doc, '${selectors.details.status}'))[0]
    var genres = (await html.selectText(doc, '${selectors.details.genres}')).filter(Boolean)
${
  selectors.details.author
    ? `    var author = (await html.selectText(doc, '${selectors.details.author}'))[0]
`
    : ''
}    return {
      url: manga.url,
      title: title ? title.trim() : manga.title,
      description: description ? description.trim() : undefined,
      thumbnailUrl: ${detailsCoverExpr},
      status: mapStatus(status),
      genres: genres.length > 0 ? genres : manga.genres${selectors.details.author ? ',\n      author: author ? author.trim() : undefined' : ''}
    }
  },

  getChapterList: async function (manga) {
    var doc = await getHtml(absolute(manga.url))
    var rows = await html.select(doc, '${selectors.chapters.list}')
    var out = []
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      var link = await html.selectFirst(row, '${selectors.chapters.link}')
      if (!link) continue
      var href = absolute(String(await html.attr(link, 'href') || ''))
      if (href === '') continue
      var chName = (await html.selectText(row, '${selectors.chapters.name}'))[0] || ''${
        selectors.chapters.date
          ? `
      var dateText = (await html.selectText(row, '${selectors.chapters.date}'))[0]`
          : ''
      }
      out.push({
        url: href,
        name: chName.trim() || 'Chapter ' + (rows.length - i),
        chapterNumber: parseChapterNumber(chName)${selectors.chapters.date ? ',\n        dateUpload: dateText ? Date.parse(dateText) || 0 : 0' : ''}
      })
    }
    return out
  },

  getPageList: async function (chapter) {
    var doc = await getHtml(absolute(chapter.url))
    var srcs = await html.selectAttr(doc, '${selectors.reader.images}', '${selectors.reader.imageAttr || 'src'}')
    var pages = []
    for (var i = 0; i < srcs.length; i++) {
      var src = srcs[i]
      if (!src) continue
      pages.push(${pageEntryExpr})
    }
    if (pages.length === 0) throw new Error('${name}: no readable images found in this chapter')
    return pages
  }
}
`

  return code
}

/**
 * Compute SHA256 hex of a string.
 */
export function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Generate an index.json entry for the extension.
 */
export function generateIndexEntry(config, extensionCode) {
  return {
    packageId: config.id,
    name: config.name,
    lang: config.lang || 'en',
    version: config.version || '1.0.0',
    apiVersion: 1,
    isNsfw: config.isNsfw || false,
    file: `${config.id}.js`,
    sha256: sha256(extensionCode),
    description: `${config.name} extension for MihonPC`
  }
}

/**
 * analyze-site.mjs — Fetches a manga website and detects its structure.
 *
 * Outputs a JSON analysis describing:
 *   - detected card selectors (popular/latest grids)
 *   - link patterns (/manga/xxx, /title/xxx etc.)
 *   - title selectors
 *   - image/cover selectors
 *   - chapter list patterns
 *   - reader page image selectors
 */
import { load } from 'cheerio'

/**
 * Fetch a URL with a browser-like User-Agent.
 * @param {string} url
 * @returns {Promise<{status: number, text: string, finalUrl: string}>}
 */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    },
    redirect: 'follow'
  })
  const text = await res.text()
  return { status: res.status, text, finalUrl: res.url }
}

/**
 * Common manga-card CSS selectors to probe.
 */
const CARD_CANDIDATES = [
  // Generic patterns
  '.manga-card',
  '.manga-item',
  '.manga-list-item',
  '.series-item',
  '.comic-item',
  '.book-item',
  '.content-item',
  // Grid cards
  'div.grid > div:has(a img)',
  '.grid > div:has(a[href])',
  'ul.manga-list > li',
  'ul.series-list > li',
  // Common framework patterns
  '.card:has(a img)',
  '.col:has(a img)',
  'article:has(a img)',
  // Table patterns
  '.chapter-row',
  '.list-group-item:has(a)',
  // Broad fallback
  'div[class*="manga"]',
  'div[class*="comic"]',
  'div[class*="series"]',
  'div[class*="item"]:has(a img)',
  'a[href*="/manga/"]',
  'a[href*="/title/"]',
  'a[href*="/comic/"]',
  'a[href*="/series/"]',
  'a[href*="/read/"]'
]

/**
 * Common title selectors inside a card.
 */
const TITLE_CANDIDATES = [
  'h3.title',
  'h3',
  'h4',
  'h2',
  '.title',
  '.name',
  '.series-title',
  '.manga-name',
  'a[title]',
  'div.font-black',
  'div.font-bold',
  'span.title',
  'p.title',
  'a > span',
  'a'
]

/**
 * Common cover/thumbnail selectors.
 */
const COVER_CANDIDATES = [
  'img.cover',
  'img.thumbnail',
  'img[data-src]',
  'img.lazyload',
  'img[loading="lazy"]',
  'img.js-page',
  'img'
]

/**
 * Common chapter list selectors.
 */
const CHAPTER_CANDIDATES = [
  '.chapter-list li',
  '.chapter-list a',
  '#chapters a',
  'ul.chapters li',
  '.chapter-item',
  'a[href*="/chapter"]',
  'a[href*="/chapters/"]',
  'a[href*="/ch-"]',
  'a[href*="/read/"]',
  '.episode-list a',
  'div.chapter a',
  'tr:has(a[href*="chapter"])',
  '.list-group-item a'
]

/**
 * Common reader page image selectors.
 */
const READER_IMAGE_CANDIDATES = [
  '#reader img.page',
  '#reader img',
  'img.js-page',
  'img.wp-manga-chapter-img',
  'img.page-image',
  'img[data-src]',
  '.reading-content img',
  '.container img[src*="/chapter"]',
  '#readerarea img',
  '.page-container img',
  'img.img-responsive'
]

/**
 * Analyze a page and find which selectors match.
 * @param {string} htmlText
 * @param {string[]} candidates
 * @returns {{selector: string, count: number, samples: string[]}[]}
 */
function probeSelectors(htmlText, candidates) {
  const $ = load(htmlText)
  const results = []
  for (const sel of candidates) {
    try {
      const matched = $(sel)
      if (matched.length > 0) {
        const samples = []
        matched.slice(0, 3).each((_, el) => {
          const $el = $(el)
          // Get a short text preview
          const text = $el.text().trim().substring(0, 80)
          const href = $el.attr('href') || $el.find('a').first().attr('href') || ''
          const imgSrc =
            $el.attr('src') ||
            $el.attr('data-src') ||
            $el.find('img').first().attr('src') ||
            $el.find('img').first().attr('data-src') ||
            ''
          samples.push({
            text: text || undefined,
            href: href || undefined,
            imgSrc: imgSrc || undefined
          })
        })
        results.push({ selector: sel, count: matched.length, samples })
      }
    } catch {
      // Invalid selector for this doc, skip
    }
  }
  return results
}

/**
 * Detect the link pattern used by the site (e.g. /manga/, /title/, /comic/).
 * @param {string} htmlText
 * @returns {string[]}
 */
function detectLinkPatterns(htmlText) {
  const $ = load(htmlText)
  const patterns = new Map()
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || ''
    // Look for /manga/xxx, /title/xxx, /comic/xxx, /series/xxx etc.
    const match = href.match(/^\/(manga|title|comic|series|manhua|manhwa|webtoon|read|book)\//)
    if (match) {
      const pattern = `/${match[1]}/`
      patterns.set(pattern, (patterns.get(pattern) || 0) + 1)
    }
  })
  return [...patterns.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, count]) => ({ pattern: p, count }))
}

/**
 * Detect navigation/pagination patterns.
 * @param {string} htmlText
 * @returns {object}
 */
function detectPagination(htmlText) {
  const $ = load(htmlText)
  const pagination = {
    hasNextPage: false,
    nextPageSelector: null,
    paginationType: 'unknown'
  }

  // Look for pagination links
  const pageLinks = $('a[href*="page="], a[href*="p="], a.next, a.pagination-next, .pagination a, nav a')
  if (pageLinks.length > 0) {
    pagination.hasNextPage = true
    const href = pageLinks.first().attr('href') || ''
    if (href.includes('page=')) pagination.paginationType = 'query-param'
    else if (href.match(/\/page\/\d+/)) pagination.paginationType = 'path-segment'
    else pagination.paginationType = 'link-based'
  }

  // Check for infinite scroll indicators
  if ($('[data-page], [data-next], .load-more, #load-more, .infinite-scroll').length > 0) {
    pagination.paginationType = 'infinite-scroll'
  }

  return pagination
}

/**
 * Full site analysis.
 * @param {string} baseUrl — the site homepage or popular page
 * @returns {Promise<object>}
 */
export async function analyzeSite(baseUrl) {
  console.log(`\n🔍 Fetching ${baseUrl} ...`)
  const home = await fetchPage(baseUrl)
  if (home.status >= 400) {
    throw new Error(`HTTP ${home.status} fetching ${baseUrl}`)
  }

  console.log(`✅ Got ${home.text.length} bytes (status ${home.status})`)
  console.log(`🔗 Final URL: ${home.finalUrl}\n`)

  const analysis = {
    baseUrl: new URL(home.finalUrl).origin,
    fetchedUrl: home.finalUrl,
    cards: probeSelectors(home.text, CARD_CANDIDATES),
    titles: probeSelectors(home.text, TITLE_CANDIDATES),
    covers: probeSelectors(home.text, COVER_CANDIDATES),
    chapters: probeSelectors(home.text, CHAPTER_CANDIDATES),
    readerImages: probeSelectors(home.text, READER_IMAGE_CANDIDATES),
    linkPatterns: detectLinkPatterns(home.text),
    pagination: detectPagination(home.text),
    detectedFeatures: {
      hasSearch:
        home.text.includes('search') ||
        home.text.includes('Search') ||
        !!load(home.text)('form[action*="search"], input[name="q"], input[name="query"], input[placeholder*="search" i]')
          .length,
      hasLatestUpdates:
        home.text.toLowerCase().includes('latest') ||
        home.text.toLowerCase().includes('recent') ||
        home.text.toLowerCase().includes('new chapter'),
      hasPopular:
        home.text.toLowerCase().includes('popular') ||
        home.text.toLowerCase().includes('trending') ||
        home.text.toLowerCase().includes('hot'),
      usesLazyLoad: home.text.includes('data-src') || home.text.includes('lazyload'),
      usesReferer: home.text.includes('referer') || home.text.includes('referrer'),
      isCloudflareProtected:
        home.text.includes('cf-browser-verification') || home.text.includes('cloudflare')
    }
  }

  return analysis
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('analyze-site.mjs')) {
  const url = process.argv[2]
  if (!url) {
    console.error('Usage: node analyze-site.mjs <URL>')
    process.exit(1)
  }
  analyzeSite(url)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err) => {
      console.error('Error:', err.message)
      process.exit(1)
    })
}

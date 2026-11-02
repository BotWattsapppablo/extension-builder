/**
 * fixture-site.mjs — a fake manga site, served locally, that is deliberately
 * awkward in the ways the real sites are awkward.
 *
 * The builder is only worth trusting if it can be tested without visiting
 * someone else's server, and a localhost test needs the net guard stood down:
 *
 *   node fixture-site.mjs &
 *   BUILDER_ALLOW_PRIVATE=1 BUILDER_NO_BROWSER=1 node auto-build.mjs http://127.0.0.1:4599
 *   node test-extension.mjs output/fixtural.js
 *
 * Pages below each reproduce a defect class the audit measured on real sites:
 * lazy-loaded reader images, a chapter list inside a <select>, a reader whose
 * images only exist in an embedded JSON blob, a search page with different
 * markup than the homepage, and pagination that only answers ?listing-page=N.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.FIXTURE_PORT || 4599)

const card = (n, title, slug) => `
      <div class="book-item">
        <a class="book-img" href="/manga/${slug}"><img data-src="/covers/${slug}.jpg" alt="${title}"></a>
        <h3 class="book-title"><a href="/manga/${slug}">${title}</a></h3>
        <span class="badge">New</span>
      </div>`

const shelf = (list) => `<!doctype html>
<html lang="en"><head><title>Fixtural Manga</title></head>
<body>
  <nav><a href="/">Home</a><a href="/browse">Browse</a></nav>
  <section class="grid">${list}</section>
  <div class="pagination"><a href="/browse?listing-page=2">2</a></div>
</body></html>`

const TITLES = [
  ['Ash Lantern', 'ash-lantern'], ['Bronze Kite', 'bronze-kite'], ['Cedar Signal', 'cedar-signal'],
  ['Dusk Orchard', 'dusk-orchard'], ['Ember Atlas', 'ember-atlas'], ['Fern Circuit', 'fern-circuit'],
  ['Glass Harbor', 'glass-harbor'], ['Hollow Compass', 'hollow-compass']
]

const browseCards = (offset) =>
  TITLES.map(([t, s], i) => card(offset + i, `${t} ${offset + i}`, `${s}`)).join('')

const pages = {
  '/': () => shelf(browseCards(0)),

  // The listing page the builder is expected to adopt as "popular".
  '/browse': (url) => {
    const page = Number(url.searchParams.get('listing-page') || '1')
    if (page > 3) return ''
    return shelf(browseCards((page - 1) * TITLES.length))
  },

  // Search results use a different container than the browse page: a builder
  // that reuses the homepage's card selector finds nothing here.
  '/search': () => `<!doctype html>
<html lang="en"><head><title>search</title></head><body>
  <div class="result-row">
    <a href="/manga/ash-lantern"><img src="/covers/ash-lantern.jpg" alt="Ash Lantern"></a>
    <p class="result-title"><a href="/manga/ash-lantern">Ash Lantern</a></p>
  </div>
  <div class="result-row">
    <a href="/manga/bronze-kite"><img src="/covers/bronze-kite.jpg" alt="Bronze Kite"></a>
    <p class="result-title"><a href="/manga/bronze-kite">Bronze Kite</a></p>
  </div>
</body></html>`,

  '/manga/ash-lantern': () => `<!doctype html>
<html lang="en"><head><title>Ash Lantern</title>
<meta property="og:locale" content="en_US">
<script type="application/ld+json">
{"@type":"CreativeWork","name":"Ash Lantern","description":"A lamplighter inherits a lantern that will not stay lit.","genre":["Action","Adventure"],"author":{"name":"R. Okafor"},"image":"/covers/ash-lantern.jpg"}
</script>
</head><body>
  <h1>Ash Lantern</h1>
  <div class="summary-table">
    <span class="label">Status:</span><span class="value">Ongoing</span>
  </div>
  <div class="chapter-shell">
    <select id="chapter-select">
      <option value="/manga/ash-lantern/ch-1">Chapter 1</option>
      <option value="/manga/ash-lantern/ch-2">Chapter 2</option>
      <option value="/manga/ash-lantern/ch-3">Chapter 3</option>
      <option value="/manga/ash-lantern/ch-4">Chapter 4</option>
    </select>
    <ul class="chapter-list">
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-4">Chapter 4</a><span class="date">Jan 4</span></li>
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-3">Chapter 3</a><span class="date">Jan 3</span></li>
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-2">Chapter 2</a><span class="date">Jan 2</span></li>
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-1">Chapter 1</a><span class="date">Jan 1</span></li>
    </ul>
  </div>
</body></html>`,

  // Reader: images are lazy, and the real list also sits in a script blob.
  '/manga/ash-lantern/ch-1': () => `<!doctype html>
<html lang="en"><body>
  <div class="reader">
    <img class="page-lazy" data-src="/images/ash-lantern/ch-1/01.jpg" src="/spacer.gif">
    <img class="page-lazy" data-src="/images/ash-lantern/ch-1/02.jpg" src="/spacer.gif">
  </div>
  <script>window.chapterImages = ["/images/ash-lantern/ch-1/01.jpg","/images/ash-lantern/ch-1/02.jpg","/images/ash-lantern/ch-1/03.jpg","/images/ash-lantern/ch-1/04.jpg"];</script>
</body></html>`,

  '/manga/ash-lantern/ch-2': () => `<!doctype html>
<html lang="en"><body>
  <div class="reader"><img src="/images/ash-lantern/ch-2/01.jpg"></div>
  <script>var data_job = JSON.stringify({"currentImages":["/images/ash-lantern/ch-2/01.jpg","/images/ash-lantern/ch-2/02.jpg","/images/ash-lantern/ch-2/03.jpg"]});</script>
</body></html>`,

  '/manga/ash-lantern/ch-3': () => `<!doctype html>
<html lang="en"><body>
  <div id="reader-area">
    <img src="/images/ash-lantern/ch-3/1.jpg">
    <img src="/images/ash-lantern/ch-3/2.jpg">
    <img src="/images/ash-lantern/ch-3/3.jpg">
    <img src="/images/ash-lantern/ch-3/4.jpg">
  </div>
</body></html>`,

  // Reader whose script blob mixes the chapter with images that are not part
  // of it: only the folder most of the list shares is the real chapter.
  '/manga/ash-lantern/ch-4': () => `<!doctype html>
<html lang="en"><body>
  <div class="reader"><img src="/images/ash-lantern/ch-4/01.jpg"></div>
  <aside><img src="/images/related/bronze-kite.jpg"></aside>
  <script>window.pages = ["/images/ash-lantern/ch-4/01.jpg","/images/ash-lantern/ch-4/02.jpg","/images/ash-lantern/ch-4/03.jpg","/images/related/bronze-kite.jpg","/images/related/cedar-signal.jpg"];</script>
</body></html>`
}

// A one-pixel GIF so the extension's image load check has something to fetch.
const GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (/^\/(covers|images)\//.test(path) || path === '/spacer.gif') {
    res.writeHead(200, { 'content-type': 'image/gif' })
    return res.end(GIF)
  }
  const render = pages[path]
  if (!render) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  const body = render(url)
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('no page')
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fixture manga site on http://127.0.0.1:${PORT}`)
})

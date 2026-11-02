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
  <form class="site-search" action="/search" method="get"><input type="text" name="q"></form>
  <section class="grid">${list}</section>
  <div class="pagination"><a href="/browse?listing-page=2">2</a><a class="filter" href="/browse?year=2024">2024</a></div>
</body></html>`

const TITLES = [
  ['Ash Lantern', 'ash-lantern'], ['Bronze Kite', 'bronze-kite'], ['Cedar Signal', 'cedar-signal'],
  ['Dusk Orchard', 'dusk-orchard'], ['Ember Atlas', 'ember-atlas'], ['Fern Circuit', 'fern-circuit'],
  ['Glass Harbor', 'glass-harbor'], ['Hollow Compass', 'hollow-compass']
]

// Page 2 of the catalogue has to be other series, or a builder that never
// varies the page number still looks like it is paging.
const TITLES_PAGE2 = [
  ['Iron Meridian', 'iron-meridian'], ['Jade Ledger', 'jade-ledger'], ['Kelp Republic', 'kelp-republic'],
  ['Lunar Ferry', 'lunar-ferry'], ['Marrow Bell', 'marrow-bell'], ['Nomad Almanac', 'nomad-almanac'],
  ['Ochre Vine', 'ochre-vine'], ['Pillar Quilt', 'pillar-quilt']
]

const browseCards = (offset) => {
  const set = offset === 0 ? TITLES : TITLES_PAGE2
  return set.map(([t, s], i) => card(offset + i, `${t} ${offset + i}`, s)).join('')
}

const pages = {
  '/': () => shelf(browseCards(0)),

  // The listing page the builder is expected to adopt as "popular".
  '/browse': (url) => {
    const page = Number(url.searchParams.get('listing-page') || '1')
    if (page > 3) return ''
    // Deep listing pages fail now and then on real sites, and a search that
    // trips over one must still hand back what the other pages gave.
    if (page === 3) throw new Error('listing page 3 is down')
    return shelf(browseCards((page - 1) * TITLES.length))
  },

  // The site indexes only its first four titles, and renders what it does not
  // know in a container the browse page's card selector does not match. The
  // measured endpoint therefore answers for "Ash Lantern" and returns nothing
  // for "Glass Harbor" — the case a catalogue walk exists to cover.
  '/search': (url) => {
    const q = String(url.searchParams.get('q') || '').toLowerCase().trim()
    // Indexed the way a real partial index is: only the first four entries,
    // matched against the titles the listing actually shows.
    const indexed = TITLES.slice(0, 4).map(([t, s], i) => ({ title: `${t} ${i}`, slug: s, num: i }))
    const hits = q ? indexed.filter((entry) => entry.title.toLowerCase().includes(q)) : []
    if (hits.length > 0) {
      return shelf(hits.map((entry) => card(entry.num, entry.title, entry.slug)).join(''))
    }
    return `<!doctype html>
<html lang="en"><head><title>search</title></head><body>
  <p class="no-results">Nothing matches "${q}".</p>
</body></html>`
  },

  // Two <h1>s, in the order an episode-style theme writes them: the chapter
  // heading first, the series name second. A builder that takes the first one
  // stores "Episode.1" as the title of the manga, which is what comic-ogyaaa
  // did and what check-fixture.mjs now refuses to accept.
  '/manga/ash-lantern': () => `<!doctype html>
<html lang="en"><head><title>『Ash Lantern』Episode.1 - Fixtural Manga</title>
<meta property="og:locale" content="en_US">
<meta property="og:title" content="『Ash Lantern』Episode.1 - Fixtural Manga">
<script type="application/ld+json">
{"@type":"CreativeWork","name":"Ash Lantern","description":"A lamplighter inherits a lantern that will not stay lit.","genre":["Action","Adventure"],"author":{"name":"R. Okafor"},"image":"/covers/ash-lantern.jpg"}
</script>
</head><body>
  <h1>Episode.1</h1>
  <h1>Ash Lantern</h1>
  <h2>R. Okafor</h2>
  <div class="summary-table">
    <span class="label">Status:</span><span class="value">Ongoing</span>
  </div>
  <div class="chapter-shell">
    <select id="chapter-select">
      <option value="/manga/ash-lantern/ch-1">Chapter 1</option>
      <option value="/manga/ash-lantern/ch-2">Chapter 2</option>
      <option value="/manga/ash-lantern/ch-3">Chapter 3</option>
      <option value="/manga/ash-lantern/ch-0">Extra Chapter</option>
      <option value="/manga/ash-lantern/ch-4">Chapter 4</option>
    </select>
    <ul class="chapter-list">
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-4">Chapter 4</a><span class="date">Jan 4</span></li>
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-3">Chapter 3</a><span class="date">Jan 3</span></li>
      <li class="wp-manga-chapter"><a href="/manga/ash-lantern/ch-0">Extra Chapter</a><span class="date">Jan 3</span></li>
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
</body></html>`,

  // The prose chapter. No images anywhere, two thousand characters of text:
  // this is the shape lightnovel.to serves, and the rule that names it has to
  // be measured against a page like this instead of guessed at.
  '/manga/ash-lantern/ch-0': () => `<!doctype html>
<html lang="en"><head><title>Ash Lantern — Extra Chapter</title></head><body>
  <h1>Ash Lantern</h1>
  <h2>Extra Chapter</h2>
  <article class="chapter-text">
    <p>The lamplighter's ledger opened with a name nobody in the harbour could place. It was written in a steady hand, in ink that had long since gone the colour of rust, and it recorded a debt rather than a birth.</p>
    <p>She had inherited three things from him: the lantern, a brass key with no lock in this house to fit it, and one instruction she had heard so often it had stopped sounding like a warning. Never light the lantern before the fog comes in from the west.</p>
    <p>The first winter she kept the lamp unlit, the way he had. Fuel sat in the tin under the stairs and the wick stayed dry, and the dark of the upper window looked ordinary to anyone passing on the quay. Ordinary was the whole art of it.</p>
    <p>By spring the gulls had taken to circling the roof at dusk, and the men on the boats began to ask, without asking, whether the light would be needed again soon. She told them it was a matter of weather. Weather was a matter of the ledger, and the ledger was not for reading aloud.</p>
    <p>There was a page near the back where the entries changed. Earlier lines named a ship and a tonnage and a sum; later ones gave only a date and a single word, always the same word, written smaller each time.</p>
    <p>She counted the repetitions twice and got different numbers, which is the sort of thing that keeps a person awake on a calm night. The lamp went out on its own, in a closed room, and nothing in the house had been touched.</p>
    <p>Her uncle had worked the western light for forty-one years and had never once, in all that time, been thanked by anyone who lived to describe it. The harbour paid him in fish and in silence, and he had seemed content with both.</p>
    <p>What she understood late, and only in pieces, was that the light was never meant for the ships. The ships were the excuse. Something on the shore had been taught, over four decades, to expect a signal at a particular hour, and the town had built its whole idea of safety around that expectation.</p>
    <p>The fog came in from the west on the ninth of October, three weeks after anyone sensible would have stopped watching for it. She found the key warm when she picked it up off the shelf, which it had no business being.</p>
    <p>So she lit the lantern, because a promise kept is easier to carry than a promise broken, and because the ledger had finally run out of blank pages. Whatever the light had been calling in, at least it would arrive somewhere she could look it in the face.</p>
  </article>
  <nav class="pager"><a href="/manga/ash-lantern/ch-1">Next chapter</a></nav>
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
  let body = ''
  try {
    body = render(url)
  } catch {
    // A route that throws stands for a page the site cannot serve right now.
    res.writeHead(500, { 'content-type': 'text/plain' })
    return res.end('down')
  }
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

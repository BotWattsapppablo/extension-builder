# 🧩 MihonPC Extension Builder

Generate a working MihonPC manga extension from **just a URL**.

## ⚡ One command — fully automatic

```bash
cd "extension builder"
npm install            # once
node auto-build.mjs https://mangapill.com
```

That's it. The tool will:

1. **Fetch the homepage**
2. **Detect the manga cards** (scored by content-link density — no hand-tuned selectors)
3. **Validate the listing URLs with real fetches** — popular / latest / search are only kept if they actually render manga cards (news pages and manga-detail pages can't sneak in)
4. **Follow a manga link** → detect details (title, description, cover, status, genres, author, artist) and the chapter list (via a generic chapter-link-container scan, with JSON-API probing when the site loads chapters via JavaScript)
5. **Follow a chapter link** → detect the reader's page-image selector + referer requirements
6. **Detect pagination** and verify page 2 actually renders before enabling it
7. **Generate** a ready-to-install `.js` extension + `index.json` + a config file

### Then verify it (optional but recommended)

```bash
node test-extension.mjs output/mangapill.js
```

This loads the generated extension in a mock of the app's real sandbox bridge
(`http` + `html`, same semantics as `src/main/extensions/bridge.ts`) and runs the
full pipeline **live** against the site:

```
✅ getPopularManga(1)  — 40 manga, e.g. "Be-Bop High School"
✅ searchManga(1, ...) — 50 results
✅ getMangaDetails     — status=ongoing genres=2 | Oda Eiichirou
✅ getChapterList      — 450 chapters
✅ getPageList         — 27 pages
✅ image loads         — HTTP 200 (CDN + referer)
   6/6 checks passed — ALL GOOD 🎉
```

Details return `author` and `artist` too — labelled rows like
`Author(s) : Oda Eiichirou` are detected and the label is stripped
automatically.

Verified working: **mangapill.com** (6/6), **mangahere.cc** (7/7),
**kakamanga.com** (7/7 — JSON chapter API, 3877 chapters, referer-gated CDN).

## 🖥️ Desktop app — build many sites at once

Double-click **`Extension Builder.exe`** (on the Desktop, or in this folder).
No browser, no server — it's a real window.

The `.exe` is a small native launcher: it finds this folder, finds `node`, and
opens the app. It never goes stale, because it runs whatever the code is today.
Rebuild it after moving the project with `node make-exe.mjs`. If it can't find
the folder it asks you for it once and remembers.

`Build App.bat` and `npm run app` do the same thing from a terminal.

- Paste **one site per line** in the left box (blank lines and `#` comments are
  ignored, duplicates are dropped).
- **Build at once** sets how many sites run in parallel — 20 by default, 30 max.
  Each site gets its own row with live status (`queued → building → verifying →
  built`), its own checks score and its own log: click a row to read that site's
  output only.
- **Verify each build (live)** runs the full smoke test against the real site
  after each build, in its own small pool so 30 tests never hammer the sites.
- **Stop** finishes the jobs already running and never starts another.
- Requests are queued per hostname, so a 30-site batch can't turn into 30
  simultaneous hits on one site, and Cloudflare-gated sites share the single
  browser window (one render at a time).

A site that can't be reached fails its row with the reason (`ENOTFOUND`, HTTP
403, empty page) and writes nothing to `output/`.

## Other tools

| Command | What it does |
|---------|--------------|
| `node auto-build.mjs <url>` | **Fully automatic build from URL only** |
| `node test-extension.mjs <file.js>` | End-to-end smoke test of any generated extension |
| `node build-extension.mjs` | Interactive wizard (suggests selectors, asks before generating) |
| `node build-extension.mjs --config output/x.config.json` | Rebuild after editing a config |
| `node quick-build.mjs <id> <url> --card ... ` | Build from explicit CLI arguments |
| `node analyze-site.mjs <url>` | Dump a site's structure without generating anything |
| `node test-app.mjs` | Launch the desktop app, run a small batch, verify the window |
| `node audit-extensions.mjs` | Grade **every** extension in `output/` and rank the failure types |
| `node .audit/rebuild-failed.mjs` | Rebuild the ones an audit marked broken, then report the repair rate |

## Testing at scale (the audit loop)

The builder only ever proved one site at a time. To fix systematic problems you
need counts, so `audit-extensions.mjs` loads every `output/*.js` in a replica of
MihonPC's own extension bridge (`ext-sandbox.mjs` — same 3-documents-per-call and
3000-element limits as `src/main/extensions/bridge.ts`) and walks the full path
the app walks: page 1 → page 2 → search → details → chapters → a real chapter's
pages → fetch the actual image bytes. Each extension gets its own process.

```
node audit-extensions.mjs --workers 12       # grades everything, ~7 min for 900
node audit-extensions.mjs --filter manga     # one subset
node .audit/rebuild-failed.mjs --workers 6   # rebuild the broken ones (no browser windows)
```

It writes `.audit/audit.json` (every record), `.audit/broken.tsv`, and prints the
verdict table. `.audit/triage.mjs` and `.audit/why-empty.mjs` then explain a class
by re-checking a sample against the live HTML.

`index.json` is the store list MihonPC reads, and it now contains **only
extensions that passed their live test** — a build that fails is left out (and any
older entry for it is removed), so a broken source can't be installed by accident.

## Output

All generated files go to `extension builder/output/`:

| File | Purpose |
|------|---------|
| `<id>.js` | The extension file — import in MihonPC |
| `<id>.config.json` | Detected selectors/URLs — edit & rebuild |
| `index.json` | Store list (with SHA256) — verified extensions only |

## Install in MihonPC

1. Open MihonPC → **Browse** → **Extensions**
2. Click **Import local file**
3. Select the `.js` file from `output/`
4. Go to **Sources** → find your source → **Test extension**

## Troubleshooting a generated extension

1. Run `node test-extension.mjs output/<id>.js` — it tells you exactly which method fails
2. Fix the selector in `output/<id>.config.json`
3. Rebuild with `node build-extension.mjs --config output/<id>.config.json`
4. Re-test, then import the new `.js`

### Cloudflare keeps asking me to verify, over and over

That is the gate rejecting the *browser*, not the click. What the builder does
about it:

- uses a real Chrome / Edge / Brave / Opera when one is installed — bundled
  Chromium is what gets looped — and never overrides its user agent, because
  `cf_clearance` is hashed with the UA the browser really has, so a spoofed one
  voids the cookie and the challenge comes straight back;
- stops touching the page the moment it loads: a site that embeds its own
  Turnstile box in a search or login form is **not** a gate, and clicking it
  again is how a build restarts the challenge;
- gives up after a few re-issued challenges and says so, instead of hanging.

If a site still loops, delete its profile folder (`.browser-profile-*`) and
re-run — a half-solved cached cookie can cause it — or force another browser:
`set BUILDER_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe`.

Known limitations (reported honestly during the build):
- Sites whose search endpoint is missing or bot-gated (e.g. behind a Cloudflare
  challenge) get a **catalogue-walk fallback**: each search page scans a block of
  3 listing pages (the bridge allows 3 documents per call) and the app's own
  paging walks on, so rare titles are reachable by scrolling — but slowly, and
  the build prints a warning naming this.
- Sites that render one reader image per URL (e.g. `/1.html`, `/2.html`) will
  only expose the first page — the tool prints a warning when it detects this.
- Bot-gated sites (Cloudflare 403/522, "Just a moment…") are retried in a real
  **headed** browser window (`browser-fetch.mjs`): Chrome, Edge, Brave or Opera
  if one is installed — they pass gates that bundled Chromium cannot — otherwise
  Playwright's Chromium. `BUILDER_BROWSER=<path>` forces one. A window pops up
  for a few seconds. If the challenge shows a "Verify you are human" checkbox the
  tool clicks it itself; if Cloudflare insists on a real human, the build prints a
  prompt, raises the window and waits up to 2½ minutes. Each browser keeps its own
  profile (`.browser-profile-*/`), so a solved challenge is cached and later builds
  skip the gate. If a gate keeps re-issuing itself the build says so and moves on
  instead of hanging. Sites whose origin is simply down (HTTP 522) can't be reached.
- JS-only SPAs (no server-rendered HTML) are rendered in the same browser window
  so their post-JavaScript DOM can be analyzed.

## Files

| File | What it does |
|------|--------------|
| `auto-build.mjs` | **URL → extension, zero questions asked** |
| `test-extension.mjs` | Mock-bridge end-to-end tester |
| `build-extension.mjs` | Interactive wizard |
| `quick-build.mjs` | Build from explicit arguments |
| `analyze-site.mjs` | Website structure analyzer |
| `generate-extension.mjs` | Extension code generator (library) |
| `browser-fetch.mjs` | Headed-Chromium fallback for bot-gated / JS-only sites |
| `batch.mjs` | Concurrent build engine (worker pool + per-job logs) used by the app |
| `app/` | Electron desktop app — `Extension Builder.exe` / `Build App.bat` / `npm run app` |
| `make-exe.mjs` | Compiles the native `Extension Builder.exe` launcher |

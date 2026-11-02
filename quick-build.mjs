/**
 * quick-build.mjs — Generate an extension from a preset config without the wizard.
 *
 * Usage:
 *   node quick-build.mjs <name> <baseUrl> [options]
 *
 * Example:
 *   node quick-build.mjs mangapill https://mangapill.com \
 *     --card "div.grid > div:has(a img)" \
 *     --title "div.font-black" \
 *     --chapters "#chapters a"
 *
 * For full control, use build-extension.mjs with --config.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateExtension, sha256, generateIndexEntry } from './generate-extension.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, 'output')

function parseArgs(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      opts[args[i].slice(2)] = args[i + 1]
      i++
    }
  }
  return opts
}

const args = process.argv.slice(2)
if (args.length < 2 || args[0].startsWith('--')) {
  console.log(`
Usage: node quick-build.mjs <id> <baseUrl> [options]

Options:
  --name "Display Name"         Display name (default: id capitalized)
  --lang en                     Language code (default: en)
  --card ".manga-card"          Card CSS selector
  --card-link "a"               Link inside card
  --card-title "h3"             Title inside card
  --card-cover "img"            Cover image inside card
  --cover-attr "src"            Cover image attribute
  --detail-title "h1"           Details page title selector
  --detail-desc ".description"  Details page description
  --detail-cover "img"          Details page cover
  --detail-status ".status"     Details page status
  --detail-genres ".tags a"     Details page genres
  --chapters ".chapter-list li" Chapter list selector
  --chapter-link "a"            Chapter link selector
  --reader-imgs "#reader img"   Reader images selector
  --img-attr "src"              Image attribute
  --popular-url "/popular?page={page}"
  --search-url "/search?q={query}&page={page}"
  --latest-url "/latest?page={page}"
  --nsfw                        Mark as NSFW
  --referer                     Images need Referer header
`)
  process.exit(0)
}

const id = args[0]
const baseUrl = args[1].replace(/\/+$/, '')
const opts = parseArgs(args.slice(2))

const config = {
  id,
  name: opts.name || id.charAt(0).toUpperCase() + id.slice(1),
  lang: opts.lang || 'en',
  baseUrl,
  supportsLatest: !!opts['latest-url'],
  isNsfw: args.includes('--nsfw'),
  version: opts.version || '1.0.0',
  needsReferer: args.includes('--referer'),
  selectors: {
    card: opts.card || '.manga-card',
    cardLink: opts['card-link'] || 'a',
    cardTitle: opts['card-title'] || 'h3',
    cardCover: opts['card-cover'] || 'img',
    coverAttr: opts['cover-attr'] || 'src',
    details: {
      title: opts['detail-title'] || 'h1',
      description: opts['detail-desc'] || '.description',
      cover: opts['detail-cover'] || 'img',
      coverAttr: opts['cover-attr'] || 'src',
      status: opts['detail-status'] || '.status',
      genres: opts['detail-genres'] || '.tags a',
      author: opts['detail-author'] || ''
    },
    chapters: {
      list: opts.chapters || '.chapter-list li',
      link: opts['chapter-link'] || 'a',
      name: opts['chapter-name'] || 'a',
      date: opts['chapter-date'] || ''
    },
    reader: {
      images: opts['reader-imgs'] || '#reader img',
      imageAttr: opts['img-attr'] || 'src'
    }
  },
  urls: {
    popular: opts['popular-url']
      ? (opts['popular-url'].startsWith('http') ? opts['popular-url'] : `${baseUrl}${opts['popular-url']}`)
      : `${baseUrl}/popular?page={page}`,
    search: opts['search-url']
      ? (opts['search-url'].startsWith('http') ? opts['search-url'] : `${baseUrl}${opts['search-url']}`)
      : `${baseUrl}/search?q={query}&page={page}`
  }
}

if (opts['latest-url']) {
  config.urls.latest = opts['latest-url'].startsWith('http')
    ? opts['latest-url']
    : `${baseUrl}${opts['latest-url']}`
}

// Generate
const extensionCode = generateExtension(config)
const hash = sha256(extensionCode)

mkdirSync(OUTPUT_DIR, { recursive: true })

const jsPath = join(OUTPUT_DIR, `${id}.js`)
writeFileSync(jsPath, extensionCode, 'utf-8')

const configPath = join(OUTPUT_DIR, `${id}.config.json`)
writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

// Update index
const indexPath = join(OUTPUT_DIR, 'index.json')
let index = { name: 'Extension Builder Output', apiVersion: 1, extensions: [] }
if (existsSync(indexPath)) {
  try { index = JSON.parse(readFileSync(indexPath, 'utf-8')) } catch { /* fresh */ }
}
const entry = generateIndexEntry(config, extensionCode)
const existingIdx = index.extensions.findIndex((e) => e.packageId === id)
if (existingIdx >= 0) index.extensions[existingIdx] = entry
else index.extensions.push(entry)
writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

console.log(`\n✅ Extension "${config.name}" generated!`)
console.log(`   File:   ${jsPath}`)
console.log(`   Config: ${configPath}`)
console.log(`   SHA256: ${hash}\n`)

/**
 * build-extension.mjs — Interactive CLI tool to build MihonPC extensions.
 *
 * Usage:
 *   node build-extension.mjs                       (interactive wizard)
 *   node build-extension.mjs --url https://site.com (analyze + wizard)
 *   node build-extension.mjs --config config.json   (from config file)
 *
 * The tool:
 *   1. Analyzes the target website to detect its structure
 *   2. Lets you pick/customize the CSS selectors
 *   3. Generates a .js extension file + index.json entry
 *   4. Saves everything in the "extension builder/output/" folder
 */
import { createInterface } from 'node:readline'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSite } from './analyze-site.mjs'
import { generateExtension, sha256, generateIndexEntry } from './generate-extension.mjs'
import { siteNameFrom } from './site-name.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = join(__dirname, 'output')

// ── Simple readline-based prompts (no deps needed) ──────────────────────────

function createRl() {
  return createInterface({ input: process.stdin, output: process.stdout })
}

async function ask(rl, question, defaultValue = '') {
  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue)
    })
  })
}

async function askYesNo(rl, question, defaultYes = false) {
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]'
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      const a = answer.trim().toLowerCase()
      if (a === '') resolve(defaultYes)
      else resolve(a === 'y' || a === 'yes')
    })
  })
}

async function askChoice(rl, question, options) {
  console.log(`\n  ${question}`)
  options.forEach((opt, i) => {
    console.log(`    ${i + 1}. ${typeof opt === 'string' ? opt : opt.label}`)
  })
  return new Promise((resolve) => {
    rl.question(`  Choice (1-${options.length}): `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1
      if (idx >= 0 && idx < options.length) {
        resolve(options[idx])
      } else {
        resolve(options[0])
      }
    })
  })
}

// ── Main wizard ──────────────────────────────────────────────────────────────

async function runWizard(initialUrl = null) {
  const rl = createRl()

  console.log('\n╔══════════════════════════════════════════════════════════╗')
  console.log('║       🧩 Yomi Builder — Wizard                         ║')
  console.log('╚══════════════════════════════════════════════════════════╝\n')

  // Step 1: Get the URL
  const siteUrl = initialUrl || (await ask(rl, '🌐 Enter the manga website URL', 'https://mangapill.com'))

  // Step 2: Analyze the site
  let analysis = null
  try {
    analysis = await analyzeSite(siteUrl)
    console.log('\n✅ Site analyzed successfully!\n')

    // Show what was detected
    console.log('  📊 Detection Results:')
    console.log(`     Cards found:     ${analysis.cards.length > 0 ? '✅' : '❌'} (${analysis.cards.length} selector patterns)`)
    console.log(`     Titles found:    ${analysis.titles.length > 0 ? '✅' : '❌'} (${analysis.titles.length} selector patterns)`)
    console.log(`     Covers found:    ${analysis.covers.length > 0 ? '✅' : '❌'} (${analysis.covers.length} selector patterns)`)
    console.log(`     Link patterns:   ${analysis.linkPatterns.length > 0 ? '✅' : '❌'} (${analysis.linkPatterns.map((p) => p.pattern).join(', ') || 'none'})`)
    console.log(`     Has search:      ${analysis.detectedFeatures.hasSearch ? '✅' : '❌'}`)
    console.log(`     Has latest:      ${analysis.detectedFeatures.hasLatestUpdates ? '✅' : '❌'}`)
    console.log(`     Has popular:     ${analysis.detectedFeatures.hasPopular ? '✅' : '❌'}`)
    console.log(`     Uses lazy-load:  ${analysis.detectedFeatures.usesLazyLoad ? '✅' : '❌'}`)
    console.log(`     Cloudflare:      ${analysis.detectedFeatures.isCloudflareProtected ? '⚠️  Yes' : '✅ No'}`)
    console.log()
  } catch (err) {
    console.log(`\n⚠️  Could not analyze site: ${err.message}`)
    console.log('   You can still enter selectors manually.\n')
  }

  // Step 3: Extension metadata
  console.log('  ─── Extension Metadata ─────────────────────────────────\n')

  const baseUrl = analysis?.baseUrl || new URL(siteUrl).origin
  const siteName = siteNameFrom(new URL(siteUrl).hostname)
  const defaultName = siteName.charAt(0).toUpperCase() + siteName.slice(1)

  const config = {
    id: await ask(rl, 'Extension ID (stable, unique)', siteName),
    name: await ask(rl, 'Display name', defaultName),
    lang: await ask(rl, 'Language (ISO 639-1)', 'en'),
    baseUrl: await ask(rl, 'Base URL', baseUrl),
    supportsLatest: await askYesNo(rl, 'Supports latest updates?', analysis?.detectedFeatures?.hasLatestUpdates ?? true),
    isNsfw: await askYesNo(rl, 'Is NSFW?', false),
    version: await ask(rl, 'Version', '1.0.0'),
    needsReferer: await askYesNo(rl, 'Images need Referer header?', analysis?.detectedFeatures?.usesReferer ?? false)
  }

  // Step 4: Selectors — offer detected ones or let user type
  console.log('\n  ─── CSS Selectors ─────────────────────────────────────\n')

  const bestCard = analysis?.cards?.[0]?.selector || '.manga-card'
  const bestTitle = analysis?.titles?.[0]?.selector || 'h3'
  const bestCover = analysis?.covers?.[0]?.selector || 'img'
  const imgAttr = analysis?.detectedFeatures?.usesLazyLoad ? 'data-src' : 'src'

  if (analysis?.cards?.length > 0) {
    console.log('  Top detected card selectors:')
    analysis.cards.slice(0, 5).forEach((c, i) => {
      console.log(`    ${i + 1}. "${c.selector}" — ${c.count} matches`)
      if (c.samples[0]?.text) console.log(`       Sample: "${c.samples[0].text.substring(0, 60)}"`)
    })
    console.log()
  }

  config.selectors = {
    card: await ask(rl, 'Manga card selector', bestCard),
    cardLink: await ask(rl, 'Link inside card', 'a'),
    cardTitle: await ask(rl, 'Title inside card', bestTitle),
    cardCover: await ask(rl, 'Cover image inside card', bestCover),
    coverAttr: await ask(rl, 'Cover image attribute', imgAttr),

    details: {
      title: await ask(rl, 'Details page — title selector', 'h1'),
      description: await ask(rl, 'Details page — description', '.description, div.mb-3 p'),
      cover: await ask(rl, 'Details page — cover image', 'img[data-src], img.cover'),
      coverAttr: await ask(rl, 'Details page — cover attr', imgAttr),
      status: await ask(rl, 'Details page — status text', '.status'),
      genres: await ask(rl, 'Details page — genre links', '.tags a, .genres a'),
      author: await ask(rl, 'Details page — author (empty to skip)', '')
    },

    chapters: {
      list: await ask(rl, 'Chapter list items', analysis?.chapters?.[0]?.selector || '.chapter-list li'),
      link: await ask(rl, 'Chapter link', 'a'),
      name: await ask(rl, 'Chapter name', 'a'),
      date: await ask(rl, 'Chapter date (empty to skip)', '.date')
    },

    reader: {
      images: await ask(rl, 'Reader page images', analysis?.readerImages?.[0]?.selector || '#reader img'),
      imageAttr: await ask(rl, 'Reader image attribute', imgAttr)
    }
  }

  // Step 5: URL Patterns
  console.log('\n  ─── URL Patterns ──────────────────────────────────────\n')
  console.log('   Use {page} for page number and {query} for search query.\n')

  config.urls = {
    popular: await ask(rl, 'Popular page URL', `${config.baseUrl}/popular?page={page}`),
    search: await ask(rl, 'Search URL', `${config.baseUrl}/search?q={query}&page={page}`)
  }

  if (config.supportsLatest) {
    config.urls.latest = await ask(rl, 'Latest updates URL', `${config.baseUrl}/latest?page={page}`)
  }

  rl.close()

  // Step 6: Generate the extension
  console.log('\n  ─── Generating Extension ─────────────────────────────\n')

  const extensionCode = generateExtension(config)
  const hash = sha256(extensionCode)
  const indexEntry = generateIndexEntry(config, extensionCode)

  // Save files
  mkdirSync(OUTPUT_DIR, { recursive: true })

  const jsPath = join(OUTPUT_DIR, `${config.id}.js`)
  writeFileSync(jsPath, extensionCode, 'utf-8')
  console.log(`  ✅ Extension saved:  ${jsPath}`)

  const configPath = join(OUTPUT_DIR, `${config.id}.config.json`)
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`  ✅ Config saved:     ${configPath}`)

  // Build or update index.json
  const indexPath = join(OUTPUT_DIR, 'index.json')
  let index = { name: 'Yomi Builder Output', apiVersion: 1, extensions: [] }
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf-8'))
    } catch {
      /* fresh index */
    }
  }
  // Update or add entry
  const existingIdx = index.extensions.findIndex((e) => e.packageId === config.id)
  if (existingIdx >= 0) {
    index.extensions[existingIdx] = indexEntry
  } else {
    index.extensions.push(indexEntry)
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  console.log(`  ✅ Index updated:    ${indexPath}`)

  console.log(`\n  🔑 SHA256: ${hash}`)
  console.log(`\n  ──────────────────────────────────────────────────────`)
  console.log(`  🎉 Extension "${config.name}" generated successfully!`)
  console.log(`\n  📋 Next steps:`)
  console.log(`     1. Open MihonPC → Browse → Extensions`)
  console.log(`     2. Click "Import local file" and select ${config.id}.js`)
  console.log(`     3. Test each method via the Test extension tool`)
  console.log(`     4. Adjust selectors in ${config.id}.config.json and re-run:`)
  console.log(`        node build-extension.mjs --config output/${config.id}.config.json\n`)

  return { config, extensionCode, hash }
}

// ── From config file ────────────────────────────────────────────────────────

async function buildFromConfig(configPath) {
  console.log(`\n🔧 Building from config: ${configPath}\n`)
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  const extensionCode = generateExtension(config)
  const hash = sha256(extensionCode)
  const indexEntry = generateIndexEntry(config, extensionCode)

  mkdirSync(OUTPUT_DIR, { recursive: true })

  const jsPath = join(OUTPUT_DIR, `${config.id}.js`)
  writeFileSync(jsPath, extensionCode, 'utf-8')
  console.log(`  ✅ Extension saved:  ${jsPath}`)

  const indexPath = join(OUTPUT_DIR, 'index.json')
  let index = { name: 'Yomi Builder Output', apiVersion: 1, extensions: [] }
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, 'utf-8'))
    } catch {
      /* fresh index */
    }
  }
  const existingIdx = index.extensions.findIndex((e) => e.packageId === config.id)
  if (existingIdx >= 0) {
    index.extensions[existingIdx] = indexEntry
  } else {
    index.extensions.push(indexEntry)
  }
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
  console.log(`  ✅ Index updated:    ${indexPath}`)
  console.log(`\n  🔑 SHA256: ${hash}`)
  console.log(`  🎉 Done!\n`)
}

// ── CLI entry ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Yomi Builder

Usage:
  node build-extension.mjs                        Interactive wizard
  node build-extension.mjs --url <URL>             Analyze URL + wizard
  node build-extension.mjs --config <file.json>    Build from saved config

Options:
  --url <URL>          Start with a specific website URL
  --config <file>      Build from a previously saved config.json
  --help, -h           Show this help
`)
  process.exit(0)
}

const urlIdx = args.indexOf('--url')
const configIdx = args.indexOf('--config')

if (configIdx >= 0 && args[configIdx + 1]) {
  buildFromConfig(args[configIdx + 1]).catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
} else {
  const initialUrl = urlIdx >= 0 ? args[urlIdx + 1] : null
  runWizard(initialUrl).catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}

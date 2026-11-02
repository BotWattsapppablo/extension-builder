/**
 * query-safety.mjs — one rule for every search probe this project sends.
 *
 * Two failure modes, in opposite directions, both learned the expensive way:
 *
 * 1. A card's text can contain lazy-loader markup. URL-encoded and sent as
 *    `?q=`, `img src="…"` reads to the site's firewall like an injection
 *    attempt — enough to get this machine's IP blocked. Markup therefore
 *    disqualifies the whole term; it is never truncated into something safe.
 *    The smell test runs on the raw text, before punctuation is touched,
 *    because deleting the `=` out of `src=` is exactly what hides it.
 *
 * 2. Cleaning the *title* instead of dropping it also breaks searches. Sites
 *    match what they stored: on comic-ogyaaa, "(元)奴隷エルフを…" finds the
 *    series, while "元 奴隷エルフを…" — the same characters with the
 *    parentheses turned into a space — finds nothing. CJK titles have no word
 *    spaces, so every punctuation-to-space substitution invents a word
 *    boundary the site does not know. Titles are therefore sent verbatim, in
 *    their own script, with the characters a URL needs handled by
 *    `encodeURIComponent` at the call site rather than by mangling the term.
 */

/** Looks like markup or a URL rather than something a person would type. */
const MARKUP_SMELL = /https?:|www\.|\/\/[a-z0-9]|javascript:|data\s*:|(?:^|\s)[a-z-]{2,}\s*=\s*["']|on(?:error|load|click)\s*=|[<>]/i

/** Control characters never survive; they arrive from scraped text nodes. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g

/**
 * A query a person could plausibly have typed, or '' if there is no such thing
 * in this text. Everything else is preserved exactly as the site wrote it.
 */
export function safeQuery(text, max = 60) {
  const noTags = String(text || '').replace(/<[^>]*>/g, ' ')
  if (MARKUP_SMELL.test(noTags)) return ''
  const clean = noTags.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  if (clean.length < 2) return ''
  if (clean.length <= max) return clean
  // A long title is cut to a *prefix*, which sites still match. Cut on a space
  // when the text has spaces; CJK has none and takes the hard cut.
  const head = clean.slice(0, max)
  const wordStart = head.lastIndexOf(' ')
  return wordStart >= 8 ? head.slice(0, wordStart) : head
}

/**
 * Every term worth trying for these titles, best first: each title as the site
 * spells it, then its first words in case the full string is too exact. A
 * title that smells of markup is skipped, not replaced — the next real title
 * beats a generic guess on a foreign catalogue.
 */
export function searchTerms(titles, { limit = 3 } = {}) {
  const out = []
  for (const raw of titles || []) {
    if (out.length >= limit) break
    const full = safeQuery(String(raw || '').replace(/\s+/g, ' ').trim())
    if (!full || out.includes(full)) continue
    out.push(full)
    const words = safeQuery(full.split(/\s+/).slice(0, 2).join(' '), 40)
    if (words && words !== full && !out.includes(words)) out.push(words)
  }
  return out
}

/** The single best term for one title, or a generic guess if it is unusable. */
export function searchTerm(title, fallback = 'one piece') {
  return searchTerms([title], { limit: 1 })[0] || fallback
}

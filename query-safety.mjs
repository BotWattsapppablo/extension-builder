/**
 * query-safety.mjs — one rule for every search probe this project sends.
 *
 * A search term is whatever a card's text happened to contain. On some sites
 * that text includes lazy-loader markup, and a URL-encoded `img src="…"` sent
 * as `?q=` reads to the site's firewall like an injection attempt — enough to
 * get this machine's IP blocked. Anything still smelling of markup after
 * cleaning is dropped entirely, not truncated.
 */

/** A query a person could plausibly have typed, or '' if there isn't one. */
export function safeQuery(text, max = 40) {
  const clean = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^A-Za-z0-9 \-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
  if (clean.length < 3) return ''
  if (/https?|www|com|src|class|alt|div|img|span|href/i.test(clean)) return ''
  return clean
}

/** First few words of a title, cleaned — the term the harnesses search with. */
export function searchTerm(title, fallback = 'one piece') {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ')
  return safeQuery(words) || fallback
}

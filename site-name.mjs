/**
 * site-name.mjs — the store id a hostname becomes.
 *
 * The first label is the wrong answer: `new.astratoons.com`, `v2.komiknesiaku.com`
 * and `es.mangacrab.org` all shipped as "new", "v2" and "es", so two sources
 * could share one file name and one index entry — the later build silently
 * replaced the earlier one. The label that carries the brand is the one just
 * above the TLD (or just above `co.uk`-style second-level suffixes).
 */

const SECOND_LEVEL = /^(co|com|net|org|ac|or|ne|in|gov|edu|mil|sch|res|go|gob|lg|fb)$/

function secondLevel(label) {
  return SECOND_LEVEL.test(label)
}

export function siteNameFrom(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '').split(':')[0]
  if (!host) return 'site'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.replace(/\./g, '-') // IP literal
  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return labels[0] || 'site'
  const tld = labels[labels.length - 1]
  const penult = labels[labels.length - 2]
  const name = tld.length === 2 && secondLevel(penult) ? labels[labels.length - 3] : penult
  return name || labels[0]
}

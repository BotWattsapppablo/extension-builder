/**
 * title-safety.mjs — telling a series title from an episode heading.
 *
 * Episode-style sites (comic-ogyaaa and every "reader is the landing page"
 * theme) put the chapter heading in the page's FIRST <h1> and the series name
 * in a later one. The builder used to take h1[0], so the library showed
 * "Episode.1" as the title of a manga.
 *
 * isEpisodeLabel and pickSeriesTitle are emitted verbatim into every generated
 * extension via `titleHelpersSource` — the builder, the test harness and the
 * shipped extension all decide with the same rule, so a check can never pass
 * here and fail in the app.
 */

export function isEpisodeLabel(text) {
  var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  if (t === '') return true
  // "第1話", "第1話 かくして二人は出会った", "第3巻", "제1화"
  if (/^第\s*[0-9〇一二三四五六七八九十百千]+\s*[話话回夜章節巻卷幕]/.test(t)) return true
  if (/^제\s*[0-9]+\s*[화회]/.test(t)) return true
  // "Episode.1", "Ch. 239", "Chapter 12", "Tome 3", "capítulo 5" — a numbering
  // word with a number glued to it. Without the number, "Book of Stars" is a
  // title, so the bare word only counts when the string is nothing else.
  if (/^(ep(?:isode)?s?|ch(?:ap(?:ter)?|itre)?|cap[ií]tulo|cap|kapa|rozdzia[lł]|glava|bab|b[oö]lum|tome|vol(?:ume)?|volume|book|part|act|scene|theam)[\s.:\-#]*[0-9]/i.test(t)) return true
  return /^(ep(?:isode)?|chapter|chapitre|cap[ií]tulo|tome|volume|book|part)[\s.:\-#]*$/i.test(t)
}

export function pickSeriesTitle(nodes, cardTitle) {
  var src = Array.isArray(nodes) ? nodes : [nodes]
  var list = []
  for (var i = 0; i < src.length; i++) {
    var t = String(src[i] == null ? '' : src[i]).replace(/\s+/g, ' ').trim()
    if (t !== '' && list.indexOf(t) === -1) list.push(t)
  }
  for (var j = 0; j < list.length; j++) {
    if (!isEpisodeLabel(list[j])) return list[j]
  }
  // Nothing on the page names the series. The card the reader clicked does, and
  // that is the last source that has never been an episode heading.
  var card = String(cardTitle == null ? '' : cardTitle).replace(/\s+/g, ' ').trim()
  if (card !== '' && !isEpisodeLabel(card)) return card
  return list.length > 0 ? list[0] : card
}

/** The two functions above, as the source text to drop into a generated extension. */
export const titleHelpersSource = [isEpisodeLabel, pickSeriesTitle]
  .map((fn) => fn.toString())
  .join('\n\n')

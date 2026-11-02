/**
 * text-safety.mjs — telling "this site has no pictures" from "we lost them".
 *
 * lightnovel.to built cleanly, passed browse / search / details / chapters, and
 * then failed getPageList with "no readable images found in this chapter".
 * Measured on one of its chapters: 0 `<img>` tags and 106,000 characters of
 * prose. It is a novel site. A manga reader has nothing to display, so the
 * extension is not broken — the source type is wrong, and the old message made
 * it look like the builder's fault.
 *
 * The rule runs in three places, so it lives here once: the shipped extension
 * (its own getPageList error), the harness (what it prints) and the fixture
 * check. `textHelpersSource` pastes the function into generated extensions
 * verbatim, the way title-safety.mjs does for the episode-title rule.
 */

/** The phrase a generated extension puts in its error when the chapter is prose. */
export const TEXT_SITE_MARK = 'text-only chapter'

/**
 * True when an HTML page reads like an article rather than a strip of images.
 * Only ever consulted after every image source came up empty, so a page that
 * still has prose this long is a novel chapter, not a failed extraction.
 */
export function isTextChapter(htmlText) {
  var t = String(htmlText == null ? '' : htmlText)
  if (t.length < 1500) return false
  var body = t
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  var prose = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (prose.length < 1200) return false
  // Two independent shapes: paragraphs are what a writer produces, sentences
  // are what a reader reads. Nav and labels give neither.
  var paragraphs = (body.match(/<p[\s>]/gi) || []).length
  var sentences = (prose.match(/[.!?…]["'“”’)\]]?\s/g) || []).length
  return paragraphs >= 4 && sentences >= 12
}

/** Source text for the helpers that get pasted into a generated extension. */
export const textHelpersSource = [isTextChapter].map((fn) => fn.toString()).join('\n\n')

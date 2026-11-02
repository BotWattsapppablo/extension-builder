/**
 * ext-sandbox.mjs — the MihonPC extension bridge, reproduced exactly.
 *
 * Generated extensions call bare `http`, `html`, `cache`, `prefs` and `log`,
 * which the app injects into their sandbox. The limits below are copied from
 * src/main/extensions/{bridge,html-session}.ts, so an extension that passes
 * here passes in the app — and one that breaks here breaks there.
 *
 * A sandbox is single-use-serial: reset() between invokes, like the app does.
 * Never share one instance across concurrent extensions — run each extension in
 * its own process instead.
 */
import * as cheerio from 'cheerio'

// What the app itself puts on the wire when an extension does not say
// otherwise (src/main/extensions/extension-registry.ts). The sandbox used to
// substitute a Chrome UA here, which quietly passed every extension that only
// works because *it* asks for a browser — the test was kinder than the app.
export const UA = 'Yomi/0.0.0 (Windows) Yomi-ExtensionHost/1'
export const MAX_DOCS = 3 // MAX_DOCS_PER_SESSION
export const MAX_ELEMENTS = 3000 // MAX_ELEMENTS_PER_SESSION

export function makeSandbox() {
  const sessions = new Map()
  let nextId = 1
  let docCount = 0
  let elCount = 0

  function reset() {
    sessions.clear()
    nextId = 1
    docCount = 0
    elCount = 0
  }

  function addEl($, el) {
    if (elCount >= MAX_ELEMENTS) throw new Error(`html: max ${MAX_ELEMENTS} elements per call`)
    const id = nextId++
    sessions.set(id, { kind: 'el', $, el })
    elCount++
    return id
  }

  const http = {
    async request(url, opts = {}) {
      const headers = { 'User-Agent': UA, ...(opts.headers || {}) }
      const res = await fetch(url, { headers, redirect: 'follow' })
      // Field names mirror the real bridge: { status, text, finalUrl }
      return { status: res.status, text: await res.text(), finalUrl: res.url }
    },
    async getText(url, opts = {}) {
      return http.request(url, opts)
    },
    async getJson(url, opts = {}) {
      const r = await http.request(url, opts)
      return { ...r, json: JSON.parse(r.text) }
    }
  }

  const html = {
    load(htmlString) {
      if (typeof htmlString !== 'string' || htmlString.length === 0) throw new Error('html.load expects a non-empty string')
      if (htmlString.length > 4 * 1024 * 1024) throw new Error('html.load: input too large')
      if (docCount >= MAX_DOCS) throw new Error(`html.load: max ${MAX_DOCS} documents per call`)
      const $ = cheerio.load(htmlString)
      const id = nextId++
      sessions.set(id, { kind: 'doc', $ })
      docCount++
      return id
    },    select(rootId, selector) {
      if (typeof selector !== 'string' || selector.length === 0 || selector.length > 500) throw new Error('html.select: bad selector')
      const entry = sessions.get(handle('select', rootId))
      if (!entry) throw new Error(`html handle ${rootId} not found (expired or invalid)`)
      const scope = entry.kind === 'doc' ? entry.$.root() : entry.el
      return scope.find(selector).toArray().slice(0, MAX_ELEMENTS).map((n) => addEl(entry.$, entry.$(n)))
    },
    selectFirst(rootId, selector) {
      const ids = html.select(handle('selectFirst', rootId), selector)
      return ids.length > 0 ? ids[0] : null
    },
    text(id) {
      const entry = sessions.get(handle('text', id))
      if (!entry) throw new Error(`html handle ${id} not found`)
      return entry.kind === 'doc' ? entry.$('body').text() : entry.el.text()
    },
    attr(id, name) {
      if (typeof name !== 'string' || name.length > 100) throw new Error('html.attr: bad attribute name')
      const entry = sessions.get(handle('attr', id))
      if (!entry) throw new Error(`html handle ${id} not found`)
      if (entry.kind === 'doc') throw new Error('html.attr on document is not supported')
      return entry.el.attr(name) ?? null
    },
    selectText(rootId, selector) {
      return html.select(handle('selectText', rootId), selector).map((id) => html.text(id).trim())
    },
    selectAttr(rootId, selector, name) {
      return html.select(handle('selectAttr', rootId), selector).map((id) => html.attr(id, name))
    }
  }

  /**
   * The host rejects a non-integer root with `html.<action>: root handle
   * required` before it ever looks the handle up, so do the same — a Promise
   * where a handle belongs has to fail here, not silently resolve later.
   */
  function handle(action, value) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(`html.${action}: root handle required (got ${describe(value)})`)
    }
    return value
  }

  /** Say what was actually passed, since "got a Promise" is the whole diagnosis. */
  function describe(value) {
    if (value && typeof value.then === 'function') return 'a Promise — did you forget to await html.load?'
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'an array'
    return typeof value
  }

  // The real host answers every html call over an async bridge. A synchronous
  // sandbox hides the whole class of "forgot to await html.load" bugs: the
  // Promise lands inside an object, reads as a handle here, and reaches Yomi as
  // "html.selectText: root handle required". Everything the extension sees is
  // therefore a Promise, exactly like the app.
  const asyncHtml = Object.fromEntries(
    Object.entries(html).map(([name, fn]) => [name, async (...args) => fn(...args)])
  )

  return {
    http,
    html: asyncHtml,
    reset,
    globals: {
      http,
      html: asyncHtml,
      cache: { get: async () => null, set: async () => ({ ok: true }) },
      prefs: { get: async () => null, set: async () => ({ ok: true }) },
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    }
  }
}

/** Install the sandbox globals an extension expects to find. */
export function install(sandbox) {
  for (const [name, value] of Object.entries(sandbox.globals)) globalThis[name] = value
}

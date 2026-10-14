// Markdown rendering for assistant replies — the reader's `src/lib/markdown.js`,
// ported to globals (`marked` and `DOMPurify` are loaded from `vendor/` by the
// manifest before this file runs).
//
// The output is not fully trusted: the model writes it, but a web page can
// carry instructions that steer the model, so a hostile page could try to
// smuggle HTML into an answer. Everything therefore goes through DOMPurify, and
// images are dropped outright (a remote <img> would leak that you read the
// answer, and would be a tracking pixel the page controls).
//
// LaTeX maths is handled around the sanitiser: `AIMath` swaps the formulas for
// inert tokens first and KaTeX renders them back afterwards, so DOMPurify keeps
// its strict allow-list while formulas still come out typeset.
(function () {
  'use strict'

  const markedLib = globalThis.marked
  const math = globalThis.AIMath
  const katex = globalThis.katex
  const purifier =
    typeof globalThis.DOMPurify === 'function'
      ? globalThis.DOMPurify(globalThis)
      : globalThis.DOMPurify

  const ALLOWED_TAGS = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'del', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'span',
  ]

  const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class', 'align']

  /** Guard for the lengths KaTeX is willing to chew through. */
  const MAX_TEX_LENGTH = 2000

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char])
  }

  /**
   * One formula as HTML.
   *
   * `htmlAndMathml` (KaTeX's default) is the pair you want: the HTML half is what
   * you actually see — KaTeX's own stylesheet and fonts, so it is typeset like
   * the reference rendering — and the MathML half is hidden by that stylesheet
   * but still readable by screen readers. MathML alone, which is what this used
   * to emit, has no styling of its own and comes out small and plain.
   *
   * KaTeX escapes the LaTeX it is given and leaves \href, \url and the \html…
   * commands inert unless `trust` is enabled — this stays on the defaults, so the
   * result is safe to inject. Bad LaTeX renders as a red KaTeX error span instead
   * of throwing; if KaTeX is missing altogether the raw formula is shown, escaped.
   */
  function renderMath(item) {
    if (!katex?.renderToString) return escapeHtml(item.display ? `$$${item.tex}$$` : `$${item.tex}$`)
    const tex = item.tex.length > MAX_TEX_LENGTH ? item.tex.slice(0, MAX_TEX_LENGTH) : item.tex
    try {
      return katex.renderToString(tex, {
        output: 'htmlAndMathml',
        displayMode: item.display,
        throwOnError: false,
        trust: false,
        maxExpand: 1000,
      })
    } catch {
      return escapeHtml(item.display ? `$$${tex}$$` : `$${tex}$`)
    }
  }

  // Open links in a new tab, and never hand the opener over.
  if (purifier?.addHook) {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer nofollow')
      }
    })
  }

  /** Parse markdown text into a sanitised HTML string. '' on any failure. */
  function renderMarkdown(source) {
    if (!source) return ''
    if (!markedLib || !purifier) return ''

    const masked = math ? math.maskMath(source) : { text: source, items: [] }

    let html
    try {
      html = markedLib.parse(masked.text, { gfm: true, breaks: true })
    } catch {
      // Malformed markdown should never take the panel down.
      return ''
    }

    try {
      const clean = purifier.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        FORBID_TAGS: ['img', 'style', 'svg', 'math', 'iframe', 'form', 'input'],
        ALLOW_DATA_ATTR: false,
      })
      return math ? math.unmaskMath(clean, masked.items, renderMath) : clean
    } catch {
      return ''
    }
  }

  globalThis.AIMarkdown = { renderMarkdown }
})()

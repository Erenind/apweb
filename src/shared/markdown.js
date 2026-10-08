// Markdown rendering for assistant replies — the reader's `src/lib/markdown.js`,
// ported to globals (`marked` and `DOMPurify` are loaded from `vendor/` by the
// manifest before this file runs).
//
// The output is not fully trusted: the model writes it, but a web page can
// carry instructions that steer the model, so a hostile page could try to
// smuggle HTML into an answer. Everything therefore goes through DOMPurify, and
// images are dropped outright (a remote <img> would leak that you read the
// answer, and would be a tracking pixel the page controls).
(function () {
  'use strict'

  const markedLib = globalThis.marked
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

    let html
    try {
      html = markedLib.parse(source, { gfm: true, breaks: true })
    } catch {
      // Malformed markdown should never take the panel down.
      return ''
    }

    try {
      return purifier.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        FORBID_TAGS: ['img', 'style', 'svg', 'math', 'iframe', 'form', 'input'],
        ALLOW_DATA_ATTR: false,
      })
    } catch {
      return ''
    }
  }

  globalThis.AIMarkdown = { renderMarkdown }
})()

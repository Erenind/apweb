// LaTeX extraction for assistant replies.
//
// Math is lifted out of the markdown *before* it is parsed and put back as
// KaTeX-rendered MathML *after* DOMPurify has run. Two reasons for that order:
// the sanitiser never has to permit MathML tags, and the maths itself is then
// rendered by KaTeX, which escapes its own input (and gates \href / \html* behind
// `trust: false`, which is the default and stays that way).
//
// Pure string work, no DOM, so `test/logic.test.js` can cover the edge cases.
(function () {
  'use strict'

  /** A token marked and DOMPurify both leave alone: plain word characters. */
  function token(index) {
    return `apwebmathtoken${index}`
  }

  // Longest delimiters first, so `$$` is never read as two `$`.
  const DELIMITERS = [
    { open: '$$', close: '$$', display: true },
    { open: '\\[', close: '\\]', display: true },
    { open: '\\(', close: '\\)', display: false },
    { open: '$', close: '$', display: false },
  ]

  // Models rarely stick to `$…$`: they wrap LaTeX in a fenced block tagged
  // `latex`/`math`, or write a bare `\begin{align}`. Both are maths, and treating
  // them as code (or as text) is what made formulas come out unrendered.
  const MATH_FENCE_LANGUAGES = new Set(['math', 'latex', 'tex', 'katex', 'amsmath', 'equation'])
  const MATH_ENVIRONMENTS = new Set([
    'equation', 'equation*', 'align', 'align*', 'aligned', 'gather', 'gather*',
    'multline', 'multline*', 'split', 'cases', 'matrix', 'pmatrix', 'bmatrix',
    'Bmatrix', 'vmatrix', 'Vmatrix', 'array',
  ])

  function isEscaped(text, index) {
    let backslashes = 0
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1
    return backslashes % 2 === 1
  }

  /** The maths starting at `index`, or null when nothing valid starts there. */
  function matchMath(text, index) {
    for (const delimiter of DELIMITERS) {
      if (!text.startsWith(delimiter.open, index)) continue
      if (isEscaped(text, index)) continue

      const from = index + delimiter.open.length
      let close = text.indexOf(delimiter.close, from)
      while (close !== -1 && isEscaped(text, close)) {
        close = text.indexOf(delimiter.close, close + 1)
      }
      if (close === -1) continue

      const tex = text.slice(from, close)
      if (!tex.trim()) continue

      if (!delimiter.display) {
        // Inline `$…$` is the ambiguous one, so it has to look deliberate:
        // no padding whitespace, no line break, no nested `$`. That is what keeps
        // "$5 and $10" or "12$ a piece" from being eaten as maths.
        if (/^\s|\s$/.test(tex)) continue
        if (tex.includes('\n') || tex.includes('$')) continue
      }

      return {
        tex,
        display: delimiter.display,
        start: index,
        end: close + delimiter.close.length,
      }
    }
    return null
  }

  /** A bare `\begin{env}…\end{env}` block, which needs no delimiters. */
  function matchEnvironment(text, index) {
    if (text[index] !== '\\' || isEscaped(text, index)) return null
    const begin = /^\\begin\{([\w*]+)\}/.exec(text.slice(index))
    if (!begin || !MATH_ENVIRONMENTS.has(begin[1])) return null
    const closing = `\\end{${begin[1]}}`
    const end = text.indexOf(closing, index + begin[0].length)
    if (end === -1) return null
    return {
      tex: text.slice(index, end + closing.length),
      display: true,
      start: index,
      end: end + closing.length,
    }
  }

  /**
   * Replace every maths span with an inert token.
   * Returns `{ text, items }`, where each item carries the LaTeX and whether it
   * was display maths.
   */
  function maskMath(source) {
    const text = String(source ?? '')
    const items = []
    let out = ''
    let i = 0

    while (i < text.length) {
      const atLineStart = i === 0 || text[i - 1] === '\n'

      // Fenced code block: everything inside is literal, maths included.
      if (atLineStart && (text[i] === '`' || text[i] === '~')) {
        const fence = /^(`{3,}|~{3,})/.exec(text.slice(i))
        if (fence) {
          const marks = fence[0]
          const found = text.indexOf(`\n${marks}`, i + marks.length)
          const stop = found === -1 ? text.length : found + 1 + marks.length
          // …unless the info string says the block *is* maths.
          const infoEnd = text.indexOf('\n', i + marks.length)
          const info = text.slice(i + marks.length, infoEnd === -1 ? text.length : infoEnd).trim()
          if (MATH_FENCE_LANGUAGES.has(info.toLowerCase())) {
            const body = text
              .slice(infoEnd === -1 ? text.length : infoEnd + 1, found === -1 ? text.length : found)
              .trim()
            if (body) {
              out += token(items.length)
              items.push({ tex: body, display: true, start: i, end: stop })
            } else {
              out += text.slice(i, stop)
            }
            i = stop
            continue
          }
          out += text.slice(i, stop)
          i = stop
          continue
        }
      }

      // Inline code span: also literal.
      if (text[i] === '`') {
        const ticks = /^`+/.exec(text.slice(i))[0]
        const found = text.indexOf(ticks, i + ticks.length)
        const stop = found === -1 ? text.length : found + ticks.length
        out += text.slice(i, stop)
        i = stop
        continue
      }

      const math = matchMath(text, i)
      if (math) {
        out += token(items.length)
        items.push(math)
        i = math.end
        continue
      }

      const environment = matchEnvironment(text, i)
      if (environment) {
        out += token(items.length)
        items.push(environment)
        i = environment.end
        continue
      }

      out += text[i]
      i += 1
    }

    return { text: out, items }
  }

  /** Put rendered maths back where the tokens are. */
  function unmaskMath(html, items, render) {
    let out = html
    for (let index = 0; index < items.length; index += 1) {
      const marker = token(index)
      if (!out.includes(marker)) continue
      // A function replacer: the rendered HTML may contain `$`, which a string
      // replacement would treat as a `$&`-style pattern.
      out = out.replace(marker, () => render(items[index]))
    }
    return out
  }

  globalThis.AIMath = { maskMath, unmaskMath }
})()

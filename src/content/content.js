// Content script: everything that touches the page.
//
// It creates one ShadowRoot that holds the assistant panel and the floating
// "问 AI" pill. The shadow root is what keeps the page's CSS and ours from
// stepping on each other; the panel's own stylesheet is linked from inside it.
//
// Selection handling is the ported "划词即问" feature: when a selection
// settles, either a small button appears next to it (default) or the question
// is sent straight away, exactly like the reader — where selecting a word
// explained it without leaving the page.
(function () {
  'use strict'

  const AICore = globalThis.AICore
  const AIStore = globalThis.AIStore
  const AIPanel = globalThis.AIPanel
  const api = globalThis.browser ?? globalThis.chrome

  // Content scripts can be injected twice (e.g. after an extension reload on an
  // already-open tab); only the first one should build a UI.
  if (globalThis.__apwebContentLoaded) return
  globalThis.__apwebContentLoaded = true

  const HOST_ID = 'apweb-root-host'
  const SETTLE_MS = 300
  const PAGE_TEXT_LIMIT = 6000
  const PARAGRAPH_LIMIT = 2000

  const BLOCK_TAGS = new Set([
    'P', 'LI', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'FIGCAPTION', 'PRE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'ARTICLE', 'SECTION', 'MAIN', 'DIV',
  ])

  let host = null
  let shadow = null
  let panel = null
  let pill = null
  let pillLabel = null
  let selTimer = null
  let pillText = ''
  let pillAction = ''

  /* ------------------------------ shadow host ------------------------------- */

  function buildHost() {
    host = document.createElement('div')
    host.id = HOST_ID
    // `all: initial` keeps inherited page styles (font, color, line-height) from
    // leaking in; the declarations after it re-establish what we need.
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; margin: 0; padding: 0; z-index: 2147483647;'

    shadow = host.attachShadow({ mode: 'open' })

    const reset = document.createElement('style')
    reset.textContent = ':host { all: initial; }'
    shadow.appendChild(reset)

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = api.runtime.getURL('src/content/panel.css')
    shadow.appendChild(link)

    ;(document.documentElement || document.body).appendChild(host)
  }

  /* --------------------------- page text / context --------------------------- */

  function isOurNode(node) {
    if (!node) return false
    try {
      return node.getRootNode?.() === shadow
    } catch {
      return false
    }
  }

  /**
   * True when the event came from inside our shadow root. Events that cross the
   * shadow boundary are retargeted, so `event.target` is the host element and
   * `getRootNode()` can't tell us — the composed path can.
   */
  function isOurEvent(event) {
    const path = event.composedPath?.()
    return Array.isArray(path) && path.includes(host)
  }

  function currentRange() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    if (isOurNode(selection.anchorNode) || isOurNode(selection.focusNode)) return null
    return selection.getRangeAt(0)
  }

  function selectionText() {
    const range = currentRange()
    return range ? range.toString().trim() : ''
  }

  /** Selections inside form fields are almost always about copying, not asking. */
  function isEditable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement
    if (!el?.closest) return false
    return Boolean(el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'))
  }

  function pageText(limit) {
    const body = document.body
    if (!body) return ''
    let text = ''
    try {
      text = body.innerText ?? body.textContent ?? ''
    } catch {
      return ''
    }
    return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, limit ?? PAGE_TEXT_LIMIT)
  }

  /**
   * The block the selection sits in — the web page's answer to the reader's
   * "current page", used to disambiguate a single word. Walks up to the first
   * block that holds at least the selection and is not absurdly long.
   */
  function nearestBlockText(range, selected) {
    let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement
    let last = ''
    const need = Math.max((selected ?? '').length, 1)

    while (el && el !== document.body && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) {
        let text = ''
        try {
          text = (el.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim()
        } catch {
          text = ''
        }
        if (text.length >= need) {
          if (text.length <= PARAGRAPH_LIMIT) return text
          last = text
        }
      }
      el = el.parentElement
    }
    return last.slice(0, PARAGRAPH_LIMIT)
  }

  /** What to attach for `contextMode`. Always returns a label so the chip reads. */
  function describeContext({ mode, selectionText: selected }) {
    if (mode === 'page') {
      return { label: '页面正文', text: pageText() }
    }

    const range = currentRange()
    if (range) {
      const text = nearestBlockText(range, selected)
      if (text) return { label: '选中处那一段', text }
    }
    return { label: '页面正文', text: pageText(PARAGRAPH_LIMIT) }
  }

  /* ---------------------------------- pill ---------------------------------- */

  function buildPill() {
    pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'apweb-pill'
    pill.hidden = true

    const dot = document.createElement('span')
    dot.className = 'apweb-pill__dot'
    pillLabel = document.createElement('span')
    pillLabel.className = 'apweb-pill__label'
    pill.appendChild(dot)
    pill.appendChild(pillLabel)
    // preventDefault keeps the page selection alive: without it the mousedown
    // would collapse the selection before our click handler reads it.
    pill.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    pill.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      hidePill()
      if (pillText) void askSelection(pillText, pillAction)
    })
    panel.el.appendChild(pill)
  }

  function showPill(rect, text, action) {
    const settings = AIStore.state.settings
    pillText = text
    pillAction = action
    const label = AICore.selectionActionLabel(action, settings.selectionPrompts)
    pillLabel.textContent = label
    pill.title = `用 AI 处理选中的文字（${label}）`
    pill.hidden = false

    const width = pill.offsetWidth || 80
    const height = pill.offsetHeight || 28
    let left = rect.left
    let top = rect.bottom + 6
    if (top + height > window.innerHeight - 4) top = Math.max(4, rect.top - height - 6)
    left = Math.min(Math.max(4, left), Math.max(4, window.innerWidth - width - 4))
    pill.style.left = `${left}px`
    pill.style.top = `${top}px`
  }

  function hidePill() {
    if (pill) pill.hidden = true
  }

  /**
   * Ask about a selection. The context is built here, in the page, because only
   * the page can read it; the panel then opens wherever it was last left and
   * answers.
   */
  function askSelection(text, action) {
    if (!panel) return
    const built = panel.buildSelectionContext(text)
    void panel.askSelection({ text, action, context: built.context, contextInfo: built.contextInfo })
  }

  /* ------------------------------ selection flow ----------------------------- */

  function scheduleSelectionCheck() {
    window.clearTimeout(selTimer)
    selTimer = window.setTimeout(handleSelection, SETTLE_MS)
  }

  function handleSelection() {
    if (!panel) return
    const trigger = AIStore.state.settings.selectionTrigger
    if (trigger === 'off') {
      hidePill()
      return
    }

    const range = currentRange()
    const text = range ? range.toString().trim() : ''
    if (!text) {
      hidePill()
      return
    }
    if (isEditable(range.startContainer)) {
      hidePill()
      return
    }

    const action = AIStore.state.settings.selectionAction
    if (trigger === 'auto') {
      hidePill()
      void askSelection(text, action)
      return
    }

    showPill(range.getBoundingClientRect(), text, action)
  }

  function installSelectionListeners() {
    // Capture phase, so a page that stops mouse events can't hide the feature.
    document.addEventListener(
      'mouseup',
      (event) => {
        if (isOurEvent(event)) return
        scheduleSelectionCheck()
      },
      true,
    )
    document.addEventListener(
      'keyup',
      (event) => {
        if (isOurEvent(event)) return
        if (event.shiftKey || event.key?.startsWith('Arrow')) scheduleSelectionCheck()
      },
      true,
    )
    document.addEventListener(
      'mousedown',
      (event) => {
        if (!isOurEvent(event)) hidePill()
      },
      true,
    )
    window.addEventListener('scroll', hidePill, true)
    window.addEventListener('resize', hidePill, true)
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      hidePill()
      // Inside the panel Esc is handled by the panel itself; this covers the case
      // where focus is still on the page.
      if (panel?.isOpen()) panel.setOpen(false)
    })
  }

  /* ---------------------------------- boot ---------------------------------- */

  async function boot() {
    if (!document.documentElement) return
    buildHost()
    await AIStore.load()

    // The panel's open state is per tab (kept by the background), not a global
    // setting: a fresh tab starts closed, while navigating inside a tab keeps
    // whatever you left there.
    let startOpen = false
    try {
      const reply = await api.runtime.sendMessage({ t: 'apweb:panel-state' })
      startOpen = reply?.open === true
    } catch {
      // No background yet: start closed.
    }

    panel = AIPanel.createPanel({
      getSelection: selectionText,
      describeContext,
      pageInfo: () => ({ title: document.title, url: location.href }),
      onClose: () => hidePill(),
      startOpen,
      onOpenChange: (open) => {
        void api.runtime.sendMessage({ t: 'apweb:set-panel-state', open }).catch(() => {})
      },
    })
    panel.el.setAttribute('data-apweb', 'panel')
    shadow.appendChild(panel.el)

    buildPill()
    installSelectionListeners()

    api.runtime.onMessage.addListener((message) => {
      if (message?.t === 'apweb:toggle-panel') {
        panel.toggle()
        if (panel.isOpen()) panel.focusComposer()
      }
    })
  }

  void boot()
})()

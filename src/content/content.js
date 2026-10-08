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
  let launcher = null
  let pageZoom = 1
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
   * the page can read it; then the question goes to whichever surface should
   * answer it — the browser sidebar when it is open, otherwise the in-page panel.
   */
  async function askSelection(text, action) {
    if (!panel) return
    const built = panel.buildSelectionContext(text)
    const payload = {
      text,
      action,
      context: built.context,
      contextInfo: built.contextInfo,
      title: document.title,
      url: location.href,
    }

    try {
      const reply = await api.runtime.sendMessage({ t: 'apweb:selection', payload })
      if (reply?.handled) return
    } catch {
      // No background listener (e.g. the extension is reloading): answer here.
    }
    await panel.askSelection(payload)
  }

  /* -------------------------------- launcher -------------------------------- */

  /**
   * The prominent one-click way into the feature. It sits in the corner of every
   * page so 「划词即问」 can be started without first opening the panel through
   * the toolbar; it stays out of the way while the panel is open, because the
   * panel carries the same toggle in its header.
   */
  function buildLauncher() {
    launcher = document.createElement('button')
    launcher.type = 'button'
    launcher.className = 'apweb-launch'
    launcher.hidden = true

    const glyph = document.createElement('span')
    glyph.className = 'apweb-launch__glyph'
    glyph.textContent = '✦'
    launcher.appendChild(glyph)

    launcher.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    launcher.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!panel) return
      panel.setSelectionAuto(!panel.isSelectionAuto())
      // The toggle now lives inside the settings form, so open it: the click
      // should show the switch it just flipped.
      panel.setOpen(true)
      panel.openSettings()
    })

    panel.el.appendChild(launcher)
  }

  function syncLauncher() {
    if (!launcher || !panel) return
    const settings = AIStore.state.settings
    const on = settings.selectionTrigger === 'auto'
    const visible = settings.showLauncher !== false && !panel.isOpen()
    launcher.hidden = !visible
    // The launcher is chrome, not page content: keep it the same size on screen
    // however far the page is zoomed in.
    launcher.style.transformOrigin = 'bottom right'
    launcher.style.transform = pageZoom === 1 ? '' : `scale(${1 / pageZoom})`
    launcher.classList.toggle('apweb-launch--on', on)
    launcher.title = on
      ? '划词即问已开启：选中文字就直接发给 AI（点击关闭并打开面板）'
      : '启动划词即问：选中文字就直接发给 AI'
  }

  function setPageZoom(zoom) {
    const value = Number(zoom)
    pageZoom = Number.isFinite(value) && value > 0 ? value : 1
    panel?.setPageZoom(pageZoom)
    syncLauncher()
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
      if (event.key === 'Escape') hidePill()
    })
  }

  /* ---------------------------------- boot ---------------------------------- */

  async function boot() {
    if (!document.documentElement) return
    buildHost()
    await AIStore.load()

    panel = AIPanel.createPanel({
      getSelection: selectionText,
      describeContext,
      pageInfo: () => ({ title: document.title, url: location.href }),
      onClose: () => hidePill(),
      // Remembering this is what carries the panel's state across navigation.
      startOpen: AIStore.state.settings.panelOpen,
      onOpenChange: (open) => {
        AIStore.updateSettings({ panelOpen: open })
        syncLauncher()
      },
    })
    panel.el.setAttribute('data-apweb', 'panel')
    shadow.appendChild(panel.el)

    buildPill()
    buildLauncher()
    syncLauncher()
    AIStore.subscribe(() => syncLauncher())
    installSelectionListeners()

    // Register before asking for the zoom, so a toolbar click during that round
    // trip is not dropped.
    api.runtime.onMessage.addListener((message) => {
      if (message?.t === 'apweb:toggle-panel') {
        panel.toggle()
        if (panel.isOpen()) panel.focusComposer()
      } else if (message?.t === 'apweb:zoom') {
        setPageZoom(message.zoom)
      }
    })

    // The panel is drawn by the page, so it has to know the page's zoom to keep a
    // constant on-screen size.
    try {
      const reply = await api.runtime.sendMessage({ t: 'apweb:get-zoom' })
      setPageZoom(reply?.zoom)
    } catch {
      setPageZoom(1)
    }
  }

  void boot()
})()

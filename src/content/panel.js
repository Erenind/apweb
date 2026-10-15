// The assistant panel: conversation, streaming, settings and prompt editors.
//
// This is the reader's `ChatPanel.vue` + `ChatSettingsForm.vue` rewritten as
// plain DOM. It cannot use Vue's runtime compiler: the extension's content
// security policy forbids `eval`, which compiling a template string requires.
// The DOM is therefore built by hand, with references kept on each message so a
// streamed reply only touches its own text node.
(function () {
  'use strict'

  const AICore = globalThis.AICore
  const AIMarkdown = globalThis.AIMarkdown
  const AIStore = globalThis.AIStore
  const i18n = globalThis.AII18n
  const api = globalThis.browser ?? globalThis.chrome

  const PORT_NAME = 'apweb-ai'

  /* --------------------------------- tiny DOM -------------------------------- */

  function h(tag, props, children) {
    const el = document.createElement(tag)
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key]
        if (value === undefined) continue
        if (key === 'class') el.className = value
        else if (key === 'text') el.textContent = value
        else if (key === 'style' && typeof value !== 'string') Object.assign(el.style, value)
        else if (key === 'on') {
          for (const ev of Object.keys(value)) el.addEventListener(ev, value[ev])
        } else if (key === 'value') el.value = value
        else if (key === 'checked') el.checked = Boolean(value)
        else if (key === 'selected') el.selected = Boolean(value)
        else if (key === 'disabled') el.disabled = Boolean(value)
        else if (key === 'hidden') el.hidden = Boolean(value)
        // A false boolean attribute must be *absent*, not `attr="false"`.
        else if (value === false) continue
        else el.setAttribute(key, value === true ? '' : value)
      }
    }
    append(el, children)
    return el
  }

  function append(parent, children) {
    if (children === undefined || children === null || children === false) return
    if (Array.isArray(children)) {
      for (const child of children) append(parent, child)
      return
    }
    parent.appendChild(children instanceof Node ? children : document.createTextNode(String(children)))
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild)
  }

  /** Stop our keystrokes/clicks from reaching the page's own handlers. */
  function isolate(root) {
    for (const type of [
      'keydown', 'keyup', 'keypress',
      'mousedown', 'mouseup', 'click', 'dblclick',
      'pointerdown', 'wheel', 'contextmenu',
    ]) {
      root.addEventListener(type, (event) => event.stopPropagation())
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // Fall through to the textarea trick.
    }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }

  /* ------------------------------ chat transport ----------------------------- */

  /**
   * One streamed completion, over a short-lived port to the background page.
   * A fresh port per request lets the background event page sleep between them.
   */
  function streamOnce(request, onDelta, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }

      const port = api.runtime.connect({ name: PORT_NAME })
      const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
      let settled = false

      const finish = (fn, arg) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        try {
          port.disconnect()
        } catch {
          // already gone
        }
        fn(arg)
      }

      const onAbort = () => {
        try {
          port.postMessage({ t: 'abort', id })
        } catch {
          // port already closed
        }
        // Settle right away rather than waiting for the background to echo the
        // cancellation: disconnecting the port also aborts the request on the
        // other side, so there is nothing left to wait for.
        finish(() => reject(abortError()))
      }

      signal?.addEventListener('abort', onAbort)

      port.onMessage.addListener((message) => {
        if (!message || message.id !== id) return
        if (message.t === 'delta') onDelta(message.kind, message.text)
        else if (message.t === 'done') finish(resolve)
        else if (message.t === 'aborted') finish(() => reject(abortError()))
        else if (message.t === 'error') finish(() => reject(new Error(message.message)))
      })

      port.onDisconnect.addListener(() => {
        if (!settled) finish(() => reject(new Error(i18n.t('connectionLost'))))
      })

      try {
        port.postMessage({ t: 'chat', id, request })
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  function abortError() {
    const error = new Error('aborted')
    error.name = 'AbortError'
    return error
  }

  /* ------------------------------ panel geometry ----------------------------- */

  // Bounds for the floating panel. The stored geometry is clamped against the
  // current window whenever it is restored, so a panel dragged on a big screen
  // cannot come back off-screen on a small one.
  const MIN_PANEL_WIDTH = 300
  const MIN_PANEL_HEIGHT = 240
  const PANEL_MARGIN = 8
  const PANEL_HEAD_KEEP = 60
  /** Must match the height transition on `.apweb-composer__body`. */
  const COMPOSER_ANIM_MS = 200
  /** How long the corner switch has to be held to open the card instead of toggling. */
  const LONG_PRESS_MS = 450

  function clampPanelRect(rect, viewport) {
    const maxWidth = Math.max(MIN_PANEL_WIDTH, viewport.width - PANEL_MARGIN * 2)
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, viewport.height - PANEL_MARGIN * 2)
    const width = Math.min(Math.max(Math.round(rect.width), MIN_PANEL_WIDTH), maxWidth)
    const height = Math.min(Math.max(Math.round(rect.height), MIN_PANEL_HEIGHT), maxHeight)
    const left = Math.min(
      Math.max(PANEL_MARGIN, Math.round(rect.left)),
      Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN),
    )
    const top = Math.min(
      Math.max(PANEL_MARGIN, Math.round(rect.top)),
      Math.max(PANEL_MARGIN, viewport.height - PANEL_HEAD_KEEP),
    )
    return { left, top, width, height }
  }

  /* ------------------------------ corner layout ------------------------------ */

  /** The four points of the star on the corner switch, as one path. */
  const STAR_PATH =
    'M12 2c.7 5.5 4.5 9.3 10 10-5.5.7-9.3 4.5-10 10-.7-5.5-4.5-9.3-10-10 5.5-.7 9.3-4.5 10-10z'
  const CROSS_PATH = 'M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5'

  /**
   * A 24×24 icon, built node by node. An `innerHTML` string would be shorter, but
   * the content scripts run under a CSP without `eval`, and building the shape
   * here keeps the icon — and its `currentColor` — in one place instead of in a
   * string that has to be parsed.
   */
  function svgIcon(d, stroke) {
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', d)
    if (stroke) {
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '2')
      path.setAttribute('stroke-linecap', 'round')
    } else {
      path.setAttribute('fill', 'currentColor')
    }
    svg.appendChild(path)
    return svg
  }

  /**
   * Which layout to build. Android — where a floating window has no room to be
   * dragged and the bottom corner is the one thumb-reachable spot — gets the
   * bottom layout: the card on the left, the round controls on the right. Every
   * other platform keeps the movable panel.
   *
   * `platform` is what `runtime.getPlatformInfo()` answered, when the caller could
   * ask. The user agent and the pointer media query cover the rest, so a touch-only
   * device that will not answer still gets the layout it can use.
   */
  function isMobileLayout(platform) {
    if (typeof platform?.os === 'string') return platform.os === 'android'
    const ua = globalThis.navigator?.userAgent ?? ''
    if (/Android/i.test(ua)) return true
    try {
      return globalThis.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches === true
    } catch {
      return false
    }
  }

  /* --------------------------------- the panel ------------------------------- */

  function createPanel(options) {
    const opts = options ?? {}
    const embed = Boolean(opts.embed)
    // Android decides two things: the card layout on the page, and which settings
    // the form offers — the Android-only ones live on the settings page, which is
    // an embedded panel and so keeps the desktop arrangement around them.
    const platformMobile = isMobileLayout(opts.platform)
    const android = opts.android ?? opts.mobile ?? platformMobile
    const mobile = !embed && (opts.mobile ?? platformMobile)
    const getSelection = opts.getSelection ?? (() => '')
    const describeContext = opts.describeContext ?? (() => null)
    const pageInfo = opts.pageInfo ?? (() => ({ title: document.title, url: location.href }))

    const S = () => AIStore.state.settings
    const messages = () => AIStore.state.messages

    let open = Boolean(opts.startOpen)
    let showSettings = Boolean(opts.startWithSettings)
    let draftText = ''
    let streaming = false
    let failureText = ''
    let contextInfo = ''
    let controller = null
    let currentRun = 0
    let scrollTimer = null
    let frame = 0
    // The prompt editors start folded away; the state is remembered so a
    // settings re-render (switching a prompt, adding one…) doesn't slam it shut.
    let promptsOpen = false
    // Last fold state applied to the composer, so repeated store updates do not
    // restart the animation.
    let composerApplied = null
    let composerAnimTimer = null
    const refs = {}

    /* -------------------------------- structure ------------------------------- */

    const scope = h('div', {
      class: `apweb-scope${embed ? ' apweb-scope--embed' : ''}${mobile ? ' apweb-scope--mobile' : ''}`,
    })

    refs.model = h('span', { class: 'apweb-title__model' })
    refs.dot = h('span', { class: 'apweb-dot' })
    refs.clearBtn = h('button', {
      type: 'button',
      title: i18n.t('clearChat'),
      text: i18n.t('clear'),
      on: { click: () => clearChat() },
    })
    refs.settingsBtn = h('button', {
      type: 'button',
      title: i18n.t('settings'),
      text: '⚙',
      on: { click: () => setShowSettings(!showSettings) },
    })
    const closeBtn = h('button', {
      type: 'button',
      title: i18n.t('collapse'),
      text: '✕',
      on: { click: () => setOpen(false) },
    })

    const head = h('header', { class: 'apweb-panel__head' }, [
      h('div', { class: 'apweb-title' }, [refs.dot, h('strong', { text: i18n.t('assistant') }), refs.model]),
      h('div', { class: 'apweb-head-actions' }, [
        refs.settingsBtn,
        refs.clearBtn,
        // On Android the card is closed with the round button in the corner, so
        // the header holds no second ✕.
        embed || opts.hideClose || mobile ? null : closeBtn,
      ]),
    ])

    refs.settingsEl = h('div', { class: 'apweb-settings', hidden: true })
    refs.msgs = h('div', { class: 'apweb-msgs' })
    refs.failure = h('p', { class: 'apweb-failure', hidden: true })

    refs.input = h('textarea', {
      rows: 2,
      placeholder: i18n.t('composerPlaceholder'),
      on: {
        input: () => {
          draftText = refs.input.value
        },
        keydown: (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
          event.preventDefault()
          void send()
        },
      },
    })
    refs.sendBtn = h('button', {
      type: 'button',
      class: 'apweb-send',
      text: i18n.t('send'),
      on: { click: () => void send() },
    })
    refs.stopBtn = h('button', {
      type: 'button',
      class: 'apweb-stop',
      text: i18n.t('stop'),
      hidden: true,
      on: { click: () => stop() },
    })

    // The composer folds away: reading a long answer should not be cramped by an
    // input box nobody is typing in. The fold state is remembered.
    // The fold arrow floats just outside the composer's top-left corner; the
    // padding lives on an inner row so a body height of 0 really means 0.
    refs.composerToggle = h('button', {
      type: 'button',
      class: 'apweb-composer__toggle',
      'data-field': 'composer-toggle',
      title: i18n.t('foldComposer'),
      on: { click: () => setComposerOpen(!isComposerOpen()) },
    }, [h('span', { class: 'apweb-composer__chevron' })])
    refs.composerBody = h('div', { class: 'apweb-composer__body' }, [
      h('div', { class: 'apweb-composer__inner' }, [refs.input, refs.stopBtn, refs.sendBtn]),
    ])
    refs.composer = h('div', { class: 'apweb-composer' }, [refs.composerToggle, refs.composerBody])
    const composer = refs.composer

    refs.panel = h('section', { class: 'apweb-panel' }, [
      // The Android card is only the conversation and the composer: no title bar,
      // no settings/clear/close buttons — its controls are the two in the corner,
      // and the settings live on their own page.
      mobile ? null : head,
      refs.settingsEl,
      refs.msgs,
      refs.failure,
      composer,
    ])
    if (!open) refs.panel.hidden = true

    scope.appendChild(refs.panel)

    // The Android corner controls: a round switch that turns 划词即问 on and off,
    // and — while the card is open — a round close button above it. Since the card
    // has no title bar, holding the switch is what brings it back.
    if (mobile) {
      let pressTimer = null
      let longPressed = false

      const endPress = () => {
        window.clearTimeout(pressTimer)
        pressTimer = null
      }

      refs.switchBtn = h('button', {
        type: 'button',
        class: 'apweb-fab apweb-fab--switch',
        'data-field': 'selection-switch',
        on: {
          click: () => {
            // A hold opens the card; the click that follows it must not also
            // toggle the switch.
            if (longPressed) {
              longPressed = false
              return
            }
            toggleSelectionAuto()
          },
        },
      }, [svgIcon(STAR_PATH)])
      refs.switchBtn.addEventListener('pointerdown', () => {
        longPressed = false
        endPress()
        pressTimer = window.setTimeout(() => {
          pressTimer = null
          longPressed = true
          setOpen(true)
        }, LONG_PRESS_MS)
      })
      // Releasing, sliding off the button or the browser cancelling the gesture all
      // mean "not a hold".
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
        refs.switchBtn.addEventListener(type, endPress)
      }

      refs.closeFab = h('button', {
        type: 'button',
        class: 'apweb-fab apweb-fab--close',
        'data-field': 'close-panel',
        title: i18n.t('closePanel'),
        on: { click: () => setOpen(false) },
      }, [svgIcon(CROSS_PATH, true)])
      // The column order is what puts the close button above the switch.
      refs.dock = h('div', { class: 'apweb-dock' }, [refs.closeFab, refs.switchBtn])
      scope.appendChild(refs.dock)
    }

    isolate(scope)
    // Esc hides the panel. The listener has to sit on the scope: the panel stops
    // key events from reaching the page, so a page-level listener would never see
    // Esc pressed while the composer has focus.
    scope.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !open) return
      event.preventDefault()
      setOpen(false)
    })

    if (!embed && !mobile) {
      // A grip of our own instead of CSS `resize`: it is visible, it cannot be
      // confused with the browser's corner resizer, and — because we own the
      // drag — the size is saved exactly when the user finishes resizing.
      refs.resizeHandle = h('div', {
        class: 'apweb-resize-handle',
        title: i18n.t('resizePanel'),
        'data-field': 'resize-handle',
      })
      refs.panel.appendChild(refs.resizeHandle)
      enableDrag(head, refs.panel)
      enableResize(refs.resizeHandle, refs.panel)
      applyStoredRect()
    }
    // The Android card is anchored to the bottom corner instead: no grip, nothing
    // to drag, and the stylesheet owns where it sits.

    /* --------------------------------- helpers -------------------------------- */

    function setOpen(next) {
      open = Boolean(next)
      refs.panel.hidden = !open
      // The corner close button belongs to the card: no card, no close button.
      syncLauncher()
      opts.onOpenChange?.(open)
      if (open) {
        syncHeader()
        if (showSettings) renderSettings()
        scrollToBottom(true)
        // Android: never grab the input when the card appears. Selecting a word is
        // what opens it there, and focusing would throw the on-screen keyboard over
        // the answer before it has even streamed. Tapping the field still opens the
        // keyboard, because that is the browser's own focus, not ours.
        if (!embed && !mobile) refs.input.focus({ preventScroll: true })
      } else {
        opts.onClose?.()
      }
    }

    function setShowSettings(next) {
      showSettings = Boolean(next)
      refs.settingsEl.hidden = !showSettings
      if (showSettings) renderSettings()
      else {
        // These controls live inside the form; drop the refs along with it.
        refs.modeBtn = null
        refs.modeHint = null
        refs.triggerSelect = null
        refs.actionSelect = null
        refs.actionHint = null
        refs.keyInput = null
        refs.keyHint = null
        refs.temperatureRow = null
        refs.temperatureInput = null
        refs.temperatureNote = null
        refs.cardHeightInput = null
        refs.sentRow = null
      }
      syncComposer()
    }

    function toggle() {
      setOpen(!open)
    }

    function viewport() {
      return { width: window.innerWidth, height: window.innerHeight }
    }

    /** Restore the panel where and at the size the user last left it. */
    function applyStoredRect() {
      const stored = S().panelRect
      if (!stored) return
      const rect = clampPanelRect(stored, viewport())
      refs.panel.style.left = `${rect.left}px`
      refs.panel.style.top = `${rect.top}px`
      refs.panel.style.right = 'auto'
      refs.panel.style.width = `${rect.width}px`
      refs.panel.style.height = `${rect.height}px`
    }

    /** Where the panel is right now, in viewport pixels. */
    function currentRect() {
      const rect = refs.panel.getBoundingClientRect()
      return clampPanelRect(
        { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        viewport(),
      )
    }

    function saveRect() {
      update({ panelRect: currentRect() })
    }

    /**
     * Drag the bottom-right grip to resize. Like the header drag, the move/up
     * listeners sit on `window` in the capture phase: the panel stops pointer
     * events from reaching the page, so a bubble-phase listener would never see
     * the release.
     */
    function enableResize(handle, panel) {
      let resizing = false
      let pointerId = null
      let startX = 0
      let startY = 0
      let startWidth = 0
      let startHeight = 0

      const onMove = (event) => {
        if (!resizing) return
        if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) return
        const size = clampPanelRect(
          {
            left: 0,
            top: 0,
            width: startWidth + (event.clientX - startX),
            height: startHeight + (event.clientY - startY),
          },
          viewport(),
        )
        panel.style.width = `${size.width}px`
        panel.style.height = `${size.height}px`
      }

      const endResize = (event) => {
        if (!resizing) return
        if (event && pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) {
          return
        }
        const id = pointerId
        resizing = false
        pointerId = null
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', endResize, true)
        window.removeEventListener('pointercancel', endResize, true)
        window.removeEventListener('blur', endResize, true)
        try {
          if (id !== null) handle.releasePointerCapture?.(id)
        } catch {
          // already released
        }
        saveRect()
      }

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        const rect = panel.getBoundingClientRect()
        resizing = true
        pointerId = event.pointerId ?? null
        startX = event.clientX
        startY = event.clientY
        startWidth = rect.width
        startHeight = rect.height
        event.preventDefault()
        event.stopPropagation()
        try {
          if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId)
        } catch {
          // capture is optional; the window listeners keep the resize alive
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', endResize, true)
        window.addEventListener('pointercancel', endResize, true)
        window.addEventListener('blur', endResize, true)
      })
    }

    function syncHeader() {
      const model = S().model
      refs.model.textContent = model || ''
      refs.dot.classList.toggle('apweb-dot--live', streaming)
    }

    /* ---------------------------- ask on select ------------------------------- */

    /** 选中即发送 is the 'auto' trigger; 'click' selects first and asks on a tap. */
    const isSelectionAuto = () => S().selectionTrigger === 'auto'

    /**
     * The one control behind both the Android corner switch and the settings form's
     * ✦ button: on = 选中即发送, off = 选中后先弹出按钮。「完全关闭」 is reachable
     * only from the select below them and reads as off here — so the two buttons can
     * never claim different things about the same setting, which is what made them
     * look out of sync.
     */
    function setSelectionAuto(on) {
      update({ selectionTrigger: on ? 'auto' : 'click' })
      syncLauncher()
    }

    const toggleSelectionAuto = () => setSelectionAuto(!isSelectionAuto())

    /**
     * Android: the two things the card's own settings change. Both are handed to
     * the stylesheet — the height as a custom property (so the viewport cap next to
     * it stays CSS's business) and "answers only" as a class, which reflows the
     * transcript instead of rebuilding it.
     */
    function syncCardOptions() {
      if (!mobile) return
      scope.style.setProperty('--ap-card-max', `${S().panelMaxHeight}px`)
      refs.panel.classList.toggle('apweb-panel--answers-only', S().showSentContent === false)
    }

    /** Keep the corner controls in step with the setting, whoever changed it. */
    function syncLauncher() {
      if (!refs.switchBtn) return
      const auto = isSelectionAuto()
      refs.switchBtn.classList.toggle('apweb-fab--on', auto)
      refs.switchBtn.setAttribute('aria-pressed', String(auto))
      const label = auto
        ? i18n.t('switchAuto')
        : S().selectionTrigger === 'off'
          ? i18n.t('switchFullyOff')
          : i18n.t('switchClick')
      refs.switchBtn.title = label
      refs.switchBtn.setAttribute('aria-label', label)
      refs.closeFab.hidden = !open
    }

    /**
     * Refresh the prominent toggle inside the settings form, if that form is
     * currently on screen. It is the settings-page twin of the Android corner
     * switch — same setting, same two meanings — so whichever one you press, the
     * other agrees. The select just below still knows the third state, 完全关闭.
     */
    function refreshModeControl() {
      const btn = refs.modeBtn
      if (!btn) return
      const auto = isSelectionAuto()
      btn.classList.toggle('apweb-mode__btn--on', auto)
      btn.textContent = auto ? i18n.t('modeOn') : i18n.t('modeOff')
      btn.title = auto ? i18n.t('modeOnTitle') : i18n.t('modeOffTitle')
      if (refs.modeHint) {
        refs.modeHint.textContent = auto
          ? i18n.t('modeHintOn')
          : S().selectionTrigger === 'off'
            ? i18n.t('modeHintOffWhenDisabled')
            : i18n.t('modeHintOff')
      }
    }

    /**
     * Keep the two 划词 selects in step with the settings no matter who changed
     * them. The prominent toggle at the top of the form edits the same
     * `selectionTrigger` as the first select, so clicking it has to move that
     * select too — otherwise the form below only catches up when it happens to be
     * rebuilt, which reads as two controls disagreeing. Refreshing the values in
     * place (instead of re-rendering) also keeps focus in the text fields.
     */
    function refreshSelectionFields() {
      const settings = S()
      const trigger = settings.selectionTrigger

      if (refs.triggerSelect && refs.triggerSelect.value !== trigger) {
        refs.triggerSelect.value = trigger
      }

      if (refs.actionSelect) {
        const action = AICore.findPrompt(settings.selectionPrompts, settings.selectionAction)?.id ?? ''
        if (refs.actionSelect.value !== action) refs.actionSelect.value = action
        // Nothing to pick while 划词提问 is off; a live-looking control that does
        // nothing is exactly what confuses people.
        refs.actionSelect.disabled = trigger === 'off'
      }

      if (refs.actionHint) {
        refs.actionHint.textContent =
          trigger === 'off'
            ? i18n.t('purposeHintOff')
            : i18n.t('purposeHintOn')
      }
    }

    function syncComposer() {
      refs.sendBtn.hidden = streaming
      refs.stopBtn.hidden = !streaming
      refs.sendBtn.disabled = !canSend()
      // Only touch the field when it actually differs: assigning the same string
      // back to a focused <textarea> would jump the caret to the end.
      if (refs.input.value !== draftText) refs.input.value = draftText
      refs.input.disabled = !S().apiKey && showSettings

      const open = isComposerOpen()
      // Only touch the fold when the state actually changed: otherwise a store
      // update mid-animation would snap the height and kill the transition.
      if (open !== composerApplied) {
        const animate = composerApplied !== null
        composerApplied = open
        applyComposer(open, animate)
      }
    }

    const isComposerOpen = () => S().composerOpen !== false

    /**
     * Fold or unfold the composer.
     *
     * `height: auto` cannot be interpolated, so the animation is driven with an
     * explicit pixel height: measure the natural height, animate to it (or to 0),
     * then hand the height back to `auto` once the transition is over so the row
     * can still grow with its content.
     */
    function applyComposer(open, animate) {
      refs.composer.classList.toggle('apweb-composer--collapsed', !open)
      refs.composerToggle.title = open ? i18n.t('foldComposer') : i18n.t('unfoldComposer')
      refs.composerToggle.setAttribute('aria-expanded', String(open))
      // A clipped input must not stay in the tab order.
      for (const el of [refs.input, refs.sendBtn, refs.stopBtn]) {
        el.tabIndex = open ? 0 : -1
      }

      window.clearTimeout(composerAnimTimer)
      composerAnimTimer = null

      if (!animate) {
        refs.composerBody.style.height = open ? '' : '0px'
        return
      }

      const body = refs.composerBody
      const from = Math.round(body.getBoundingClientRect().height)
      body.style.height = `${from}px`
      // Flush layout so the browser animates from the height we just pinned.
      void body.offsetHeight

      if (!open) {
        body.style.height = '0px'
        return
      }

      body.style.height = `${body.scrollHeight}px`
      composerAnimTimer = window.setTimeout(() => {
        composerAnimTimer = null
        body.style.height = ''
      }, COMPOSER_ANIM_MS)
    }

    function setComposerOpen(open) {
      update({ composerOpen: open })
      if (open && !embed) refs.input.focus({ preventScroll: true })
    }

    function canSend() {
      const settings = S()
      return Boolean(settings.baseUrl && settings.model) && !streaming
    }

    /** Ready to ask. Local endpoints (Ollama) legitimately have no key. */
    function ready() {
      const settings = S()
      if (!settings.baseUrl || !settings.model) return false
      if (!settings.apiKey && settings.providerId !== 'ollama') return false
      return true
    }

    function setFailure(text) {
      failureText = text || ''
      refs.failure.textContent = failureText
      refs.failure.hidden = !failureText
    }

    function scrollToBottom(immediate) {
      window.clearTimeout(scrollTimer)
      const run = () => {
        refs.msgs.scrollTop = refs.msgs.scrollHeight
      }
      if (immediate) run()
      else scrollTimer = window.setTimeout(run, 30)
    }

    function scheduleUpdate(message) {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateMessageNode(message)
        scrollToBottom(false)
      })
    }

    /* --------------------------------- render --------------------------------- */

    function renderMessages() {
      clear(refs.msgs)
      if (!messages().length) {
        refs.msgs.appendChild(
          h('p', {
            class: 'apweb-hint',
            text: i18n.t('emptyHint'),
          }),
        )
        return
      }
      for (const message of messages()) refs.msgs.appendChild(buildMessageNode(message))
      scrollToBottom(true)
    }

    function buildMessageNode(message) {
      const meta = h('div', { class: 'apweb-msg__meta' }, [
        h('span', { text: message.role === 'user' ? i18n.t('you') : 'AI' }),
        message.context ? h('span', { class: 'apweb-msg__context', text: i18n.t('contextLabel', { context: message.context }) }) : null,
      ])

      if (message.role === 'assistant' && message.content) {
        meta.appendChild(
          h('button', {
            type: 'button',
            class: 'apweb-msg__copy',
            text: i18n.t('copy'),
            on: {
              click: async () => {
                const ok = await copyText(message.content)
                if (!ok) setFailure(i18n.t('copyFailed'))
              },
            },
          }),
        )
      }

      const thinking = h('details', { class: 'apweb-thinking', hidden: !message.reasoning }, [
        h('summary'),
        h('p'),
      ])

      const body = h('div', { class: 'apweb-msg__body' })

      const node = h(
        'div',
        { class: `apweb-msg apweb-msg--${message.role === 'user' ? 'user' : 'assistant'}` },
        [meta, thinking, body],
      )

      message._el = node
      message._body = body
      message._thinking = thinking
      message._thinkingP = thinking.querySelector('p')
      updateMessageNode(message)
      return node
    }

    function updateMessageNode(message) {
      const body = message._body
      if (!body) return

      if (message.role === 'assistant') {
        body.classList.add('apweb-msg__body--md')
        const html = AIMarkdown.renderMarkdown(message.content)
        // `renderMarkdown` sanitises; if the renderer is unavailable fall back to
        // plain text so nothing unsanitised is ever injected.
        if (html) body.innerHTML = html
        else body.textContent = message.content || '…'
      } else {
        body.classList.remove('apweb-msg__body--md')
        body.textContent = message.content || '…'
      }

      if (message._thinking) {
        const reasoning = message.reasoning ?? ''
        message._thinking.hidden = !reasoning
        if (reasoning) {
          message._thinking.querySelector('summary').textContent = i18n.t('thinking', { count: reasoning.length })
          message._thinkingP.textContent = reasoning
        }
      }
    }

    /* ---------------------------------- turns --------------------------------- */

    const composerPromptText = () => AICore.findPrompt(S().composerPrompts, S().composerPromptId)?.text ?? ''

    /**
     * The context a selection turn would attach, as a ready-made payload.
     * Exposed so the content script can decide whether a short selection gets
     * context before the panel opens.
     */
    function buildSelectionContext(text) {
      const settings = S()
      // A word or two is ambiguous on its own, so send its surroundings along —
      // only for those, and only if page text is wanted at all.
      if (!settings.includePageText) return { context: '', contextInfo: '' }
      if (text.length >= AICore.SHORT_SELECTION_LENGTH) return { context: '', contextInfo: '' }

      const described = describeContext({ mode: settings.contextMode, selectionText: text })
      if (!described?.text) return { context: '', contextInfo: '' }

      const { title, url } = pageInfo()
      const source = url
          ? i18n.t('contextSource', { title: title || i18n.t('currentPage'), url })
          : i18n.t('contextSourceNoUrl', { title: title || i18n.t('currentPage') })
      const context =
        `${i18n.t('contextPreamble')}\n` +
        `${source}${described.label}：\n"""\n${described.text}\n"""`
      return { context, contextInfo: described.label }
    }

    async function buildContext({ includeSelection = true, includePage = S().includePageText, selectionText = '' } = {}) {
      const settings = S()
      const parts = []
      const info = []

      const highlight = includeSelection ? getSelection().trim() : ''
      if (highlight) {
        parts.push(`${i18n.t('selectedTextPreamble')}\n"""\n${highlight}\n"""`)
        info.push(i18n.t('selectedChip'))
      }

      if (includePage) {
        const described = describeContext({
          mode: settings.contextMode,
          selectionText: highlight || selectionText,
        })
        if (described?.text) {
          const { title, url } = pageInfo()
          const source = url
          ? i18n.t('contextSource', { title: title || i18n.t('currentPage'), url })
          : i18n.t('contextSourceNoUrl', { title: title || i18n.t('currentPage') })
          parts.push(
            `${i18n.t('contextPreamble')}\n` +
              `${source}${described.label}：\n"""\n${described.text}\n"""`,
          )
          info.push(described.label)
        }
      }

      contextInfo = info.filter(Boolean).join(' + ')
      return parts.join('\n\n')
    }

    /**
     * Run one user/assistant exchange. A turn that arrives while another is
     * streaming interrupts it, which is what "I selected something else, answer
     * this instead" should feel like.
     */
    async function runTurn({ userText, promptText, modelText, context, action }) {
      if (controller) controller.abort()
      const runId = ++currentRun

      setFailure('')
      const user = { role: 'user', content: userText, context: contextInfo }
      // What actually goes to the model, when it differs from what we display.
      if (modelText) user.forModel = modelText
      // Which 划词用途 asked for this turn, so history can be filtered by mode.
      if (action) user.action = action
      AIStore.pushMessage(user)
      const reply = { role: 'assistant', content: '' }
      AIStore.pushMessage(reply)
      renderMessages()

      const payload = [{ role: 'system', content: promptText ?? '' }]
      // The page reference goes *above* the turn it belongs to, so the ask that
      // follows cannot be misread as applying to it.
      if (context) payload.push({ role: 'system', content: context })
      payload.push(...historyFor(action))

      streaming = true
      const localController = new AbortController()
      controller = localController
      syncComposer()
      syncHeader()

      try {
        const settings = S()
        const request = {
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          model: settings.model,
          // Undefined for models that only accept one temperature, so the field
          // is left out of the request instead of being a 400.
          temperature: AICore.effectiveTemperature(settings),
          messages: payload,
          settings,
        }
        const onDelta = (kind, text) => {
          if (kind === 'reasoning') reply.reasoning = (reply.reasoning ?? '') + text
          else reply.content += text
          scheduleUpdate(reply)
        }

        try {
          await streamOnce(request, onDelta, localController.signal)
        } catch (error) {
          // An endpoint that will not take a temperature says so in the error;
          // no table can know every relay's models, so notice it, remember it for
          // this endpoint+model and retry once without the field. Safe to retry:
          // a rejected request never streamed anything.
          const retryable =
            request.temperature !== undefined &&
            !localController.signal.aborted &&
            AICore.isTemperatureRejection(error?.message)
          if (!retryable) throw error
          update({
            temperatureOffSlots: { ...S().temperatureOffSlots, [AICore.pairSlot(settings)]: true },
          })
          await streamOnce({ ...request, temperature: undefined }, onDelta, localController.signal)
        }
        if (!reply.content) {
          reply.content = reply.reasoning ? i18n.t('onlyThinking') : i18n.t('noContent')
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (!reply.content) reply.content = i18n.t('stopped')
        } else {
          setFailure(error?.message ?? String(error))
          if (!reply.content) {
            AIStore.popMessage()
            renderMessages()
          }
        }
      } finally {
        // An interrupted run must not clear the state of the run that replaced it.
        if (runId === currentRun) {
          streaming = false
          controller = null
          syncComposer()
          syncHeader()
        }
        AIStore.touchMessages()
        scheduleUpdate(reply)
      }
    }

    /**
     * The earlier turns to send as context, newest last.
     *
     * A selection turn records which 划词用途 asked it. Once you switch modes those
     * answers are worse than useless: they are a run of examples that contradict
     * the new instruction, and the model happily keeps following them ("switched to
     * 只解释 and it still explains *and* translates"). So turns asked in another
     * mode are dropped, together with their answers, while turns with no mode (the
     * composer) and turns in the current mode stay. Earlier turns are sent without
     * their context blobs, otherwise every follow-up would repeat the whole page;
     * `forModel` carries the framed version of a turn (the transcript shows the
     * short one).
     */
    function historyFor(action) {
      // Drop the empty reply this turn just pushed.
      const list = messages().slice(0, -1)
      const kept = []
      for (let i = 0; i < list.length; i++) {
        const message = list[i]
        if (message.role === 'user' && action && message.action && message.action !== action) {
          // Skip the question and the answer that went with it.
          if (list[i + 1]?.role === 'assistant') i += 1
          continue
        }
        kept.push(message)
      }
      return kept
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.forModel ?? message.content }))
    }

    async function send() {
      const text = draftText.trim()
      if (!text || !canSend()) return
      draftText = ''
      refs.input.value = ''
      const context = await buildContext()
      await runTurn({ userText: text, promptText: composerPromptText(), context })
    }

    /**
     * Triggered by the page when a selection finishes (pill click or auto-send).
     * `selection` is `{ text, action }`.
     */
    async function askSelection(selection) {
      const text = (selection?.text ?? '').trim()
      if (!text) return
      setOpen(true)
      if (!ready()) {
        // Nothing to send with — surface the settings instead of failing mutely.
        // On Android they are their own page, and the card must not hold a form, so
        // it says where to go instead.
        if (android) setFailure(i18n.t('needKey'))
        else setShowSettings(true)
        return
      }

      // Answering the same snippet twice in a row is never what the user meant —
      // but if they asked something else in between, selecting it again is fair.
      const lastUser = [...messages()].reverse().find((message) => message.role === 'user')
      if (lastUser?.content?.trim() === text) return

      const settings = S()
      const action = selection.action ?? settings.selectionAction
      const ask = AICore.findPrompt(settings.selectionPrompts, action)?.text ?? ''
      // The content script has the page and passes the context in; when the call
      // comes from the panel's own composer, build it from this document.
      const prebuilt =
        typeof selection.context === 'string' && selection.contextInfo !== undefined
      const built = prebuilt
        ? { context: selection.context, contextInfo: selection.contextInfo }
        : buildSelectionContext(text)
      const context = built.context
      // The chip should describe what was actually attached.
      contextInfo = [
        AICore.selectionActionLabel(action, settings.selectionPrompts),
        context ? built.contextInfo : '',
      ]
        .filter(Boolean)
        .join(' · ')

      await runTurn({
        userText: text,
        // Selecting text uses the selection library, not the composer one.
        promptText: ask,
        // The transcript shows just the snippet; the model gets the guarded quote.
        modelText: AICore.selectionTurnText(text),
        context,
        action,
      })
    }

    function stop() {
      controller?.abort()
    }

    function clearChat() {
      if (controller) controller.abort()
      AIStore.clearMessages()
      setFailure('')
      renderMessages()
    }

    /* ---------------------------- settings form ------------------------------- */

    function update(patch) {
      AIStore.updateSettings(patch)
    }

    function field(labelText, control, hint) {
      return h('label', { class: 'apweb-field' }, [
        h('span', { text: labelText }),
        control,
        hint ?? null,
      ])
    }

    function selectControl(options, value, onChange, attrs) {
      const el = h(
        'select',
        Object.assign({ on: { change: (event) => onChange(event.target.value) } }, attrs ?? {}),
        options.map((option) => h('option', { value: option.value, text: option.label, selected: option.value === value })),
      )
      el.value = value
      return el
    }

    function textControl(value, onChange, attrs) {
      return h(
        'input',
        Object.assign(
          {
            type: 'text',
            value,
            spellcheck: 'false',
            on: { input: (event) => onChange(event.target.value) },
          },
          attrs ?? {},
        ),
      )
    }

    function renderSettings() {
      const settings = S()
      const provider = AICore.providerById(settings.providerId)
      const isCustom = provider.id === 'custom'
      const thinking = AICore.thinkingInfo(settings)

      clear(refs.settingsEl)
      refs.settingsEl.hidden = false

      // The prominent 「划词即问」 control lives here, in the AI settings, so the
      // panel body itself stays free of permanent chrome.
      refs.modeBtn = h('button', {
        type: 'button',
        class: 'apweb-mode__btn',
        'data-field': 'selection-toggle',
        on: { click: () => toggleSelectionAuto() },
      })
      refs.modeHint = h('span', { class: 'apweb-mode__hint' })
      refs.settingsEl.appendChild(h('div', { class: 'apweb-mode' }, [refs.modeBtn, refs.modeHint]))
      refreshModeControl()

      // Provider ---------------------------------------------------------------
      refs.settingsEl.appendChild(
        field(
          i18n.t('provider'),
          selectControl(
            AICore.PROVIDERS.map((item) => ({ value: item.id, label: item.label })),
            settings.providerId,
            (id) => {
              const next = AICore.providerById(id)
              // 自定义 has no preset to fall back on, so it restores its own last
              // endpoint. Carrying the previous provider's address over would also
              // carry its key, since a key belongs to an endpoint+model pair.
              update(
                next.id === 'custom'
                  ? {
                      providerId: 'custom',
                      baseUrl: S().customBaseUrl,
                      model: S().customModel,
                    }
                  : { providerId: next.id, baseUrl: next.baseUrl, model: next.model },
              )
              renderSettings()
            },
            { 'data-field': 'provider' },
          ),
        ),
      )

      // Endpoint (custom only) -------------------------------------------------
      if (isCustom) {
        refs.settingsEl.appendChild(
          field(
            i18n.t('endpoint'),
            textControl(settings.baseUrl, (value) => {
              // Remember 自定义's own address as it is typed, so switching away and
              // back does not start from a blank field.
              update(
                S().providerId === 'custom'
                  ? { baseUrl: value, customBaseUrl: value }
                  : { baseUrl: value },
              )
              refreshKeyFields()
              syncComposer()
            }, { type: 'url', placeholder: 'https://api.example.com/v1', 'data-field': 'base-url' }),
            settings.baseUrl ? null : h('span', { class: 'apweb-warn-inline', text: i18n.t('endpointRequired') }),
          ),
        )
      }

      // Model ------------------------------------------------------------------
      const listId = 'apweb-model-suggestions'
      const modelInput = textControl(settings.model, (value) => {
        update(
          S().providerId === 'custom' ? { model: value, customModel: value } : { model: value },
        )
        refreshKeyFields()
        refreshThinking()
        syncComposer()
        syncHeader()
      }, { placeholder: provider.model || 'model-name', 'data-field': 'model', list: listId })
      if (isCustom) modelInput.removeAttribute('list')
      refs.settingsEl.appendChild(
        h('label', { class: 'apweb-field' }, [
          h('span', { text: i18n.t('modelLabel') }),
          modelInput,
          h(
            'datalist',
            { id: listId },
            (provider.models ?? []).map((name) => h('option', { value: name })),
          ),
        ]),
      )

      // API key ----------------------------------------------------------------
      refs.keyHint = h('span', {
        class: 'apweb-hint-inline',
        text: i18n.t('keyHint', { provider: provider.label, model: settings.model || i18n.t('modelPlaceholder') }),
      })
      refs.settingsEl.appendChild(
        field(
          'API Key',
          (refs.keyInput = h('input', {
            type: 'password',
            value: settings.apiKey,
            spellcheck: 'false',
            autocomplete: 'off',
            placeholder: 'sk-...',
            'data-field': 'api-key',
            on: { input: (event) => update({ apiKey: event.target.value }) },
          })),
          refs.keyHint,
        ),
      )

      // Context ----------------------------------------------------------------
      refs.settingsEl.appendChild(
        h('label', { class: 'apweb-check' }, [
          h('input', {
            class: 'apweb-switch',
            type: 'checkbox',
            checked: settings.includePageText,
            'data-field': 'include-page-text',
            on: { change: (event) => update({ includePageText: event.target.checked }) },
          }),
          h('span', { text: i18n.t('includePage') }),
        ]),
      )
      refs.settingsEl.appendChild(
        field(
          i18n.t('contextScope'),
          selectControl(
            [
              { value: 'paragraph', label: i18n.t('scopeParagraph') },
              { value: 'page', label: i18n.t('scopePage') },
            ],
            settings.contextMode,
            (value) => update({ contextMode: value }),
            { 'data-field': 'context-mode' },
          ),
          h('span', { class: 'apweb-hint-inline', text: i18n.t('scopeHint') }),
        ),
      )

      // Thinking ---------------------------------------------------------------
      refs.thinkingRow = h('label', { class: 'apweb-check' }, [
        h('input', {
          class: 'apweb-switch',
          type: 'checkbox',
          checked: settings.thinking,
          'data-field': 'thinking',
          on: { change: (event) => update({ thinking: event.target.checked }) },
        }),
        h('span', { text: i18n.t('useThinking') }),
      ])
      refs.thinkingNote = h('p', { class: 'apweb-note' })
      refs.settingsEl.appendChild(refs.thinkingRow)
      refs.settingsEl.appendChild(refs.thinkingNote)
      refreshThinking()

      // Temperature ------------------------------------------------------------
      // A switch, plus the value: some endpoints reject the field outright
      // ("temperature is deprecated for this model") and no built-in table can
      // know every relay's quirks, so it has to be controllable by hand.
      refs.temperatureRow = h('label', { class: 'apweb-check' }, [
        h('input', {
          class: 'apweb-switch',
          type: 'checkbox',
          checked: settings.sendTemperature !== false,
          'data-field': 'send-temperature',
          on: {
            change: (event) => {
              update({ sendTemperature: event.target.checked })
              refreshTemperature()
            },
          },
        }),
        h('span', { text: i18n.t('sendTemperature') }),
      ])
      refs.temperatureInput = h('input', {
        type: 'number',
        min: '0',
        max: '2',
        step: '0.1',
        value: String(settings.temperature ?? ''),
        'data-field': 'temperature',
        on: {
          input: (event) => {
            const value = Number(event.target.value)
            // An empty or half-typed box must not silently become 0 (or NaN).
            if (event.target.value.trim() !== '' && Number.isFinite(value)) {
              update({ temperature: Math.min(Math.max(value, 0), 2) })
            }
          },
        },
      })
      refs.temperatureNote = h('p', { class: 'apweb-note' })
      refs.settingsEl.appendChild(refs.temperatureRow)
      refs.settingsEl.appendChild(
        field(i18n.t('temperatureValue'), refs.temperatureInput, refs.temperatureNote),
      )
      refreshTemperature()

      // Selection behaviour ----------------------------------------------------
      // These two selects mirror the same settings the prominent toggle above
      // edits, so they are refreshed in place (see refreshSelectionFields) rather
      // than only when this form is rebuilt.
      refs.triggerSelect = selectControl(
        [
          { value: 'off', label: i18n.t('triggerOff') },
          { value: 'click', label: i18n.t('triggerClick') },
          { value: 'auto', label: i18n.t('triggerAuto') },
        ],
        settings.selectionTrigger,
        (value) => update({ selectionTrigger: value }),
        { 'data-field': 'selection-trigger' },
      )
      refs.settingsEl.appendChild(
        field(
          i18n.t('selectionTrigger'),
          refs.triggerSelect,
          h('span', {
            class: 'apweb-hint-inline',
            text: i18n.t('triggerHint'),
          }),
        ),
      )
      refs.actionSelect = selectControl(
        settings.selectionPrompts.map((item) => ({ value: item.id, label: item.name })),
        AICore.findPrompt(settings.selectionPrompts, settings.selectionAction)?.id ?? '',
        (value) => update({ selectionAction: value }),
        { 'data-field': 'selection-action' },
      )
      refs.actionHint = h('span', { class: 'apweb-hint-inline' })
      refs.settingsEl.appendChild(
        field(i18n.t('selectionPurpose'), refs.actionSelect, refs.actionHint),
      )
      refreshSelectionFields()

      // Android -----------------------------------------------------------------
      // The card on the page has no title bar, so everything that shapes it is
      // here — and only here, which is why these two are listed apart.
      if (android) {
        refs.settingsEl.appendChild(
          h('h4', { class: 'apweb-settings__section', text: i18n.t('androidSettings') }),
        )
        refs.cardHeightInput = h('input', {
          type: 'number',
          min: '160',
          max: '2000',
          step: '20',
          value: String(settings.panelMaxHeight),
          'data-field': 'panel-max-height',
          on: {
            input: (event) => {
              const value = Number(event.target.value)
              // A half-typed box must not be written as 0 (or NaN); a real value is
              // rounded into the range the box offers.
              if (event.target.value.trim() !== '' && Number.isFinite(value)) {
                update({ panelMaxHeight: AICore.clampCardHeight(value) })
              }
            },
          },
        })
        refs.settingsEl.appendChild(
          field(
            i18n.t('cardMaxHeight'),
            refs.cardHeightInput,
            h('span', { class: 'apweb-hint-inline', text: i18n.t('cardMaxHeightNote') }),
          ),
        )
        refs.sentRow = h('label', { class: 'apweb-check' }, [
          h('input', {
            class: 'apweb-switch',
            type: 'checkbox',
            checked: settings.showSentContent !== false,
            'data-field': 'show-sent-content',
            on: { change: (event) => update({ showSentContent: event.target.checked }) },
          }),
          h('span', { text: i18n.t('showSentContent') }),
        ])
        refs.settingsEl.appendChild(refs.sentRow)
        refs.settingsEl.appendChild(
          h('p', { class: 'apweb-note', text: i18n.t('showSentContentNote') }),
        )
      }

      // Prompt libraries -------------------------------------------------------
      refs.settingsEl.appendChild(buildPrompts())

      refs.settingsEl.appendChild(
        h('p', {
          class: 'apweb-note',
          text:
            i18n.t('keyStorageNote'),
        }),
      )

      const actions = h('div', { class: 'apweb-actions' }, [
        h('button', {
          type: 'button',
          class: 'apweb-ghost',
          text: i18n.t('clearKey'),
          on: { click: () => update({ apiKey: '' }) },
        }),
        h('button', {
          type: 'button',
          class: 'apweb-primary',
          text: i18n.t('done'),
          on: { click: () => setShowSettings(false) },
        }),
      ])
      refs.settingsEl.appendChild(actions)

      syncComposer()
    }

    function buildPrompts() {
      const details = h('details', { class: 'apweb-prompts' }, [
        h('summary', { text: i18n.t('prompts') }),
        buildPromptGroup('composer', i18n.t('composerPrompts')),
        buildPromptGroup('selection', i18n.t('selectionPrompts')),
      ])
      details.open = promptsOpen
      details.addEventListener('toggle', () => {
        promptsOpen = details.open
      })
      return details
    }

    function buildPromptGroup(kind, label) {
      const settings = S()
      const isComposer = kind === 'composer'
      const list = isComposer ? settings.composerPrompts : settings.selectionPrompts
      const currentId = isComposer ? settings.composerPromptId : settings.selectionAction
      const current = AICore.findPrompt(list, currentId)

      const select = selectControl(
        list.map((item) => ({ value: item.id, label: item.name })),
        current?.id ?? '',
        (value) => {
          update(isComposer ? { composerPromptId: value } : { selectionAction: value })
          renderSettings()
        },
        { 'data-field': `${kind}-prompt-select` },
      )

      const nameInput = h('input', {
        class: 'apweb-prompts__name',
        type: 'text',
        value: current?.name ?? '',
        'data-field': `${kind}-prompt-name`,
        on: { input: (event) => AIStore.updatePrompt(kind, { name: event.target.value }) },
      })

      const textArea = h('textarea', {
        class: 'apweb-prompts__text',
        rows: isComposer ? 4 : 3,
        value: current?.text ?? '',
        'data-field': `${kind}-prompt-text`,
        on: { input: (event) => AIStore.updatePrompt(kind, { text: event.target.value }) },
      })
      textArea.textContent = current?.text ?? ''

      const actions = h('div', { class: 'apweb-prompts__actions' }, [
        h('button', {
          type: 'button',
          text: i18n.t('addPrompt'),
          'data-field': `${kind}-prompt-add`,
          on: {
            click: () => {
              AIStore.addPrompt(kind)
              renderSettings()
            },
          },
        }),
        h('button', {
          type: 'button',
          text: i18n.t('deletePrompt'),
          disabled: list.length <= 1,
          'data-field': `${kind}-prompt-delete`,
          on: {
            click: () => {
              AIStore.deletePrompt(kind)
              renderSettings()
            },
          },
        }),
        h('button', {
          type: 'button',
          text: i18n.t('resetPrompts'),
          'data-field': `${kind}-prompt-reset`,
          on: {
            click: () => {
              AIStore.resetPrompts(kind)
              renderSettings()
            },
          },
        }),
      ])

      return h('div', { class: 'apweb-prompts__group' }, [
        h('label', { class: 'apweb-field' }, [h('span', { text: label }), select]),
        nameInput,
        textArea,
        actions,
        !isComposer
          ? h('p', {
              class: 'apweb-hint-inline',
              text:
                i18n.t('selectionPromptNote'),
            })
          : null,
      ])
    }

    /**
     * Sync the key field with the endpoint+model pair that is selected now.
     *
     * Keys are stored per `baseUrl|model`, so changing the model (or a custom
     * address) makes `settings.apiKey` that pair's key — empty when there is none
     * yet. The input has to follow, otherwise it keeps showing the previous
     * model's key and the next keystroke there would save *that* key under the new
     * model, which is exactly how "the api-key didn't change with the model" shows
     * up. Assigning only when the value differs keeps typing undisturbed.
     */
    function refreshKeyFields() {
      const settings = S()
      if (refs.keyInput && refs.keyInput.value !== settings.apiKey) {
        refs.keyInput.value = settings.apiKey
      }
      if (!refs.keyHint) return
      const provider = AICore.providerById(settings.providerId)
      refs.keyHint.textContent = i18n.t('keyHint', { provider: provider.label, model: settings.model || i18n.t('modelPlaceholder') })
    }

    function refreshThinking() {
      const settings = S()
      const info = AICore.thinkingInfo(settings)
      if (refs.thinkingRow) refs.thinkingRow.hidden = !info.available
      if (!refs.thinkingNote) return
      refs.thinkingNote.className = info.available ? 'apweb-note' : 'apweb-note apweb-note--plain'
      if (info.available) {
        refs.thinkingNote.textContent = info.canDisable
          ? i18n.t('thinkingOffNote')
          : i18n.t('thinkingForcedNote')
      } else if (info.reason === 'model') {
        refs.thinkingNote.textContent =
          i18n.t('thinkingModelNote')
      } else {
        refs.thinkingNote.textContent = i18n.t('thinkingNoControlNote')
      }
    }

    /**
     * Keep the temperature switch, its value box and its note in step — including
     * after the app quietly marked this endpoint+model as "no temperature".
     */
    function refreshTemperature() {
      const settings = S()
      const on = settings.sendTemperature !== false
      if (refs.temperatureInput) {
        refs.temperatureInput.disabled = !on
        const value = String(settings.temperature ?? '')
        if (refs.temperatureInput.value !== value) refs.temperatureInput.value = value
      }
      if (!refs.temperatureNote) return
      const skipped = Boolean(settings.temperatureOffSlots?.[AICore.pairSlot(settings)])
      refs.temperatureNote.textContent = !on
        ? i18n.t('temperatureOffNote')
        : skipped
          ? i18n.t('temperatureSkippedNote')
          : i18n.t('temperatureOnNote')
    }

    /* ---------------------------------- drag ---------------------------------- */

    /**
     * Drag the panel by its header.
     *
     * Two things here are deliberate, and both were bugs before:
     *
     *  - The move/up listeners are on `window` with `capture: true`. The panel
     *    calls `stopPropagation()` on mouse events so the page never sees clicks
     *    inside it; a bubble-phase listener on `window` was therefore never
     *    reached when the pointer was released *over the panel*, so the drag
     *    never ended and the panel kept following the cursor. Capture runs from
     *    the window down, before anything can stop it.
     *  - `setPointerCapture` retargets every move to the header, so the drag
     *    survives the pointer crossing an iframe or leaving the window.
     */
    function enableDrag(handle, panel) {
      let dragging = false
      let pointerId = null
      let startX = 0
      let startY = 0
      let originLeft = 0
      let originTop = 0

      const onMove = (event) => {
        if (!dragging) return
        if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) return
        const rect = panel.getBoundingClientRect()
        // Clamped with the same helper that saves the rect, so a drag to the edge
        // does not get silently nudged the next time the panel is restored.
        const next = clampPanelRect(
          {
            left: originLeft + event.clientX - startX,
            top: originTop + event.clientY - startY,
            width: rect.width,
            height: rect.height,
          },
          viewport(),
        )
        panel.style.left = `${next.left}px`
        panel.style.top = `${next.top}px`
        panel.style.right = 'auto'
      }

      const endDrag = (event) => {
        if (!dragging) return
        if (event && pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) {
          return
        }
        const id = pointerId
        dragging = false
        pointerId = null
        window.removeEventListener('pointermove', onMove, true)
        window.removeEventListener('pointerup', endDrag, true)
        window.removeEventListener('pointercancel', endDrag, true)
        window.removeEventListener('blur', endDrag, true)
        try {
          if (id !== null) handle.releasePointerCapture?.(id)
        } catch {
          // The capture was already released (or never taken).
        }
        saveRect()
      }

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        if (event.target.closest('button')) return
        const rect = panel.getBoundingClientRect()
        dragging = true
        pointerId = event.pointerId ?? null
        startX = event.clientX
        startY = event.clientY
        originLeft = rect.left
        originTop = rect.top
        event.preventDefault()
        try {
          if (event.pointerId !== undefined) handle.setPointerCapture?.(event.pointerId)
        } catch {
          // Capture is a nicety; the window listeners below keep the drag alive.
        }
        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', endDrag, true)
        window.addEventListener('pointercancel', endDrag, true)
        window.addEventListener('blur', endDrag, true)
      })
    }

    /* ---------------------------------- wiring -------------------------------- */

    const unsubscribe = AIStore.subscribe((_state, meta) => {
      syncHeader()
      syncLauncher()
      syncCardOptions()
      refreshModeControl()
      refreshSelectionFields()
      refreshKeyFields()
      refreshTemperature()
      syncComposer()
      // A change that came from another surface (options page / another tab) has
      // to be reflected in the transcript too.
      if (meta?.remote) renderMessages()
    })

    renderMessages()
    syncHeader()
    syncLauncher()
    syncCardOptions()
    syncComposer()
    if (showSettings) renderSettings()

    return {
      el: scope,
      setOpen,
      isOpen: () => open,
      toggle,
      askSelection,
      setSelectionAuto,
      buildSelectionContext,
      isSelectionAuto,
      openSettings: () => setShowSettings(true),
      focusComposer: () => refs.input.focus({ preventScroll: true }),
      destroy: () => {
        controller?.abort()
        window.clearTimeout(scrollTimer)
        if (frame) window.cancelAnimationFrame(frame)
        unsubscribe()
      },
    }
  }

  globalThis.AIPanel = { createPanel, isMobileLayout }
})()

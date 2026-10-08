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
        else if (key === 'html') el.innerHTML = value
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
        if (!settled) finish(() => reject(new Error('后台连接已断开，请重试')))
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

  /* ------------------------------ page reflow -------------------------------- */

  // Space reserved on the page while a panel is docked. Kept per document, not
  // per panel, so two panels in one document (as the test harness builds) share
  // one snapshot instead of overwriting each other's restoration.
  const REFLOW_PROPS = ['marginRight', 'marginLeft', 'overflowX']
  const reflowRecords = new WeakMap()

  function beginReflow(el) {
    const existing = reflowRecords.get(el)
    if (existing) {
      existing.owners += 1
      return existing
    }
    const record = { owners: 1, snapshot: {} }
    for (const prop of REFLOW_PROPS) record.snapshot[prop] = el.style[prop]
    // Measured before anything is reserved: afterwards our own margin would be
    // counted as part of the scrollbar.
    const value = window.innerWidth - el.clientWidth
    record.scrollbar = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
    reflowRecords.set(el, record)
    return record
  }

  function endReflow(el) {
    const record = reflowRecords.get(el)
    if (!record) return
    record.owners -= 1
    // Someone else is still reserving space — only the last one out restores.
    if (record.owners > 0) return
    for (const prop of REFLOW_PROPS) el.style[prop] = record.snapshot[prop]
    reflowRecords.delete(el)
  }

  /* --------------------------------- the panel ------------------------------- */

  function createPanel(options) {
    const opts = options ?? {}
    const embed = Boolean(opts.embed)
    const fill = Boolean(opts.fill)
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
    // Which layout ('floating' | 'right' | 'left') is currently applied.
    let appliedMode = null
    // Page zoom (1 = 100%). The panel is drawn by the page, so it inherits the
    // page's zoom; it counter-scales itself to keep a constant on-screen size.
    // Widths that mean "pixels on screen" — the dock width, and what the page
    // reserves — are therefore device pixels, divided by the zoom wherever a
    // page-space length is needed.
    let pageZoom = 1
    // Whether this panel is currently counted as an owner of the page reflow.
    let holdsReflow = false
    const refs = {}

    /* -------------------------------- structure ------------------------------- */

    const scope = h('div', {
      class: `apweb-scope${embed ? ' apweb-scope--embed' : ''}${fill ? ' apweb-scope--fill' : ''}`,
    })

    refs.model = h('span', { class: 'apweb-title__model' })
    refs.dot = h('span', { class: 'apweb-dot' })
    refs.clearBtn = h('button', {
      type: 'button',
      title: '清空对话',
      text: '清空',
      on: { click: () => clearChat() },
    })
    refs.settingsBtn = h('button', {
      type: 'button',
      title: '设置',
      text: '⚙',
      on: { click: () => setShowSettings(!showSettings) },
    })
    const closeBtn = h('button', {
      type: 'button',
      title: '收起',
      text: '✕',
      on: { click: () => setOpen(false) },
    })

    const head = h('header', { class: 'apweb-panel__head' }, [
      h('div', { class: 'apweb-title' }, [refs.dot, h('strong', { text: 'AI 助手' }), refs.model]),
      h('div', { class: 'apweb-head-actions' }, [
        refs.settingsBtn,
        refs.clearBtn,
        embed || opts.hideClose ? null : closeBtn,
      ]),
    ])

    refs.settingsEl = h('div', { class: 'apweb-settings', hidden: true })
    refs.msgs = h('div', { class: 'apweb-msgs' })
    refs.failure = h('p', { class: 'apweb-failure', hidden: true })

    refs.input = h('textarea', {
      rows: 2,
      placeholder: 'Enter 发送，Shift+Enter 换行',
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
      text: '发送',
      on: { click: () => void send() },
    })
    refs.stopBtn = h('button', {
      type: 'button',
      class: 'apweb-stop',
      text: '停止',
      hidden: true,
      on: { click: () => stop() },
    })

    const composer = h('div', { class: 'apweb-composer' }, [refs.input, refs.stopBtn, refs.sendBtn])

    refs.panel = h('section', { class: 'apweb-panel' }, [
      head,
      refs.settingsEl,
      refs.msgs,
      refs.failure,
      composer,
    ])
    if (!open) refs.panel.hidden = true

    // In the docked layout the panel sits flush against an edge and needs its own
    // grip on the inner edge: CSS `resize` only ever draws one at the
    // bottom-right corner, which is useless for a panel docked to the right.
    refs.dockHandle = h('div', {
      class: 'apweb-dock-handle',
      hidden: true,
      title: '拖动调整宽度，双击复位',
      'data-field': 'dock-handle',
      on: { dblclick: () => setDockWidth(AICore.DEFAULT_SETTINGS.dockWidth) },
    })
    refs.panel.appendChild(refs.dockHandle)

    scope.appendChild(refs.panel)
    isolate(scope)
    if (!embed) {
      enableDrag(head, refs.panel)
      enableDockResize(refs.dockHandle, refs.panel)
    }
    applyLayout()

    /* --------------------------------- helpers -------------------------------- */

    function setOpen(next) {
      open = Boolean(next)
      refs.panel.hidden = !open
      opts.onOpenChange?.(open)
      // Docking reserves page space only while the panel is on screen.
      applyLayout()
      if (open) {
        syncHeader()
        if (showSettings) renderSettings()
        scrollToBottom(true)
        if (!embed) refs.input.focus({ preventScroll: true })
      } else {
        opts.onClose?.()
      }
    }

    function setShowSettings(next) {
      showSettings = Boolean(next)
      refs.settingsEl.hidden = !showSettings
      if (showSettings) renderSettings()
      else {
        // The mode control lives inside the form; drop the refs along with it.
        refs.modeBtn = null
        refs.modeHint = null
      }
      syncComposer()
    }

    function toggle() {
      setOpen(!open)
    }

    /** 'right' | 'left' when the panel is docked, otherwise null. */
    function modeSide() {
      const mode = S().panelMode
      return mode === 'right' || mode === 'left' ? mode : null
    }

    /** Which edge the panel is anchored to — decides the zoom scaling origin. */
    function panelAnchor() {
      const side = modeSide()
      if (side) return side
      // A floating panel is anchored right until it has been dragged somewhere.
      return refs.panel.style.left ? 'left' : 'right'
    }

    /** Width the dock is clamped against, in device pixels. */
    function deviceViewportWidth() {
      return window.innerWidth * pageZoom
    }

    function setPageZoom(zoom) {
      const value = Number(zoom)
      pageZoom = Number.isFinite(value) && value > 0 ? value : 1
      applyLayout()
    }

    /**
     * Counter-scale so a page zoom of 200% does not make the panel look twice as
     * big. Anchoring the origin on the panel's own edge keeps the dock flush and
     * keeps a dragged floating panel where it was put.
     */
    function applyZoom() {
      if (embed) return
      const scale = 1 / pageZoom
      refs.panel.style.transformOrigin = panelAnchor() === 'left' ? 'top left' : 'top right'
      refs.panel.style.transform = scale === 1 ? '' : `scale(${scale})`
    }

    function setDockWidth(width) {
      const clamped = AICore.clampDockWidth(width, deviceViewportWidth())
      refs.panel.style.width = `${clamped}px`
      update({ dockWidth: clamped })
      return clamped
    }

    /**
     * Apply the docked/floating layout. Only a *change* of mode resets the
     * inline position, so a panel the user dragged stays where they put it while
     * unrelated settings change.
     */
    function applyLayout() {
      if (embed) return
      const side = modeSide()
      const mode = side ?? 'floating'
      const changed = mode !== appliedMode
      appliedMode = mode

      scope.classList.toggle('apweb-scope--dock', Boolean(side))
      scope.classList.toggle('apweb-scope--dock-right', side === 'right')
      scope.classList.toggle('apweb-scope--dock-left', side === 'left')
      refs.dockHandle.hidden = !side

      if (side) {
        if (changed) {
          // Docking wins over wherever the panel was dragged to while floating.
          refs.panel.style.left = ''
          refs.panel.style.top = ''
          refs.panel.style.right = ''
        }
        const width = AICore.clampDockWidth(S().dockWidth, deviceViewportWidth())
        refs.panel.style.width = `${width}px`
        // Full height means "full height on screen": the box is drawn in page
        // pixels first, so at a zoom of 200% it must be laid out twice as tall to
        // end up covering the viewport after the counter-scale below.
        refs.panel.style.height =
          pageZoom === 1 ? '' : `${Math.round(window.innerHeight * pageZoom)}px`
        // Reflow only while the panel is actually on screen — closing it gives
        // the page its space back.
        if (open) applyReflow(side, width)
        else clearReflow()
      } else if (changed) {
        clearReflow()
        refs.panel.style.width = ''
        refs.panel.style.height = ''
        refs.panel.style.left = ''
        refs.panel.style.top = ''
        refs.panel.style.right = ''
      }
      applyZoom()
    }

    /**
     * Reserve the panel's width on the page. The panel itself stays `fixed`, so
     * a page's `position: fixed` chrome still spans the whole window — that is
     * the one thing a generic in-page dock cannot reshape (the native sidebar
     * gets it right because the browser resizes the content area).
     *
     * The panel is nudged inwards by the scrollbar width so the page's own
     * scrollbar stays visible in the strip beside it, and the reserved margin
     * covers both. Without that the scrollbar would sit underneath the panel and
     * become unreachable.
     */
    function applyReflow(side, width) {
      const el = document.documentElement
      if (!el || !side) return
      if (!holdsReflow) {
        holdsReflow = true
        beginReflow(el)
      }
      const record = reflowRecords.get(el)
      if (!record) return

      // `width` is a device-pixel width; the page's margin is in its own (zoomed)
      // pixels, so it has to be divided back out.
      const reserve = width / pageZoom + record.scrollbar
      // Full-bleed sections sized with `100vw` would otherwise stick out into the
      // reserved strip and add a horizontal scrollbar.
      el.style.overflowX = 'hidden'
      if (side === 'right') {
        el.style.marginRight = `${reserve}px`
        el.style.marginLeft = record.snapshot.marginLeft
      } else {
        el.style.marginLeft = `${reserve}px`
        el.style.marginRight = record.snapshot.marginRight
      }

      refs.panel.style.right = side === 'right' ? `${record.scrollbar}px` : ''
      refs.panel.style.left = side === 'left' ? `${record.scrollbar}px` : ''
    }

    function clearReflow() {
      if (holdsReflow) {
        holdsReflow = false
        const el = document.documentElement
        if (el) endReflow(el)
      }
      refs.panel.style.left = ''
      refs.panel.style.right = ''
    }

    /**
     * Drag the inner edge of a docked panel to resize it. Same capture-phase
     * listener trick as the header drag: the panel stops pointer events from
     * reaching the page, so a bubble-phase listener on `window` would never see
     * the release.
     */
    function enableDockResize(handle, panel) {
      let resizing = false
      let pointerId = null
      let side = null
      let width = 0

      const onMove = (event) => {
        if (!resizing) return
        if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) return
        // getBoundingClientRect() is the *rendered* box; multiply back by the zoom
        // to get the width in device pixels, which is what the setting stores.
        const rect = panel.getBoundingClientRect()
        const raw = (side === 'right' ? rect.right - event.clientX : event.clientX - rect.left) * pageZoom
        width = AICore.clampDockWidth(raw, deviceViewportWidth())
        panel.style.width = `${width}px`
        // The page has to give up (or take back) space as the edge moves.
        applyReflow(side, width)
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
        if (width) update({ dockWidth: width })
      }

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        side = modeSide()
        if (!side) return
        resizing = true
        pointerId = event.pointerId ?? null
        width = panel.getBoundingClientRect().width * pageZoom
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

    /**
     * Refresh the prominent toggle inside the settings form, if that form is
     * currently on screen. It reflects one question: does selecting text send it
     * straight away? On = 'auto', off = 'click' (the pill). The reader-era
     * 「完全关闭」 state stays reachable from the select just below it.
     */
    function refreshModeControl() {
      const btn = refs.modeBtn
      if (!btn) return
      const trigger = S().selectionTrigger
      const on = trigger === 'auto'
      const off = trigger === 'off'
      btn.classList.toggle('apweb-mode__btn--on', on)
      btn.textContent = on ? '✦ 划词即问 · 已开启' : '✦ 启动划词即问'
      btn.title = on
        ? '点击改为「选中后显示按钮」'
        : '点击开启：在网页上选中文字就直接发给 AI'
      if (refs.modeHint) {
        refs.modeHint.textContent = on
          ? '现在在任意网页选中文字，就会直接发给我。'
          : off
            ? '划词提问目前是关闭的，点上面按钮开启「选中即发送」。'
            : '开启后选中文字自动发送；关闭则改为弹出按钮、点击再发。'
      }
    }

    function toggleSelectionAuto() {
      setSelectionAuto(S().selectionTrigger !== 'auto')
    }

    function setSelectionAuto(on) {
      update({ selectionTrigger: on ? 'auto' : 'click' })
      refreshModeControl()
    }

    function syncComposer() {
      refs.sendBtn.hidden = streaming
      refs.stopBtn.hidden = !streaming
      refs.sendBtn.disabled = !canSend()
      // Only touch the field when it actually differs: assigning the same string
      // back to a focused <textarea> would jump the caret to the end.
      if (refs.input.value !== draftText) refs.input.value = draftText
      refs.input.disabled = !S().apiKey && showSettings
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
            text: '问点什么吧。在页面上选中文字会弹出「问 AI」按钮，也可以直接在这里提问。',
          }),
        )
        return
      }
      for (const message of messages()) refs.msgs.appendChild(buildMessageNode(message))
      scrollToBottom(true)
    }

    function buildMessageNode(message) {
      const meta = h('div', { class: 'apweb-msg__meta' }, [
        h('span', { text: message.role === 'user' ? '你' : 'AI' }),
        message.context ? h('span', { class: 'apweb-msg__context', text: `上下文：${message.context}` }) : null,
      ])

      if (message.role === 'assistant' && message.content) {
        meta.appendChild(
          h('button', {
            type: 'button',
            class: 'apweb-msg__copy',
            text: '复制',
            on: {
              click: async () => {
                const ok = await copyText(message.content)
                if (!ok) setFailure('复制失败：浏览器不允许写剪贴板')
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
          message._thinking.querySelector('summary').textContent = `思考过程（${reasoning.length} 字）`
          message._thinkingP.textContent = reasoning
        }
      }
    }

    /* ---------------------------------- turns --------------------------------- */

    const composerPromptText = () => AICore.findPrompt(S().composerPrompts, S().composerPromptId)?.text ?? ''

    /**
     * The context a selection turn would attach, as a ready-made payload.
     * Exposed so the content script can hand the exact same context to the
     * browser sidebar, which has no page DOM of its own to read.
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
      const source = url ? `《${title || '当前网页'}》(${url})` : `《${title || '当前网页'}》`
      const context =
        `以下只是参考上下文，不要翻译、不要解释、不要总结，也不要在回答里复述：\n` +
        `${source}${described.label}：\n"""\n${described.text}\n"""`
      return { context, contextInfo: described.label }
    }

    async function buildContext({ includeSelection = true, includePage = S().includePageText, selectionText = '' } = {}) {
      const settings = S()
      const parts = []
      const info = []

      const highlight = includeSelection ? getSelection().trim() : ''
      if (highlight) {
        parts.push(`用户选中的文字：\n"""\n${highlight}\n"""`)
        info.push('选中文字')
      }

      if (includePage) {
        const described = describeContext({
          mode: settings.contextMode,
          selectionText: highlight || selectionText,
        })
        if (described?.text) {
          const { title, url } = pageInfo()
          const source = url ? `《${title || '当前网页'}》(${url})` : `《${title || '当前网页'}》`
          parts.push(
            `以下只是参考上下文，不要翻译、不要解释、不要总结，也不要在回答里复述：\n` +
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
    async function runTurn({ userText, promptText, modelText, context }) {
      if (controller) controller.abort()
      const runId = ++currentRun

      setFailure('')
      const user = { role: 'user', content: userText, context: contextInfo }
      // What actually goes to the model, when it differs from what we display.
      if (modelText) user.forModel = modelText
      AIStore.pushMessage(user)
      const reply = { role: 'assistant', content: '' }
      AIStore.pushMessage(reply)
      renderMessages()

      const payload = [{ role: 'system', content: promptText ?? '' }]
      // The page reference goes *above* the turn it belongs to, so the ask that
      // follows cannot be misread as applying to it.
      if (context) payload.push({ role: 'system', content: context })
      // Earlier turns are sent without their context blobs, otherwise every
      // follow-up would repeat the whole page. `forModel` carries the framed
      // version of a turn (what the reader sees stays short).
      const history = messages()
        .slice(0, -1)
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.forModel ?? message.content }))
      payload.push(...history)

      streaming = true
      const localController = new AbortController()
      controller = localController
      syncComposer()
      syncHeader()

      try {
        const settings = S()
        await streamOnce(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            temperature: settings.temperature,
            messages: payload,
            settings,
          },
          (kind, text) => {
            if (kind === 'reasoning') reply.reasoning = (reply.reasoning ?? '') + text
            else reply.content += text
            scheduleUpdate(reply)
          },
          localController.signal,
        )
        if (!reply.content) {
          reply.content = reply.reasoning ? '（只有思考过程，没有正文）' : '（没有返回内容）'
        }
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (!reply.content) reply.content = '（已停止）'
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
        setShowSettings(true)
        return
      }

      // Answering the same snippet twice in a row is never what the user meant —
      // but if they asked something else in between, selecting it again is fair.
      const lastUser = [...messages()].reverse().find((message) => message.role === 'user')
      if (lastUser?.content?.trim() === text) return

      const settings = S()
      const action = selection.action ?? settings.selectionAction
      const ask = AICore.findPrompt(settings.selectionPrompts, action)?.text ?? ''
      // A caller that already has the page (the content script, relaying to the
      // sidebar) can pass the context in; otherwise build it from this document.
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
        'data-field': 'selection-auto',
        on: { click: () => toggleSelectionAuto() },
      })
      refs.modeHint = h('span', { class: 'apweb-mode__hint' })
      refs.settingsEl.appendChild(h('div', { class: 'apweb-mode' }, [refs.modeBtn, refs.modeHint]))
      refreshModeControl()

      // Provider ---------------------------------------------------------------
      refs.settingsEl.appendChild(
        field(
          '服务商',
          selectControl(
            AICore.PROVIDERS.map((item) => ({ value: item.id, label: item.label })),
            settings.providerId,
            (id) => {
              const next = AICore.providerById(id)
              update({
                providerId: next.id,
                ...(next.id === 'custom' ? {} : { baseUrl: next.baseUrl, model: next.model }),
              })
              renderSettings()
            },
          ),
        ),
      )

      // Endpoint (custom only) -------------------------------------------------
      if (isCustom) {
        refs.settingsEl.appendChild(
          field(
            '接口地址',
            textControl(settings.baseUrl, (value) => {
              update({ baseUrl: value })
              syncComposer()
            }, { type: 'url', placeholder: 'https://api.example.com/v1', 'data-field': 'base-url' }),
            settings.baseUrl ? null : h('span', { class: 'apweb-warn-inline', text: '填上接口地址才能发送' }),
          ),
        )
      }

      // Model ------------------------------------------------------------------
      const listId = 'apweb-model-suggestions'
      const modelInput = textControl(settings.model, (value) => {
        update({ model: value })
        refreshKeyHint()
        refreshThinking()
        syncComposer()
        syncHeader()
      }, { placeholder: provider.model || 'model-name', 'data-field': 'model', list: listId })
      if (isCustom) modelInput.removeAttribute('list')
      refs.settingsEl.appendChild(
        h('label', { class: 'apweb-field' }, [
          h('span', { text: '模型' }),
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
        text: `这个 key 只用于 ${provider.label} · ${settings.model || '（未填模型）'}，换模型会自动换成对应的 key`,
      })
      refs.settingsEl.appendChild(
        field(
          'API Key',
          h('input', {
            type: 'password',
            value: settings.apiKey,
            spellcheck: 'false',
            autocomplete: 'off',
            placeholder: 'sk-...',
            'data-field': 'api-key',
            on: { input: (event) => update({ apiKey: event.target.value }) },
          }),
          refs.keyHint,
        ),
      )

      // Context ----------------------------------------------------------------
      refs.settingsEl.appendChild(
        h('label', { class: 'apweb-check' }, [
          h('input', {
            type: 'checkbox',
            checked: settings.includePageText,
            on: { change: (event) => update({ includePageText: event.target.checked }) },
          }),
          h('span', { text: '发送时附带页面内容' }),
        ]),
      )
      refs.settingsEl.appendChild(
        field(
          '附带范围',
          selectControl(
            [
              { value: 'paragraph', label: '选中处所在的那一段（推荐）' },
              { value: 'page', label: '整个页面正文' },
            ],
            settings.contextMode,
            (value) => update({ contextMode: value }),
            { 'data-field': 'context-mode' },
          ),
          h('span', { class: 'apweb-hint-inline', text: '划词提问时只会在选中的是词或短句（不足 40 字）时附带。' }),
        ),
      )

      // Thinking ---------------------------------------------------------------
      refs.thinkingRow = h('label', { class: 'apweb-check' }, [
        h('input', {
          type: 'checkbox',
          checked: settings.thinking,
          'data-field': 'thinking',
          on: { change: (event) => update({ thinking: event.target.checked }) },
        }),
        h('span', { text: '使用思考模式（默认关闭）' }),
      ])
      refs.thinkingNote = h('p', { class: 'apweb-note' })
      refs.settingsEl.appendChild(refs.thinkingRow)
      refs.settingsEl.appendChild(refs.thinkingNote)
      refreshThinking()

      // Selection behaviour ----------------------------------------------------
      refs.settingsEl.appendChild(
        field(
          '划词提问',
          selectControl(
            [
              { value: 'off', label: '关闭（只选中，不发送）' },
              { value: 'click', label: '选中后显示按钮，点击提问' },
              { value: 'auto', label: '选中后自动提问' },
            ],
            settings.selectionTrigger,
            (value) => update({ selectionTrigger: value }),
            { 'data-field': 'selection-trigger' },
          ),
          h('span', {
            class: 'apweb-hint-inline',
            text: '自动提问会在每次划选后立刻产生一次 API 调用；只想复制文字就用「关闭」。',
          }),
        ),
      )
      refs.settingsEl.appendChild(
        field(
          '划词用途',
          selectControl(
            settings.selectionPrompts.map((item) => ({ value: item.id, label: item.name })),
            AICore.findPrompt(settings.selectionPrompts, settings.selectionAction)?.id ?? '',
            (value) => {
              update({ selectionAction: value })
              renderSettings()
            },
            { 'data-field': 'selection-action' },
          ),
        ),
      )
      refs.settingsEl.appendChild(
        h('label', { class: 'apweb-check' }, [
          h('input', {
            type: 'checkbox',
            checked: settings.showLauncher,
            'data-field': 'show-launcher',
            on: { change: (event) => update({ showLauncher: event.target.checked }) },
          }),
          h('span', { text: '在页面右下角显示「划词即问」快捷按钮' }),
        ]),
      )

      // Display mode -----------------------------------------------------------
      refs.settingsEl.appendChild(
        field(
          '面板显示方式',
          selectControl(
            [
              { value: 'floating', label: '浮动卡片（可拖动）' },
              { value: 'right', label: '固定在右侧（占满高度）' },
              { value: 'left', label: '固定在左侧（占满高度）' },
            ],
            settings.panelMode,
            (value) => {
              update({ panelMode: value })
              applyLayout()
            },
            { 'data-field': 'panel-mode' },
          ),
          h('span', {
            class: 'apweb-hint-inline',
            text:
              `固定后拖动贴着页面的那条边可调宽度（最窄 ${AICore.DOCK_MIN_WIDTH}px），双击复位。` +
              '想要真正「占位」的侧栏，用浏览器自带的「AI 助手」侧栏（视图 → 侧栏）。',
          }),
        ),
      )

      // Prompt libraries -------------------------------------------------------
      refs.settingsEl.appendChild(buildPrompts())

      refs.settingsEl.appendChild(
        h('p', {
          class: 'apweb-note',
          text:
            'key 只保存在本机浏览器（browser.storage.local），请求由浏览器直接发往上面的接口地址，' +
            '不经过任何中转。共用电脑上记得清掉。',
        }),
      )

      const actions = h('div', { class: 'apweb-actions' }, [
        h('button', {
          type: 'button',
          class: 'apweb-ghost',
          text: '清除 key',
          on: { click: () => update({ apiKey: '' }) },
        }),
        h('button', {
          type: 'button',
          class: 'apweb-primary',
          text: '完成',
          on: { click: () => setShowSettings(false) },
        }),
      ])
      refs.settingsEl.appendChild(actions)

      syncComposer()
    }

    function buildPrompts() {
      const details = h('details', { class: 'apweb-prompts' }, [
        h('summary', { text: '提示词' }),
        buildPromptGroup('composer', '提问提示词（在输入框提问时使用）'),
        buildPromptGroup('selection', '划词提示词（选中内容后使用）'),
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
          text: '+ 新建',
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
          text: '删除',
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
          text: '恢复默认',
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
                '你写的内容会放在选中文字前面；系统一定会再补一句「只处理引号内的文字，不要翻译页面正文」，' +
                '这条不能改——它是防止整页被翻译的保险。',
            })
          : null,
      ])
    }

    function refreshKeyHint() {
      if (!refs.keyHint) return
      const settings = S()
      const provider = AICore.providerById(settings.providerId)
      refs.keyHint.textContent = `这个 key 只用于 ${provider.label} · ${settings.model || '（未填模型）'}，换模型会自动换成对应的 key`
    }

    function refreshThinking() {
      const settings = S()
      const info = AICore.thinkingInfo(settings)
      if (refs.thinkingRow) refs.thinkingRow.hidden = !info.available
      if (!refs.thinkingNote) return
      refs.thinkingNote.className = info.available ? 'apweb-note' : 'apweb-note apweb-note--plain'
      if (info.available) {
        refs.thinkingNote.textContent = info.canDisable
          ? '默认关闭。打开后模型会先推理再回答，更准但更慢。'
          : '这个模型只能强制思考，无法关闭（例如智谱 GLM-5.3）。'
      } else if (info.reason === 'model') {
        refs.thinkingNote.textContent =
          '当前模型不接受思考开关，不会发送相关参数（例如 Kimi K3、GLM-4-Flash 这类非思考模型）。'
      } else {
        refs.thinkingNote.textContent = '这个接口地址没有可用的思考开关，不会发送相关参数。'
      }
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
        const left = Math.min(
          Math.max(0, originLeft + event.clientX - startX),
          Math.max(0, window.innerWidth - panel.offsetWidth),
        )
        const top = Math.min(
          Math.max(0, originTop + event.clientY - startY),
          Math.max(0, window.innerHeight - 40),
        )
        panel.style.left = `${left}px`
        panel.style.top = `${top}px`
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
      }

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return
        if (event.target.closest('button')) return
        // A docked panel is pinned to its edge; there is nothing to drag.
        if (modeSide()) return
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
      refreshModeControl()
      syncComposer()
      applyLayout()
      // A change that came from another surface (sidebar / options / another
      // tab) has to be reflected in the transcript too.
      if (meta?.remote) renderMessages()
    })

    // The docked width is clamped against the viewport, so a window resize has to
    // re-run the layout and the reflow.
    const onWindowResize = () => applyLayout()
    if (!embed) window.addEventListener('resize', onWindowResize)

    renderMessages()
    syncHeader()
    syncComposer()
    applyLayout()
    if (showSettings) renderSettings()

    return {
      el: scope,
      setOpen,
      isOpen: () => open,
      toggle,
      askSelection,
      setSelectionAuto,
      buildSelectionContext,
      setPageZoom,
      getPageZoom: () => pageZoom,
      isSelectionAuto: () => S().selectionTrigger === 'auto',
      refreshLayout: applyLayout,
      openSettings: () => setShowSettings(true),
      focusComposer: () => refs.input.focus({ preventScroll: true }),
      destroy: () => {
        controller?.abort()
        window.clearTimeout(scrollTimer)
        if (frame) window.cancelAnimationFrame(frame)
        if (!embed) window.removeEventListener('resize', onWindowResize)
        clearReflow()
        unsubscribe()
      },
    }
  }

  globalThis.AIPanel = { createPanel }
})()

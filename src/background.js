// Background event page.
//
// It exists for two reasons:
//   1. The chat request runs here, not in the page. A content script's fetch()
//      inherits the page's origin, so calling an API directly from it would be
//      a cross-origin request subject to that API's CORS policy. With the host
//      permissions granted, a request from the background is not.
//   2. The toolbar button lives here: clicking it tells the page to toggle the
//      assistant panel.
//
// Streaming travels over a long-lived port (`runtime.connect`) rather than
// one-shot messages, so a reply can be delivered token by token.
(function () {
  'use strict'

  const AICore = globalThis.AICore
  const i18n = globalThis.AII18n
  const api = globalThis.browser ?? globalThis.chrome
  const PORT_NAME = 'apweb-ai'
  const PANEL_STATE_PREFIX = 'apweb.panel.'
  const SETTINGS_KEY = 'apweb.ai.settings'
  const TOGGLE_SELECTION_COMMAND = 'toggle-selection-trigger'

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return

    // Request id -> AbortController, so a Stop button can cancel the fetch.
    const controllers = new Map()

    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return

      if (message.t === 'chat') {
        void runChat(port, message, controllers)
      } else if (message.t === 'abort') {
        controllers.get(message.id)?.abort()
      }
    })

    port.onDisconnect.addListener(() => {
      // The tab navigated away or closed: stop paying for a stream nobody reads.
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
    })
  })

  async function runChat(port, message, controllers) {
    const { id, request } = message
    const controller = new AbortController()
    controllers.set(id, controller)

    const post = (payload) => {
      try {
        port.postMessage(payload)
      } catch {
        // The port closed between the abort and this frame.
      }
    }

    try {
      const settings = request.settings ?? {}
      for await (const chunk of AICore.streamChat({
        baseUrl: request.baseUrl,
        apiKey: request.apiKey,
        model: request.model,
        temperature: request.temperature,
        messages: request.messages,
        extraBody: AICore.thinkingBody(settings),
        signal: controller.signal,
      })) {
        post({ t: 'delta', id, kind: chunk.type, text: chunk.text })
      }
      post({ t: 'done', id })
    } catch (error) {
      if (error?.name === 'AbortError') post({ t: 'aborted', id })
      else post({ t: 'error', id, message: error?.message ?? String(error) })
    } finally {
      controllers.delete(id)
    }
  }

  /* ------------------------------ message routing ---------------------------- */

  api.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== 'object') return undefined
    if (message.t === 'apweb:panel-state') return readPanelState(sender)
    if (message.t === 'apweb:set-panel-state') return writePanelState(sender, message.open === true)
    return undefined
  })

  /* ------------------------------- panel state ------------------------------- */

  // Whether the floating panel is showing, per tab: a new tab starts closed, while
  // navigating inside a tab keeps the state you left. Kept in storage.session so
  // it survives the background event page being suspended; tabs that close are
  // swept out.
  function stateKey(sender) {
    const tabId = sender?.tab?.id
    return tabId === undefined ? null : `${PANEL_STATE_PREFIX}${tabId}`
  }

  async function readPanelState(sender) {
    const key = stateKey(sender)
    // The language rides along: the background page always has i18n access, while
    // a content script may not, and the panel needs it before it builds anything.
    const language = i18n?.language?.() ?? null
    if (!key || !api.storage?.session) return { open: false, language }
    try {
      const stored = await api.storage.session.get(key)
      return { open: stored?.[key] === true, language }
    } catch {
      return { open: false, language }
    }
  }

  async function writePanelState(sender, open) {
    const key = stateKey(sender)
    if (!key || !api.storage?.session) return { ok: false }
    try {
      await api.storage.session.set({ [key]: open })
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  api.tabs?.onRemoved?.addListener((tabId) => {
    if (!api.storage?.session) return
    void api.storage.session.remove(`${PANEL_STATE_PREFIX}${tabId}`).catch(() => {})
  })

  /* ------------------------------ toolbar button ----------------------------- */

  // Where the button leads depends on the platform: Android keeps its settings on
  // a page of their own (the in-page card has no title bar and no ⚙), so there the
  // button opens that page. Everywhere else it still toggles the floating panel.
  async function isAndroid() {
    try {
      const info = await api.runtime.getPlatformInfo?.()
      return info?.os === 'android'
    } catch {
      // No platform API: keep the desktop behaviour.
      return false
    }
  }

  async function openSettingsPage() {
    try {
      if (api.runtime.openOptionsPage) {
        await api.runtime.openOptionsPage()
        return
      }
    } catch {
      // Older Android builds have not always had it; a tab does the same job.
    }
    try {
      await api.tabs.create({ url: api.runtime.getURL('src/options/options.html') })
    } catch {
      // No tabs API either: nothing left to try.
    }
  }

  api.action?.onClicked.addListener(async (tab) => {
    if (await isAndroid()) {
      await openSettingsPage()
      return
    }
    if (!tab?.id) return
    try {
      await api.tabs.sendMessage(tab.id, { t: 'apweb:toggle-panel' })
    } catch {
      // The content script is missing — usually a tab that was already open
      // when the extension was installed or reloaded. Inject it on demand; its
      // own load guard makes a second injection a no-op.
      await injectContent(tab.id)
      try {
        await api.tabs.sendMessage(tab.id, { t: 'apweb:toggle-panel' })
      } catch {
        // chrome://, about:, the add-on store… nowhere to put a panel.
      }
    }
  })

  /* --------------------------- selection shortcut ---------------------------- */

  // The shortcut changes the same persisted setting as the ✦ button and the
  // select below it. Storage then broadcasts the change to every page and the
  // options page. A full-off mode has no third shortcut state: like the button,
  // the shortcut turns it on in 'auto' mode.
  let selectionToggle = Promise.resolve()

  api.commands?.onCommand.addListener((command) => {
    if (command !== TOGGLE_SELECTION_COMMAND) return undefined
    selectionToggle = selectionToggle.then(toggleSelectionTrigger).catch(() => {})
    return selectionToggle
  })

  async function toggleSelectionTrigger() {
    if (!api.storage?.local) return

    let settings = {}
    try {
      const stored = await api.storage.local.get(SETTINGS_KEY)
      const value = stored?.[SETTINGS_KEY]
      if (value && typeof value === 'object' && !Array.isArray(value)) settings = value
    } catch {
      return
    }

    const selectionTrigger = settings.selectionTrigger === 'auto' ? 'click' : 'auto'
    try {
      await api.storage.local.set({
        [SETTINGS_KEY]: { ...settings, selectionTrigger },
      })
    } catch {
      // Storage may be unavailable in private browsing; leave the state alone.
    }
  }

  async function injectContent(tabId) {
    try {
      await api.scripting.executeScript({
        target: { tabId },
        files: [
          'vendor/marked.umd.js',
          'vendor/purify.min.js',
          'src/shared/ai.js',
          'src/shared/markdown.js',
          'src/shared/store.js',
          'src/content/panel.js',
          'src/content/content.js',
        ],
      })
    } catch {
      // Restricted page or missing permission: nothing more to do.
    }
  }
})()

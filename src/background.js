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
  const api = globalThis.browser ?? globalThis.chrome
  const PORT_NAME = 'apweb-ai'
  const PANEL_STATE_PREFIX = 'apweb.panel.'

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
    if (!key || !api.storage?.session) return { open: false }
    try {
      const stored = await api.storage.session.get(key)
      return { open: stored?.[key] === true }
    } catch {
      return { open: false }
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

  api.action?.onClicked.addListener(async (tab) => {
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

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
  const SIDEBAR_PORT = 'apweb-sidebar'

  // Live browser-sidebar panels. A selection is routed here when one is open, so
  // the sidebar answers instead of the in-page panel (which would otherwise show
  // the same answer twice).
  const sidebarPorts = new Set()

  api.runtime.onConnect.addListener((port) => {
    if (port.name === SIDEBAR_PORT) {
      port.apwebVisible = true
      sidebarPorts.add(port)
      port.onMessage.addListener((message) => {
        if (message?.t === 'apweb:sidebar-state') port.apwebVisible = Boolean(message.visible)
      })
      port.onDisconnect.addListener(() => sidebarPorts.delete(port))
      return
    }

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

  /**
   * Route a selection question. Resolves `{ handled: true }` when at least one
   * visible sidebar took it, so the content script knows to stay quiet.
   */
  api.runtime.onMessage.addListener((message) => {
    if (message?.t !== 'apweb:selection') return undefined
    return routeSelection(message)
  })

  function routeSelection(message) {
    const inbox = [...sidebarPorts].filter((port) => port.apwebVisible)
    if (!inbox.length) return { handled: false }
    for (const port of inbox) {
      try {
        port.postMessage({ t: 'apweb:selection', payload: message.payload })
      } catch {
        // The sidebar went away between the check and the send.
      }
    }
    return { handled: true }
  }

  /**
   * Page zoom scales everything the page draws, including a content-script
   * overlay. The panel asks for the tab's zoom so it can scale itself back to a
   * constant on-screen size; `tabs.getZoom` needs no extra permission, and if it
   * is unavailable the panel simply behaves as at 100%.
   */
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.t !== 'apweb:get-zoom') return undefined
    const tabId = sender?.tab?.id
    const none = { zoom: 1 }
    if (tabId === undefined || !api.tabs?.getZoom) return none
    try {
      return api.tabs.getZoom(tabId).then(
        (zoom) => ({ zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 }),
        () => none,
      )
    } catch {
      return none
    }
  })

  // Zooming after load has to reach the panel too, not just the next page load.
  api.tabs?.onZoomChange?.addListener((info) => {
    if (info?.tabId === undefined) return
    const zoom = Number.isFinite(info.newZoomFactor) && info.newZoomFactor > 0 ? info.newZoomFactor : 1
    Promise.resolve(
      api.tabs.sendMessage(info.tabId, { t: 'apweb:zoom', zoom }),
    ).catch(() => {
      // No content script in that tab; nothing to update.
    })
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

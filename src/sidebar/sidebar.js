// The native Firefox sidebar: the same panel, filling the space Firefox gives
// it. Unlike the in-page panel it has no page document to read, so the content
// script builds the context and forwards the whole question over the port.
(async function () {
  'use strict'

  const AIStore = globalThis.AIStore
  const AIPanel = globalThis.AIPanel
  const api = globalThis.browser ?? globalThis.chrome

  await AIStore.load()

  const panel = AIPanel.createPanel({
    embed: true,
    fill: true,
    startOpen: true,
    hideClose: true,
  })
  document.getElementById('app').appendChild(panel.el)

  const port = api.runtime.connect({ name: 'apweb-sidebar' })

  // Tell the background whether this sidebar is actually on screen: a sidebar
  // that is merely loaded (bfcache) must not swallow questions meant for the
  // in-page panel.
  function reportVisibility() {
    try {
      port.postMessage({ t: 'apweb:sidebar-state', visible: document.visibilityState === 'visible' })
    } catch {
      // port closed
    }
  }
  reportVisibility()
  document.addEventListener('visibilitychange', reportVisibility)

  port.onMessage.addListener((message) => {
    if (message?.t === 'apweb:selection' && message.payload) {
      void panel.askSelection(message.payload)
    }
  })
})()

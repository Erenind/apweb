// The options page just hosts the same panel, opened straight into its settings
// form — so there is exactly one implementation of the settings UI to maintain.
(async function () {
  'use strict'

  const api = globalThis.browser ?? globalThis.chrome
  const AIStore = globalThis.AIStore
  const AIPanel = globalThis.AIPanel

  await AIStore.load()

  // On Android this page *is* the settings UI — the toolbar button opens it — so the
  // panel is told which platform it is on: that is what lists the Android-only
  // settings. Everywhere else it is the same settings form as the in-page ⚙.
  const platform = await Promise.resolve(api.runtime.getPlatformInfo?.()).catch(() => null)

  const panel = AIPanel.createPanel({
    embed: true,
    startOpen: true,
    startWithSettings: true,
    hideClose: true,
    platform,
  })

  document.getElementById('app').appendChild(panel.el)
})()

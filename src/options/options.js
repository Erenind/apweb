// The options page just hosts the same panel, opened straight into its settings
// form — so there is exactly one implementation of the settings UI to maintain.
(async function () {
  'use strict'

  const AIStore = globalThis.AIStore
  const AIPanel = globalThis.AIPanel

  await AIStore.load()

  const panel = AIPanel.createPanel({
    embed: true,
    startOpen: true,
    startWithSettings: true,
    hideClose: true,
  })

  document.getElementById('app').appendChild(panel.el)
})()

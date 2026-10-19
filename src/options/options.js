// The options page just hosts the same panel, opened straight into its settings
// form — so there is exactly one implementation of the settings UI to maintain.
(async function () {
  'use strict'

  const api = globalThis.browser ?? globalThis.chrome
  const AIStore = globalThis.AIStore
  const AIPanel = globalThis.AIPanel

  // Browser-facing strings — the installed name, the description and the toolbar
  // tooltip come from `_locales` through `manifest.json`, and this page's static text
  // comes from the same tables. Without it an English install still showed the
  // Chinese name, because nothing had been localised before our scripts ran. (The
  // panel's own UI stays on AII18n: it needs both languages at once to re-localise
  // untouched shipped prompts, and `getMessage` only ever returns the current one.)
  const message = (key) => {
    try {
      return api.i18n?.getMessage?.(key) || ''
    } catch {
      return ''
    }
  }
  // The `lang` attribute has to follow the locale that actually supplied the text,
  // which is why each `_locales` file states its own tag. `getUILanguage()` is not
  // used here: it can disagree with the locale `_locales` resolves to.
  document.documentElement.lang = message('uiLang') || 'en'
  const pageTitle = message('optionsPageTitle')
  if (pageTitle) document.title = pageTitle
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const text = message(node.getAttribute('data-i18n'))
    if (text) node.textContent = text
  }

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

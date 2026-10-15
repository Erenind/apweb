// Harness for src/background.js: the per-tab panel state. The browser APIs are
// stubbed; what is under test is our own wiring.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

const onConnect = []
const onMessage = []
const onRemoved = []
const sessionStore = new Map()
const removedKeys = []
// The toolbar button: what it was clicked with, and what it did.
const actionClicks = []
const toggles = []
const openedOptions = []
const createdTabs = []
let platformOs = 'linux'

globalThis.browser = {
  runtime: {
    onConnect: { addListener: (fn) => onConnect.push(fn) },
    onMessage: { addListener: (fn) => onMessage.push(fn) },
    // Android sends the button to the settings page instead of toggling the panel.
    getPlatformInfo: async () => ({ os: platformOs }),
    getURL: (path) => `moz-extension://test/${path}`,
    openOptionsPage: async () => {
      openedOptions.push(true)
    },
  },
  storage: {
    session: {
      get: async (key) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
      set: async (obj) => {
        for (const [key, value] of Object.entries(obj)) sessionStore.set(key, value)
      },
      remove: async (key) => {
        removedKeys.push(key)
        sessionStore.delete(key)
      },
    },
  },
  tabs: {
    sendMessage: async (tabId, message) => {
      toggles.push({ tabId, message })
    },
    create: async (options) => {
      createdTabs.push(options)
      return { id: 99 }
    },
    onRemoved: { addListener: (fn) => onRemoved.push(fn) },
  },
  action: { onClicked: { addListener: (fn) => actionClicks.push(fn) } },
  scripting: { executeScript: async () => {} },
}

function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel })
}

load('src/shared/i18n.js')
load('src/shared/ai.js')
load('src/background.js')

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`)
  }
}

// Firefox resolves a sendMessage with the first listener that returns a value.
async function dispatchRuntimeMessage(message, sender) {
  for (const fn of onMessage) {
    const result = fn(message, sender)
    if (result !== undefined) return await result
  }
  return undefined
}

const fromTab = (id, windowId = 1) => ({ tab: { id, windowId } })

;(async () => {
  check('a connect listener was registered', onConnect.length > 0)
  check('a message listener was registered', onMessage.length > 0)
  check('tab removal is watched', onRemoved.length > 0)

  console.log('per-tab panel state')
  const freshState = await dispatchRuntimeMessage({ t: 'apweb:panel-state' }, fromTab(42))
  check('a fresh tab starts closed', freshState?.open === false)
  // The content script takes its UI language from here, because a content script
  // may not have i18n access of its own.
  check('the reply carries the UI language', typeof freshState?.language === 'string')
  await dispatchRuntimeMessage({ t: 'apweb:set-panel-state', open: true }, fromTab(42))
  check(
    'the state is remembered for that tab',
    (await dispatchRuntimeMessage({ t: 'apweb:panel-state' }, fromTab(42)))?.open === true,
  )
  check(
    'another tab is unaffected',
    (await dispatchRuntimeMessage({ t: 'apweb:panel-state' }, fromTab(43)))?.open === false,
  )

  onRemoved[0](42)
  await new Promise((r) => setTimeout(r, 0))
  check('closing a tab sweeps its state', removedKeys.includes('apweb.panel.42'))

  check('unknown messages are not answered', (await dispatchRuntimeMessage({ t: 'nope' }, fromTab(1))) === undefined)

  console.log('toolbar button')
  const clickButton = async (tabId = 7) => {
    check('the button has a click listener', actionClicks.length > 0)
    for (const fn of actionClicks) await fn({ id: tabId })
  }

  platformOs = 'linux'
  await clickButton()
  check(
    'on a desktop the button toggles the panel in the tab',
    toggles.length === 1 && toggles[0].message?.t === 'apweb:toggle-panel',
  )
  check('and opens no settings page', openedOptions.length === 0)

  // Android has no draggable panel to toggle and no ⚙ inside the card: the button
  // is how you reach the settings.
  platformOs = 'android'
  await clickButton(8)
  check('on Android the button opens the settings page', openedOptions.length === 1)
  check('and leaves the page alone', toggles.length === 1)

  // A build without openOptionsPage still has to get there.
  delete globalThis.browser.runtime.openOptionsPage
  platformOs = 'android'
  await clickButton(9)
  check('without that API it opens the page in a tab', createdTabs.length === 1)
  check('pointing at the options page', /options\/options\.html$/.test(createdTabs[0]?.url ?? ''))

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})()

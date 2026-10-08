// Harness for src/background.js: sidebar routing and the per-tab panel state.
// The browser APIs are stubbed; what is under test is our own wiring.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

const onConnect = []
const onMessage = []
const onRemoved = []
const sentToTab = []
const sessionStore = new Map()
const removedKeys = []

// Mutable knobs the tests poke.
let sidebarOpen = true
const tabsToQuery = [{ id: 11 }, { id: 12 }, { id: 13 }]

globalThis.browser = {
  runtime: {
    onConnect: { addListener: (fn) => onConnect.push(fn) },
    onMessage: { addListener: (fn) => onMessage.push(fn) },
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
    query: async () => tabsToQuery,
    sendMessage: async (tabId, message) => {
      sentToTab.push([tabId, message])
    },
    onRemoved: { addListener: (fn) => onRemoved.push(fn) },
  },
  sidebarAction: {
    isOpen: async () => sidebarOpen,
  },
  action: { onClicked: { addListener: () => {} } },
  scripting: { executeScript: async () => {} },
}

function load(rel) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { filename: rel })
}

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

function makePort(name) {
  const port = {
    name,
    received: [],
    _msg: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._msg.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    postMessage: (message) => port.received.push(message),
    disconnect: () => port._disc.forEach((fn) => fn()),
  }
  return port
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

  console.log('selection routing')
  const question = { t: 'apweb:selection', payload: { text: 'hello' } }
  check(
    'without a sidebar the page answers',
    (await dispatchRuntimeMessage(question, fromTab(11)))?.handled === false,
  )

  const sidebar = makePort('apweb-sidebar')
  onConnect[0](sidebar)
  await new Promise((r) => setTimeout(r, 0))
  check('opening the sidebar tells every tab to close its panel', sentToTab.length === tabsToQuery.length)
  check('the takeover message is the right one', sentToTab[0]?.[1]?.t === 'apweb:sidebar-opened')

  check('a visible sidebar answers', (await dispatchRuntimeMessage(question, fromTab(11)))?.handled === true)
  check('the sidebar received the question', sidebar.received[0]?.payload?.text === 'hello')

  // A sidebar that is loaded but collapsed must not swallow the question — that
  // is what made 「划词即问」 look broken while the sidebar was open elsewhere.
  sidebarOpen = false
  check('a collapsed sidebar is skipped', (await dispatchRuntimeMessage(question, fromTab(11)))?.handled === false)
  sidebarOpen = true
  check('a visible sidebar answers again', (await dispatchRuntimeMessage(question, fromTab(11)))?.handled === true)

  sidebar.disconnect()
  check('a disconnected sidebar is dropped', (await dispatchRuntimeMessage(question, fromTab(11)))?.handled === false)

  console.log('per-tab panel state')
  check(
    'a fresh tab starts closed',
    (await dispatchRuntimeMessage({ t: 'apweb:panel-state' }, fromTab(42)))?.open === false,
  )
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})()

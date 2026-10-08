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
    sendMessage: async () => {},
    onRemoved: { addListener: (fn) => onRemoved.push(fn) },
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

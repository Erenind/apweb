// Harness for src/background.js: sidebar routing and zoom plumbing. The real
// browser APIs are stubbed; what is under test is our own wiring.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')

const onConnect = []
const onMessage = []
const onZoomChange = []
const sentToTab = []

globalThis.browser = {
  runtime: {
    onConnect: { addListener: (fn) => onConnect.push(fn) },
    onMessage: { addListener: (fn) => onMessage.push(fn) },
  },
  tabs: {
    getZoom: async (tabId) => (tabId === 1 ? 1.25 : 1),
    sendMessage: async (tabId, message) => {
      sentToTab.push([tabId, message])
    },
    onZoomChange: { addListener: (fn) => onZoomChange.push(fn) },
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
function dispatchRuntimeMessage(message, sender) {
  for (const fn of onMessage) {
    const result = fn(message, sender)
    if (result !== undefined) return result
  }
  return undefined
}

;(async () => {
  check('a connect listener was registered', onConnect.length > 0)
  check('message listeners were registered', onMessage.length >= 2)
  check('zoom-change listener was registered', onZoomChange.length > 0)

  console.log('selection routing')
  check('without a sidebar the page answers', dispatchRuntimeMessage({ t: 'apweb:selection' })?.handled === false)

  const sidebar = makePort('apweb-sidebar')
  onConnect[0](sidebar)
  const payload = { text: 'hello', action: 'explain-translate' }
  check('with a sidebar the sidebar answers', dispatchRuntimeMessage({ t: 'apweb:selection', payload })?.handled === true)
  check('the sidebar received the question', sidebar.received[0]?.payload === payload)

  // A sidebar that is loaded but not on screen must not swallow the question.
  sidebar._msg.forEach((fn) => fn({ t: 'apweb:sidebar-state', visible: false }))
  check('a hidden sidebar is skipped', dispatchRuntimeMessage({ t: 'apweb:selection', payload })?.handled === false)
  sidebar._msg.forEach((fn) => fn({ t: 'apweb:sidebar-state', visible: true }))
  check('a visible sidebar answers again', dispatchRuntimeMessage({ t: 'apweb:selection', payload })?.handled === true)

  console.log('zoom')
  const zoom = await dispatchRuntimeMessage({ t: 'apweb:get-zoom' }, { tab: { id: 1 } })
  check('tab zoom is reported', zoom?.zoom === 1.25)
  const fallback = await dispatchRuntimeMessage({ t: 'apweb:get-zoom' }, undefined)
  check('no tab falls back to 100%', fallback?.zoom === 1)
  check('unknown messages are not answered', dispatchRuntimeMessage({ t: 'nope' }) === undefined)

  onZoomChange[0]({ tabId: 7, newZoomFactor: 1.5 })
  await new Promise((r) => setTimeout(r, 0))
  check('zoom changes are forwarded to the page', sentToTab[0]?.[0] === 7 && sentToTab[0]?.[1]?.zoom === 1.5)

  sidebar.disconnect()
  check('a disconnected sidebar is dropped', dispatchRuntimeMessage({ t: 'apweb:selection', payload })?.handled === false)

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})()

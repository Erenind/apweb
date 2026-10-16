// Exercise the Chrome / Edge service worker with isolated API stubs.
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'))
const tick = () => new Promise((resolve) => setImmediate(resolve))
let failures = 0
function check(name, condition) {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`)
  }
}

async function runSuite() {
  console.log('background: chrome / edge')
  const onConnect = []
  const onMessage = []
  const onRemoved = []
  const actionClicks = []
  const sessionStore = new Map()
  const timers = new Map()
  const imported = []
  const toggles = []
  const openedOptions = []
  const createdTabs = []
  const injections = []
  let platformOs = 'linux'
  let platformCalls = 0
  let missingContent = false
  let storageFails = false
  let nextTimer = 0

  const api = {
    i18n: { getUILanguage: () => 'zh-CN' },
    runtime: {
      onConnect: { addListener: (fn) => onConnect.push(fn) },
      onMessage: { addListener: (fn) => onMessage.push(fn) },
      getPlatformInfo: async () => {
        platformCalls++
        return { os: platformOs }
      },
      getManifest: () => manifest,
      getURL: (file) => `chrome-extension://test/${file}`,
      openOptionsPage: async () => { openedOptions.push(true) },
    },
    storage: {
      session: {
        get: async (key) => {
          if (storageFails) throw new Error('storage unavailable')
          return sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}
        },
        set: async (obj) => {
          if (storageFails) throw new Error('storage unavailable')
          for (const [key, value] of Object.entries(obj)) sessionStore.set(key, value)
        },
        remove: async (key) => { sessionStore.delete(key) },
      },
    },
    tabs: {
      sendMessage: async (tabId, message) => {
        if (missingContent) throw new Error('no receiver')
        toggles.push({ tabId, message })
      },
      create: async (options) => {
        createdTabs.push(options)
        return { id: 99 }
      },
      onRemoved: { addListener: (fn) => onRemoved.push(fn) },
    },
    action: { onClicked: { addListener: (fn) => actionClicks.push(fn) } },
    scripting: {
      executeScript: async (options) => {
        injections.push(options)
        missingContent = false
      },
    },
  }
  // No window or document: the worker must start without a DOM or browser alias.
  const context = vm.createContext({
    chrome: api,
    AbortController,
    setInterval: (fn, delay) => {
      const id = ++nextTimer
      timers.set(id, { fn, delay })
      return id
    },
    clearInterval: (id) => { timers.delete(id) },
  })
  const load = (file) => vm.runInContext(
    fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file },
  )
  context.importScripts = (...files) => {
    for (const file of files) {
      const relative = path.posix.join(path.posix.dirname(manifest.background.service_worker), file)
      imported.push(relative)
      load(relative)
    }
  }
  const start = () => load(manifest.background.service_worker)
  start()
  check('listeners register synchronously',
    onConnect.length === 1 && onMessage.length === 1 && onRemoved.length === 1)
  check('worker loads localisation before the AI core and background listeners',
    JSON.stringify(imported) === JSON.stringify([
      'src/shared/i18n.js', 'src/shared/ai.js', 'src/background.js',
    ]))
  check('worker starts without browser, window or document',
    !context.browser && !context.window && !context.document)
  check('idle background has no keep-alive timers', timers.size === 0)

  // Model Chrome's callback contract, including versions that ignore Promises.
  function dispatch(message, sender) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message reply timed out')), 1000)
      const respond = (reply) => {
        clearTimeout(timeout)
        resolve(reply)
      }
      const result = onMessage[0](message, sender, respond)
      if (result !== true) {
        clearTimeout(timeout)
        if (result?.then) reject(new Error('listener returned a Promise instead of true'))
        else resolve(undefined)
      }
    })
  }
  const fromTab = (id) => ({ tab: { id } })
  const readState = (id) => dispatch({ t: 'apweb:panel-state' }, fromTab(id))
  const writeState = (id, open) => dispatch({ t: 'apweb:set-panel-state', open }, fromTab(id))

  check('a fresh tab starts closed', (await readState(42)).open === false)
  check('the reply carries the UI language', (await readState(42)).language === 'zh')
  check('saving state replies asynchronously', (await writeState(42, true)).ok === true)
  check('the tab keeps its state', (await readState(42)).open === true)
  check('another tab is unaffected', (await readState(43)).open === false)

  onConnect.length = onMessage.length = onRemoved.length = actionClicks.length = 0
  start()
  check('state survives a background restart', (await readState(42)).open === true)
  onRemoved[0](42)
  await tick()
  check('closing a tab sweeps its state', !sessionStore.has('apweb.panel.42'))
  check('unknown messages are not answered', await dispatch({ t: 'nope' }, fromTab(1)) === undefined)
  check('invalid messages are not answered', await dispatch(null, fromTab(1)) === undefined)
  check('options pages have no per-tab state',
    (await dispatch({ t: 'apweb:panel-state' }, {})).open === false)
  check('options pages cannot save per-tab state',
    (await dispatch({ t: 'apweb:set-panel-state', open: true }, {})).ok === false)
  storageFails = true
  check('failed reads still reply', (await readState(42)).open === false)
  check('failed writes still reply', (await writeState(42, true)).ok === false)
  storageFails = false

  await actionClicks[0]({ id: 7 })
  check('desktop toolbar toggles the panel',
    toggles.length === 1 && toggles[0].message.t === 'apweb:toggle-panel')
  check('desktop toolbar opens no options page', openedOptions.length === 0)
  missingContent = true
  await actionClicks[0]({ id: 8 })
  check('existing tabs receive every content dependency in manifest order',
    injections[0]?.target.tabId === 8 &&
    JSON.stringify(injections[0]?.files) === JSON.stringify(manifest.content_scripts[0].js) &&
    injections[0].files.includes('src/shared/i18n.js') &&
    injections[0].files.includes('src/shared/math.js') &&
    injections[0].files.includes('vendor/katex.min.js'))
  check('toolbar retries the toggle after injection', toggles.length === 2)
  platformOs = 'android'
  await actionClicks[0]({ id: 9 })
  check('Android toolbar opens settings', openedOptions.length === 1 && toggles.length === 2)
  delete api.runtime.openOptionsPage
  await actionClicks[0]({ id: 10 })
  check('Android falls back to an options tab',
    createdTabs[0]?.url === api.runtime.getURL('src/options/options.html'))

  function makePort(name = 'apweb-ai') {
    const messages = []
    const disconnects = []
    const port = {
      name,
      sent: [],
      onMessage: { addListener: (fn) => messages.push(fn) },
      onDisconnect: { addListener: (fn) => disconnects.push(fn) },
      postMessage: (message) => { port.sent.push(message) },
      receive: (message) => messages.forEach((fn) => fn(message)),
      disconnect: () => disconnects.forEach((fn) => fn()),
    }
    onConnect[0](port)
    return port
  }
  const streamChat = context.AICore.streamChat
  let release
  let signal
  context.AICore.streamChat = async function* (request) {
    signal = request.signal
    await new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
    yield { type: 'reasoning', text: 'thinking' }
    yield { type: 'content', text: 'answer' }
  }
  const port = makePort()
  check('connecting alone starts no keep-alive', timers.size === 0)
  port.receive({ t: 'chat', id: 'one', request: {} })
  check('an active chat starts keep-alive', timers.size === 1)
  const timer = [...timers.values()][0]
  check('keep-alive runs before the idle deadline', timer.delay > 0 && timer.delay < 30000)
  const callsBefore = platformCalls
  timer.fn()
  check('keep-alive calls an extension API while waiting for the first token',
    platformCalls === callsBefore + 1)
  release()
  await tick()
  check('reasoning, content and completion are delivered in order',
    JSON.stringify(port.sent) === JSON.stringify([
      { t: 'delta', id: 'one', kind: 'reasoning', text: 'thinking' },
      { t: 'delta', id: 'one', kind: 'content', text: 'answer' },
      { t: 'done', id: 'one' },
    ]))
  check('completion clears keep-alive', timers.size === 0)

  port.receive({ t: 'chat', id: 'two', request: {} })
  port.receive({ t: 'abort', id: 'two' })
  check('Stop aborts the fetch and clears keep-alive immediately', signal.aborted && timers.size === 0)
  await tick()
  check('Stop sends an aborted response', port.sent.at(-1).t === 'aborted')

  port.receive({ t: 'chat', id: 'three', request: {} })
  port.disconnect()
  check('disconnect aborts the fetch and clears keep-alive immediately',
    signal.aborted && timers.size === 0)
  await tick()
  context.AICore.streamChat = async function* () { throw new Error('network failed') }
  const errorPort = makePort()
  errorPort.receive({ t: 'chat', id: 'error', request: {} })
  await tick()
  check('errors are delivered and clear keep-alive',
    errorPort.sent[0]?.t === 'error' && errorPort.sent[0]?.message === 'network failed' &&
    timers.size === 0)
  context.AICore.streamChat = streamChat
}

;(async () => {
  await runSuite()
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exitCode = failures ? 1 : 0
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

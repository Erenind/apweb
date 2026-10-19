// Integration-ish harness for src/content/panel.js, using a tiny hand-written
// DOM + a fake WebExtension port. Not shipped; run with node.
const fs = require('fs')
const vm = require('vm')

const ROOT = require('path').join(__dirname, '..')

/* ------------------------------- mini DOM --------------------------------- */

// Event plumbing with real capture/bubble semantics and `stopPropagation`, so a
// bug where a bubble-phase listener on `window` is swallowed by the panel's own
// stopPropagation (that is what broke panel dragging) can actually show up here.
function listenersFor(target, type) {
  if (!target._listeners) target._listeners = {}
  if (!target._listeners[type]) target._listeners[type] = []
  return target._listeners[type]
}

function addListener(target, type, fn, opts) {
  const capture = Boolean(opts === true || (opts && opts.capture === true))
  listenersFor(target, type).push({ fn, capture })
}

function removeListener(target, type, fn, opts) {
  const list = target._listeners?.[type]
  if (!list) return
  const capture = Boolean(opts === true || (opts && opts.capture === true))
  const index = list.findIndex((entry) => entry.fn === fn && entry.capture === capture)
  if (index >= 0) list.splice(index, 1)
}

function eventPath(target) {
  const chain = []
  let node = target
  while (node && node !== globalThis.document && node !== globalThis) {
    chain.push(node)
    node = node.parentNode
  }
  const path = [...chain]
  if (!path.includes(globalThis.document)) path.push(globalThis.document)
  if (!path.includes(globalThis)) path.push(globalThis)
  return path
}

function dispatchEvent(target, type, extra = {}) {
  const path = eventPath(target)
  const event = {
    type,
    target,
    currentTarget: null,
    defaultPrevented: false,
    _stopped: false,
    _stoppedImmediate: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this._stopped = true
    },
    stopImmediatePropagation() {
      this._stopped = true
      this._stoppedImmediate = true
    },
    composedPath: () => path.slice(),
    ...extra,
  }

  const invoke = (node, capture) => {
    for (const entry of [...(node._listeners?.[type] ?? [])]) {
      if (entry.capture !== capture) continue
      if (event._stoppedImmediate) return
      event.currentTarget = node
      entry.fn(event)
    }
  }

  for (let i = path.length - 1; i >= 1; i--) {
    if (event._stopped) return event
    invoke(path[i], true)
  }
  if (!event._stopped) {
    invoke(target, true)
    invoke(target, false)
  }
  for (let i = 1; i < path.length; i++) {
    if (event._stopped) return event
    invoke(path[i], false)
  }
  return event
}

class Node {
  constructor() {
    this.parentNode = null
    this._attrs = {}
    this._listeners = {}
  }
  get isConnected() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return !!(node.documentElement || node === globalThis.document)
  }
  getRootNode() {
    let node = this
    while (node.parentNode) node = node.parentNode
    return node === globalThis.document ? globalThis.document : node
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null
  }
  addEventListener(type, fn, opts) {
    addListener(this, type, fn, opts)
  }
  removeEventListener(type, fn, opts) {
    removeListener(this, type, fn, opts)
  }
  dispatch(type, extra = {}) {
    return dispatchEvent(this, type, extra)
  }
  setAttribute(key, value) {
    this._attrs[key] = String(value)
    if (key === 'type') this.type = String(value)
  }
  getAttribute(key) {
    return key in this._attrs ? this._attrs[key] : null
  }
  removeAttribute(key) {
    delete this._attrs[key]
  }
  hasAttribute(key) {
    return key in this._attrs
  }
}

class Text extends Node {
  constructor(text) {
    super()
    this.nodeType = 3
    this.textContent = String(text)
  }
  get textContent() {
    return this._text
  }
  set textContent(value) {
    this._text = String(value)
  }
  get outerHTML() {
    return this._text
  }
}

class El extends Node {
  constructor(tag) {
    super()
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    // CSSStyleDeclaration reads back '' for unset properties; a plain object would
    // read back undefined and make restore-the-page assertions lie. The custom
    // property API is here too: the Android card publishes its height through it.
    const styleTarget = {
      setProperty(name, value) {
        styleTarget[name] = String(value)
      },
      getPropertyValue(name) {
        return styleTarget[name] ?? ''
      },
      removeProperty(name) {
        delete styleTarget[name]
        return ''
      },
    }
    this.style = new Proxy(
      styleTarget,
      {
        get(target, prop) {
          if (typeof prop === 'symbol') return target[prop]
          return target[prop] ?? ''
        },
        set(target, prop, value) {
          target[prop] = value
          return true
        },
      },
    )
    this.hidden = false
    this.value = ''
    this.checked = false
    this.selected = false
    this.disabled = false
    this.type = undefined
    this.scrollTop = 0
    this.scrollHeight = 100
    this.dataset = {}
    this.shadowRoot = null
    const self = this
    this.classList = {
      add(...names) {
        const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean))
        names.forEach((n) => set.add(n))
        self.className = [...set].join(' ')
      },
      remove(...names) {
        const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean))
        names.forEach((n) => set.delete(n))
        self.className = [...set].join(' ')
      },
      contains(name) {
        return String(self.className || '').split(/\s+/).includes(name)
      },
      toggle(name, force) {
        const has = this.contains(name)
        const want = force === undefined ? !has : force
        if (want) this.add(name)
        else this.remove(name)
        return want
      },
    }
  }
  attachShadow() {
    const root = new El('#shadow-root')
    root.nodeType = 11
    this.shadowRoot = root
    root.host = this
    return root
  }
  get innerText() {
    return this.textContent
  }
  set innerText(value) {
    this.textContent = value
  }
  get nodeName() {
    return this.tagName
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1)
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }
  remove() {
    this.parentNode?.removeChild(this)
  }
  get textContent() {
    if (this._text !== undefined) return this._text
    return this.childNodes.map((n) => n.textContent).join('')
  }
  set textContent(value) {
    this._text = String(value)
    this.childNodes = []
  }
  get innerHTML() {
    return this._html ?? ''
  }
  set innerHTML(value) {
    this._html = String(value)
    this.childNodes = []
  }
  descendants() {
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        out.push(child)
        if (child.nodeType === 1) walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelector(selector) {
    const found = this.descendants().find((n) => {
      if (n.nodeType !== 1) return false
      if (selector.startsWith('.')) return n.classList.contains(selector.slice(1))
      return n.tagName === selector.toUpperCase()
    })
    return found || null
  }
  querySelectorAll(selector) {
    return this.descendants().filter((n) => {
      if (n.nodeType !== 1) return false
      if (selector.startsWith('.')) return n.classList.contains(selector.slice(1))
      return n.tagName === selector.toUpperCase()
    })
  }
  closest(selector) {
    let node = this
    while (node) {
      if (node.nodeType === 1) {
        if (selector.startsWith('.')) {
          if (node.classList.contains(selector.slice(1))) return node
        } else if (node.tagName === selector.toUpperCase()) return node
      }
      node = node.parentNode
    }
    return null
  }
  getBoundingClientRect() {
    return { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }
  }
  get offsetWidth() {
    return 380
  }
  get offsetHeight() {
    return 40
  }
  get clientWidth() {
    // 1200px window with a 15px classic scrollbar; the real code measures this
    // to keep the page's scrollbar visible beside a docked panel.
    return this._clientWidth ?? 0
  }
  // Counted, not a no-op: on Android the card must not steal focus (that is what
  // threw the on-screen keyboard over the answer).
  focus() {
    this.focusCount = (this.focusCount ?? 0) + 1
  }
  select() {}
}

const document = new El('#document')
document.nodeType = 9
document.documentElement = new El('html')
document.documentElement._clientWidth = 1185
document.body = new El('body')
document.documentElement.appendChild(document.body)
document.createElement = (tag) => new El(tag)
document.createTextNode = (text) => new Text(text)
// The corner icons are inline SVG: real nodes, built with createElementNS.
document.createElementNS = (_ns, tag) => new El(tag)
document.implementation = { createHTMLDocument: () => document }

globalThis.Node = Node
globalThis.document = document
globalThis.window = globalThis
globalThis.innerWidth = 1200
globalThis.innerHeight = 800
globalThis.navigator = {}
globalThis.location = { href: 'https://example.com/article' }
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis._listeners = {}
globalThis.addEventListener = (type, fn, opts) => addListener(globalThis, type, fn, opts)
globalThis.removeEventListener = (type, fn, opts) => removeListener(globalThis, type, fn, opts)
document.execCommand = () => true

// The content script reads the page selection through window.getSelection().
let fakeSelection = null
globalThis.getSelection = () => fakeSelection

/* ---------------------------- fake storage / port -------------------------- */

const storage = {}
const ports = []
const storageListeners = []
const contentMessageListeners = []
const sentToBackground = []

function makePort(name) {
  const port = {
    name,
    /** Every message the panel sent, so tests can inspect the request. */
    received: [],
    _msg: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._msg.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    emit: (m) => port._msg.forEach((fn) => fn(m)),
    postMessage(m) {
      port.received.push(m)
      if (m.t === 'chat') {
        // A relay that rejects `temperature` answers 400 before streaming; the
        // panel is expected to retry once without the field.
        if (rejectTemperatureOnce && m.request?.temperature !== undefined) {
          rejectTemperatureOnce = false
          setTimeout(() => port.emit({ t: 'error', id: m.id, message: 'temperature is deprecated for this model' }), 0)
          return
        }
        setTimeout(() => {
          port.emit({ t: 'delta', id: m.id, kind: 'content', text: '你好' })
          port.emit({ t: 'delta', id: m.id, kind: 'content', text: '，世界' })
          port.emit({ t: 'delta', id: m.id, kind: 'reasoning', text: '想一下' })
          port.emit({ t: 'done', id: m.id })
        }, 0)
      }
    },
    disconnect() {},
  }
  ports.push(port)
  return port
}

globalThis.browser = {
  // The panel's UI language follows the browser's; pin it to Chinese so the
  // assertions below can read the strings, and exercise English separately in
  // logic.test.js.
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    onChanged: {
      addListener: (fn) => storageListeners.push(fn),
    },
    local: {
      async get(key) {
        // A real browser hands back a fresh clone, never the live object.
        const clone = (value) => JSON.parse(JSON.stringify(value ?? null))
        return key == null
          ? Object.fromEntries(Object.entries(storage).map(([k, v]) => [k, clone(v)]))
          : { [key]: storage[key] === undefined ? undefined : clone(storage[key]) }
      },
      async set(obj) {
        // A real browser fires onChanged in every context, including the one
        // that wrote — this is what exercises the store's echo suppression.
        const changes = {}
        for (const key of Object.keys(obj)) {
          // storage.local structured-clones on write: the snapshot is frozen, so
          // mutating the live object afterwards must not change it.
          const cloned = JSON.parse(JSON.stringify(obj[key] ?? null))
          storage[key] = cloned
          changes[key] = { newValue: cloned }
        }
        setTimeout(() => {
          for (const fn of storageListeners) fn(changes, 'local')
        }, 0)
      },
    },
  },
  runtime: {
    connect: ({ name }) => makePort(name),
    getURL: (path) => `moz-extension://test/${path}`,
    // The content script asks this to pick the Android layout.
    getPlatformInfo: async () => {
      platformInfoCalls++
      return { os: platformOs }
    },
    onMessage: { addListener: (fn) => contentMessageListeners.push(fn) },
    sendMessage: async (message) => {
      sentToBackground.push(message)
      if (message?.t === 'apweb:panel-state') return { open: tabPanelOpen }
      if (message?.t === 'apweb:set-panel-state') {
        tabPanelOpen = message.open === true
        return { ok: true }
      }
      return undefined
    },
  },
}

// What the background would hold for "is the floating panel showing in this tab".
let tabPanelOpen = false
// What `runtime.getPlatformInfo` answers, and whether it was asked at all.
let platformOs = 'linux'
let platformInfoCalls = 0
// Set by a test that wants the next chat request to fail on `temperature` once.
let rejectTemperatureOnce = false

function dispatchToContent(message) {
  for (const fn of [...contentMessageListeners]) fn(message)
}

/** The most recent chat request the panel handed to the background. */
function lastChatRequest() {
  for (let i = ports.length - 1; i >= 0; i--) {
    const chat = ports[i].received.find((m) => m?.t === 'chat')
    if (chat) return chat.request
  }
  return null
}

/** Simulate another surface (options page / another tab) writing storage. */
function remoteWrite(key, value) {
  const cloned = JSON.parse(JSON.stringify(value ?? null))
  storage[key] = cloned
  for (const fn of storageListeners) fn({ [key]: { newValue: cloned } }, 'local')
}

// DOMPurify/marked can't run on the mini DOM, so the sanitised-markdown layer is
// stubbed here; its own logic is a near-verbatim port.
globalThis.AIMarkdown = { renderMarkdown: (src) => (src ? `<p>${src}</p>` : '') }

function load(rel) {
  vm.runInThisContext(fs.readFileSync(`${ROOT}/${rel}`, 'utf8'), { filename: rel })
}

load('src/shared/i18n.js')
load('src/shared/ai.js')
load('src/shared/store.js')
load('src/content/panel.js')
load('src/content/content.js')

const AICore = globalThis.AICore
const AIStore = globalThis.AIStore
const AIPanel = globalThis.AIPanel

let failures = 0
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`)
  }
}
const tick = () => new Promise((r) => setTimeout(r, 10))

;(async () => {
  await AIStore.load()

  console.log('first-run defaults')
  check('there is no panel display-mode setting', !('panelMode' in AIStore.state.settings))
  check('the floating panel starts closed', tabPanelOpen === false)
  // `rem` resolves against the page's <html> font size, not our own 15px, so a
  // page using the 62.5% trick would shrink the whole panel. Keep it in px.
  const panelCss = fs.readFileSync(`${ROOT}/src/content/panel.css`, 'utf8')
  // Comments discuss these values by name, so match against the declarations only.
  const panelRules = panelCss.replace(/\/\*[\s\S]*?\*\//g, '')
  check('panel styles use absolute px, never rem', !/\d\s*rem\b/.test(panelRules))
  // U+2303/U+2304 are missing from plenty of fonts, which made the fold arrow
  // disappear; it is drawn from borders instead.
  const panelJs = fs.readFileSync(`${ROOT}/src/content/panel.js`, 'utf8')
  check('the fold arrow is CSS-drawn, not a glyph', !/[\u2303\u2304]/.test(panelJs))
  // Specificity trap: `.apweb-composer button` (0,1,1) also matches the fold
  // toggle and beats `.apweb-composer__toggle` (0,1,0), which forced the notch to
  // 54.4x36.8px — a big patch over the transcript with its arrow clipped away.
  check('no bare `.apweb-composer button` rule', !/\.apweb-composer\s+button\b/.test(panelRules))
  // The exact pixels are hand-tuned, so assert the shape of the layout instead:
  // the notch sits just above the composer's top edge (the old 54.4x36.8 bug put
  // its bottom ~25px inside), and when folded it is fully above that edge, where
  // the panel's rounded corner cannot clip it away.
  const toggleRule = panelRules.match(/\.apweb-composer__toggle\s*\{([^}]*)\}/)?.[1] ?? ''
  const toggleTop = parseFloat(toggleRule.match(/top:\s*(-?[\d.]+)px/)?.[1])
  const toggleHeight = parseFloat(toggleRule.match(/height:\s*([\d.]+)px/)?.[1])
  const toggleBottom = toggleTop + toggleHeight
  check(
    'the notch hugs the composer top edge',
    Number.isFinite(toggleBottom) && toggleBottom >= -8 && toggleBottom <= 2,
  )
  const collapsedToggleRule =
    panelRules.match(/\.apweb-composer--collapsed\s+\.apweb-composer__toggle\s*\{([^}]*)\}/)?.[1] ?? ''
  const collapsedTop = parseFloat(collapsedToggleRule.match(/top:\s*(-?[\d.]+)px/)?.[1])
  check(
    'the folded notch stays fully above the composer edge',
    Number.isFinite(collapsedTop) && collapsedTop + toggleHeight <= 0,
  )
  AIStore.updateSettings({ providerId: 'deepseek', model: 'deepseek-flash', apiKey: 'sk-test' })

  console.log('panel construction')
  const panel = AIPanel.createPanel({
    startOpen: true,
    getSelection: () => '',
    describeContext: () => null,
    pageInfo: () => ({ title: '测试页', url: 'https://example.com/x' }),
  })
  check('returns element', panel.el && panel.el.nodeType === 1)
  check('root has scope class', panel.el.classList.contains('apweb-scope'))
  check('panel starts open', panel.isOpen() === true)
  check('header shows model', panel.el.textContent.includes('deepseek-flash'))

  console.log('settings form')
  panel.openSettings()
  const settingsEl = panel.el.querySelector('.apweb-settings')
  check('settings element exists', !!settingsEl)
  check('settings visible after open', settingsEl.hidden === false)
  check('settings has providers select', settingsEl.querySelectorAll('select').length >= 4)
  check('settings rendered inputs', settingsEl.querySelectorAll('input').length >= 4)
  check('settings has prompt editors', !!settingsEl.querySelector('.apweb-prompts'))
  check(
    'checkboxes are rendered as switches',
    settingsEl
      .querySelectorAll('input')
      .filter((i) => i.type === 'checkbox')
      .every((i) => i.classList.contains('apweb-switch')),
  )

  console.log('api key follows the model')
  const fieldInput = (name) =>
    settingsEl.querySelectorAll('input').find((i) => i.getAttribute('data-field') === name)
  const keyInput = fieldInput('api-key')
  const modelInput = fieldInput('model')
  check('the key field is present', !!keyInput && !!modelInput)

  // Save a key for the model that is selected now.
  keyInput.value = 'sk-for-first'
  keyInput.dispatch('input', { target: keyInput })
  check('the key is stored for the current pair', AIStore.state.settings.apiKey === 'sk-for-first')

  // Typing a different model name switches to that pair's key — which is empty —
  // instead of leaving the previous model's key in the box.
  modelInput.value = 'deepseek-v4-pro'
  modelInput.dispatch('input', { target: modelInput })
  check('the field follows the new model', keyInput.value === '')
  check('the new pair has no key yet', AIStore.state.settings.apiKey === '')
  check(
    'the old key stays bound to the old model',
    AIStore.state.settings.apiKeys['https://api.deepseek.com|deepseek-flash'] === 'sk-for-first',
  )
  check('the hint names the new model', keyInput.closest('label').textContent.includes('deepseek-v4-pro'))

  // With the box cleared, typing can no longer resurrect the old key under the
  // new model — the bug behind "the api-key didn't change with the model".
  keyInput.value = 'sk-for-second'
  keyInput.dispatch('input', { target: keyInput })
  check(
    'the new model gets its own key',
    AIStore.state.settings.apiKeys['https://api.deepseek.com|deepseek-v4-pro'] === 'sk-for-second',
  )
  modelInput.value = 'deepseek-flash'
  modelInput.dispatch('input', { target: modelInput })
  check('switching back shows the first model’s key', keyInput.value === 'sk-for-first')

  console.log('switching to 自定义 does not inherit the preset')
  const providerSelectOf = () =>
    settingsEl.querySelectorAll('select').find((s) => s.getAttribute('data-field') === 'provider')
  providerSelectOf().dispatch('change', { target: { value: 'custom' } })
  const customBase = settingsEl.querySelectorAll('input').find((i) => i.getAttribute('data-field') === 'base-url')
  const customKey = settingsEl.querySelectorAll('input').find((i) => i.getAttribute('data-field') === 'api-key')
  check('the custom address field appears, empty', !!customBase && customBase.value === '')
  check('and the preset address is not carried over', AIStore.state.settings.baseUrl === '')
  check('nor is the preset model', AIStore.state.settings.model === '')
  check('nor the preset key', customKey.value === '' && AIStore.state.settings.apiKey === '')
  check(
    'the preset key is still stored under its own endpoint+model',
    AIStore.state.settings.apiKeys['https://api.deepseek.com|deepseek-flash'] === 'sk-for-first',
  )

  // Filling in a relay remembers it, so switching away and back restores it.
  customBase.value = 'https://relay.example/v1'
  customBase.dispatch('input', { target: customBase })
  const customModel = settingsEl.querySelectorAll('input').find((i) => i.getAttribute('data-field') === 'model')
  customModel.value = 'my-model'
  customModel.dispatch('input', { target: customModel })
  check(
    'the custom endpoint is remembered',
    AIStore.state.settings.customBaseUrl === 'https://relay.example/v1' &&
      AIStore.state.settings.customModel === 'my-model',
  )

  providerSelectOf().dispatch('change', { target: { value: 'deepseek' } })
  check('a preset restores its own address', AIStore.state.settings.baseUrl === 'https://api.deepseek.com')
  check('and its own model', AIStore.state.settings.model === 'deepseek-flash')
  providerSelectOf().dispatch('change', { target: { value: 'custom' } })
  check(
    'switching back to 自定义 restores the relay',
    AIStore.state.settings.baseUrl === 'https://relay.example/v1' &&
      AIStore.state.settings.model === 'my-model',
  )
  // Leave the harness on the preset the later tests expect.
  providerSelectOf().dispatch('change', { target: { value: 'deepseek' } })

  console.log('prompt editors start folded')
  const prompts = settingsEl.querySelector('.apweb-prompts')
  check('prompt editor collapsed by default', !prompts.open)
  prompts.open = true
  prompts.dispatch('toggle', {})
  // Switching the selection prompt re-renders the form; the fold must survive.
  const promptSelect = settingsEl
    .querySelectorAll('select')
    .find((s) => s.getAttribute('data-field') === 'selection-prompt-select')
  promptSelect.dispatch('change', { target: promptSelect })
  check('prompt editor stays open across a re-render', panel.el.querySelector('.apweb-prompts').open === true)

  // Flip a setting through the form and make sure it persists to the store.
  const triggerSelect = settingsEl
    .querySelectorAll('select')
    .find((s) => s.getAttribute('data-field') === 'selection-trigger')
  check('trigger select present', !!triggerSelect)
  triggerSelect.value = 'auto'
  triggerSelect.dispatch('change', { target: triggerSelect })
  check('trigger setting saved', AIStore.state.settings.selectionTrigger === 'auto')

  console.log('prominent 划词即问 toggle')
  const modeBtn = panel.el.querySelector('.apweb-mode__btn')
  check('toggle button present', !!modeBtn)
  check('toggle now lives inside the settings form', !!settingsEl.querySelector('.apweb-mode__btn'))
  check('toggle is lit while the trigger is auto', modeBtn.classList.contains('apweb-mode__btn--on'))
  check('toggle says 已开启 when on', modeBtn.textContent.includes('已开启'))

  // The toggle edits the same setting as the 划词提问 select right below it, so the
  // form must follow immediately instead of only after it is rebuilt.
  const triggerSelectEl = settingsEl
    .querySelectorAll('select')
    .find((s) => s.getAttribute('data-field') === 'selection-trigger')
  const actionSelectEl = settingsEl
    .querySelectorAll('select')
    .find((s) => s.getAttribute('data-field') === 'selection-action')
  check('the select shows the mode the form was built with', triggerSelectEl.value === 'auto')

  // The settings-page twin of the Android corner switch: on = 选中即发送 ('auto'),
  // off = 选中后先弹出按钮 ('click'). The two can never disagree.
  modeBtn.dispatch('click', {})
  check('the toggle falls back to the button mode', AIStore.state.settings.selectionTrigger === 'click')
  check('toggle label changes', modeBtn.textContent === globalThis.AII18n.STRINGS.zh.modeOff)
  check('the select follows it immediately', triggerSelectEl.value === 'click')
  check('划词用途 stays live', actionSelectEl.disabled === false)
  check('the hint describes the button', panel.el.querySelector('.apweb-mode__hint').textContent.includes('小按钮'))

  modeBtn.dispatch('click', {})
  check('pressing again goes back to sending straight away', AIStore.state.settings.selectionTrigger === 'auto')
  check('the select follows that too', triggerSelectEl.value === 'auto')
  check('划词用途 is live again', actionSelectEl.disabled === false)
  check('the toggle is lit again', modeBtn.classList.contains('apweb-mode__btn--on'))

  // 「完全关闭」 is only reachable from the select; the button reads it as off.
  AIStore.updateSettings({ selectionTrigger: 'off' })
  check('a fully disabled trigger shows as off', !modeBtn.classList.contains('apweb-mode__btn--on'))
  check('and says why', panel.el.querySelector('.apweb-mode__hint').textContent.includes('完全关闭'))
  check('a selection does nothing, so 划词用途 greys out', actionSelectEl.disabled === true)
  AIStore.updateSettings({ selectionTrigger: 'auto' })

  console.log('streamed composer turn')
  const composerBody = panel.el.querySelector('.apweb-composer__body')
  const composerRow = panel.el.querySelector('.apweb-composer')
  const composerToggle = panel.el.querySelector('.apweb-composer__toggle')
  check('composer has a fold toggle', !!composerToggle)
  check('composer starts unfolded', !composerRow.classList.contains('apweb-composer--collapsed'))
  check('unfolded body has no pinned height', composerBody.style.height === '')
  composerToggle.dispatch('click', {})
  check('folding collapses the body to zero height', composerBody.style.height === '0px')
  check('folding marks the composer collapsed', composerRow.classList.contains('apweb-composer--collapsed'))
  check('the chevron is CSS-drawn', !!composerToggle.querySelector('.apweb-composer__chevron'))
  check('the arrow flips up', composerToggle.getAttribute('aria-expanded') === 'false')
  check('the clipped input leaves the tab order', composerBody.querySelectorAll('textarea')[0].tabIndex === -1)
  check('the folded state is saved', AIStore.state.settings.composerOpen === false)
  composerToggle.dispatch('click', {})
  check('unfolding animates to the natural height', composerBody.style.height === '100px')
  await new Promise((r) => setTimeout(r, 260))
  check('then hands the height back to auto', composerBody.style.height === '')
  check('the arrow points down again', composerToggle.getAttribute('aria-expanded') === 'true')
  check('the unfolded state is saved', AIStore.state.settings.composerOpen === true)

  const textarea = panel.el.querySelector('.apweb-composer').querySelectorAll('textarea')[0]
  check('composer textarea present', !!textarea)
  textarea.value = '这是什么？'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()

  const msgs = AIStore.state.messages
  check('two messages recorded', msgs.length === 2)
  check('user message kept', msgs[0]?.content === '这是什么？')
  check('assistant reply streamed', msgs[1]?.content === '你好，世界')
  check('reasoning captured', msgs[1]?.reasoning === '想一下')
  const bodies = panel.el.querySelectorAll('.apweb-msg__body')
  check('assistant html rendered', bodies.some((b) => b.innerHTML.includes('你好，世界')))
  check('thinking block shown', panel.el.querySelectorAll('.apweb-thinking').some((d) => d.hidden === false))

  // Messages carry DOM references in memory; storage must only ever see plain
  // data, or structured cloning rejects and the history is lost.
  const stored = storage['apweb.ai.messages'] ?? []
  check('stored messages are plain data', stored.every((m) => !('_body' in m) && !('_el' in m)))
  check(
    'stored messages keep their content',
    stored.some((m) => m.role === 'assistant' && m.content === '你好，世界'),
  )

  console.log('selection turn')
  const before = AIStore.state.messages.length
  await panel.askSelection({ text: 'serendipity' })
  await tick()
  await tick()
  const after = AIStore.state.messages.slice(before)
  check('selection added user turn', after[0]?.content === 'serendipity')
  check('selection user turn has forModel guard', (after[0]?.forModel ?? '').includes(AICore.SCOPE_RULE))
  check('selection turn got a reply', after[1]?.content === '你好，世界')

  console.log('clear + close')
  panel.el
    .querySelectorAll('button')
    .find((b) => b.textContent === '清空')
    .dispatch('click', {})
  check('messages cleared', AIStore.state.messages.length === 0)
  panel.setOpen(false)
  check('panel closes', panel.isOpen() === false)
  check('panel hidden', panel.el.querySelector('.apweb-panel').hidden === true)

  console.log('content script: selection -> pill -> ask')
  // content.js boots asynchronously (buildHost + AIStore.load + createPanel).
  await tick()
  await tick()
  // The settings step above left the trigger on "auto"; go back to the default
  // "click" behaviour so the pill path is what gets exercised.
  AIStore.updateSettings({ selectionTrigger: 'click' })
  const host = document.documentElement.childNodes.find((n) => n.id === 'apweb-root-host')
  check('shadow host injected', !!host && !!host.shadowRoot)
  const shadowPill = host?.shadowRoot?.querySelector('.apweb-pill')
  check('pill built in shadow root', !!shadowPill)
  check('pill starts hidden', shadowPill?.hidden === true)

  check('no corner launcher is injected', !host?.shadowRoot?.querySelector('.apweb-launch'))
  check('the floating panel starts hidden', host.shadowRoot.querySelector('.apweb-panel').hidden === true)

  const paragraph = new El('p')
  paragraph.innerText = 'A short paragraph that contains the target word and a bit more text around it.'
  document.body.appendChild(paragraph)
  const wordNode = new Text('serendipity')
  paragraph.appendChild(wordNode)
  const range = {
    startContainer: wordNode,
    toString: () => 'serendipity',
    getBoundingClientRect: () => ({ left: 40, top: 100, right: 120, bottom: 120, width: 80, height: 20 }),
  }
  fakeSelection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: wordNode,
    focusNode: wordNode,
    getRangeAt: () => range,
    toString: () => 'serendipity',
  }
  document.dispatch('mouseup', { target: paragraph, composedPath: () => [paragraph] })
  await new Promise((r) => setTimeout(r, 420))

  check('pill appears after selection settles', shadowPill?.hidden === false)
  check(
    'pill labelled with the configured action',
    shadowPill?.textContent.includes(
      AICore.selectionActionLabel(
        AIStore.state.settings.selectionAction,
        AIStore.state.settings.selectionPrompts,
      ),
    ),
  )

  const beforeSelection = AIStore.state.messages.length
  shadowPill.dispatch('click', { composedPath: () => [shadowPill] })
  await tick()
  await tick()
  const selectionTurn = AIStore.state.messages.slice(beforeSelection)
  check('pill click asked about the selection', selectionTurn[0]?.content === 'serendipity')
  check('pill click opens the panel', host.shadowRoot.querySelector('.apweb-panel').hidden === false)
  // Open state lives per tab in the background, not in the shared settings.
  check('opening the panel is recorded for this tab', tabPanelOpen === true)
  check('selection turn answered', selectionTurn[1]?.content === '你好，世界')
  check(
    'short selection attached the paragraph as context',
    (selectionTurn[0]?.context ?? '').includes('选中处那一段'),
  )

  console.log('switching 划词用途 takes effect')
  const askWith = async (word) => {
    const node = new Text(word)
    paragraph.appendChild(node)
    range.startContainer = node
    range.toString = () => word
    fakeSelection.anchorNode = node
    fakeSelection.focusNode = node
    fakeSelection.toString = () => word
    document.dispatch('mouseup', { target: paragraph, composedPath: () => [paragraph] })
    await new Promise((r) => setTimeout(r, 420))
    shadowPill.dispatch('click', { composedPath: () => [shadowPill] })
    await tick()
    await tick()
    return lastChatRequest()
  }

  // Which action is the default is the user's choice, so switch to *some other*
  // one rather than assuming a particular pair.
  const defaultAction = AIStore.state.settings.selectionAction
  const otherAction = AIStore.state.settings.selectionPrompts.find((p) => p.id !== defaultAction).id
  check('the turn above used the default mode', (selectionTurn[0]?.action ?? defaultAction) === defaultAction)
  AIStore.updateSettings({ selectionAction: otherAction })
  const explainRequest = await askWith('ubiquitous')
  const otherPrompt = AICore.findPrompt(AIStore.state.settings.selectionPrompts, otherAction).text
  check('the newly chosen mode is the system message', explainRequest?.messages?.[0]?.content === otherPrompt)
  check(
    'questions asked in the old mode are left out of the request',
    !explainRequest.messages.some((m) => String(m.content).includes('serendipity')),
  )
  const followUp = await askWith('perseverance')
  check(
    'questions in the current mode stay in the request',
    followUp.messages.some((m) => String(m.content).includes('ubiquitous')),
  )
  check('and the newest question is last', String(followUp.messages.at(-1).content).includes('perseverance'))

  console.log('drag by the header')
  const contentPanel = host.shadowRoot.querySelector('.apweb-panel')
  const dragHead = host.shadowRoot.querySelector('.apweb-panel__head')
  // Make the shim's rect reflect the panel's inline styles, so the geometry the
  // drag/resize code reads back and saves is the geometry it just set.
  contentPanel.getBoundingClientRect = () => {
    const px = (value, fallback) => {
      const n = parseFloat(value)
      return Number.isFinite(n) ? n : fallback
    }
    const width = px(contentPanel.style.width, 380)
    const height = px(contentPanel.style.height, 600)
    // No inline left means the stylesheet's `right: 16px` is still in charge.
    const anchoredRight = !contentPanel.style.left
    const left = anchoredRight ? 1200 - px(contentPanel.style.right, 16) - width : px(contentPanel.style.left, 10)
    const top = px(contentPanel.style.top, 16)
    return { left, top, right: left + width, bottom: top + height, width, height }
  }
  check('drag handle present', !!dragHead)
  dragHead.dispatch('pointerdown', {
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 100,
    target: dragHead,
  })
  // Move and release *over the panel*: the panel stops mouse events from
  // reaching the page, which is exactly what used to swallow the release and
  // leave the panel stuck to the cursor. A window capture listener still fires.
  dragHead.dispatch('pointermove', { pointerId: 7, clientX: 260, clientY: 180 })
  check(
    'panel follows the pointer',
    // started at 1200 - 16 - 380 = 804, moved +160/+80, clamped to the window.
    contentPanel.style.left === '812px' && contentPanel.style.top === '96px',
  )
  check('panel switches off its right anchor', contentPanel.style.right === 'auto')
  dragHead.dispatch('pointerup', { pointerId: 7 })
  dragHead.dispatch('pointermove', { pointerId: 7, clientX: 620, clientY: 520 })
  check('drag ends on pointerup', contentPanel.style.left === '812px')
  check('window drag listeners removed', (globalThis._listeners.pointermove ?? []).length === 0)
  check(
    'the position is saved',
    AIStore.state.settings.panelRect?.left === 812 && AIStore.state.settings.panelRect?.top === 96,
  )

  console.log('resize grip')
  const resizeHandle = host.shadowRoot.querySelector('.apweb-resize-handle')
  check('resize grip present', !!resizeHandle)
  resizeHandle.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 812, clientY: 96, target: resizeHandle })
  resizeHandle.dispatch('pointermove', { pointerId: 9, clientX: 912, clientY: 136 })
  check(
    'the panel grows with the grip',
    contentPanel.style.width === '480px' && contentPanel.style.height === '640px',
  )
  resizeHandle.dispatch('pointerup', { pointerId: 9 })
  check(
    'the size is saved',
    AIStore.state.settings.panelRect?.width === 480 && AIStore.state.settings.panelRect?.height === 640,
  )
  check('window resize listeners removed', (globalThis._listeners.pointermove ?? []).length === 0)

  console.log('esc hides the panel')
  check('the panel is open', host.shadowRoot.querySelector('.apweb-panel').hidden === false)
  host.shadowRoot.querySelector('.apweb-scope').dispatch('keydown', { key: 'Escape' })
  check('esc inside the panel closes it', host.shadowRoot.querySelector('.apweb-panel').hidden === true)

  // Reopen through the pill, then close with Esc while focus is on the page: the
  // panel stops key events, so the page-level listener is the only one that can
  // see those.
  shadowPill.dispatch('click', { composedPath: () => [shadowPill] })
  await tick()
  check('the pill reopens the panel', host.shadowRoot.querySelector('.apweb-panel').hidden === false)
  document.dispatch('keydown', { key: 'Escape' })
  check('esc on the page closes it', host.shadowRoot.querySelector('.apweb-panel').hidden === true)

  console.log('geometry is restored')
  const restored = AIPanel.createPanel({ startOpen: true })
  const restoredPanel = restored.el.querySelector('.apweb-panel')
  check(
    'a new panel opens where the last one was left',
    // 812 + the new 480px width would hang off a 1200px window, so the restore
    // clamps back to 712 to keep the whole panel on screen.
    restoredPanel.style.left === '712px' && restoredPanel.style.top === '96px',
  )
  check(
    'and at the size the last one was left',
    restoredPanel.style.width === '480px' && restoredPanel.style.height === '640px',
  )
  restored.destroy()

  // Encodes the root cause of the stuck-drag bug: because the panel calls
  // stopPropagation on mouse events, a bubble-phase listener on window never
  // sees a release that happens over the panel — only a capture-phase one does.
  let bubbleSaw = false
  let captureSaw = false
  const bubbleProbe = () => {
    bubbleSaw = true
  }
  const captureProbe = () => {
    captureSaw = true
  }
  globalThis.addEventListener('mouseup', bubbleProbe)
  globalThis.addEventListener('mouseup', captureProbe, true)
  dragHead.dispatch('mouseup', { target: dragHead })
  globalThis.removeEventListener('mouseup', bubbleProbe)
  globalThis.removeEventListener('mouseup', captureProbe, true)
  check('panel blocks bubble-phase listeners on window', bubbleSaw === false)
  check('capture-phase listener on window still fires', captureSaw === true)

  console.log('per-tab panel state')
  // A fresh content script (i.e. a new page in this tab) reads the state back.
  tabPanelOpen = true
  const reopened = AIPanel.createPanel({ startOpen: tabPanelOpen })
  check('a new page in the same tab restores the state', reopened.isOpen() === true)
  reopened.destroy()
  tabPanelOpen = false

  console.log('cross-surface sync')
  remoteWrite('apweb.ai.messages', [{ role: 'assistant', content: '来自侧栏' }])
  await tick()
  check(
    'remote messages render in the panel',
    panel.el.querySelector('.apweb-msg__body').innerHTML.includes('来自侧栏'),
  )
  check('remote messages land in the store', AIStore.state.messages[0].content === '来自侧栏')

  console.log('temperature reaches the request only when the model takes one')
  AIStore.updateSettings({ providerId: 'moonshot', model: 'kimi-k3', apiKey: 'sk-moonshot' })
  textarea.value = '温度测试'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()
  const fixedRequest = lastChatRequest()
  check('kimi-k3 is asked without a temperature field', fixedRequest?.temperature === undefined)
  check('but the messages still go out', Array.isArray(fixedRequest?.messages) && fixedRequest.messages.length > 0)

  AIStore.updateSettings({ providerId: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' })
  textarea.value = '温度测试二'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()
  check('a range-taking Moonshot model gets our temperature', lastChatRequest()?.temperature === 0.3)

  console.log('temperature setting')
  const sendTemperature = settingsEl
    .querySelectorAll('input')
    .find((i) => i.getAttribute('data-field') === 'send-temperature')
  const temperatureValue = settingsEl
    .querySelectorAll('input')
    .find((i) => i.getAttribute('data-field') === 'temperature')
  check('the form exposes a temperature switch and value', !!sendTemperature && !!temperatureValue)
  check('it starts on', AIStore.state.settings.sendTemperature !== false)

  sendTemperature.checked = false
  sendTemperature.dispatch('change', { target: sendTemperature })
  check('turning it off is remembered', AIStore.state.settings.sendTemperature === false)
  check('and greys out the value box', temperatureValue.disabled === true)

  AIStore.updateSettings({ providerId: 'custom', baseUrl: 'https://plain.example/v1', model: 'm1', apiKey: 'k' })
  const beforeOff = ports.length
  textarea.value = '不带温度'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()
  const offRequest = ports
    .slice(beforeOff)
    .map((port) => port.received.find((m) => m.t === 'chat')?.request)
    .filter(Boolean)[0]
  check('the request goes out with no temperature field', offRequest && offRequest.temperature === undefined)

  sendTemperature.checked = true
  sendTemperature.dispatch('change', { target: sendTemperature })
  check('turning it back on is remembered', AIStore.state.settings.sendTemperature === true)
  temperatureValue.value = '0.8'
  temperatureValue.dispatch('input', { target: temperatureValue })
  check('the value box edits the setting', AIStore.state.settings.temperature === 0.8)
  temperatureValue.value = '9'
  temperatureValue.dispatch('input', { target: temperatureValue })
  check('the value is clamped to the allowed range', AIStore.state.settings.temperature === 2)

  console.log('a relay that rejects temperature')
  AIStore.updateSettings({
    providerId: 'custom',
    baseUrl: 'https://modelsell.cc/v1',
    model: 'claude-fable-5',
    apiKey: 'sk-x',
    temperature: 0.3,
  })
  rejectTemperatureOnce = true
  const beforeRetry = ports.length
  const answersBefore = AIStore.state.messages.length
  textarea.value = '温度被拒绝'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()
  const attempts = ports
    .slice(beforeRetry)
    .map((port) => port.received.find((m) => m.t === 'chat')?.request)
    .filter(Boolean)
  check('the first attempt sent the temperature', attempts[0]?.temperature === 0.3)
  check('the retry left it out', attempts.length === 2 && attempts[1].temperature === undefined)
  check('and the answer still arrives', AIStore.state.messages.at(-1).content === '你好，世界')
  check(
    'the endpoint+model is remembered as no-temperature',
    AIStore.state.settings.temperatureOffSlots['https://modelsell.cc/v1|claude-fable-5'] === true,
  )
  check('the note says so', !AIStore.state.settings.sendTemperature === false)

  const beforeNext = ports.length
  textarea.value = '再问一次'
  textarea.dispatch('input', { target: textarea })
  textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, target: textarea })
  await tick()
  await tick()
  const nextRequest = ports
    .slice(beforeNext)
    .map((port) => port.received.find((m) => m.t === 'chat')?.request)
    .filter(Boolean)[0]
  check('later turns skip the field from the start', nextRequest && nextRequest.temperature === undefined)
  check('the transcript kept the earlier turns', AIStore.state.messages.length > answersBefore)

  console.log('android layout')
  // The other half of the selection story, on the desktop: a mouse drag fires
  // `selectionchange` after every character, so pausing mid-drag must not send the
  // half-selected text — the check waits for the button to come up.
  // Park the selection first: an earlier test's mouseup may still have a settle
  // timer in flight, and it would fire in the middle of the scenario below.
  const parkedSelection = fakeSelection
  fakeSelection = null
  await new Promise((r) => setTimeout(r, 350))
  fakeSelection = parkedSelection
  AIStore.updateSettings({ selectionTrigger: 'auto' })
  const dragWord = new Text('halfway')
  paragraph.appendChild(dragWord)
  range.startContainer = dragWord
  range.toString = () => 'halfway'
  fakeSelection.anchorNode = dragWord
  fakeSelection.focusNode = dragWord
  fakeSelection.toString = () => 'halfway'
  document.dispatch('mousedown', { target: paragraph, composedPath: () => [paragraph] })
  document.dispatch('selectionchange', { target: document })
  await new Promise((r) => setTimeout(r, 420))
  check(
    'nothing is sent while the drag is still going',
    !AIStore.state.messages.some((message) => message.content === 'halfway'),
  )
  document.dispatch('mouseup', { target: paragraph, composedPath: () => [paragraph] })
  await new Promise((r) => setTimeout(r, 420))
  await tick()
  check(
    'and it goes out once the drag ends',
    AIStore.state.messages.some((message) => message.content === 'halfway'),
  )

  // Same story with the keyboard: holding shift+arrow extends the selection once
  // per repeat, and only the release may send it.
  const keysWord = new Text('held')
  paragraph.appendChild(keysWord)
  range.startContainer = keysWord
  range.toString = () => 'held'
  fakeSelection.anchorNode = keysWord
  fakeSelection.focusNode = keysWord
  fakeSelection.toString = () => 'held'
  document.dispatch('keydown', { key: 'ArrowRight', shiftKey: true, target: paragraph })
  document.dispatch('selectionchange', { target: document })
  await new Promise((r) => setTimeout(r, 420))
  check(
    'nothing is sent while the key is still held',
    !AIStore.state.messages.some((message) => message.content === 'held'),
  )
  document.dispatch('keyup', { key: 'ArrowRight', shiftKey: true, target: paragraph })
  await new Promise((r) => setTimeout(r, 420))
  await tick()
  check(
    'and it goes out when the key is released',
    AIStore.state.messages.some((message) => message.content === 'held'),
  )

  // The content script asks the platform before it builds the panel; a desktop
  // answer keeps the floating window it has always had.
  check('the content script asked for the platform', platformInfoCalls > 0)
  check('a desktop keeps the floating window', !host.shadowRoot.querySelector('.apweb-fab'))
  check('android resolves to the corner layout', AIPanel.isMobileLayout({ os: 'android' }) === true)
  check('another platform does not', AIPanel.isMobileLayout({ os: 'linux' }) === false)

  // A phone never fires mouseup for a long-press selection: the word is picked and
  // then the handles are dragged, so `selectionchange` is all that arrives. Without
  // it the pill never appears and nothing is ever sent — the bug this covers.
  AIStore.updateSettings({ selectionTrigger: 'click' })
  shadowPill.hidden = true
  const touchWord = new Text('полиглот')
  paragraph.appendChild(touchWord)
  range.startContainer = touchWord
  range.toString = () => 'полиглот'
  fakeSelection.anchorNode = touchWord
  fakeSelection.focusNode = touchWord
  fakeSelection.toString = () => 'полиглот'
  document.dispatch('selectionchange', { target: document })
  await new Promise((r) => setTimeout(r, 420))
  check('a touch selection brings the pill up too', shadowPill.hidden === false)
  check(
    'and with the configured action on it',
    shadowPill.textContent.includes(
      AICore.selectionActionLabel(
        AIStore.state.settings.selectionAction,
        AIStore.state.settings.selectionPrompts,
      ),
    ),
  )

  // `navigator` is a getter on the node global, so it has to be redefined rather
  // than assigned (the harness's own `globalThis.navigator = {}` is a no-op).
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:142.0) Gecko/142.0' },
    configurable: true,
  })
  check('the user agent covers a silent platform', AIPanel.isMobileLayout() === true)
  Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  globalThis.matchMedia = (query) => ({ matches: /pointer:\s*coarse/.test(query) })
  check('a touch-only device gets it too', AIPanel.isMobileLayout() === true)
  delete globalThis.matchMedia
  check('and a mouse-only desktop does not', AIPanel.isMobileLayout() === false)

  // The stylesheet has to keep the card clear of the round controls and anchor it
  // to the bottom; the pixels themselves are hand-tuned, so assert the shape.
  const androidCardRule =
    panelRules.match(/\.apweb-scope--mobile \.apweb-panel\s*\{([^}]*)\}/)?.[1] ?? ''
  check(
    'the card is anchored to the bottom corner',
    /inset:\s*auto\b/.test(androidCardRule) && /max-height:/.test(androidCardRule),
  )
  check('and stops short of the switch column', androidCardRule.includes('var(--ap-dock-column)'))
  check('with the height setting as its ceiling', androidCardRule.includes('var(--ap-card-max'))
  const fabRule = panelRules.match(/\.apweb-fab\s*\{([^}]*)\}/)?.[1] ?? ''
  check('the corner controls are round', /border-radius:\s*999px/.test(fabRule))
  check('and pale while 划词即问 is off', fabRule.includes('var(--ap-fab-bg)'))
  check('holding one cannot start a text selection', /user-select:\s*none/.test(fabRule))
  const fabOnRule = panelRules.match(/\.apweb-fab--on\s*\{([^}]*)\}/)?.[1] ?? ''
  check('the switch goes green while it is on', fabOnRule.includes('var(--ap-accent)'))
  check(
    'answers-only hides what you sent',
    /\.apweb-panel--answers-only \.apweb-msg--user\s*\{[^}]*display:\s*none/.test(panelRules),
  )

  AIStore.updateSettings({ selectionTrigger: 'click' })
  const android = AIPanel.createPanel({ startOpen: true, mobile: true })
  check('the scope is flagged as the mobile layout', android.el.classList.contains('apweb-scope--mobile'))
  const androidCard = android.el.querySelector('.apweb-panel')
  check('the card is only the conversation and the composer', !android.el.querySelector('.apweb-panel__head'))
  check('and its height setting reaches the stylesheet', android.el.style.getPropertyValue('--ap-card-max') === '220px')
  check(
    'nothing is placed by script: the stylesheet owns the geometry',
    androidCard.style.left === '' && androidCard.style.top === '' && androidCard.style.width === '',
  )
  check('an anchored card has no resize grip', !android.el.querySelector('.apweb-resize-handle'))

  const starBtn = android.el.querySelector('.apweb-fab--switch')
  const cornerClose = android.el.querySelector('.apweb-fab--close')
  const dock = android.el.querySelector('.apweb-dock')
  check('the corner switch is there', !!starBtn && !!cornerClose)
  check('with the close button above the switch', dock?.childNodes[0] === cornerClose && dock?.childNodes[1] === starBtn)
  check('the switch carries the star svg', !!starBtn?.querySelector('svg'))
  check('and the close button the cross svg', !!cornerClose?.querySelector('svg'))
  check(
    'the switch is pale while a selection waits for the button',
    starBtn?.classList.contains('apweb-fab--on') === false &&
      starBtn?.getAttribute('aria-pressed') === 'false',
  )
  check('and says what a tap will do', (starBtn?.title ?? '').includes('选中即发送'))
  check('the close button shows with the open card', cornerClose?.hidden === false)

  starBtn.dispatch('click', {})
  check('tapping the switch sends on select', AIStore.state.settings.selectionTrigger === 'auto')
  check(
    'and the switch goes green',
    starBtn.classList.contains('apweb-fab--on') === true &&
      starBtn.getAttribute('aria-pressed') === 'true',
  )
  starBtn.dispatch('click', {})
  check('tapping it again goes back to the button', AIStore.state.settings.selectionTrigger === 'click')
  check('and the switch goes pale', starBtn.classList.contains('apweb-fab--on') === false)

  // A trigger set to 「完全关闭」 on the settings page reads as off here too, and a
  // tap still means "send on select".
  AIStore.updateSettings({ selectionTrigger: 'off' })
  check('a fully disabled trigger keeps the switch pale', !starBtn.classList.contains('apweb-fab--on'))
  check('and says so', (starBtn.title ?? '').includes('完全关闭'))
  starBtn.dispatch('click', {})
  check('tapping from fully off switches the sending on', AIStore.state.settings.selectionTrigger === 'auto')
  AIStore.updateSettings({ selectionTrigger: 'click' })

  cornerClose.dispatch('click', {})
  check('the corner close button hides the card', android.isOpen() === false && androidCard.hidden === true)
  check('and hides itself with it', cornerClose.hidden === true)

  // With no title bar, holding the switch is the only way back to the card. The tap
  // the browser sends afterwards must not also flip 划词即问.
  starBtn.dispatch('pointerdown', {})
  await new Promise((r) => setTimeout(r, 520))
  check('a long press opens the card', android.isOpen() === true)
  starBtn.dispatch('pointerup', {})
  starBtn.dispatch('click', {})
  check('and the click after it does nothing', AIStore.state.settings.selectionTrigger === 'click')
  android.setOpen(false)
  starBtn.dispatch('pointerdown', {})
  starBtn.dispatch('pointerup', {})
  starBtn.dispatch('click', {})
  check('a short tap still toggles', AIStore.state.settings.selectionTrigger === 'auto')
  AIStore.updateSettings({ selectionTrigger: 'click' })

  // The card must not steal focus: on a phone that is what threw the on-screen
  // keyboard over the answer the moment a word was selected.
  const androidInput = androidCard.querySelector('.apweb-composer').querySelectorAll('textarea')[0]
  androidInput.focusCount = 0
  android.setOpen(false)
  android.setOpen(true)
  check('opening the card leaves the keyboard down', !androidInput.focusCount)
  const desktopInput = panel.el.querySelector('.apweb-composer').querySelectorAll('textarea')[0]
  desktopInput.focusCount = 0
  panel.setOpen(false)
  panel.setOpen(true)
  check('a desktop panel still focuses its input', desktopInput.focusCount === 1)

  // The two Android-only settings live on the settings page, which is an embedded
  // panel: on Android it lists them, on a desktop it does not.
  check('a desktop settings form lists no Android section', !settingsEl.querySelector('.apweb-settings__section'))
  const optionsPanel = AIPanel.createPanel({
    embed: true,
    startOpen: true,
    startWithSettings: true,
    platform: { os: 'android' },
  })
  const optionsSettings = optionsPanel.el.querySelector('.apweb-settings')
  check('the Android settings page lists its own section', !!optionsSettings.querySelector('.apweb-settings__section'))
  check(
    'and still keeps the desktop arrangement around it',
    !optionsPanel.el.classList.contains('apweb-scope--mobile'),
  )
  const heightInput = optionsSettings
    .querySelectorAll('input')
    .find((input) => input.getAttribute('data-field') === 'panel-max-height')
  check('with the card height', !!heightInput && heightInput.value === '220')
  const sentSwitch = optionsSettings
    .querySelectorAll('input')
    .find((input) => input.getAttribute('data-field') === 'show-sent-content')
  check('and the “show what I sent” switch', !!sentSwitch && sentSwitch.checked === true)

  heightInput.value = '900'
  heightInput.dispatch('input', { target: heightInput })
  check('the height is saved', AIStore.state.settings.panelMaxHeight === 900)
  check('and reaches the card without a reload', android.el.style.getPropertyValue('--ap-card-max') === '900px')
  heightInput.value = '9'
  heightInput.dispatch('input', { target: heightInput })
  check('a silly height is clamped, not stored', AIStore.state.settings.panelMaxHeight === 160)

  sentSwitch.checked = false
  sentSwitch.dispatch('change', { target: sentSwitch })
  check('the switch is saved', AIStore.state.settings.showSentContent === false)
  check('and the card drops what you sent', androidCard.classList.contains('apweb-panel--answers-only'))
  sentSwitch.checked = true
  sentSwitch.dispatch('change', { target: sentSwitch })
  check('turning it back on restores it', !androidCard.classList.contains('apweb-panel--answers-only'))

  // The settings-page button and the corner switch are the same on/off: whichever
  // one is pressed, the other follows.
  const optionsModeBtn = optionsSettings.querySelector('.apweb-mode__btn')
  optionsModeBtn.dispatch('click', {})
  check('the settings page can switch sending on', AIStore.state.settings.selectionTrigger === 'auto')
  check('and the corner switch goes green with it', starBtn.classList.contains('apweb-fab--on'))
  starBtn.dispatch('click', {})
  check('the corner switch can go back to the button', AIStore.state.settings.selectionTrigger === 'click')
  check('and the settings button goes pale with it', !optionsModeBtn.classList.contains('apweb-mode__btn--on'))
  optionsPanel.destroy()
  android.destroy()

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('harness crashed:', error)
  process.exit(2)
})

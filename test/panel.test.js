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
    // read back undefined and make restore-the-page assertions lie.
    this.style = new Proxy(
      {},
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
  focus() {}
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
    _msg: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._msg.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    emit: (m) => port._msg.forEach((fn) => fn(m)),
    postMessage(m) {
      if (m.t === 'chat') {
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
  storage: {
    onChanged: {
      addListener: (fn) => storageListeners.push(fn),
    },
    local: {
      async get(key) {
        return key == null ? { ...storage } : { [key]: storage[key] }
      },
      async set(obj) {
        Object.assign(storage, obj)
        // A real browser fires onChanged in every context, including the one
        // that wrote — this is what exercises the store's echo suppression.
        const changes = {}
        for (const key of Object.keys(obj)) changes[key] = { newValue: obj[key] }
        setTimeout(() => {
          for (const fn of storageListeners) fn(changes, 'local')
        }, 0)
      },
    },
  },
  runtime: {
    connect: ({ name }) => makePort(name),
    getURL: (path) => `moz-extension://test/${path}`,
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

function dispatchToContent(message) {
  for (const fn of [...contentMessageListeners]) fn(message)
}

/** Simulate another surface (options page / another tab) writing storage. */
function remoteWrite(key, value) {
  storage[key] = value
  for (const fn of storageListeners) fn({ [key]: { newValue: value } }, 'local')
}

// DOMPurify/marked can't run on the mini DOM, so the sanitised-markdown layer is
// stubbed here; its own logic is a near-verbatim port.
globalThis.AIMarkdown = { renderMarkdown: (src) => (src ? `<p>${src}</p>` : '') }

function load(rel) {
  vm.runInThisContext(fs.readFileSync(`${ROOT}/${rel}`, 'utf8'), { filename: rel })
}

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
  check('toggle reflects auto mode', modeBtn.classList.contains('apweb-mode__btn--on'))
  check('toggle says 已开启 when on', modeBtn.textContent.includes('已开启'))
  modeBtn.dispatch('click', {})
  check('toggle switches back to click mode', AIStore.state.settings.selectionTrigger === 'click')
  check('toggle label resets', modeBtn.textContent.includes('启动划词即问'))

  console.log('streamed composer turn')
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
  check('pill labelled with the action', shadowPill?.textContent.includes('解释并翻译'))

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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})().catch((error) => {
  console.error('harness crashed:', error)
  process.exit(2)
})

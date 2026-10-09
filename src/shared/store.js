// Settings + chat persistence, backed by browser.storage.local (shared between
// content scripts, the background page and the options page).
//
// This is the reader's `src/lib/chat-storage.js` with localStorage swapped for
// the extension storage API and Vue's `reactive`/`watch` replaced by a tiny
// subscribe/notify pair. The normalisation rules (preset endpoints win, keys
// are remembered per endpoint+model, thinking is remembered per provider) are
// ported unchanged, so a config saved by one of these builds behaves like one
// from the reader.
(function () {
  'use strict'

  const AICore = globalThis.AICore
  const api = globalThis.browser ?? globalThis.chrome

  const SETTINGS_KEY = 'apweb.ai.settings'
  const MESSAGES_KEY = 'apweb.ai.messages'
  const MAX_MESSAGES = 60
  // Only these fields are persisted. The panel hangs its DOM nodes off each
  // message (`_body`, `_thinking`…) so a streamed reply can be updated in place;
  // DOM nodes are not structured-cloneable, so writing the objects as-is would
  // make browser.storage.local.set reject and silently lose the whole history.
  // `action` records which 划词用途 asked a selection turn, so the panel can keep
  // history from a mode you have since switched away from out of the request.
  const MESSAGE_FIELDS = ['role', 'content', 'forModel', 'context', 'reasoning', 'action']

  const { DEFAULT_SETTINGS, apiKeySlot, findPrompt, providerById } = AICore

  async function read(key, fallback) {
    try {
      const result = await api.storage.local.get(key)
      const raw = result?.[key]
      return raw === undefined ? fallback : raw
    } catch {
      return fallback
    }
  }

  // Recent local writes, so the storage change events that echo them back can be
  // ignored instead of costing a needless re-render. A list rather than the last
  // value: two writes can be in flight at once (`pushMessage` runs twice in a
  // turn), and the echo of the first can arrive after the second was written.
  const recentWrites = new Map()
  const RECENT_WRITES_KEPT = 20

  function rememberWrite(key, value) {
    let json
    try {
      json = JSON.stringify(value)
    } catch {
      return
    }
    const list = recentWrites.get(key) ?? []
    list.push(json)
    if (list.length > RECENT_WRITES_KEPT) list.shift()
    recentWrites.set(key, list)
  }

  /** True when this change is just our own write coming back to us. */
  function isOwnEcho(key, value) {
    const list = recentWrites.get(key)
    if (!list?.length) return false
    let json
    try {
      json = JSON.stringify(value)
    } catch {
      return false
    }
    const index = list.lastIndexOf(json)
    if (index < 0) return false
    list.splice(index, 1)
    return true
  }

  async function write(key, value) {
    rememberWrite(key, value)
    try {
      await api.storage.local.set({ [key]: value })
    } catch {
      // Quota or private mode: the app keeps working, just without persistence.
    }
  }

  function plainMessage(message) {
    const out = {}
    for (const field of MESSAGE_FIELDS) {
      if (message[field] !== undefined) out[field] = message[field]
    }
    return out
  }

  /**
   * A preset provider owns its endpoint. Now that the address field is only
   * shown for "自定义", a URL saved by an older build would otherwise keep
   * working while being invisible — so preset providers always resolve to
   * their own address.
   */
  function normalize(value) {
    const provider = providerById(value.providerId)
    const merged =
      provider.id === 'custom'
        ? value
        : { ...value, baseUrl: provider.baseUrl, model: value.model || provider.model }

    const apiKeys = { ...(merged.apiKeys ?? {}) }
    // Carry a key saved by an older build (a single `apiKey`) into its slot.
    // Note the emptiness check: DEFAULT_SETTINGS already supplies `apiKeys: {}`,
    // so testing for the property's absence would never match.
    if (Object.keys(apiKeys).length === 0 && merged.apiKey) {
      apiKeys[apiKeySlot(merged)] = merged.apiKey
    }

    // Thinking is remembered per provider; a single `thinking: true` from an
    // earlier build becomes that provider's preference.
    const thinkingByProvider = { ...(merged.thinkingByProvider ?? {}) }
    if (!merged.thinkingByProvider && merged.thinking) {
      thinkingByProvider[merged.providerId] = true
    }

    // The prompt libraries are stored in full so edits stick, but a stored list
    // may be missing entries a newer build added (or be empty altogether).
    const composerPrompts = mergePrompts(
      DEFAULT_SETTINGS.composerPrompts,
      merged.composerPrompts ?? merged.systemPrompts,
    )
    const selectionPrompts = mergePrompts(DEFAULT_SETTINGS.selectionPrompts, merged.selectionPrompts)

    // A reader-era `selectionAction: 'off'` meant "don't auto-send"; map it onto
    // the trigger switch rather than leaving a prompt list with no selection.
    const legacyOff = merged.selectionAction === 'off'
    const selectionTrigger =
      merged.selectionTrigger === 'auto' || merged.selectionTrigger === 'off'
        ? merged.selectionTrigger
        : legacyOff
          ? 'off'
          : 'click'

    const contextMode = merged.contextMode === 'page' ? 'page' : 'paragraph'

    // The panel's last geometry, kept only if it is complete — a half-written
    // record would place the panel at NaN.
    const storedRect = merged.panelRect
    const panelRect =
      storedRect &&
      typeof storedRect === 'object' &&
      ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(storedRect[key]))
        ? {
            left: storedRect.left,
            top: storedRect.top,
            width: storedRect.width,
            height: storedRect.height,
          }
        : null

    return {
      ...DEFAULT_SETTINGS,
      ...merged,
      apiKeys,
      apiKey: apiKeys[apiKeySlot(merged)] ?? '',
      thinkingByProvider,
      thinking: thinkingByProvider[merged.providerId] ?? false,
      contextMode,
      panelRect,
      selectionTrigger,
      composerPrompts,
      composerPromptId:
        findPrompt(composerPrompts, merged.composerPromptId ?? merged.systemPromptId)?.id ??
        composerPrompts[0].id,
      selectionPrompts,
      selectionAction:
        findPrompt(selectionPrompts, merged.selectionAction)?.id ?? selectionPrompts[0].id,
    }
  }

  /** Stored entries win (the user may have edited them); new defaults are added. */
  function mergePrompts(defaults, stored) {
    if (!Array.isArray(stored) || stored.length === 0) return defaults.map((item) => ({ ...item }))
    const result = stored
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        text: typeof item.text === 'string' ? item.text : '',
      }))
    for (const item of defaults) {
      if (!result.some((entry) => entry.id === item.id)) result.push({ ...item })
    }
    return result
  }

  const state = {
    settings: normalize({ ...DEFAULT_SETTINGS }),
    messages: [],
    loaded: false,
  }

  const listeners = new Set()

  /**
   * Notify subscribers. `meta.remote` marks a change that came from another
   * context (the options page, another tab) rather than from this one — the panel
   * uses it to know when to rebuild its message list.
   */
  function emit(meta) {
    for (const fn of [...listeners]) {
      try {
        fn(state, meta ?? { remote: false })
      } catch (error) {
        console.error('[apweb] store listener failed', error)
      }
    }
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  async function load() {
    const [storedSettings, storedMessages] = await Promise.all([
      read(SETTINGS_KEY, {}),
      read(MESSAGES_KEY, []),
    ])
    state.settings = normalize({ ...DEFAULT_SETTINGS, ...(storedSettings ?? {}) })
    state.messages = Array.isArray(storedMessages) ? storedMessages.slice(-MAX_MESSAGES) : []
    state.loaded = true
    emit({ remote: false })
    return state
  }

  // Keep every surface in step: the in-page panel, the options page and other
  // tabs all read and write this one store, so a change made in any of them has
  // to reach the others.
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return
    let touched = false
    if (changes[SETTINGS_KEY]) {
      const value = changes[SETTINGS_KEY].newValue ?? {}
      if (!isOwnEcho(SETTINGS_KEY, value)) {
        state.settings = normalize({ ...DEFAULT_SETTINGS, ...value })
        touched = true
      }
    }
    if (changes[MESSAGES_KEY]) {
      const value = changes[MESSAGES_KEY].newValue
      if (!isOwnEcho(MESSAGES_KEY, value)) {
        state.messages = Array.isArray(value) ? value.slice(-MAX_MESSAGES) : []
        touched = true
      }
    }
    if (touched) emit({ remote: true })
  })

  function saveSettings() {
    return write(SETTINGS_KEY, { ...state.settings })
  }

  function saveMessages() {
    return write(MESSAGES_KEY, state.messages.slice(-MAX_MESSAGES).map(plainMessage))
  }

  /* ------------------------------ settings edits ----------------------------- */

  function updateSettings(patch) {
    const settings = state.settings

    // The key field edits the slot for whatever is selected right now; changing
    // the model / provider / address loads that pair's key instead.
    const editsKey = Object.prototype.hasOwnProperty.call(patch, 'apiKey')
    if (editsKey) {
      const slot = apiKeySlot(settings)
      // Clearing a key removes the entry instead of leaving an empty one behind.
      if (patch.apiKey) settings.apiKeys[slot] = patch.apiKey
      else delete settings.apiKeys[slot]
    }

    // Same shape as keys: the switch edits the current provider's preference
    // and changing provider loads that provider's preference.
    const editsThinking = Object.prototype.hasOwnProperty.call(patch, 'thinking')
    if (editsThinking) settings.thinkingByProvider[settings.providerId] = patch.thinking

    Object.assign(settings, patch)

    const switchesKey = 'providerId' in patch || 'model' in patch || 'baseUrl' in patch
    if (switchesKey && !editsKey) {
      settings.apiKey = settings.apiKeys[apiKeySlot(settings)] ?? ''
    }
    if ('providerId' in patch && !editsThinking) {
      settings.thinking = settings.thinkingByProvider[settings.providerId] ?? false
    }

    saveSettings()
    emit()
  }

  /* ------------------------------- prompt editing ---------------------------- */

  function promptListKey(kind) {
    return kind === 'composer' ? 'composerPrompts' : 'selectionPrompts'
  }

  function promptIdKey(kind) {
    return kind === 'composer' ? 'composerPromptId' : 'selectionAction'
  }

  /** Edit the entry currently selected in `kind`'s list ('composer' | 'selection'). */
  function updatePrompt(kind, patch) {
    const settings = state.settings
    const list = settings[promptListKey(kind)]
    const current = findPrompt(list, settings[promptIdKey(kind)])
    if (!current) return
    Object.assign(current, patch)
    saveSettings()
    emit()
  }

  /** Add a copy of the current entry and switch to it. Returns the new id. */
  function addPrompt(kind) {
    const settings = state.settings
    const list = settings[promptListKey(kind)]
    const current = findPrompt(list, settings[promptIdKey(kind)])
    const base =
      kind === 'composer'
        ? DEFAULT_SETTINGS.composerPrompts[0]
        : DEFAULT_SETTINGS.selectionPrompts[0]
    let index = list.length + 1
    let id = `custom-${Date.now().toString(36)}`
    while (list.some((item) => item.id === id)) id = `${id}-${index++}`

    list.push({
      id,
      name: `${(current ?? base).name} 副本`,
      text: (current ?? base).text,
    })
    settings[promptIdKey(kind)] = id
    saveSettings()
    emit()
    return id
  }

  /** Delete the current entry (never the last one). */
  function deletePrompt(kind) {
    const settings = state.settings
    const list = settings[promptListKey(kind)]
    if (list.length <= 1) return
    const id = settings[promptIdKey(kind)]
    const index = list.findIndex((item) => item.id === id)
    if (index < 0) return
    list.splice(index, 1)
    const next = list[Math.max(0, index - 1)]
    settings[promptIdKey(kind)] = next.id
    saveSettings()
    emit()
  }

  /** Put the shipped defaults back. */
  function resetPrompts(kind) {
    const settings = state.settings
    const defaults =
      kind === 'composer'
        ? DEFAULT_SETTINGS.composerPrompts
        : DEFAULT_SETTINGS.selectionPrompts
    const list = defaults.map((item) => ({ ...item }))
    settings[promptListKey(kind)] = list
    settings[promptIdKey(kind)] = list[0].id
    saveSettings()
    emit()
  }

  /* ------------------------------- chat history ------------------------------ */

  function pushMessage(message) {
    state.messages.push(message)
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES)
    saveMessages()
    emit()
    return message
  }

  function popMessage() {
    const removed = state.messages.pop()
    saveMessages()
    emit()
    return removed
  }

  function clearMessages() {
    state.messages = []
    saveMessages()
    emit()
  }

  /** Persist a change made in place (e.g. a streamed reply grew). */
  function touchMessages() {
    saveMessages()
    emit()
  }

  globalThis.AIStore = {
    state,
    subscribe,
    load,
    saveSettings,
    saveMessages,
    updateSettings,
    updatePrompt,
    addPrompt,
    deletePrompt,
    resetPrompts,
    pushMessage,
    popMessage,
    clearMessages,
    touchMessages,
    MAX_MESSAGES,
  }
})()

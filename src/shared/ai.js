// Shared AI core — a classic script (no `export`) so it can be loaded both by
// the background event page and by content scripts, which do not support ES
// modules. Everything hangs off `globalThis.AICore`.
//
// This is the reader's `src/lib/ai.js` ported to the browser: the OpenAI
// compatible client, the provider presets, the per-provider "thinking"
// controls, and the two prompt libraries. Only the parts that talked to PDF
// concepts were left behind.
(function () {
  'use strict'

  const i18n = globalThis.AII18n

  const PROVIDERS = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      // Checked against api-docs.deepseek.com 2026-09: no /v1 suffix, and these
      // are the two model ids the API accepts.
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      models: ['deepseek-flash', 'deepseek-v4-pro'],
      supportsThinking: true,
    },
    { id: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3' },
    {
      id: 'dashscope',
      label: i18n.t('providerDashscope'),
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
    },
    {
      id: 'zhipu',
      label: i18n.t('providerZhipu'),
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      // GLM-5.2 rather than GLM-5.3 on purpose: 5.3 can no longer disable
      // thinking (the API errors on `disabled`), which is exactly the slowness
      // this setting exists to avoid.
      model: 'glm-4.6',
      models: ['glm-5.2', 'glm-5.3', 'glm-4.6'],
    },
    { id: 'ollama', label: i18n.t('providerOllama'), baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
    { id: 'custom', label: i18n.t('providerCustom'), baseUrl: '', model: '' },
  ]

  const DEFAULT_SETTINGS = {
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: '',
    // Keys are remembered per endpoint + model, so switching models switches
    // the key. `apiKey` above is the live value for the currently selected pair.
    apiKeys: {},
    // Attach the surrounding page text so a short question has context.
    includePageText: true,
    // 'paragraph' = the block around the selection, 'page' = the whole page.
    contextMode: 'paragraph',
    // Where and how big the floating panel was left, in viewport pixels:
    // { left, top, width, height }. null until the panel is first moved or
    // resized, so a fresh install uses the default top-right card.
    panelRect: null,
    // The endpoint/model last used with the 自定义 provider. Presets own theirs,
    // so only 自定义 needs a memory: switching away and back should bring your own
    // relay back, not inherit whichever preset you happened to be on (and with it
    // that preset's key, which shares the same endpoint+model slot).
    customBaseUrl: '',
    customModel: '',
    // Whether the composer (input + send) is unfolded.
    composerOpen: true,
    // DeepSeek's own default is thinking on, but that makes every question wait
    // for a reasoning pass; a reading assistant wants quick answers.
    thinking: false,
    // Remembered per provider, so switching between them keeps each preference.
    thinkingByProvider: {},
    // What a text selection does. The reader auto-sent on every selection;
    // on the open web that would fire a request every time you copy a line, so
    // the default here is to show a small button and only ask when it is
    // clicked. 'auto' restores the reader's behaviour, 'off' disables it.
    //   'click' | 'auto' | 'off'
    selectionTrigger: 'click',
    // Which of `selectionPrompts` the button/auto-send uses, or 'off'.
    selectionAction: 'explain',
    // Two prompt libraries, one per entry point. Edit them, add your own,
    // switch between them — ids are stable so the current choice survives an
    // edit.
    composerPromptId: 'default',
    // Shipped prompts are built from the i18n table: Chinese in a Chinese
    // browser, English elsewhere. `store.js` re-localises them on load while they
    // are still the shipped text, so switching the browser language switches the
    // language the assistant is asked to answer in.
    composerPrompts: [shippedPrompt('default', 'composerPromptName', 'composerPromptText')],
    selectionPrompts: [
      shippedPrompt('explain-translate', 'explainTranslateName', 'explainTranslateText'),
      shippedPrompt('translate', 'translateName', 'translateText'),
      shippedPrompt('explain', 'explainName', 'explainText'),
    ],
    temperature: 0.3,
  }

  // The scope has to be spelled out in the request itself: the page text we
  // send along for disambiguation is otherwise an easy thing for the model to
  // treat as material to translate.
  const SCOPE_RULE = i18n.t('scopeRule')

  /**
   * The user turn for a selection. The scope rule is always part of it — it is
   * what stops the model from translating the whole page, so it must not depend
   * on how someone words their instruction. The user's own instruction travels
   * separately, as the turn's system message.
   */
  function selectionTurnText(text) {
    return `${SCOPE_RULE}\n\n"""\n${text}\n"""`
  }

  /** One shipped prompt, in the current language. */
  function shippedPrompt(id, nameKey, textKey) {
    return { id, name: i18n.t(nameKey), text: i18n.t(textKey) }
  }

  /** Name of a selection prompt, or the disabled option's label. */
  function selectionActionLabel(action, prompts) {
    if (action === 'off') return i18n.t('triggerOff')
    const list = prompts ?? []
    return list.find((item) => item.id === action)?.name ?? i18n.t('explainTranslateName')
  }

  function findPrompt(list, id) {
    return list?.find((item) => item.id === id) ?? list?.[0] ?? null
  }

  /** A word or short phrase needs its surrounding text to be disambiguated. */
  const SHORT_SELECTION_LENGTH = 40

  function providerById(id) {
    return PROVIDERS.find((provider) => provider.id === id) ?? PROVIDERS[PROVIDERS.length - 1]
  }

  /**
   * How to turn thinking off/on for each provider's OpenAI-compatible API,
   * checked against the vendor docs in 2026-10. They are not the same field, and
   * a wrong one is a 400 — so each entry records exactly what that API accepts:
   *
   *   DeepSeek   thinking: { type: enabled | disabled }
   *   智谱 GLM   thinking: { type: enabled | disabled }   (5.3 errors on disabled)
   *   通义 Qwen  enable_thinking: true | false
   *   Kimi       thinking: { type: enabled | disabled }   (only kimi-k2.6; k3 and
   *              k2.7-code always think)
   *   OpenAI     reasoning_effort: minimal | high         (only gpt-5 accepts it)
   */
  const THINKING_CONTROLS = {
    deepseek: {
      off: { thinking: { type: 'disabled' } },
      on: { thinking: { type: 'enabled' } },
    },
    zhipu: {
      off: { thinking: { type: 'disabled' } },
      on: { thinking: { type: 'enabled' } },
      cannotDisable: /^glm-5\.3/,
    },
    dashscope: {
      off: { enable_thinking: false },
      on: { enable_thinking: true },
      only: /^qwen3/,
    },
    moonshot: {
      off: { thinking: { type: 'disabled' } },
      on: { thinking: { type: 'enabled' } },
      only: /^kimi-k2\.6/,
    },
    openai: {
      off: { reasoning_effort: 'minimal' },
      on: { reasoning_effort: 'high' },
      only: /^gpt-5/,
    },
  }

  function hostOf(url) {
    try {
      return new URL(url).host
    } catch {
      return ''
    }
  }

  /** The control for this endpoint, or null when we know of no parameter for it. */
  function thinkingControl(settings) {
    const direct = THINKING_CONTROLS[providerById(settings.providerId).id]
    if (direct) return direct
    // A custom address that is really DeepSeek still speaks DeepSeek's dialect.
    if (/(^|\.)api\.deepseek\.com$/.test(hostOf(settings.baseUrl))) return THINKING_CONTROLS.deepseek
    return null
  }

  /**
   * What the UI should show for the current provider/model:
   *   available   — a switch can be sent at all
   *   canDisable  — turning it off is possible (some models force thinking)
   *   reason      — why not, when unavailable
   */
  function thinkingInfo(settings) {
    const control = thinkingControl(settings)
    if (!control) return { available: false, canDisable: false, reason: 'no-control' }

    const model = (settings.model ?? '').trim()
    if (control.only && !control.only.test(model)) {
      return { available: false, canDisable: false, reason: 'model' }
    }
    return {
      available: true,
      canDisable: !control.cannotDisable?.test(model),
      reason: null,
    }
  }

  /** Extra body fields implementing the current thinking preference. */
  function thinkingBody(settings) {
    const control = thinkingControl(settings)
    const info = thinkingInfo(settings)
    if (!info.available || !control) return {}
    if (settings.thinking) return control.on
    return info.canDisable ? control.off : {}
  }

  /**
   * Endpoints that only accept one temperature per model. Sending our own default
   * is a 400 — "invalid temperature: only 0.6 is allowed for this model" — so for
   * these models the field is left out entirely and the API applies the value it
   * allows (which, by definition, is the only one it accepts).
   *
   *   Moonshot/Kimi  kimi-k3 → 1, kimi-k2.6 → 0.6
   *   OpenAI         gpt-5 reasoning models only support the default (1)
   *
   * Add a regex here when another model turns out to fix its temperature.
   */
  const FIXED_TEMPERATURE = {
    moonshot: /^kimi-(k3|k2\.6)/,
    openai: /^gpt-5/,
  }

  /** The fixed-temperature rule for this endpoint, or null if it takes a range. */
  function temperatureControl(settings) {
    const direct = FIXED_TEMPERATURE[providerById(settings.providerId).id]
    if (direct) return direct
    // A custom address that is really Moonshot speaks Moonshot's dialect.
    if (/(^|\.)api\.moonshot\.cn$/.test(hostOf(settings.baseUrl))) return FIXED_TEMPERATURE.moonshot
    return null
  }

  /** True when the selected model decides its own temperature. */
  function temperatureIsFixed(settings) {
    const control = temperatureControl(settings)
    return Boolean(control?.test((settings.model ?? '').trim()))
  }

  /**
   * The temperature to actually send: the configured value, or `undefined` to
   * omit the field for a model that only accepts one value.
   */
  function effectiveTemperature(settings) {
    if (temperatureIsFixed(settings)) return undefined
    const value = Number(settings.temperature)
    return Number.isFinite(value) ? value : undefined
  }

  /**
   * Which stored key belongs to this endpoint/model pair. Keyed by the address
   * rather than the provider id, because every custom endpoint shares the id
   * "custom" and two different relays must not share one key.
   */
  function apiKeySlot({ baseUrl, model } = {}) {
    const address = (baseUrl ?? '').trim().replace(/\/+$/, '')
    return `${address}|${(model ?? '').trim()}`
  }

  function endpoint(baseUrl) {
    return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  async function toError(response) {
    let detail = ''
    try {
      const body = await response.json()
      detail = body?.error?.message ?? body?.message ?? ''
    } catch {
      try {
        detail = await response.text()
      } catch {
        detail = ''
      }
    }

    const hints = {
      401: i18n.t('error401'),
      402: i18n.t('error402'),
      403: i18n.t('error403'),
      404: i18n.t('error404'),
      429: i18n.t('error429'),
      500: i18n.t('error500'),
      503: i18n.t('error503'),
    }
    const hint = hints[response.status] ?? i18n.t('errorStatus', { status: response.status })
    return new Error(detail ? `${hint}：${detail}` : hint)
  }

  /**
   * Stream a chat completion. Yields `{ type: 'content' | 'reasoning', text }`
   * deltas as they arrive. Throws an Error with a readable message for the
   * common failures.
   */
  async function* streamChat({
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    /** Provider-specific fields (thinking controls, …) merged into the body. */
    extraBody,
    signal,
  }) {
    let response
    try {
      response = await fetch(endpoint(baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(temperature === undefined ? {} : { temperature }),
          ...(extraBody ?? {}),
        }),
        signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // fetch() rejects with a TypeError for both network failures and CORS
      // rejections; browsers deliberately hide which one it was.
      throw new Error(i18n.t('errorNetwork'))
    }

    if (!response.ok) throw await toError(response)
    if (!response.body) throw new Error(i18n.t('errorNoStream'))

    // A relay whose address is missing its path segment (…/v1) happily answers
    // 200 with its own web page. Without this the stream just yields nothing and
    // the panel says "（没有返回内容）", which hides the real problem.
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) {
      throw new Error(i18n.t('errorHtml'))
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line; keep the trailing partial.
        let boundary = buffer.search(/\r?\n\r?\n/)
        while (boundary !== -1) {
          // A stop can arrive while injected frames are still queued in the
          // buffer; honour it before emitting more of them.
          if (signal?.aborted) return

          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + buffer.match(/\r?\n\r?\n/)[0].length)

          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            if (payload === '[DONE]') return

            try {
              const parsed = JSON.parse(payload)
              const delta = parsed?.choices?.[0]?.delta
              // Thinking models stream their chain of thought next to the answer.
              if (delta?.reasoning_content) {
                yield { type: 'reasoning', text: delta.reasoning_content }
              }
              if (delta?.content) yield { type: 'content', text: delta.content }
            } catch {
              // Keep-alive comments and half-written frames are not fatal.
            }
          }
          boundary = buffer.search(/\r?\n\r?\n/)
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  globalThis.AICore = {
    PROVIDERS,
    DEFAULT_SETTINGS,
    SCOPE_RULE,
    SHORT_SELECTION_LENGTH,
    selectionTurnText,
    selectionActionLabel,
    findPrompt,
    providerById,
    thinkingControl,
    thinkingInfo,
    thinkingBody,
    temperatureControl,
    temperatureIsFixed,
    effectiveTemperature,
    apiKeySlot,
    streamChat,
  }
})()

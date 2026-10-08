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

  const PROVIDERS = [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
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
    { id: 'moonshot', label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'dashscope', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    {
      id: 'zhipu',
      label: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      // GLM-5.2 rather than GLM-5.3 on purpose: 5.3 can no longer disable
      // thinking (the API errors on `disabled`), which is exactly the slowness
      // this setting exists to avoid.
      model: 'glm-5.2',
      models: ['glm-5.2', 'glm-5.3', 'glm-4.6'],
    },
    { id: 'ollama', label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
    { id: 'custom', label: '自定义', baseUrl: '', model: '' },
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
    selectionAction: 'explain-translate',
    // Two prompt libraries, one per entry point. Edit them, add your own,
    // switch between them — ids are stable so the current choice survives an
    // edit.
    composerPromptId: 'default',
    composerPrompts: [
      {
        id: 'default',
        name: '默认助手',
        text:
          '你是一个嵌在浏览器里的阅读助手。用户会给出他正在看的网页内容（可能只有其中一段），' +
          '请优先依据这些内容回答；如果所给内容里没有答案，就直接说明，不要编造。' +
          '回答尽量简洁，用用户提问的语言作答。',
      },
    ],
    selectionPrompts: [
      {
        id: 'explain-translate',
        name: '解释并翻译',
        text:
          '先用一两句话解释引号内文字的意思，然后给出通顺的译文（原文是中文就译成英文，否则译成中文）。',
      },
      {
        id: 'translate',
        name: '只翻译',
        text:
          '把引号内的文字翻译成通顺的译文（原文是中文就译成英文，否则译成中文），只输出译文。',
      },
      {
        id: 'explain',
        name: '只解释',
        text: '解释引号内文字的意思，说清关键概念，以及它在上下文里的含义。回答简短一些。',
      },
    ],
    temperature: 0.3,
  }

  // The scope has to be spelled out in the request itself: the page text we
  // send along for disambiguation is otherwise an easy thing for the model to
  // treat as material to translate.
  const SCOPE_RULE =
    '只处理下面引号内的文字。页面正文（如果有）只是给你理解用的参考，不要翻译它、不要解释它、不要总结它，也不要在回答里复述它。'

  /**
   * The user turn for a selection. The scope rule is always part of it — it is
   * what stops the model from translating the whole page, so it must not depend
   * on how someone words their instruction. The user's own instruction travels
   * separately, as the turn's system message.
   */
  function selectionTurnText(text) {
    return `${SCOPE_RULE}\n\n"""\n${text}\n"""`
  }

  /** Name of a selection prompt, or '关闭' for the disabled option. */
  function selectionActionLabel(action, prompts) {
    if (action === 'off') return '关闭（只选中，不发送）'
    const list = prompts ?? []
    return list.find((item) => item.id === action)?.name ?? '解释并翻译'
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
      401: 'API key 无效或已过期',
      402: '账户余额不足',
      403: '这个 key 没有访问权限',
      404: '接口地址或模型名不对',
      429: '请求太频繁或额度用完了',
      500: '服务端出错了，稍后再试',
      503: '服务端繁忙，稍后再试',
    }
    const hint = hints[response.status] ?? `请求失败（HTTP ${response.status}）`
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
      throw new Error('连不上这个接口：可能是网络不通，或者该服务不允许浏览器直连（CORS）')
    }

    if (!response.ok) throw await toError(response)
    if (!response.body) throw new Error('这个接口没有返回流式内容')

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
    apiKeySlot,
    streamChat,
  }
})()

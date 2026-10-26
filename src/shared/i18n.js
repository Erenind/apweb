// UI and conversation language.
//
// The language follows the browser's UI language: a Chinese browser gets the
// Chinese strings, anything else gets English. There is no in-panel switch — the
// point is that the panel speaks whatever the rest of the browser speaks.
//
// Loaded *first* by every host (content script, background page, options page),
// because `ai.js` and `store.js` read it while building their defaults. `t()` is a
// plain lookup, and everything user-facing in the extension lives in STRINGS — a
// test asserts that no other module contains CJK text.
(function () {
  'use strict'

  const api = globalThis.browser ?? globalThis.chrome
  let cachedTag = null

  function browserTag() {
    try {
      const tag = api?.i18n?.getUILanguage?.()
      if (tag) return tag
    } catch {
      // No i18n API (or no permission): fall back to the navigator below.
    }
    return globalThis.navigator?.language ?? 'en'
  }

  /**
   * 'zh' | 'en'. Called with no tag it reads (and remembers) the browser's UI
   * language; called with a tag it resolves that tag and makes it current, which
   * is what lets the tests exercise both languages in one process.
   */
  function language(tag) {
    if (!tag && !cachedTag) cachedTag = browserTag()
    const value = tag ?? cachedTag
    const resolved = /^zh\b/i.test(value) ? 'zh' : 'en'
    if (tag) cachedTag = value
    return resolved
  }

  /** How the assistant is told to write its answers. */
  function languageName(tag) {
    return language(tag) === 'zh' ? '中文' : 'English'
  }

  const STRINGS = {
    zh: {
      // Panel chrome -----------------------------------------------------------
      assistant: 'AI 助手',
      clearChat: '清空对话',
      clear: '清空',
      settings: '设置',
      collapse: '收起',
      modelLabel: '模型',
      // Composer ---------------------------------------------------------------
      composerPlaceholder: 'Enter 发送，Shift+Enter 换行',
      send: '发送',
      stop: '停止',
      foldComposer: '收起输入框',
      unfoldComposer: '展开输入框',
      resizePanel: '拖动调整大小',
      emptyHint: '问点什么吧。在页面上选中文字会弹出「问 AI」按钮，也可以直接在这里提问。',
      you: '你',
      contextLabel: '上下文：{context}',
      copy: '复制',
      copyFailed: '复制失败：浏览器不允许写剪贴板',
      thinking: '思考过程（{count} 字）',
      onlyThinking: '（只有思考过程，没有正文）',
      noContent: '（没有返回内容）',
      stopped: '（已停止）',
      connectionLost: '后台连接已断开，请重试',
      // Selection mode toggle --------------------------------------------------
      modeOn: '✦ 划词即问 · 已开启',
      modeOff: '✦ 启动划词即问',
      modeOnTitle: '点击改回：选中文字后先弹出按钮，点按钮才发送',
      modeOffTitle: '点击开启：在网页上选中文字就直接发给 AI',
      modeHintOn: '开启中：选中文字会立刻发送，每次划选都会产生一次 API 调用。',
      modeHintOff: '现在选中文字会弹出「问 AI」小按钮，点它才发送。',
      modeHintOffWhenDisabled: '划词提问目前是完全关闭的，点上面按钮开启「选中即发送」。',
      purposeHintOff: '划词提问现在是关闭的；选好用途后，把上面那项打开才会生效。',
      purposeHintOn: '选中文字后要做什么；「划词提问」一打开就按这里选的方式处理。',
      // Provider / model / key -------------------------------------------------
      provider: '服务商',
      endpoint: '接口地址',
      endpointRequired: '填上接口地址才能发送',
      apiKey: 'API Key',
      keyHint: '这个 key 只用于 {provider} · {model}，换模型会自动换成对应的 key',
      modelPlaceholder: '（未填模型）',
      keyStorageNote:
        'key 只保存在本机浏览器（browser.storage.local），请求由浏览器直接发往上面的接口地址，不经过任何中转。共用电脑上记得清掉。',
      clearKey: '清除 key',
      done: '完成',
      // Context ----------------------------------------------------------------
      includePage: '发送时附带页面内容',
      contextScope: '附带范围',
      scopeParagraph: '选中处所在的那一段（推荐）',
      scopePage: '整个页面正文',
      scopeHint: '划词提问时只会在选中的是词或短句（不足 40 字）时附带。',
      // Thinking ---------------------------------------------------------------
      useThinking: '使用思考模式（默认关闭）',
      thinkingOffNote: '默认关闭。打开后模型会先推理再回答，更准但更慢。',
      thinkingForcedNote: '这个模型只能强制思考，无法关闭（例如智谱 GLM-5.3）。',
      thinkingModelNote:
        '当前模型不接受思考开关，不会发送相关参数（例如 Kimi K3、GLM-4-Flash 这类非思考模型）。',
      thinkingNoControlNote: '这个接口地址没有可用的思考开关，不会发送相关参数。',
      // Temperature ------------------------------------------------------------
      sendTemperature: '发送 temperature 参数',
      temperatureValue: 'temperature 值',
      temperatureOnNote: '发送时带上这个值（默认 0.3）。接口返回「temperature 被拒绝」时会自动重试一次并记住。',
      temperatureOffNote: '不发送 temperature，由服务端用它自己的默认值。',
      temperatureSkippedNote:
        '这个接口 + 模型之前拒绝了 temperature，已自动跳过（重新打开上面的开关可以强行发送）。',
      // Selection behaviour ----------------------------------------------------
      selectionTrigger: '划词提问',
      triggerOff: '完全关闭（选中后什么都不做）',
      triggerClick: '选中后显示按钮，点击提问',
      triggerAuto: '选中后自动提问',
      triggerHint: '自动提问会在每次划选后立刻产生一次 API 调用；只想复制文字就用「完全关闭」。',
      selectionPurpose: '划词用途',
      // Android -----------------------------------------------------------------
      androidSettings: '安卓设置',
      cardMaxHeight: '内容框最高高度（px）',
      cardMaxHeightNote: '内容框从屏幕底部往上长到这个高度就停住，再长就在框内滚动。',
      cardBottom: '距底部距离（px）',
      cardBottomNote: '内容框和圆钮会一起上移这么多，用来避开页面底部的内容。默认 12。',
      mirrorLayout: '界面镜像（按钮放到最左端）',
      mirrorLayoutNote: '打开后圆形按钮在最左端、内容框在右侧；关掉则按钮回到右下角。',
      hideSelectionPill: '隐藏选中文字下方的提示按钮（「只解释」等）',
      hideSelectionPillNote:
        '打开后选中文字不再弹出「只解释」这类小按钮，改用圆钮那一列的「提问」按钮提问。',
      showSentContent: '在内容框里显示我发送的内容',
      showSentContentNote:
        '关掉后内容框只留下 AI 的回答，划词时问的那句话不再显示（设置页里仍然能看到完整对话）。',
      needKey: '还没有填 API Key：点扩展图标打开设置页填好，再回来划词提问。',
      // Prompt library ---------------------------------------------------------
      prompts: '提示词',
      composerPrompts: '提问提示词（在输入框提问时使用）',
      selectionPrompts: '划词提示词（选中内容后使用）',
      addPrompt: '+ 新建',
      deletePrompt: '删除',
      resetPrompts: '恢复默认',
      promptCopy: '{name} 副本',
      selectionPromptNote:
        '你写的内容会放在选中文字前面；系统一定会再补一句「只处理引号内的文字，不要翻译页面正文」，这条不能改——它是防止整页被翻译的保险。',
      // Page context sent with a question --------------------------------------
      pageContextLabel: '页面正文',
      paragraphContextLabel: '选中处那一段',
      currentPage: '当前网页',
      contextSource: '《{title}》({url})',
      contextSourceNoUrl: '《{title}》',
      contextPreamble:
        '以下只是参考上下文，不要翻译、不要解释、不要总结，也不要在回答里复述：',
      selectedTextPreamble: '用户选中的文字：',
      selectedChip: '选中文字',
      // Selection pill ---------------------------------------------------------
      pillTitle: '用 AI 处理选中的文字（{label}）',
      pillShort: '问 AI',
      selectionModeOff: '关闭',
      // Android corner controls -------------------------------------------------
      switchAuto: '选中即发送：点按改回「先弹出按钮」，长按打开对话框',
      switchClick: '选中后弹出「问 AI」按钮：点按改为「选中即发送」，长按打开对话框',
      switchFullyOff: '划词提问已完全关闭：点按改为「选中即发送」，长按打开对话框',
      askDock: '提问',
      askDockTitle: '用当前选中的文字提问',
      closePanel: '关闭面板',
      // Shipped prompts --------------------------------------------------------
      composerPromptName: '默认助手',
      composerPromptText:
        '你是一个嵌在浏览器里的阅读助手。用户会给出他正在看的网页内容（可能只有其中一段），请优先依据这些内容回答；如果所给内容里没有答案，就直接说明，不要编造。回答尽量简洁，用用户提问的语言作答。',
      explainTranslateName: '解释并翻译',
      explainTranslateText:
        '先用一两句话解释引号内文字的意思，然后给出通顺的译文（原文是中文就译成英文，否则译成中文）。',
      translateName: '只翻译',
      translateText:
        '把引号内的文字翻译成通顺的译文（原文是中文就译成英文，否则译成中文），只输出译文。',
      explainName: '只解释',
      explainText: '解释引号内文字的意思，说清关键概念，以及它在上下文里的含义。回答简短一些。',
      scopeRule:
        '只处理下面引号内的文字。页面正文（如果有）只是给你理解用的参考，不要翻译它、不要解释它、不要总结它，也不要在回答里复述它。',
      // Provider presets -------------------------------------------------------
      providerDashscope: '通义千问',
      providerZhipu: '智谱 GLM',
      providerOllama: '本地 Ollama',
      providerCustom: '自定义',
      // Errors -----------------------------------------------------------------
      error401: 'API key 无效或已过期',
      error402: '账户余额不足',
      error403: '这个 key 没有访问权限',
      error404: '接口地址或模型名不对',
      error429: '请求太频繁或额度用完了',
      error500: '服务端出错了，稍后再试',
      error503: '服务端繁忙，稍后再试',
      errorStatus: '请求失败（HTTP {status}）',
      errorNetwork: '连不上这个接口：可能是网络不通，或者该服务不允许浏览器直连（CORS）',
      errorNoStream: '这个接口没有返回流式内容',
      errorHtml: '这个地址返回的是网页，不是接口数据：接口地址大概写错了（常见是漏了 /v1）',
    },
    en: {
      assistant: 'AI assistant',
      clearChat: 'Clear the conversation',
      clear: 'Clear',
      settings: 'Settings',
      collapse: 'Collapse',
      modelLabel: 'Model',
      composerPlaceholder: 'Enter to send, Shift+Enter for a new line',
      send: 'Send',
      stop: 'Stop',
      foldComposer: 'Hide the input',
      unfoldComposer: 'Show the input',
      resizePanel: 'Drag to resize',
      emptyHint:
        'Ask something. Selecting text on a page brings up an “Ask AI” button, or you can type here.',
      you: 'You',
      contextLabel: 'Context: {context}',
      copy: 'Copy',
      copyFailed: 'Could not copy: the browser blocked clipboard access',
      thinking: 'Reasoning ({count} chars)',
      onlyThinking: '(reasoning only, no answer)',
      noContent: '(nothing came back)',
      stopped: '(stopped)',
      connectionLost: 'The background connection dropped — try again',
      modeOn: '✦ Ask on select · on',
      modeOff: '✦ Switch to “ask as soon as it is selected”',
      modeOnTitle: 'Click to go back: a selection shows a button, and asking waits for a tap',
      modeOffTitle: 'Click to send the selection to the AI straight away',
      modeHintOn: 'On: a selection is sent immediately — every selection is an API call.',
      modeHintOff: 'A selection now shows the “Ask AI” button; the question goes out when you tap it.',
      modeHintOffWhenDisabled: 'Ask-on-select is fully off — the button above turns on “send straight away”.',
      purposeHintOff: 'Ask-on-select is off — turn the switch above on to use this.',
      purposeHintOn: 'What to do with a selection; used as soon as ask-on-select is on.',
      provider: 'Provider',
      endpoint: 'Endpoint',
      endpointRequired: 'An endpoint is required before sending',
      apiKey: 'API key',
      keyHint: 'This key is only used for {provider} · {model}; switching model switches the key',
      modelPlaceholder: '(no model yet)',
      keyStorageNote:
        'The key stays in this browser (browser.storage.local) and requests go straight from the browser to the endpoint above, with no relay in between. Clear it on a shared machine.',
      clearKey: 'Clear key',
      done: 'Done',
      includePage: 'Attach the page content',
      contextScope: 'What to attach',
      scopeParagraph: 'The paragraph around the selection (recommended)',
      scopePage: 'The whole page text',
      scopeHint: 'Only attached for selections under 40 characters, where a word alone is ambiguous.',
      useThinking: 'Use thinking mode (off by default)',
      thinkingOffNote: 'Off by default. On makes the model reason first: more accurate, slower.',
      thinkingForcedNote: 'This model always thinks and cannot turn it off (e.g. 智谱 GLM-5.3).',
      thinkingModelNote:
        'This model takes no thinking switch, so none is sent (e.g. Kimi K3, GLM-4-Flash).',
      thinkingNoControlNote: 'This endpoint has no thinking switch, so none is sent.',
      sendTemperature: 'Send a temperature parameter',
      temperatureValue: 'Temperature value',
      temperatureOnNote:
        'Sent with this value (0.3 by default). If the endpoint rejects it, the request is retried once and remembered.',
      temperatureOffNote: 'No temperature is sent; the service uses its own default.',
      temperatureSkippedNote:
        'This endpoint + model rejected temperature earlier, so it is skipped (turn the switch above back on to force it).',
      selectionTrigger: 'Ask on select',
      triggerOff: 'Fully off (a selection does nothing)',
      triggerClick: 'Show a button next to the selection',
      triggerAuto: 'Ask as soon as text is selected',
      triggerHint:
        'Asking automatically fires an API call on every selection; choose “Fully off” if you only want to copy text.',
      selectionPurpose: 'Selection action',
      androidSettings: 'Android',
      cardMaxHeight: 'Card height limit (px)',
      cardMaxHeightNote:
        'The card grows upward from the bottom of the screen and stops at this height; longer answers scroll inside it.',
      cardBottom: 'Bottom offset (px)',
      cardBottomNote:
        'Moves the card and its buttons up together, clear of content at the bottom of the page. Default 12.',
      mirrorLayout: 'Mirror the layout (buttons on the left)',
      mirrorLayoutNote:
        'On puts the round buttons on the far left and the card to their right; off puts the buttons back in the bottom-right corner.',
      hideSelectionPill: 'Hide the button under a selection (“Explain only” and the like)',
      hideSelectionPillNote:
        'When on, selecting text no longer pops that small action button — use the “Ask” button in the round dock instead.',
      showSentContent: 'Show what I sent in the card',
      showSentContentNote:
        'Off leaves only the answers in the card — the text you selected and asked about is still in the conversation on the settings page.',
      needKey: 'No API key yet — tap the extension icon, fill one in on the settings page, then ask again.',
      prompts: 'Prompts',
      composerPrompts: 'Composer prompt (used when typing a question)',
      selectionPrompts: 'Selection prompt (used after selecting text)',
      addPrompt: '+ New',
      deletePrompt: 'Delete',
      resetPrompts: 'Restore defaults',
      promptCopy: '{name} copy',
      selectionPromptNote:
        'Your text is placed before the selection; the system always adds “only touch the text in quotes, do not translate the page”, which cannot be changed — it is what stops a whole page being translated.',
      pageContextLabel: 'page text',
      paragraphContextLabel: 'paragraph around the selection',
      currentPage: 'the current page',
      contextSource: '“{title}” ({url})',
      contextSourceNoUrl: '“{title}”',
      contextPreamble:
        'The following is reference context only — do not translate it, explain it, summarise it, or repeat it in your answer:',
      selectedTextPreamble: 'Text the user selected:',
      selectedChip: 'selection',
      pillTitle: 'Ask the AI about the selected text ({label})',
      pillShort: 'Ask AI',
      selectionModeOff: 'Off',
      // Android corner controls -------------------------------------------------
      switchAuto: 'Send on select: tap for the button instead, long-press to open the card',
      switchClick: 'A selection shows the “Ask AI” button: tap to send straight away, long-press to open the card',
      switchFullyOff: 'Ask on select is fully off: tap to send straight away, long-press to open the card',
      askDock: 'Ask',
      askDockTitle: 'Ask about the selected text',
      closePanel: 'Close the panel',
      composerPromptName: 'Default assistant',
      composerPromptText:
        'You are a reading assistant inside the browser. The user shows you the page they are reading (sometimes just part of it); answer from that content when you can, and say so plainly when the answer is not there instead of making it up. Keep answers short and write them in English.',
      explainTranslateName: 'Explain and translate',
      explainTranslateText:
        'Explain in one or two sentences what the quoted text means, then give a fluent English translation (if the text is already English, just explain it).',
      translateName: 'Translate only',
      translateText:
        'Translate the quoted text into fluent English, and output only the translation. If it is already English, keep it as it is.',
      explainName: 'Explain only',
      explainText:
        'Explain in English what the quoted text means: the key ideas and what it means in context. Keep it short.',
      scopeRule:
        'Only handle the text between the quotes below. The page text (if any) is reference material for you: do not translate it, explain it, summarise it, or repeat it in your answer.',
      providerDashscope: 'DashScope (Qwen)',
      providerZhipu: 'Zhipu GLM',
      providerOllama: 'Local Ollama',
      providerCustom: 'Custom',
      error401: 'API key is invalid or expired',
      error402: 'The account is out of credit',
      error403: 'This key is not allowed to use that',
      error404: 'Wrong endpoint or model name',
      error429: 'Too many requests, or the quota is used up',
      error500: 'The service errored — try again later',
      error503: 'The service is busy — try again later',
      errorStatus: 'Request failed (HTTP {status})',
      errorNetwork:
        'Cannot reach that endpoint: the network is down, or the service refuses browser connections (CORS)',
      errorNoStream: 'That endpoint did not return a stream',
      errorHtml:
        'That address returned a web page, not API data — the endpoint is probably wrong (a missing /v1 is the usual cause)',
    },
  }

  function t(key, params) {
    const table = STRINGS[language()] ?? STRINGS.en
    const text = table[key] ?? STRINGS.en[key] ?? key
    if (!params) return text
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      params[name] === undefined ? whole : String(params[name]),
    )
  }

  /**
   * The shipped prompts in both languages, so `store.js` can keep an *unedited*
   * default in step with the browser language while leaving anything the user
   * typed alone. Field by field: a renamed prompt keeps its new name even when its
   * text is still the shipped one.
   */
  const SHIPPED_PROMPTS = {
    composer: [{ id: 'default', name: 'composerPromptName', text: 'composerPromptText' }],
    selection: [
      { id: 'explain-translate', name: 'explainTranslateName', text: 'explainTranslateText' },
      { id: 'translate', name: 'translateName', text: 'translateText' },
      { id: 'explain', name: 'explainName', text: 'explainText' },
    ],
  }

  function localizeShippedPrompt(kind, prompt) {
    const shipped = SHIPPED_PROMPTS[kind]?.find((entry) => entry.id === prompt.id)
    if (!shipped) return prompt
    const current = STRINGS[language()]
    const isShipped = (key, value) => STRINGS.zh[key] === value || STRINGS.en[key] === value
    return {
      ...prompt,
      name: isShipped(shipped.name, prompt.name) ? current[shipped.name] : prompt.name,
      text: isShipped(shipped.text, prompt.text) ? current[shipped.text] : prompt.text,
    }
  }

  globalThis.AII18n = {
    language,
    languageName,
    t,
    localizeShippedPrompt,
    STRINGS,
  }
})()

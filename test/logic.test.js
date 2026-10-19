// Sanity harness for the extension's framework-free modules. Not shipped.
const fs = require('fs')
const vm = require('vm')

const ROOT = require('path').join(__dirname, '..')

// --- stub the WebExtension storage API -------------------------------------
const storage = {}
globalThis.chrome = {
  // The panel follows the browser's UI language; the suite pins it to Chinese and
  // exercises the English table explicitly.
  i18n: { getUILanguage: () => 'zh-CN' },
  storage: {
    local: {
      async get(key) {
        if (key == null) return { ...storage }
        return { [key]: storage[key] }
      },
      async set(obj) {
        Object.assign(storage, obj)
      },
    },
  },
}

function load(rel) {
  const code = fs.readFileSync(`${ROOT}/${rel}`, 'utf8')
  vm.runInThisContext(code, { filename: rel })
}

load('src/shared/i18n.js')
load('src/shared/ai.js')
load('src/shared/store.js')
load('src/shared/math.js')

const AICore = globalThis.AICore
const AIStore = globalThis.AIStore
const AIMath = globalThis.AIMath
const AII18n = globalThis.AII18n

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name}`)
  }
}
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) {
    failures++
    console.log(`  FAIL ${name}\n       got ${JSON.stringify(actual)}\n       exp ${JSON.stringify(expected)}`)
  } else {
    console.log(`  ok   ${name}`)
  }
}

;(async () => {
  console.log('language')
  eq('a Chinese browser is Chinese', AII18n.language('zh-CN'), 'zh')
  eq('zh-Hans too', AII18n.language('zh-Hans'), 'zh')
  eq('an English browser is English', AII18n.language('en-US'), 'en')
  eq('anything else falls back to English', AII18n.language('fr-FR'), 'en')
  eq('the UI strings follow it', AII18n.t('send'), 'Send')
  check(
    'every Chinese string has an English one',
    Object.keys(AII18n.STRINGS.zh).every((key) => typeof AII18n.STRINGS.en[key] === 'string'),
  )
  check(
    'and there are no English-only keys',
    Object.keys(AII18n.STRINGS.en).every((key) => key in AII18n.STRINGS.zh),
  )
  eq(
    'the two tables are the same size',
    Object.keys(AII18n.STRINGS.en).length,
    Object.keys(AII18n.STRINGS.zh).length,
  )
  // English browser: the shipped prompts are the English ones …
  AIStore.updateSettings({ composerPrompts: [], selectionPrompts: [], composerPromptId: 'default' })
  await AIStore.load()
  check(
    'an English browser gets English shipped prompts',
    AIStore.state.settings.composerPrompts[0].text.includes('English'),
  )
  check(
    'the selection prompts too',
    AIStore.state.settings.selectionPrompts.some((prompt) => prompt.name === 'Translate only'),
  )
  // … and back to Chinese for the rest of the suite.
  AII18n.language('zh-CN')
  eq('and back to Chinese', AII18n.t('send'), '发送')

  console.log('AICore')
  eq('deepseek endpoint', AICore.providerById('deepseek').baseUrl, 'https://api.deepseek.com')
  eq('unknown provider -> custom', AICore.providerById('nope').id, 'custom')
  eq(
    'thinkingBody deepseek off',
    AICore.thinkingBody({ providerId: 'deepseek', model: 'deepseek-flash', thinking: false }),
    { thinking: { type: 'disabled' } },
  )
  eq(
    'thinkingBody glm-5.3 cannot disable',
    AICore.thinkingBody({ providerId: 'zhipu', model: 'glm-5.3', thinking: false }),
    {},
  )
  eq(
    'thinkingInfo glm-5.3',
    AICore.thinkingInfo({ providerId: 'zhipu', model: 'glm-5.3' }),
    { available: true, canDisable: false, reason: null },
  )
  eq(
    'thinkingInfo openai non-gpt5 unavailable',
    AICore.thinkingInfo({ providerId: 'openai', model: 'gpt-4o-mini' }).reason,
    'model',
  )
  eq(
    'custom deepseek host uses deepseek dialect',
    AICore.thinkingBody({ providerId: 'custom', baseUrl: 'https://api.deepseek.com/v1', model: 'x', thinking: false }),
    { thinking: { type: 'disabled' } },
  )
  eq(
    'custom unknown host sends nothing',
    AICore.thinkingBody({ providerId: 'custom', baseUrl: 'https://relay.example/v1', model: 'x', thinking: true }),
    {},
  )
  eq('apiKeySlot trims trailing slash', AICore.apiKeySlot({ baseUrl: 'https://a.com/', model: ' m ' }), 'https://a.com|m')
  console.log('temperature policy')
  eq(
    'kimi-k3 fixes its temperature (field omitted)',
    AICore.effectiveTemperature({ providerId: 'moonshot', model: 'kimi-k3', temperature: 0.3 }),
    undefined,
  )
  eq(
    'kimi-k2.6 fixes its temperature too',
    AICore.effectiveTemperature({ providerId: 'moonshot', model: 'kimi-k2.6', temperature: 0.3 }),
    undefined,
  )
  eq(
    'other Moonshot models still take ours',
    AICore.effectiveTemperature({ providerId: 'moonshot', model: 'moonshot-v1-8k', temperature: 0.3 }),
    0.3,
  )
  eq(
    'gpt-5 reasoning models take only the default',
    AICore.effectiveTemperature({ providerId: 'openai', model: 'gpt-5', temperature: 0.3 }),
    undefined,
  )
  eq(
    'a custom address pointed at Moonshot follows the same rule',
    AICore.effectiveTemperature({
      providerId: 'custom',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      temperature: 0.3,
    }),
    undefined,
  )
  eq(
    'other providers are untouched',
    AICore.effectiveTemperature({ providerId: 'deepseek', model: 'deepseek-flash', temperature: 0.3 }),
    0.3,
  )
  check(
    'a non-numeric temperature is dropped rather than sent as NaN',
    AICore.effectiveTemperature({ providerId: 'deepseek', model: 'x', temperature: 'warm' }) === undefined,
  )
  eq(
    'the switch turns the field off for every model',
    AICore.effectiveTemperature({
      providerId: 'deepseek',
      model: 'deepseek-flash',
      temperature: 0.3,
      sendTemperature: false,
    }),
    undefined,
  )
  eq(
    'a pair that rejected it once stays off',
    AICore.effectiveTemperature({
      providerId: 'custom',
      baseUrl: 'https://modelsell.cc/v1',
      model: 'claude-fable-5',
      temperature: 0.3,
      temperatureOffSlots: { 'https://modelsell.cc/v1|claude-fable-5': true },
    }),
    undefined,
  )
  eq(
    'other pairs are unaffected by that memory',
    AICore.effectiveTemperature({
      providerId: 'custom',
      baseUrl: 'https://modelsell.cc/v1',
      model: 'another-model',
      temperature: 0.3,
      temperatureOffSlots: { 'https://modelsell.cc/v1|claude-fable-5': true },
    }),
    0.3,
  )
  check(
    'the reported rejection is recognised',
    AICore.isTemperatureRejection('temperature is deprecated for this model.') &&
      AICore.isTemperatureRejection('invalid temperature: only 0.6 is allowed for this model') &&
      AICore.isTemperatureRejection('Unsupported value: temperature does not support 0.3 with this model'),
  )
  check(
    'unrelated errors are not mistaken for it',
    !AICore.isTemperatureRejection('API key is invalid') &&
      !AICore.isTemperatureRejection('model not found') &&
      !AICore.isTemperatureRejection(''),
  )
  eq(
    'the pair key matches the api-key slot',
    AICore.pairSlot({ baseUrl: 'https://a.com/', model: ' m ' }),
    AICore.apiKeySlot({ baseUrl: 'https://a.com/', model: ' m ' }),
  )

  console.log('LaTeX extraction')
  {
    const roundTrip = (source, render) => {
      const masked = AIMath.maskMath(source)
      return { ...masked, restored: AIMath.unmaskMath(masked.text, masked.items, render) }
    }
    const asPlain = (item) => `[${item.display ? 'block' : 'inline'}:${item.tex}]`

    const both = roundTrip('能量是 $E=mc^2$，整块：\n\n$$\\int_0^1 x\\,dx$$\n', asPlain)
    eq('two formulas are found', both.items.length, 2)
    eq('inline TeX is kept verbatim', both.items[0].tex, 'E=mc^2')
    eq('inline maths is not display mode', both.items[0].display, false)
    eq('$$ is display mode', both.items[1].display, true)
    eq(
      'restoring puts the maths back in place',
      both.restored,
      '能量是 [inline:E=mc^2]，整块：\n\n[block:\\int_0^1 x\\,dx]\n',
    )
    check('no token survives unmasking', !both.restored.includes('apwebmathtoken'))
  }
  eq('backslash parens are inline maths', AIMath.maskMath('a \\(x^2\\) b').items[0].display, false)
  eq('backslash brackets are display maths', AIMath.maskMath('a \\[x^2\\] b').items[0].display, true)
  eq('< and > in maths survive', AIMath.maskMath('$a<b>c$').items[0].tex, 'a<b>c')
  eq(
    'two formulas keep their order',
    AIMath.maskMath('$a$ and $b$').items.map((item) => item.tex),
    ['a', 'b'],
  )
  eq('an escaped dollar is not maths', AIMath.maskMath('price is \\$5 today').items.length, 0)
  eq('currency is not maths', AIMath.maskMath('it costs $5 and $10').items.length, 0)
  eq('an unmatched delimiter is left alone', AIMath.maskMath('so $x^2 and then').items.length, 0)
  eq('fenced code keeps its dollars', AIMath.maskMath('```\n$x^2$\n```').items.length, 0)
  eq('inline code keeps its dollars', AIMath.maskMath('use `$x$` here').items.length, 0)
  eq('multi-line display maths works', AIMath.maskMath('$$\na+b\n$$').items.length, 1)
  eq(
    'a ```latex fence is maths, not code',
    AIMath.maskMath('```latex\nE = mc^2\n```').items.map((i) => [i.tex, i.display]),
    [['E = mc^2', true]],
  )
  eq(
    'a ```math fence too',
    AIMath.maskMath('```math\n\\frac{a}{b}\n```').items[0]?.tex,
    '\\frac{a}{b}',
  )
  eq(
    'a plain code fence is still code',
    AIMath.maskMath('```js\nconst a = 1\n```').items.length,
    0,
  )
  eq(
    'a bare align environment is maths',
    AIMath.maskMath('\\begin{align}\na &= b + c \\\\\nd &= e\n\\end{align}').items[0]?.display,
    true,
  )
  eq(
    'a bare cases environment too',
    AIMath.maskMath('\\begin{cases} x & x > 0 \\\\ 0 & x \\le 0 \\end{cases}').items.length,
    1,
  )
  eq(
    'an unknown environment is left alone',
    AIMath.maskMath('\\begin{tikzpicture} x \\end{tikzpicture}').items.length,
    0,
  )
  eq(
    'a replacement containing $ is inserted literally',
    AIMath.unmaskMath('x apwebmathtoken0 y', [{ tex: 'a$b', display: false }], () => '<i>$&</i>'),
    'x <i>$&</i> y',
  )

  console.log('streamChat failure modes')
  {
    const realFetch = globalThis.fetch
    const collect = async (stub) => {
      globalThis.fetch = stub
      const chunks = []
      try {
        for await (const chunk of AICore.streamChat({
          baseUrl: 'https://relay.example',
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
        })) {
          chunks.push(chunk)
        }
      } catch (error) {
        globalThis.fetch = realFetch
        return { error: error.message, chunks }
      }
      globalThis.fetch = realFetch
      return { chunks }
    }

    const html = await collect(async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    check(
      'a web page instead of an API is reported clearly',
      /网页/.test(html.error ?? '') && /\/v1/.test(html.error ?? ''),
    )

    const sse = await collect(async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
    eq('a real stream still yields its deltas', sse.chunks, [{ type: 'content', text: 'hi' }])

    const http = await collect(async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    check('an HTTP error keeps its translated hint', /API key 无效/.test(http.error ?? ''))
  }

  check('selectionTurnText keeps scope rule', AICore.selectionTurnText('hello').includes(AICore.SCOPE_RULE))
  check('selectionTurnText quotes text', AICore.selectionTurnText('hello').includes('"""\nhello\n"""'))
  eq('short selection threshold', AICore.SHORT_SELECTION_LENGTH, 40)

  console.log('AIStore: defaults')
  await AIStore.load()
  eq('default provider', AIStore.state.settings.providerId, 'deepseek')
  eq('default endpoint', AIStore.state.settings.baseUrl, 'https://api.deepseek.com')
  eq('default trigger', AIStore.state.settings.selectionTrigger, 'click')
  eq(
    'default action is one of the shipped prompts',
    AICore.DEFAULT_SETTINGS.selectionPrompts.some(
      (p) => p.id === AIStore.state.settings.selectionAction,
    ),
    true,
  )
  eq('composer prompts default', AIStore.state.settings.composerPrompts.length, 1)
  eq('selection prompts default', AIStore.state.settings.selectionPrompts.length, 3)

  console.log('AIStore: the Android card settings')
  eq('card height default', AIStore.state.settings.panelMaxHeight, 220)
  check('what you sent shows in the card by default', AIStore.state.settings.showSentContent === true)
  eq('an absurd height is clamped', AICore.clampCardHeight(99999), 2000)
  eq('a too-small one too', AICore.clampCardHeight(1), 160)
  eq('a missing one falls back to the default', AICore.clampCardHeight(undefined), 220)
  storage['apweb.ai.settings'] = { panelMaxHeight: 'not a number', showSentContent: false }
  await AIStore.load()
  eq('a stored typo does not survive a load', AIStore.state.settings.panelMaxHeight, 220)
  check('and the switch is remembered', AIStore.state.settings.showSentContent === false)
  storage['apweb.ai.settings'] = {}
  await AIStore.load()

  console.log('AIStore: preset endpoint wins')
  storage['apweb.ai.settings'] = { providerId: 'deepseek', baseUrl: 'http://evil.local', model: '' }
  await AIStore.load()
  eq('preset address reset', AIStore.state.settings.baseUrl, 'https://api.deepseek.com')
  eq('preset model filled', AIStore.state.settings.model, 'deepseek-flash')

  console.log('AIStore: legacy selectionAction off')
  storage['apweb.ai.settings'] = { providerId: 'deepseek', selectionAction: 'off' }
  await AIStore.load()
  eq('legacy off -> trigger off', AIStore.state.settings.selectionTrigger, 'off')
  check(
    'legacy off falls back to a real prompt',
    AIStore.state.settings.selectionPrompts.some(
      (p) => p.id === AIStore.state.settings.selectionAction,
    ),
  )

  console.log('AIStore: key slots follow endpoint+model')
  storage['apweb.ai.settings'] = {}
  delete storage['apweb.ai.settings']
  await AIStore.load()
  AIStore.updateSettings({ providerId: 'custom', baseUrl: 'https://relay.example/v1', model: 'model-a' })
  AIStore.updateSettings({ apiKey: 'key-a' })
  eq('key stored in slot', AIStore.state.settings.apiKeys['https://relay.example/v1|model-a'], 'key-a')
  eq('live key', AIStore.state.settings.apiKey, 'key-a')
  AIStore.updateSettings({ model: 'model-b' })
  eq('switching model blanks key', AIStore.state.settings.apiKey, '')
  AIStore.updateSettings({ apiKey: 'key-b' })
  AIStore.updateSettings({ model: 'model-a' })
  eq('switching back restores key', AIStore.state.settings.apiKey, 'key-a')
  AIStore.updateSettings({ apiKey: '' })
  eq('clearing removes entry', 'https://relay.example/v1|model-a' in AIStore.state.settings.apiKeys, false)

  console.log('AIStore: thinking remembered per provider')
  AIStore.updateSettings({ providerId: 'deepseek' })
  AIStore.updateSettings({ thinking: true })
  eq('deepseek thinking on', AIStore.state.settings.thinking, true)
  AIStore.updateSettings({ providerId: 'zhipu' })
  eq('zhipu thinking default off', AIStore.state.settings.thinking, false)
  AIStore.updateSettings({ providerId: 'deepseek' })
  eq('deepseek thinking remembered', AIStore.state.settings.thinking, true)

  console.log('AIStore: prompt editing')
  const editedId = AIStore.state.settings.selectionAction
  AIStore.updatePrompt('selection', { name: '改名了' })
  eq(
    'rename sticks',
    AICore.findPrompt(AIStore.state.settings.selectionPrompts, editedId).name,
    '改名了',
  )
  const newId = AIStore.addPrompt('selection')
  eq('added prompt selected', AIStore.state.settings.selectionAction, newId)
  eq('prompt count grew', AIStore.state.settings.selectionPrompts.length, 4)
  AIStore.deletePrompt('selection')
  eq('delete leaves 3', AIStore.state.settings.selectionPrompts.length, 3)
  AIStore.resetPrompts('selection')
  eq('reset restores defaults', AIStore.state.settings.selectionPrompts.length, 3)
  eq('reset restores name', AIStore.state.settings.selectionPrompts[0].name, '解释并翻译')
  AIStore.resetPrompts('selection')
  AIStore.deletePrompt('selection')
  eq('delete leaves two', AIStore.state.settings.selectionPrompts.length, 2)
  while (AIStore.state.settings.selectionPrompts.length > 1) AIStore.deletePrompt('selection')
  AIStore.deletePrompt('selection')
  eq('cannot delete the last prompt', AIStore.state.settings.selectionPrompts.length, 1)

  console.log('AIStore: message cap')
  AIStore.clearMessages()
  for (let i = 0; i < 70; i++) AIStore.pushMessage({ role: 'user', content: `m${i}` })
  eq('messages capped at 60', AIStore.state.messages.length, 60)
  eq('oldest dropped', AIStore.state.messages[0].content, 'm10')

  // The real pipeline, minus DOMPurify (it needs a DOM, so it is stubbed): does a
  // formula in a reply actually come out as MathML, and does code stay literal?
  console.log('markdown + KaTeX wiring')
  load('vendor/marked.umd.js')
  load('vendor/katex.min.js')
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html }
  load('src/shared/markdown.js')
  {
    const html = AIMarkdown.renderMarkdown('能量是 $E=mc^2$。\n\n$$\\frac{1}{2}$$')
    check('inline maths renders as MathML', html.includes('<math') && html.includes('<msup>'))
    check('display maths is block level', html.includes('display="block"'))
    // What you actually see is KaTeX's HTML half (its CSS + web fonts); the MathML
    // half is the hidden copy screen readers use.
    check('the visible half is KaTeX HTML', html.includes('katex-html'))
    check('a MathML copy is kept for screen readers', html.includes('katex-mathml'))
    check('no placeholder leaks into the output', !html.includes('apwebmathtoken'))
    check('the surrounding markdown still renders', html.includes('<p>'))
    check('the TeX source is kept for screen readers', html.includes('application/x-tex'))
    const code = AIMarkdown.renderMarkdown('use `$x$` here')
    check('maths inside code spans stays literal', code.includes('$x$') && !code.includes('<math'))
    const bad = AIMarkdown.renderMarkdown('$\\frac{1}{$')
    check('broken TeX does not throw or inject HTML', typeof bad === 'string' && !/<script/i.test(bad))
  }

  console.log('repo invariants')
  {
    const path = require('path')
    // Comments may name Chinese UI strings; only real code counts.
    const stripComments = (text) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const files = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (entry.name.endsWith('.js') && rel !== 'src/shared/i18n.js') files.push(rel)
      }
    }
    walk('src')
    eq(
      'no user-facing string lives outside the i18n table',
      files.filter((rel) =>
        /[\u4e00-\u9fff]/.test(stripComments(fs.readFileSync(`${ROOT}/${rel}`, 'utf8'))),
      ),
      [],
    )

    const manifest = JSON.parse(fs.readFileSync(`${ROOT}/manifest.json`, 'utf8'))
    const loadsFirst = (list) => {
      const i18nAt = list.indexOf('src/shared/i18n.js')
      if (i18nAt === -1) return false
      return list.every(
        (file, index) =>
          !/shared\/(ai|store|markdown)\.js$/.test(file) || index === i18nAt || i18nAt < index,
      )
    }
    check('i18n loads before ai.js/store.js in the content script', loadsFirst(manifest.content_scripts[0].js))
    check('the manifest uses only a service worker background',
      typeof manifest.background.service_worker === 'string' &&
      !('scripts' in manifest.background) && !('page' in manifest.background))
    check('the manifest contains no Firefox-specific settings',
      !('browser_specific_settings' in manifest))
    const optionsHtml = fs.readFileSync(`${ROOT}/src/options/options.html`, 'utf8')
    check(
      '…and in the options page',
      optionsHtml.indexOf('shared/i18n.js') < optionsHtml.indexOf('shared/ai.js'),
    )

    // Everything the browser shows *before* our scripts run — the installed name,
    // the description and the toolbar tooltip — has to come from `_locales`; a
    // hardcoded name is why an English install still said 网页 AI 助手.
    const locales = ['en', 'zh_CN']
    const messages = Object.fromEntries(
      locales.map((locale) => [
        locale,
        JSON.parse(fs.readFileSync(`${ROOT}/_locales/${locale}/messages.json`, 'utf8')),
      ]),
    )
    eq('the manifest declares a default locale', manifest.default_locale, 'en')
    eq(
      'both locales carry the same keys',
      Object.keys(messages.en).sort(),
      Object.keys(messages.zh_CN).sort(),
    )
    for (const key of ['name', 'description']) {
      const msgKey = manifest[key]?.match(/^__MSG_(\w+)__$/)?.[1]
      check(`manifest ${key} is localised`, Boolean(msgKey))
      check(
        `…and every locale has ${msgKey}`,
        Boolean(msgKey) && locales.every((locale) => messages[locale][msgKey]?.message),
      )
    }
    const actionKey = manifest.action?.default_title?.match(/^__MSG_(\w+)__$/)?.[1]
    check('the toolbar title is localised', Boolean(actionKey))
    check(
      '…and every locale has it',
      Boolean(actionKey) && locales.every((locale) => messages[locale][actionKey]?.message),
    )

    // The settings page is static HTML, so its text cannot come from AII18n like the
    // panel's does: it is filled from `_locales` in options.js instead.
    const optionsKeys = [...optionsHtml.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1])
    check('the settings page uses localised strings', optionsKeys.length >= 2)
    check(
      'every settings-page key exists in every locale',
      optionsKeys.every((key) => locales.every((locale) => messages[locale][key]?.message)),
    )
    eq(
      'each locale states the language it is written in',
      [messages.en.uiLang?.message, messages.zh_CN.uiLang?.message],
      ['en', 'zh-CN'],
    )
    check('the settings page has no hardcoded Chinese', !/[\u4e00-\u9fff]/.test(optionsHtml))
    check(
      'the options script applies the messages',
      /data-i18n/.test(fs.readFileSync(`${ROOT}/src/options/options.js`, 'utf8')),
    )
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})()

// Sanity harness for the extension's framework-free modules. Not shipped.
const fs = require('fs')
const vm = require('vm')

const ROOT = require('path').join(__dirname, '..')

// --- stub the WebExtension storage API -------------------------------------
const storage = {}
globalThis.browser = {
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

load('src/shared/ai.js')
load('src/shared/store.js')

const AICore = globalThis.AICore
const AIStore = globalThis.AIStore

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
  check('selectionTurnText keeps scope rule', AICore.selectionTurnText('hello').includes(AICore.SCOPE_RULE))
  check('selectionTurnText quotes text', AICore.selectionTurnText('hello').includes('"""\nhello\n"""'))
  eq('short selection threshold', AICore.SHORT_SELECTION_LENGTH, 40)

  console.log('AIStore: defaults')
  await AIStore.load()
  eq('default provider', AIStore.state.settings.providerId, 'deepseek')
  eq('default endpoint', AIStore.state.settings.baseUrl, 'https://api.deepseek.com')
  eq('default trigger', AIStore.state.settings.selectionTrigger, 'click')
  eq('default action', AIStore.state.settings.selectionAction, 'explain-translate')
  eq('composer prompts default', AIStore.state.settings.composerPrompts.length, 1)
  eq('selection prompts default', AIStore.state.settings.selectionPrompts.length, 3)

  console.log('AIStore: preset endpoint wins')
  storage['apweb.ai.settings'] = { providerId: 'deepseek', baseUrl: 'http://evil.local', model: '' }
  await AIStore.load()
  eq('preset address reset', AIStore.state.settings.baseUrl, 'https://api.deepseek.com')
  eq('preset model filled', AIStore.state.settings.model, 'deepseek-flash')

  console.log('AIStore: legacy selectionAction off')
  storage['apweb.ai.settings'] = { providerId: 'deepseek', selectionAction: 'off' }
  await AIStore.load()
  eq('legacy off -> trigger off', AIStore.state.settings.selectionTrigger, 'off')
  eq('legacy off -> first prompt', AIStore.state.settings.selectionAction, 'explain-translate')

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
  AIStore.updatePrompt('selection', { name: '改名了' })
  eq('rename sticks', AICore.findPrompt(AIStore.state.settings.selectionPrompts, 'explain-translate').name, '改名了')
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

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed')
  process.exit(failures ? 1 : 0)
})()

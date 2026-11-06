const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

async function delegates() {
  const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8')
  const functions = ['contextForDelegate', 'withDelegateShape'].map((name) => {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}$', 'm'))
    assert.ok(match, `${name} must exist`)
    return match[0]
  }).join('\n')
  const compiled = ts.transpileModule(`${functions}\nmodule.exports = withDelegateShape`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  const delegate = { stream: (_model, context) => context, streamSimple: (_model, context) => context }
  return (api) => {
    const context = vm.createContext({ module: { exports: {} }, piAi: api,
      PI_AI_FOLDS_TRANSCRIPT: typeof api.normalizeContext === 'function' })
    vm.runInContext(compiled, context)
    return context.module.exports(delegate)
  }
}

const tool = { name: 'lookup', description: 'Find an item', parameters: { type: 'object', properties: {} } }
const legacy = { systemPrompt: 'Follow the system instructions.', tools: [tool],
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }

test('an old adapter preserves the system prompt and tools for a newer delegate', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const modern = (await delegates())(piAi)
  const context = modern.streamSimple({}, legacy, {})
  assert.equal(piAi.getCurrentSystemPrompt(context.messages), 'Follow the system instructions.')
  assert.deepEqual(piAi.getCurrentTools(context.messages).map((entry) => entry.name), ['lookup'])
  assert.equal(context.messages.at(-1).content, 'Hello')
})

test('a new adapter preserves the system prompt and tools for an older delegate', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const older = (await delegates())({ contentText: piAi.contentText })
  const context = older.stream({}, piAi.normalizeContext(legacy), {})
  assert.equal(context.systemPrompt, 'Follow the system instructions.')
  assert.deepEqual(Array.from(context.tools, (entry) => entry.name), ['lookup'])
  assert.equal(context.messages[0].content, 'Hello')
})

test('an older delegate receives the current prompt and tools after transcript updates', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const older = (await delegates())({ contentText: piAi.contentText })
  const removed = { ...tool, name: 'removed' }
  const added = { ...tool, name: 'added' }
  const transcript = { messages: [
    { role: 'system', content: 'Initial.', sections: { kept: 'Keep.', changed: 'Old.', removed: 'Discard.' },
      toolsAdded: [tool, removed], timestamp: 0 },
    { role: 'user', content: 'First.', timestamp: 1 },
    { role: 'system', content: [{ type: 'text', text: 'Update.' }], sections: { changed: 'New.', removed: null },
      toolsRemoved: [{ name: 'removed' }], toolsAdded: [added], timestamp: 2 },
    { role: 'user', content: 'Last.', timestamp: 3 },
  ] }
  const context = older.stream({}, transcript, {})
  assert.equal(context.systemPrompt, 'Initial.\n\nUpdate.\n\nKeep.\n\nNew.')
  assert.deepEqual(Array.from(context.tools, (entry) => entry.name), ['lookup', 'added'])
  assert.deepEqual(Array.from(context.messages, (entry) => entry.content), ['First.', 'Last.'])
})

test('an older delegate preserves initial fields with a later system update', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const older = (await delegates())({ contentText: piAi.contentText })
  const context = older.stream({}, {
    systemPrompt: 'Initial.', tools: [tool], messages: [
      { role: 'user', content: 'Hello.', timestamp: 0 },
      { role: 'system', content: 'Update.', toolsRemoved: [{ name: 'lookup' }], timestamp: 1 },
    ],
  }, {})
  assert.equal(context.systemPrompt, 'Initial.\n\nUpdate.')
  assert.deepEqual(Array.from(context.tools), [])
  assert.deepEqual(Array.from(context.messages, (entry) => entry.content), ['Hello.'])
})

test('a new adapter leaves an already normalized transcript intact for a new delegate', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const modern = (await delegates())(piAi)
  const normalized = piAi.normalizeContext(legacy)
  assert.equal(modern.stream({}, normalized, {}), normalized)
})

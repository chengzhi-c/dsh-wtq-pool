const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createServer } = require('node:http')

async function adapterAt(baseUrl) {
  const piAi = await import('@earendil-works/pi-ai')
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const dsh = require('@deepseek-ai/dsh-llm')
  const { PiAiAdapter } = require('@deepseek-ai/dsh-llm-pi-ai')
  const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8')
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set(['toPiModel', 'contextForDelegate', 'withDelegateShape', 'buildAdapter',
    'PI_AI_FOLDS_TRANSCRIPT', 'STREAM_IDLE_TIMEOUT_MS', 'REQUEST_IMAGE_BUDGETS', 'NO_COST',
    'THINKING_LEVELS', 'INERT_AUTH', 'LOOPBACK_BEARER'])
  const selected = file.statements.filter(node =>
    ts.isFunctionDeclaration(node) && names.has(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(row => names.has(row.name.getText(file))))
  const context = vm.createContext({ module: { exports: {} }, piAi, ...piAi, ...dsh, PiAiAdapter,
    openAICompletionsApi, CONSERVATIVE_CONTEXT_WINDOW: 128000, DEFAULT_MAX_TOKENS: 32000 })
  vm.runInContext(ts.transpileModule(selected.map(node => node.getText(file)).join('\n') + '\nmodule.exports = buildAdapter', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText, context)
  const models = [{
    id: 'fixture-model', supportsImages: true, thinkingLevels: ['off', 'low', 'high'], defaultThinkingLevel: 'low',
  }]
  const providers = ['wtqpool-qoder-cn', 'wtqpool-cn'].map(id => ({ id, name: 'Fixture', baseUrl, models }))
  return context.module.exports(providers, { get: () => undefined }).adapter
}

test('the current DSH adapter receives a finite image budget and streams through the loopback provider', async () => {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ path: req.url, body: JSON.parse(body) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }) + '\n\ndata: [DONE]\n\n')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const adapter = await adapterAt(`http://127.0.0.1:${server.address().port}/v1`)
    const target = adapter.imageRequestTarget('wtqpool-qoder-cn', 'fixture-model', { width: 1920, height: 1080 })
    assert.equal(Number.isFinite(target.maxImageBytes), true, 'the host must receive a usable image byte limit')
    assert.ok(target.maxImageBytes > 0 && target.maxImageBytes <= 1048576)
    const call = await adapter.prepareCall('wtqpool-qoder-cn', 'fixture-model')
    assert.equal(call.model.reasoning.defaultEffort, 'low')
    const chunks = []
    for await (const chunk of call.stream({ provider: 'wtqpool-qoder-cn', model: 'fixture-model',
      system: 'Follow instructions.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })) chunks.push(chunk)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].path, '/v1/chat/completions')
    assert.equal(requests[0].body.reasoning_effort, 'low')
    assert.ok(requests[0].body.messages.some(message => message.content === 'Follow instructions.'))
    assert.ok(JSON.stringify(chunks).includes('Ready'))
    for (const provider of ['wtqpool-qoder-cn', 'wtqpool-cn']) {
      for await (const chunk of adapter.stream({ provider, model: 'fixture-model',
        reasoningEffort: 'off', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })) {}
      assert.equal(requests.at(-1).body.reasoning_effort, 'off', provider)
    }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

function delegates() {
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
  const modern = delegates()(piAi)
  const context = modern.streamSimple({}, legacy, {})
  assert.equal(piAi.getCurrentSystemPrompt(context.messages), 'Follow the system instructions.')
  assert.deepEqual(piAi.getCurrentTools(context.messages).map((entry) => entry.name), ['lookup'])
  assert.equal(context.messages.at(-1).content, 'Hello')
})

test('a new adapter preserves the system prompt and tools for an older delegate', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const older = delegates()({ contentText: piAi.contentText })
  const context = older.stream({}, piAi.normalizeContext(legacy), {})
  assert.equal(context.systemPrompt, 'Follow the system instructions.')
  assert.deepEqual(Array.from(context.tools, (entry) => entry.name), ['lookup'])
  assert.equal(context.messages[0].content, 'Hello')
})

test('an older delegate receives the current prompt and tools after transcript updates', async () => {
  const piAi = await import('@earendil-works/pi-ai')
  const older = delegates()({ contentText: piAi.contentText })
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
  const older = delegates()({ contentText: piAi.contentText })
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

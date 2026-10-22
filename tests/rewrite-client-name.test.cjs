/**
 * The client-name rewrite for WorkBuddy's domestic host.
 *
 * The host answers 11128 (channel check) to any prompt that names this client, on
 * every account of that region. The panel's switch sends that one name as
 * `DeepSeek` instead. What matters here is that only the name changes: tool names
 * and call ids reach the upstream exactly as the host wrote them, the
 * international host's body is not touched at all, and with the switch off
 * nothing is rewritten.
 *
 * Verified against the live host as well: the same turn in a fresh conversation
 * is refused with the switch off and answered with it on.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { registerHooks, createRequire } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

registerHooks({
  resolve(specifier, context, next) {
    const ownSource = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL).startsWith(path.join(root, 'src') + path.sep)
    return next(ownSource && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs', shortCircuit: true, source: transpile(fs.readFileSync(fileURLToPath(url), 'utf8')),
    }
    return next(url, context)
  },
})

const { clientNameRewritingFetch, DOMESTIC_CHAT_HOST } = require('../src/client-name.ts')

const CN = `https://${DOMESTIC_CHAT_HOST}/v2/chat/completions`
const GLOBAL = 'https://www.workbuddy.ai/v2/chat/completions'

const chatBody = () => JSON.stringify({
  model: 'deepseek-v4.1-flash',
  stream: true,
  messages: [
    { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness.' },
    { role: 'user', content: [{ type: 'text', text: 'does deepseek harness route this?' }] },
    { role: 'assistant', content: 'Let me call DeepSeek Harness.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'DeepSeek Harness', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ],
  tools: [{ type: 'function', function: { name: 'DeepSeek Harness tool', parameters: { type: 'object', properties: {} } } }],
})

/**
 * A wrapper over a fake transport that records what the inner fetch receives.
 * Built once per test, the way the host builds it once per process: a reader that
 * is captured at construction instead of read per request has to be visible here.
 */
const transport = (replacement) => {
  const seen = []
  const wrapped = clientNameRewritingFetch(replacement, (input, init) => {
    seen.push({ url: String(input), init })
    return { ok: true, status: 200 }
  })
  const send = (url = CN, body = chatBody(), extra = {}) => {
    seen.length = 0
    wrapped(url, { method: 'POST', headers: { authorization: 'Bearer t' }, redirect: 'error', body, ...extra })
    return seen[0]
  }
  return { send }
}

/** One request through a fresh wrapper; the shape most cases need. */
const dispatch = (replacement, url = CN, body = chatBody()) => {
  const seen = transport(replacement).send(url, body)
  return { sent: JSON.parse(seen.init.body), body: seen.init.body, init: seen.init }
}

test('with the switch off the prompt goes out as the host wrote it', () => {
  const { body, sent } = dispatch(() => undefined)
  assert.equal(body, chatBody(), 'the body is forwarded byte for byte')
  assert.equal(sent.messages[0].content, 'You are an AI agent powered by DeepSeek Harness.')
})

test('with the switch on, every message text carries the replacement name', () => {
  const { sent } = dispatch(() => 'DeepSeek')
  assert.equal(sent.messages[0].content, 'You are an AI agent powered by DeepSeek.',
    'the system prompt names the vendor instead of the client')
  assert.equal(sent.messages[1].content[0].text, 'does DeepSeek route this?',
    'a user message is rewritten too: the host reads the whole prompt')
  const texts = sent.messages
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n')
        : ''))
    .join('\n')
  assert.doesNotMatch(texts, /DeepSeek Harness/i, 'no message text keeps the refused name')
})

test('the rewrite leaves tool names and call ids alone', () => {
  const { sent } = dispatch(() => 'DeepSeek')
  assert.equal(sent.messages[2].content, 'Let me call DeepSeek.',
    'a message can carry text and a tool call at once; its text is still rewritten')
  assert.equal(sent.messages[2].tool_calls[0].function.name, 'DeepSeek Harness',
    'a tool name is the client vocabulary: rewriting it would break the call it belongs to')
  assert.equal(sent.messages[3].tool_call_id, 'call_1', 'the pairing id is untouched')
  assert.equal(sent.tools[0].function.name, 'DeepSeek Harness tool', 'and so is a declared tool name')
})

test('the rest of the request survives the rewrite', () => {
  const { init } = dispatch(() => 'DeepSeek')
  assert.equal(init.method, 'POST', 'the method must not be dropped with the body')
  assert.equal(init.redirect, 'error', 'the redirect policy is part of the call')
  assert.equal(init.headers.authorization, 'Bearer t', 'the credential rides in the headers')
})

test('the international host is not rewritten, switch or no switch', () => {
  const { body } = dispatch(() => 'DeepSeek', GLOBAL)
  assert.equal(body, chatBody(), 'only the domestic host runs the channel check')
})

test('the name is read per request, so the switch needs no restart', () => {
  let replacement
  // One wrapper for all three requests, as the host has one for the whole run.
  const { send } = transport(() => replacement)
  const text = () => JSON.parse(send().init.body).messages[0].content
  assert.equal(text(), 'You are an AI agent powered by DeepSeek Harness.', 'off while the reader says so')
  replacement = 'DeepSeek'
  assert.equal(text(), 'You are an AI agent powered by DeepSeek.',
    'on as soon as it says otherwise, on the same wrapper')
  replacement = '   '
  assert.equal(text(), 'You are an AI agent powered by DeepSeek Harness.', 'a blank name is not a substitution')
})

test('a domestic call that carries no prompt is passed through untouched', () => {
  // The growth and check-in calls share this base but send no `messages`; a guard
  // on the shape is what keeps them from being handed an empty conversation.
  const growth = JSON.stringify({ location_id: 4 })
  const { body } = dispatch(() => 'DeepSeek', `https://${DOMESTIC_CHAT_HOST}/activity/growth/buddy/travel/depart`, growth)
  assert.equal(body, growth, 'a body without messages is not a chat request')
})

/**
 * The switch, driven through the host the way the panel drives it.
 *
 * The unit tests above cover the rewrite in isolation, and would all pass with the
 * wrapper never installed, the setting never read, or the document field never
 * filled. This runs the real host: it asserts the client the host builds is the
 * wrapper, turns the switch on through the panel's own channel, and then makes a
 * real domestic chat call so the URL the client builds is the one asserted
 * against. A chat base that moves away from the rewrite goes red here.
 */
test('the host installs the rewrite and reports the switch it reads', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rewrite-'))
  const settings = { enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false }
  const outgoing = []
  const transportStub = async (input, init) => {
    outgoing.push({ url: String(input), body: init?.body })
    return { ok: true, status: 200, headers: new Map(), json: async () => ({}), text: async () => '{}' }
  }
  require('../src/pi-compat.ts').installPi({
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })

  const module = { exports: {} }
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module, exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    AbortController, AbortSignal, fetch: transportStub, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Buffer, process, TextEncoder, TextDecoder,
  })
  context.exports = module.exports
  vm.runInContext(
    transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8'))
      + '\nmodule.exports.__internals = { core }\n',
    context, { filename: 'src/host.ts' },
  )
  const plugin = module.exports
  const core = plugin.__internals.core
  // The wrapper takes its inner transport from `globalThis.fetch` at the moment it
  // is built, and the module holding it is shared with this file. Swapping the
  // global for the duration of the load is what routes the host's client into the
  // recording stub instead of the network.
  const realFetch = globalThis.fetch
  globalThis.fetch = transportStub

  try {
    await plugin.onLoad()
    const client = core.client
    assert.notEqual(client.fetchImpl, transportStub,
      'without the wrapper installed the switch would be a control that does nothing')

    const send = async () => {
      outgoing.length = 0
      // The real call path, so the URL under test is the one the client builds.
      await client.chatStream({ accessToken: 't', domain: '' }, chatBody()).catch(() => {})
      assert.equal(outgoing.length, 1, 'the request must reach the transport')
      return JSON.parse(outgoing[0].body)
    }

    // Off first, so the document is read in the state a fresh install is in.
    const off = await plugin.onPanelInvoke('xd.state', {})
    assert.equal(off.replacedClientName, null, 'nothing is rewritten until the user says so')
    assert.equal((await send()).messages[0].content, 'You are an AI agent powered by DeepSeek Harness.',
      'with the switch off the refused name really does leave the process')

    const on = await plugin.onPanelInvoke('xd.setRewriteClientName', { enabled: true })
    assert.equal(on.replacedClientName, 'DeepSeek', 'the switch is saved and reported in the same answer')
    assert.equal(settings.rewriteClientName, true, 'and it is written to the settings the host owns')
    assert.equal((await send()).messages[0].content, 'You are an AI agent powered by DeepSeek.',
      'the next turn leaves without the refused name, with no reload in between')

    const back = await plugin.onPanelInvoke('xd.setRewriteClientName', { enabled: false })
    assert.equal(back.replacedClientName, null, 'turning it off is saved the same way')
    assert.equal(settings.rewriteClientName, false)
    assert.equal((await send()).messages[0].content, 'You are an AI agent powered by DeepSeek Harness.',
      'and the original wording comes back')
  } finally {
    globalThis.fetch = realFetch
    await plugin.onUnload().catch(() => {})
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

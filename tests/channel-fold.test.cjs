/**
 * The host's prompt screen, and the one retry that clears it.
 *
 * WorkBuddy refuses a system turn whose wording belongs to a client it does not
 * serve: code 11128. The same instructions in the first user turn are accepted,
 * so the plugin folds the system prompt there and retries once. A prompt that
 * has already been refused is folded before sending, so a conversation pays the
 * refused round trip once rather than on every turn.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { registerHooks } = require('node:module')
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

const { WorkBuddyUpstreamClient, foldSystemIntoUser } = require('../src/upstream.ts')

const CN = {
  accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAtMs: 0,
  uid: 'fixture-uid', domain: 'www.workbuddy.cn', sourcePath: '',
}
const SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
const REFUSAL = JSON.stringify({
  code: 11128,
  msg: 'Illegal API invocation from an unapproved channel',
  displayMsg: { en: 'Request blocked. Please send it again' },
})

function bodyOf(init) {
  return JSON.parse(String(init?.body ?? '{}'))
}

test('a system prompt refused in a 200 envelope is folded and retried', async () => {
  const calls = []
  let refused = false
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      if (!refused) {
        refused = true
        return new Response(REFUSAL, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const prepared = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'A prompt refused with HTTP 200 (envelope case)' },
      { role: 'user', content: 'hi' },
    ],
  })
  const first = await client.chatStream(CN, prepared, undefined, { headersMs: 50 })
  assert.equal(first.ok, true)
  assert.equal(calls.length, 2, 'the 200 envelope is retried once, like the 400 shape')
  assert.equal(calls[1].messages[0].content, '')
  assert.match(calls[1].messages[1].content, /envelope case/u)

  calls.length = 0
  const second = await client.chatStream(CN, prepared, undefined, { headersMs: 50 })
  assert.equal(second.ok, true)
  assert.equal(calls.length, 1, 'the accepted fold is remembered for the next turn')
  assert.equal(calls[0].messages[0].content, '')
})

test('a prompt screen labeled text/plain is still folded and retried', async () => {
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      if (calls.length === 1) {
        return new Response(REFUSAL, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(Buffer.byteLength(REFUSAL)),
          },
        })
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const result = await client.chatStream(CN, JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'A prompt refused under the wrong content type' },
      { role: 'user', content: 'hi' },
    ],
  }), undefined, { headersMs: 50 })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'a declared small body is inspected even when labeled text/plain')
  assert.equal(calls[1].messages[0].content, '')
})

test('a refused system prompt is moved into the first user turn and retried', async () => {
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      if (calls.length === 1) {
        return new Response(REFUSAL, { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const system = 'You are an AI agent powered by DeepSeek Harness. (retry case)'
  const result = await client.chatStream(CN, JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'hi' },
    ],
  }), undefined, { headersMs: 50 })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'the refusal is retried once')
  const sent = calls[1].messages
  assert.equal(sent[0].role, 'system', 'a system turn still opens the body')
  assert.equal(sent[0].content, '', 'but carries no wording the screen reads')
  assert.equal(sent[1].role, 'user')
  assert.match(sent[1].content, /You are an AI agent powered by DeepSeek Harness/u,
    'the instructions survive in the user turn')
  assert.match(sent[1].content, /^[\s\S]*\n\nhi$/u, 'the user text follows the instructions')
})

test('an accepted fold is reused on the next turn', async () => {
  const calls = []
  let refused = false
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      if (!refused) {
        refused = true
        return new Response(REFUSAL, { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const prepared = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. (reuse case)' },
      { role: 'user', content: 'again' },
    ],
  })
  assert.equal((await client.chatStream(CN, prepared, undefined, { headersMs: 50 })).ok, true)
  assert.equal(calls.length, 2, 'the first turn pays the refused round trip')
  calls.length = 0
  assert.equal((await client.chatStream(CN, prepared, undefined, { headersMs: 50 })).ok, true)
  assert.equal(calls.length, 1, 'the accepted prompt no longer pays a refused call')
  assert.equal(calls[0].messages[0].content, '')
  assert.match(calls[0].messages[1].content, /DeepSeek Harness/u)
})

test('a retry that fails again does not poison the next turn', async () => {
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      return new Response(REFUSAL, { status: 400, headers: { 'content-type': 'application/json' } })
    },
  })
  const prepared = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'A prompt that is refused twice (poison case)' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.equal((await client.chatStream(CN, prepared, undefined, { headersMs: 50 })).ok, false)
  assert.equal(calls.length, 2, 'the first turn tries the fold once')
  calls.length = 0
  assert.equal((await client.chatStream(CN, prepared, undefined, { headersMs: 50 })).ok, false)
  assert.equal(calls[0].messages[0].content, 'A prompt that is refused twice (poison case)',
    'the next turn starts from the original prompt, not a rewrite that was never accepted')
})

test('a 400 that is not the prompt screen is not retried', async () => {
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      calls.push(bodyOf(init))
      return new Response(JSON.stringify({ code: 4003, msg: 'messages must not be empty' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const result = await client.chatStream(CN, JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [{ role: 'system', content: 'unique ordinary system prompt' }, { role: 'user', content: 'hi' }],
  }), undefined, { headersMs: 50 })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'client')
  assert.equal(calls.length, 1, 'a request error is answered, not rewritten')
})

test('folding keeps array content and inserts a user turn when there is none', () => {
  const folded = JSON.parse(foldSystemIntoUser(JSON.stringify({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Alpha' }] },
      { role: 'assistant', content: 'previous' },
    ],
  })))
  assert.equal(folded.messages[0].role, 'system')
  assert.equal(folded.messages[0].content, '')
  assert.equal(folded.messages[1].role, 'user')
  assert.equal(folded.messages[1].content, 'Alpha')
  assert.equal(folded.messages[2].role, 'assistant', 'the rest of the conversation keeps its order')
})

test('an empty system turn is left alone', () => {
  assert.equal(foldSystemIntoUser(JSON.stringify({
    messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hi' }],
  })), undefined)
  assert.equal(foldSystemIntoUser(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
  })), undefined)
})

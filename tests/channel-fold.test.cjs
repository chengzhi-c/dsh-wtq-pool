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
require('./ts-loader.cjs')

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

for (const status of [200, 400]) {
  test('HTTP ' + status + ' prompt refusal folds once, preserves instructions and reuses the accepted form', async () => {
    const calls = []
    const client = new WorkBuddyUpstreamClient({
      fetchImpl: async (_url, init) => {
        calls.push(bodyOf(init))
        return calls.length === 1
          ? new Response(REFUSAL, { status, headers: { 'content-type': 'application/json' } })
          : new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const system = 'You are an AI agent powered by DeepSeek Harness. HTTP ' + status
    const prepared = JSON.stringify({
      model: 'kimi-k3-1', stream: true,
      messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }],
    })
    assert.equal((await client.chatStream(CN, prepared)).ok, true)
    assert.equal(calls.length, 2)
    const sent = calls[1].messages
    assert.equal(sent[0].role, 'system')
    assert.ok(sent[0].content.trim(), 'Kimi requires a nonempty system placeholder')
    assert.equal(sent[1].role, 'user')
    assert.equal(sent[1].content, system + '\n\nhi')
    assert.equal((await client.chatStream(CN, prepared)).ok, true)
    assert.equal(calls.length, 3, 'the accepted prompt does not pay another refused call')
    assert.deepEqual(calls[2].messages, sent)
  })
}

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
  assert.ok(calls[1].messages[0].content.trim())
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
  const raw = foldSystemIntoUser(JSON.stringify({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Alpha' }] },
      { role: 'assistant', content: 'previous' },
    ],
  }))
  const folded = JSON.parse(raw)
  assert.equal(folded.messages[0].role, 'system')
  assert.ok(folded.messages[0].content.trim())
  assert.equal(folded.messages[1].role, 'user')
  assert.equal(folded.messages[1].content, 'Alpha')
  assert.equal(folded.messages[2].role, 'assistant', 'the rest of the conversation keeps its order')
  assert.equal(foldSystemIntoUser(raw), undefined, 'the neutral placeholder must not fold a second time')
})

test('renaming assistant history preserves the leading neutral system turn', () => {
  const folded = JSON.parse(foldSystemIntoUser(JSON.stringify({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'assistant', content: 'DeepSeek Harness answered earlier.' },
      { role: 'user', content: 'Continue.' },
    ],
  })))
  assert.equal(folded.messages[0].role, 'system', 'the global gateway still requires the system turn')
  assert.ok(folded.messages[0].content.trim())
  assert.equal(folded.messages[1].content, 'DeepSeek answered earlier.')
  assert.equal(foldSystemIntoUser(JSON.stringify(folded)), undefined)
})

test('an empty system turn is left alone', () => {
  assert.equal(foldSystemIntoUser(JSON.stringify({
    messages: [{ role: 'system', content: '' }, { role: 'user', content: 'hi' }],
  })), undefined)
  assert.equal(foldSystemIntoUser(JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
  })), undefined)
})

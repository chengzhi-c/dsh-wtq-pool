/**
 * What each gateway makes of an answer that is not the answer it asked for.
 *
 * Four shapes reached a client as success before: a per-model cooldown that a
 * model id like `__proto__` swallowed, a 200 whose body was not a stream, a
 * Qoder directory that came back empty, and a Trae function that refused inside
 * the stream rather than in an HTTP body. Each case below is the smallest setup
 * that used to produce the wrong outcome.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

// This half of the plugin ships from TypeScript sources, so the checks load them
// the way every other test in this tree does.
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

const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { createWorkBuddyShim } = require('../src/shim.ts')
const { createQoderGateway } = require('../src/qoder-gateway.ts')
const { createTraeGateway } = require('../src/trae-gateway.ts')

const QUIET = { info() {}, warn() {}, error() {} }

/** A sign-in file the pool reads, far from expiry so no refresh is spent. */
function signInDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wtq-${prefix}-`))
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, domain: 'www.codebuddy.cn' },
    account: { uin: 'u-1', nickname: 'one' },
  }))
  return dir
}

/** A WorkBuddy gateway whose upstream is the given chat behaviour. */
async function workbuddyShim({ client, models, model = 'hy3' }) {
  const dir = signInDir('answer')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000, client })
  await pool.scan()
  const shim = createWorkBuddyShim({
    pool, region: 'cn', client, logger: QUIET,
    catalog: { visible: () => models.map((id) => ({ id })), current: () => models.map((id) => ({ id })) },
  })
  await shim.ready
  return {
    pool,
    base: shim.baseUrl(),
    async turn(body = {}) {
      const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...body }),
      })
      return { status: answer.status, type: answer.headers.get('content-type'), text: await answer.text() }
    },
    async close() {
      await shim.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a model id that shadows a prototype member still gets its own cooldown', async () => {
  // `modelCooldowns` is keyed by the client's model id. Written into a plain
  // object, `__proto__` went to the prototype setter instead of the table, the
  // cooldown never landed, and one request spent every attempt on the same
  // account - eight upstream 429s where one was the point.
  const models = ['__proto__', 'hy3']
  const calls = []
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async (_credential, body) => {
      calls.push(body.model)
      return { ok: false, kind: 'soft_rate', status: 429, message: 'usage exceeds frequency limit' }
    },
  }
  const shim = await workbuddyShim({ client, models, model: '__proto__' })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 429)
    assert.deepEqual(calls, ['__proto__'], 'the cooled model is not retried on the same account')
    const [account] = shim.pool.list()
    assert.ok(account.modelCooldowns['__proto__'] > Date.now(), 'the cooldown is an own key of the table')
  } finally {
    await shim.close()
  }
})

test('a 200 with an empty body is answered as an upstream failure, not an empty turn', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 502, 'a body that never started is not a 200')
    assert.match(answer.text, /empty answer stream/)
  } finally {
    await shim.close()
  }
})

test('a stream that ends without [DONE] still carries a finish chunk', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 200)
    assert.match(answer.text, /"finish_reason":"stop"/, 'a truncated stream must end with a finish chunk')
    assert.ok(answer.text.includes('data: [DONE]'), 'and with the terminator')
  } finally {
    await shim.close()
  }
})

test('a 200 envelope with an account-level code cools the account instead of one 502', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response(JSON.stringify({ code: 6004, msg: '频率限制' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 429, 'the envelope is the rate limit it says it is')
    const [account] = shim.pool.list()
    assert.ok(account.modelCooldowns['hy3'] > Date.now(), 'the account is cooled for that model')
  } finally {
    await shim.close()
  }
})

test('a transport failure does not cool the account it failed on', async () => {
  const calls = []
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => {
      calls.push(1)
      return { ok: false, kind: 'transport', status: 0, message: 'connect ECONNREFUSED' }
    },
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 502)
    assert.equal(calls.length, 1, 'every account reaches the same host, so one timeout ends the rotation')
    const [account] = shim.pool.list()
    assert.equal(account.cooldownUntilMs, 0, 'the network path failed, not the account')
    assert.equal(account.rateLimitHits, 0, 'and it is not recorded as a rate limit')
  } finally {
    await shim.close()
  }
})

test('a [DONE] with no finish frame still carries one', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.match(answer.text, /"finish_reason":"stop"/, 'the terminator alone leaves the turn unfinished')
  } finally {
    await shim.close()
  }
})

test('a 200 session envelope refreshes the token before holding the account', async () => {
  let calls = 0
  let refreshes = 0
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    refreshToken: async () => {
      refreshes += 1
      return { accessToken: 'renewed-token', expiresInSec: 3600 }
    },
    chatStream: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          response: new Response(JSON.stringify({ code: 12153, msg: 'Offline user session not found' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          }),
        }
      }
      return {
        ok: true,
        response: new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        }),
      }
    },
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 200, 'the renewed token serves the retry')
    assert.equal(refreshes, 1, 'the envelope takes the same refresh path as a 401')
    assert.equal(calls, 2, 'and the retry rides the renewed token')
    const [account] = shim.pool.list()
    assert.equal(shim.pool.activeHold(account.id), null, 'a sign-in the refresh saved is not held')
  } finally {
    await shim.close()
  }
})

test('a 200 envelope that names an exhausted balance holds the account', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response(JSON.stringify({ code: 9001, msg: '积分不足' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 402, 'a spent balance is not a request error')
    const [account] = shim.pool.list()
    assert.equal(shim.pool.activeHold(account.id)?.reason, 'spent')
  } finally {
    await shim.close()
  }
})

test('a 200 with no body is an upstream failure, not a plugin 500', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response(null, { status: 200 }) })
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 502, 'an upstream with nothing to relay is a bad gateway')
    assert.match(answer.text, /without a stream/)
  } finally {
    await shim.close()
  }
})

test('a route with a query string still matches', async () => {
  const client = { prepareChatBody: (raw) => JSON.parse(raw), chatStream: async () => ({ ok: false, kind: 'client', status: 400, message: 'unused' }) }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await fetch(shim.base + '/v1/models?probe=1')
    assert.equal(answer.status, 200, 'the query string is not part of the route')
    const body = await answer.json()
    assert.deepEqual(body.data.map((entry) => entry.id), ['hy3'])
  } finally {
    await shim.close()
  }
})

test('a 200 carrying a refusal envelope keeps the refusal and the status honest', async () => {
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 502, 'an envelope is not a stream')
    assert.match(answer.text, /11128/)
    assert.match(answer.text, /unapproved channel/)
  } finally {
    await shim.close()
  }
})

test('a non-stream request is answered as SSE, as the README states', async () => {
  const frames = [
    'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn({ stream: false })
    assert.equal(answer.type, 'text/event-stream', 'the body is SSE whatever `stream` says')
    assert.ok(answer.text.includes('data: [DONE]'))
  } finally {
    await shim.close()
  }
})

test('a real stream is still relayed byte for byte after the head is peeked', async () => {
  const frames = [
    ': heartbeat\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const client = {
    prepareChatBody: (raw) => JSON.parse(raw),
    chatStream: async () => ({
      ok: true,
      response: new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    }),
  }
  const shim = await workbuddyShim({ client, models: ['hy3'] })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 200)
    assert.equal(answer.text, frames.join(''), 'the peeked bytes are put back in front of the rest')
  } finally {
    await shim.close()
  }
})

test('a Qoder directory that lists no callable model is a failed read, not an empty provider', async () => {
  const gateway = createQoderGateway({
    region: 'cn', port: 0, logger: QUIET,
    credentials: async () => [{ userID: 'u1', token: 't1' }],
    fetchImpl: async (url) => {
      if (String(url).includes('/algo/api/v2/model/list')) {
        return new Response(JSON.stringify({ chat: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error('unexpected fetch ' + String(url))
    },
  })
  await gateway.ready
  try {
    const answer = await fetch(gateway.baseUrl() + '/v1/models', { headers: { connection: 'close' } })
    assert.notEqual(answer.status, 200, 'the host drops a provider whose discovery is empty')
    assert.match(await answer.text(), /no callable model/)
  } finally { await gateway.close() }
})

test('a Qoder request the envelope rejects names the reason it was rejected', async () => {
  const row = { key: 'qmodel', display_name: 'Qwen3-Max', is_vl: false, context_config: { a: { token_count: 200_000 } } }
  const gateway = createQoderGateway({
    region: 'cn', port: 0, logger: QUIET,
    credentials: async () => [{ userID: 'u1', token: 't1' }],
    fetchImpl: async (url) => {
      if (String(url).includes('/algo/api/v2/model/list')) {
        return new Response(JSON.stringify({ chat: [row] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error('the envelope should have refused this request before any upstream call')
    },
  })
  await gateway.ready
  try {
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'qmodel', messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'out' }] }),
    })
    assert.equal(answer.status, 400)
    const text = await answer.text()
    assert.match(text, /tool_call_id/, 'the message names the missing link')
    assert.doesNotMatch(text, /invalid JSON request/)
  } finally { await gateway.close() }
})

test('a legacy function result is linked back to the call it answers', async () => {
  const row = { key: 'qmodel', display_name: 'Qwen3-Max', is_vl: false, context_config: { a: { token_count: 200_000 } } }
  let sent
  const gateway = createQoderGateway({
    region: 'cn', port: 0, logger: QUIET,
    credentials: async () => [{ userID: 'u1', token: 't1' }],
    fetchImpl: async (url, init) => {
      if (String(url).includes('/algo/api/v2/model/list')) {
        return new Response(JSON.stringify({ chat: [row] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      sent = init
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  await gateway.ready
  try {
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        model: 'qmodel',
        messages: [
          { role: 'user', content: 'read a.txt' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'function', name: 'read_file', content: '{"ok":true}' },
          { role: 'user', content: 'and now?' },
        ],
      }),
    })
    assert.equal(answer.status, 200)
    await answer.text()
    assert.ok(sent !== undefined, 'the turn reached the upstream')
  } finally { await gateway.close() }
})

test('a Trae 4001 that arrives inside the stream still hands the turn over', async () => {
  const credential = { accessToken: 't', userId: 'u', host: '', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3_600_000 }
  const row = (id, dev, out = 32_000) => ({
    config_name: id,
    display_config: { display_name: id, multimodal: false },
    context_window_tokens: { dev },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  })
  const attempts = []
  const gateway = createTraeGateway({
    port: 0, logger: QUIET,
    credentials: async () => [credential],
    identity: async () => ({ machineId: 'm', deviceId: 'd', platform: 'win32' }),
    fetchImpl: async (url, init) => {
      const target = String(url)
      if (target.includes('get_detail_param')) {
        const name = JSON.parse(String(init?.body ?? '{}')).function
        if (name === 'solo_work_remote') return new Response(JSON.stringify({ config_info_list: [row('contested', 128_000)] }), { status: 200, headers: { 'content-type': 'application/json' } })
        if (name === 'solo_agent_remote') return new Response(JSON.stringify({ config_info_list: [row('contested', 256_000, 16_000)] }), { status: 200, headers: { 'content-type': 'application/json' } })
        return new Response(JSON.stringify({ config_info_list: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (target.includes('/model')) return new Response(JSON.stringify({ data: { list: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      const body = JSON.parse(String(init?.body ?? '{}'))
      attempts.push(body.function)
      if (body.function === 'solo_agent_remote') {
        return new Response('event: error\ndata: {"code":4001,"message":"config not found"}\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('event: output\ndata: {"response":"served"}\n\nevent: done\ndata: {}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  await gateway.ready
  try {
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'contested', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200, 'the other answer serves the turn')
    assert.deepEqual(attempts, ['solo_agent_remote', 'solo_work_remote'])
  } finally { await gateway.close() }
})


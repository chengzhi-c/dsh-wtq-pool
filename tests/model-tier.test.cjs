/**
 * What the request says about the client, and what an account's plan allows.
 *
 * Two things the gateway can get wrong without any account going bad: a UA that
 * names a different version from `X-IDE-Version`, and a plan refusal (11158)
 * read as a generic client error, which spent the whole rotation before it
 * answered and cooled an account that was healthy.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

// The core imports its siblings without an extension, so the loader needs the
// same `.ts` resolution the DSH entry builds against.
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

const { WorkBuddyUpstreamClient, classifyUpstreamError } = require('../src/upstream.ts')
const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { createWorkBuddyShim } = require('../src/shim.ts')

const QUIET = { info() {}, warn() {}, error() {} }
const SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'

/** Every version segment a UA claims; each must match `X-IDE-Version`. */
function uaVersions(ua) {
  return [...(ua ?? '').matchAll(/(?:WorkBuddy|workbuddy-ai)\/(\d+\.\d+\.\d+)/gu)].map((match) => match[1])
}

function uaVersion(ua) {
  return uaVersions(ua)[0]
}

function workbuddy(handler) {
  const seen = []
  const upstream = new WorkBuddyUpstreamClient({
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers ?? {})
      seen.push({ url, headers })
      return handler(url, init, headers)
    },
  })
  return { upstream, seen }
}

function credential(domain) {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAtMs: Date.now() + 3_600_000,
    lastRefreshAtMs: Date.now(),
    domain,
    uid: 'uid-1',
    uin: '330000000001',
  }
}

test('every region sends one client version, in the header and in the UA', async () => {
  const { upstream, seen } = workbuddy(async () => new Response(SSE, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  }))
  for (const domain of ['www.codebuddy.cn', 'www.workbuddy.ai']) {
    const result = await upstream.chatStream(credential(domain), JSON.stringify({ model: 'hy3', messages: [] }))
    assert.equal(result.ok, true)
  }
  assert.equal(seen.length, 2, 'one request per region')
  for (const { url, headers } of seen) {
    const ua = headers.get('user-agent') ?? ''
    const versions = uaVersions(ua)
    assert.ok(versions.length >= 2, `${url} spells the version in more than one segment`)
    for (const version of versions) {
      assert.equal(version, headers.get('x-ide-version'),
        `${url} names one version in every place (UA: ${ua})`)
    }
    assert.equal(headers.get('connection'), 'close',
      `${url} does not hand a pooled socket to the next account`)
  }
  const [cn, global] = seen
  assert.equal(uaVersion(cn.headers.get('user-agent')), '5.9.3',
    'the CN desktop is 5.9.3')
  assert.equal(cn.headers.get('x-agent-runtime'), 'local-agent',
    'CN 5.9 names its agent runtime')
  assert.match(cn.headers.get('user-agent'), /^WorkBuddy\/[\d.]+ WorkBuddy\/[\d.]+ CLI\//u)
  assert.equal(uaVersion(global.headers.get('user-agent')), '5.8.4',
    'the international desktop is still 5.8.4')
  assert.match(global.headers.get('user-agent'), /workbuddy-ai\//u,
    'the international spelling is the one that carries the roster')
  assert.equal(global.headers.get('x-agent-runtime'), null,
    'the runtime header does not belong to the international build')
  for (const { headers } of seen) {
    assert.equal(headers.get('x-stainless-lang'), 'js', 'the SDK fingerprint family is present')
  }
})

test('the roster call does not claim a different build from the chat call', async () => {
  const roster = JSON.stringify({ code: 0, msg: '', data: { models: [{ id: 'default-model', name: 'Auto', maxInputTokens: 1000, maxOutputTokens: 100 }] } })
  const { upstream, seen } = workbuddy(async (url) => new Response(
    url.includes('/billing/')
      ? JSON.stringify({ code: 0, msg: '', data: { Response: { Data: { Accounts: [] } } } })
      : url.includes('/auth/token/refresh')
        ? JSON.stringify({ code: 0, msg: '', data: { accessToken: 'fresh', refreshToken: 'fresh-refresh', expiresIn: 3600 } })
        : roster,
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  await upstream.fetchModels(credential('www.workbuddy.ai'))
  await upstream.fetchModels(credential('www.codebuddy.cn'))
  await upstream.refreshToken(credential('www.codebuddy.cn'))
  await upstream.fetchCredits(credential('www.codebuddy.cn'))
  assert.equal(seen.length, 4)
  for (const { url, headers } of seen) {
    assert.equal(headers.get('connection'), 'close', `${url} closes its own connection`)
  }
  const versions = new Set(seen.map(({ headers }) => uaVersion(headers.get('user-agent'))))
  assert.deepEqual([...versions].sort(), ['5.8.4', '5.9.3'],
    'each region claims its own desktop build on roster, refresh and billing')
  const globalRoster = seen.find(({ url }) => url.includes('/v3/config'))
  const cnRoster = seen.find(({ url }) => url.includes('/personal/models'))
  assert.equal(globalRoster?.headers.get('user-agent'), 'WorkBuddy/5.8.4',
    'the global product config is read with the global desktop UA')
  assert.equal(cnRoster?.headers.get('user-agent'), 'WorkBuddy/5.9.3',
    'the CN roster is read with the CN desktop UA, not the chat endpoint CLI spelling')
})

test('a plan refusal is a verdict on the model, not on the request', () => {
  assert.equal(classifyUpstreamError(400, '{"code":11158,"msg":"model not available"}'), 'model_tier')
  assert.equal(classifyUpstreamError(403, '{"code":"11158"}'), 'model_tier')
  // The code is matched as an envelope value: inside a model id it says nothing.
  assert.equal(classifyUpstreamError(400, '{"msg":"model x11158y is unknown"}'), 'client')
  // A throttle that happens to quote the code stays a throttle.
  assert.equal(classifyUpstreamError(429, '{"code":11158}'), 'soft_rate')
  assert.equal(classifyUpstreamError(402, '{"code":11158}'), 'hard_credit')
})

test('an account-level restriction is not a verdict on the request', () => {
  const body = JSON.stringify({ code: 11140, msg: 'request illegal', displayMsg: { en: 'Your account has been restricted due to unusual activity' } })
  assert.equal(classifyUpstreamError(403, body), 'account_restricted')
  assert.equal(classifyUpstreamError(400, body), 'account_restricted')
  // A WAF page carries no envelope and stays its own kind.
  assert.equal(classifyUpstreamError(403, '<html>blocked</html>'), 'waf_block')
  // A throttle and a spent balance keep their classes even if they quote it.
  assert.equal(classifyUpstreamError(429, body), 'soft_rate')
  assert.equal(classifyUpstreamError(402, body), 'hard_credit')
})

/** Two panel-written sign-ins, so the pool has somewhere to rotate to. */
function twoAccounts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-tier-'))
  const signins = path.join(dir, 'signins')
  fs.mkdirSync(signins)
  for (const uin of ['330000000001', '330000000002']) {
    fs.writeFileSync(path.join(signins, `workbuddy-panel-${uin}.info`), JSON.stringify({
      auth: {
        accessToken: `access-${uin}`,
        refreshToken: `refresh-${uin}`,
        expiresAt: Date.now() + 3_600_000,
        lastRefreshTime: Date.now(),
        domain: 'www.codebuddy.cn',
      },
      account: { uin, nickname: uin.slice(-2) },
    }))
  }
  return dir
}

async function tierShim({ respond }) {
  const dir = twoAccounts()
  const calls = []
  const { upstream } = workbuddy(async (url, init, headers) => {
    const token = (headers.get('authorization') ?? '').replace('Bearer ', '')
    calls.push(token)
    const answer = respond(token)
    if (answer !== undefined) return answer
    return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const pool = new WorkBuddyAccountPool({
    authDirs: [], dataPath: () => dir, cooldownMs: 60_000, client: upstream, logger: QUIET,
  })
  await pool.scan()
  const shim = createWorkBuddyShim({
    pool, region: 'cn', client: upstream, logger: QUIET,
    catalog: { visible: () => [{ id: 'gpt-5.5' }], current: () => [{ id: 'gpt-5.5' }] },
  })
  await shim.ready
  return {
    pool,
    calls,
    async turn() {
      const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }),
      })
      return { status: answer.status, text: await answer.text() }
    },
    async close() {
      await shim.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a model one account cannot use is served by the account that can', async () => {
  const refusing = 'access-330000000001'
  const shim = await tierShim({
    respond: (token) => token !== refusing
      ? undefined
      : new Response(JSON.stringify({ code: 11158, msg: 'this model is not included in the current plan' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        }),
  })
  try {
    const [first, second] = shim.pool.list()
    const refusedAccount = first.credential.accessToken === refusing ? first : second
    shim.pool.prefer(refusedAccount.id, 'cn')
    const answer = await shim.turn()
    assert.equal(answer.status, 200, 'the plan gate is not the end of the request')
    assert.match(answer.text, /\[DONE\]/u)
    assert.equal(answer.status, 200)
    const cooled = shim.pool.list().find((account) => account.id === refusedAccount.id)
    assert.ok(cooled.modelBlocks['gpt-5.5'] - Date.now() > 20 * 60 * 60 * 1000,
      'the model is out of that account for a day')
    assert.equal(cooled.modelCooldowns['gpt-5.5'], undefined,
      'a plan block is not a rate limit: it must not answer 429')
    assert.equal(shim.pool.activeHold(refusedAccount.id), null,
      'the account itself is not parked: it still serves every other model')
  } finally {
    await shim.close()
  }
})

test('a model no account can use answers with the plan, not a cooldown', async () => {
  const shim = await tierShim({
    respond: () => new Response(JSON.stringify({ code: 11158, msg: 'this model is not included in the current plan' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    }),
  })
  try {
    const answer = await shim.turn()
    assert.equal(answer.status, 400)
    assert.match(answer.text, /plan/u)
    assert.match(answer.text, /11158|not included/u)
    for (const account of shim.pool.list()) {
      assert.ok(account.modelBlocks['gpt-5.5'] > Date.now(), `${account.label} keeps the model out`)
      assert.equal(shim.pool.activeHold(account.id), null, `${account.label} is not parked`)
    }
    assert.equal(shim.calls.length, 2, 'both accounts were tried before giving up')

    // The steady state, not just the discovering turn: every later request for
    // this model lands on the block and must keep saying "plan", not "wait".
    const again = await shim.turn()
    assert.equal(again.status, 400, 'a blocked model is not a 429 once the turn is over')
    assert.match(again.text, /plan/u)
    assert.equal(shim.calls.length, 2, 'a blocked model spends no upstream call')
  } finally {
    await shim.close()
  }
})

test('a restricted account is stepped over, and says so when it is the only one', async () => {
  const restricted = 'access-330000000001'
  const restrictedAnswer = () => new Response(JSON.stringify({
    code: 11140,
    msg: 'request illegal',
    displayMsg: { en: 'Your account has been restricted due to unusual activity' },
  }), { status: 403, headers: { 'content-type': 'application/json' } })

  const rotating = await tierShim({ respond: (token) => token === restricted ? restrictedAnswer() : undefined })
  try {
    const [first, second] = rotating.pool.list()
    const account = first.credential.accessToken === restricted ? first : second
    rotating.pool.prefer(account.id, 'cn')
    const answer = await rotating.turn()
    assert.equal(answer.status, 200, 'the second account serves the turn')
    const hold = rotating.pool.activeHold(account.id)
    assert.equal(hold?.reason, 'restricted', 'the account is held, not merely cooled')
    assert.match(rotating.pool.unavailableReason(account.id, Date.now()), /restricted by the upstream/u)
  } finally {
    await rotating.close()
  }

  const alone = await tierShim({ respond: () => restrictedAnswer() })
  try {
    const answer = await alone.turn()
    assert.equal(answer.status, 403)
    assert.match(answer.text, /restricted by the upstream/u)
    assert.match(answer.text, /appeal/u)
    assert.equal(alone.calls.length, 2, 'the other account was tried first')

    // The hold is the steady state: the next turn must still explain the
    // restriction, not fall back to "no account available".
    const again = await alone.turn()
    assert.equal(again.status, 403)
    assert.match(again.text, /restricted by the upstream/u)
  } finally {
    await alone.close()
  }
})

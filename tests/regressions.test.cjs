const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire, registerHooks } = require('node:module')
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

test('WorkBuddy refresh stays on demand across service restarts', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-pool-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({ auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' } }))
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const models = t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  let now = Date.now()
  const timers = new Set()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch,
    Date: class extends Date { static now() { return now } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    setInterval: (callback, ms) => { const timer = { callback, at: now + ms }; timers.add(timer); return timer },
    clearInterval: (timer) => timers.delete(timer),
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  const endpointResponds = async () => {
    const state = await plugin.onPanelInvoke('xd.state')
    if (state.shims.cn.running !== true) return false
    const response = await fetch(state.shims.cn.baseUrl.replace(/\/v1$/, '') + '/healthz', {
      signal: AbortSignal.timeout(1000), headers: { connection: 'close' },
    }).catch(() => null)
    return response !== null && response.ok
  }
  try {
    await plugin.onLoad()
    await startRegisteredService()
    assert.equal(await endpointResponds(), true, 'initial endpoint must respond')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(models.mock.callCount(), 1, 'startup must seed the catalog once')
    assert.ok(Array.isArray((await plugin.onPanelInvoke('xd.doctor')).findings), 'connection check must return findings')
    now += 31 * 60 * 1000
    for (const timer of timers) if (timer.at <= now) timer.callback()
    // No count assertion here on purpose. The background timers may start async
    // work whose fetch lands at an arbitrary point, so reading the count after a
    // fixed delay was a coin flip. The invariant it was guarding is carried by
    // the count below instead, and deterministically: anything that fetched
    // between startup and this panel read shows up there as one too many.
    assert.equal((await plugin.onPanelInvoke('xd.state')).refreshing, true, 'a panel read must refresh a stale catalog')
    let state
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      state = await plugin.onPanelInvoke('xd.state')
      if (!state.refreshing) break
    }
    assert.equal(state.refreshing, false, 'the on-demand refresh must settle')
    assert.equal(models.mock.callCount(), 2, 'a stale panel read must fetch once, and nothing before it may have')
    await plugin.onPanelInvoke('xd.state', { wait: true })
    assert.equal(models.mock.callCount(), 3, 'manual refresh must bypass the cache')
    await stopRegisteredService()
    await startRegisteredService()
    assert.equal(await endpointResponds(), true, 'restarted endpoint must respond')
    let release
    let reading
    const started = new Promise((resolve) => { reading = resolve })
    const blockedModels = t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', () => new Promise((resolve) => { release = resolve; reading() }))
    const rescan = plugin.onPanelInvoke('xd.rescan')
    await started
    await stopRegisteredService()
    release([])
    assert.equal((await rescan).shims.cn.running, false, 'a late refresh must not restart a stopped endpoint')
    blockedModels.mock.restore()
    await startRegisteredService()
    await plugin.onPanelInvoke('xd.setSource', { source: 'workbuddy', enabled: false })
    const pass = plugin.onPanelInvoke('xd.runCheckinNow')
    assert.equal((await plugin.onPanelInvoke('xd.state')).autoCheckin.last.pending, true, 'an ongoing check-in must expose pending state')
    await pass
    assert.equal((await plugin.onPanelInvoke('xd.state')).autoCheckin.last.pending, undefined, 'a finished check-in must clear pending state')
  } finally {
    await plugin.onUnload()
    await stopRegisteredService()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('Qoder failure preceding output in the same packet remains an HTTP error', async () => {
  const { openQoderResponse } = require('../src/qoder-shim.ts')
  const wire = 'data: {"code":105,"message":"Login expired"}\n\n'
    + 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
  const response = await openQoderResponse(new Response(wire), 'qmodel')
  try { assert.equal(response.status, 401) } finally { await response.body?.cancel().catch(() => {}) }
})

test('vendor requests refuse redirects before exposing custom token headers', async () => {
  const { createServer } = require('node:http')
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const leaked = []
  const sink = createServer((req, res) => {
    leaked.push(req.headers['x-refresh-token'] || req.headers['x-ide-token'])
    res.end('{"code":0,"data":{"accessToken":"refreshed"}}')
  })
  const redirect = createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${sink.address().port}/unexpected` }).end()
  })
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve))
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve))
  const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${redirect.address().port}/vendor`, init)
  try {
    await new WorkBuddyUpstreamClient({ fetchImpl }).refreshToken({
      accessToken: 'test-access', refreshToken: 'test-refresh', domain: '', expiresAtMs: 0,
    }).catch(() => {})
    await new TraeSoloUpstreamClient({
      credential: async () => ({ accessToken: 'test-trae', userId: 'test', edition: 'cn', source: 'desktop', host: '', expiresAtMs: 0 }),
      identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }), fetchImpl,
    }).chatStream('{"model":"glm","messages":[]}')
    assert.deepEqual(leaked, [])
  } finally {
    await Promise.all([sink, redirect].map((server) => new Promise((resolve) => {
      server.closeAllConnections(); server.close(resolve)
    })))
  }
})

for (const source of ['qoder', 'trae']) {
  test(`${source} relay ends a failed stream in a way a client can finish on`, async () => {
    const { bridgeQoderStream } = require('../src/qoder-shim.ts')
    const { bridgeTraeStream } = require('../src/trae-shim.ts')
    let cancelled = false
    const wire = source === 'qoder'
      ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"code":105,"message":"Login expired"}\n\n'
      : 'event: output\ndata: {"response":"hello"}\n\nevent: error\ndata: {"code":5001,"message":"failed"}\n\n'
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(wire)) },
      cancel() { cancelled = true },
    })
    const relay = source === 'qoder' ? bridgeQoderStream(upstream, 'model') : bridgeTraeStream(upstream, 'model')
    let timer
    try {
      const outcome = await Promise.race([
        new Response(relay).text().then((body) => ({ body }), () => ({ error: true })),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), 200) }),
      ])
      assert.equal(outcome.timeout, undefined, 'a failure must not wait for upstream EOF')
      assert.equal(outcome.error, undefined, 'a failed stream must not error the controller')
      // The client already holds a 200 at this point, so the stream has to end
      // in the shape a client can finish on. Erroring it instead left a
      // truncated body with neither marker, so every client waited out its own
      // timeout on a turn that had already failed.
      assert.match(outcome.body, /finish_reason/)
      assert.match(outcome.body, /\[DONE\]/)
      assert.equal(cancelled, true, 'failed upstream must be cancelled')
    } finally { clearTimeout(timer); await upstream.cancel().catch(() => {}) }
  })
}

test('account scans drop deleted sign-ins but keep unreadable directories', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-scan-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const file = path.join(auth, 'login.info')
  fs.writeFileSync(file, JSON.stringify({ auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' } }))
  const pool = new WorkBuddyAccountPool({ authDirs: [auth] })
  try {
    assert.equal((await pool.scan()).length, 1)
    fs.renameSync(auth, auth + '-hidden')
    assert.equal((await pool.scan()).length, 1, 'an unreadable directory must not erase a cached account')
    fs.renameSync(auth + '-hidden', auth)
    fs.unlinkSync(file)
    assert.equal((await pool.scan()).length, 0, 'a readable directory must remove deleted sign-ins')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('growth rewards accept numeric strings and normalize tier status', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
    streak: { days: '7' }, redemption_status: { tiers: [{ tier: 'seven', days: '7', credit: '100', energy: '2' }], tier_seven_status: 'UNLOCKED' },
  } })) })
  const credential = { accessToken: 'test', refreshToken: '', domain: '', expiresAtMs: 0 }
  const streak = await client.growthStreakFull(credential)
  assert.equal(streak.days, 7)
  assert.deepEqual(streak.tiers[0], { tier: 'seven', days: 7, credit: 100, energy: 2, status: 'unlocked' })
})

/**
 * The streak's one-off collections must ask the paths that answer.
 *
 * The gift and compensation endpoints sit on the billing host without a `/v2`
 * prefix; with one they reply `404 route not found`, which reads as "nothing to
 * collect" and silently loses the credits. A make-up target is a calendar day in
 * the check-in zone, not the host's zone.
 */
test('streak collections use the paths the upstream answers on', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { zonedDay } = require('../src/checkin-time.ts')
  const calls = []
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    return new Response(JSON.stringify({ code: 0, data: { credit: 25 } }))
  } })
  const credential = { accessToken: 'test', refreshToken: '', domain: '', expiresAtMs: 0 }

  assert.equal(await client.claimGift(credential), 25)
  assert.equal(await client.claimCompensation(credential), 25)
  await client.useMakeupCard(credential, '2026-10-18')

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/billing/meter/claim-gift',
    '/billing/meter/claim-compensation',
    '/activity/growth/makeup-cards/use',
  ], 'a /v2 prefix turns these into 404s')
  assert.deepEqual(JSON.parse(calls[2].body), { target_date: '2026-10-18' })
  assert.match(zonedDay(0), /^\d{4}-\d{2}-\d{2}$/)
  assert.notEqual(zonedDay(-1), zonedDay(0), 'yesterday is a different day')
})

for (const source of ['qoder', 'trae']) {
  test(`${source} directory reads do not advance chat rotation`, async (t) => {
    const purposes = []
    const client = source === 'qoder' ? require('../src/qoder-client.ts').QoderUpstreamClient : require('../src/trae-upstream.ts').TraeSoloUpstreamClient
    t.mock.method(client.prototype, 'fetchModels', async () => (source === 'trae'
      ? { models: [{ id: 'test-model', name: 'test-model', function: 'chat' }], partial: false }
      : [{ id: 'test-model', name: 'test-model', function: 'chat' }]))
    t.mock.method(client.prototype, 'chatStream', async () => ({ ok: true, response: new Response(source === 'qoder' ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' : 'event: output\ndata: {"response":"hello"}\n\n') }))
    const gateway = source === 'qoder'
      ? require('../src/qoder-gateway.ts').createQoderGateway({ region: 'cn', port: 0, credentials: async (purpose) => { purposes.push(purpose); return [{ token: 'test', region: 'cn' }] } })
      : require('../src/trae-gateway.ts').createTraeGateway({ port: 0, credentials: async (purpose) => { purposes.push(purpose); return [{ accessToken: 'test', edition: 'cn' }] }, identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }) })
    try {
      await gateway.ready
      const response = await fetch(gateway.baseUrl() + '/v1/models', { headers: { connection: 'close' } })
      assert.equal(response.status, 200)
      await response.text()
      assert.deepEqual(purposes, [undefined], 'directory lookup must not identify itself as a chat turn')
      const chat = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ model: 'test-model', messages: [] }),
      })
      assert.equal(chat.status, 200)
      await chat.text()
      assert.deepEqual(purposes, [undefined, 'chat'], 'only a chat request must advance rotation')
    } finally { await gateway.close() }
  })
}

test('model defaults are per model and explicit reasoning remains authoritative', async (t) => {
  const { PiAiAdapter } = require('@deepseek-ai/dsh-llm-pi-ai')
  const { createProvider } = await import('@earendil-works/pi-ai')
  const { resolveRetryPolicy } = require('@deepseek-ai/dsh-llm')
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  const functions = ['toPiModel', 'buildAdapter'].map(name => {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}$', 'm'))
    assert.ok(match, name + ' factory must exist')
    return match[0]
  }).join('\n')
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, PiAiAdapter, createProvider, resolveRetryPolicy,
    withDelegateShape: value => value, openAICompletionsApi: () => ({}),
    resolveImageAttachmentAccess: () => { throw new Error('test must not access images') },
    THINKING_LEVELS: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    NO_COST: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, STREAM_IDLE_TIMEOUT_MS: 300000,
    REQUEST_IMAGE_BUDGETS: {}, INERT_AUTH: { credentials: {}, authContext: {} }, LOOPBACK_BEARER: 'test',
    CONSERVATIVE_CONTEXT_WINDOW: 128000, DEFAULT_MAX_TOKENS: 32000,
  })
  vm.runInContext(transpile(functions + '\nmodule.exports = buildAdapter;'), context)
  t.mock.method(PiAiAdapter.prototype, 'stream', options => [{ effort: options.reasoningEffort }])
  const { adapter } = context.module.exports([
    { id: 'test-provider', name: 'test-provider', baseUrl: 'http://127.0.0.1:1/v1', models: [
      { id: 'first', thinkingLevels: ['off', 'low', 'high'], defaultThinkingLevel: 'low' },
      { id: 'second', thinkingLevels: ['off', 'low', 'high'], defaultThinkingLevel: 'high' },
    ] },
  ], { get: () => undefined })
  assert.equal((await adapter.resolveModel('test-provider', 'first')).reasoning.defaultEffort, 'low')
  assert.equal((await adapter.prepareCall('test-provider', 'second')).model.reasoning.defaultEffort, 'high')
  assert.equal([...adapter.stream({ provider: 'test-provider', model: 'first' })][0].effort, 'low')
  assert.equal([...adapter.stream({ provider: 'test-provider', model: 'first', reasoningEffort: 'high' })][0].effort, 'high')
})

/**
 * A sign-in that has not expired must reach the gateway and the panel.
 *
 * `sourceCredentialExpired` decides both whether an account is offered to the
 * gateway and whether its row is probed. Its first two conditions short-circuit
 * on `expiresAtMs === 0`, which is the only value the other fixtures use — so a
 * body that recursed instead of comparing looked green everywhere while every
 * real Trae/Qoder sign-in (all of which carry a positive `expiresAtMs`) took the
 * recursive branch and threw `RangeError: Maximum call stack size exceeded` into
 * `refreshSourceAccounts`. Both sources then listed no account at all.
 *
 * The claim under test: with a future `expiresAtMs`, the account is listed and
 * its gateway reports it as usable. The sign-in is injected through the
 * discovery modules the host reads, so nothing here depends on this machine.
 */
test('a live sign-in with a future expiry reaches the panel and the gateway', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-expiry-test-'))
  const future = Date.now() + 3600000
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: true, sourceQoder: true,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] },
  }
  const trae = require('../src/trae-discovery.ts')
  const qoder = require('../src/qoder-credentials.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  // One live sign-in per source. `expiresAtMs` is in the future on purpose:
  // that is the branch the fixtures elsewhere never take.
  t.mock.method(trae, 'discoverTraeCredentials', async () => ({
    credentials: [{ accessToken: 'trae-token', userId: 'trae-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: future }],
    failures: [],
  }))
  t.mock.method(qoder, 'discoverQoderCredentials', async () => ({
    credentials: [{ region: 'cn', userID: 'qoder-user', token: 'qoder-token', name: '', email: '', expiresAtMs: future, refreshTokenExpiresAtMs: future }],
    failures: [],
  }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ code: 0, enable: true, checkedIn: false }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchUsageSummary', async () => ({ credits: [], packs: [] }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchUsage', async () => ({ userQuota: { remaining: 5, total: 10 }, dedicatedPackages: [] }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchCampaigns', async () => ({}))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    // The listing is filled by the refresh pass behind the load, so poll for it
    // the way the panel does rather than assuming it is there on the first read.
    let state
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await plugin.onPanelInvoke('xd.state')
      if (state.trae.accounts.length > 0 && state.qoder.accounts.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(state.trae.accounts.length, 1, 'a live Trae sign-in must be listed, not dropped by an expiry check')
    assert.equal(state.qoder.accounts.length, 1, 'a live Qoder sign-in must be listed, not dropped by an expiry check')
    assert.equal(state.trae.accounts[0].expired, false, 'a future expiry is not an expired sign-in')
    // The gateway picks its credential through the same check, so an empty
    // listing and an unusable gateway are two faces of one body.
    const health = await fetch(`http://127.0.0.1:${state.trae.gateways[0].port}/healthz`, { headers: { connection: 'close' } })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).credentials, 1, 'the gateway must see the live sign-in')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * Switching a source on is not answered from a read taken while it was off.
 *
 * The credential readers cache their answer for 30 s. A source switched off
 * leaves that cache holding the sign-ins it had, so switching it back on and
 * refreshing straight away was answered from the stale list: a desktop sign-in
 * made while the source was off was invisible until the cache expired *and* a
 * further refresh ran. The switch has to drop the cache first, which is what the
 * sibling build does and what `onHostSettingsChanged`'s own comment claims for
 * the panel's switches.
 */
test('switching a source on drops the cached sign-in read', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-setsource-test-'))
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] },
  }
  const trae = require('../src/trae-discovery.ts')
  const qoder = require('../src/qoder-credentials.ts')
  let traeResets = 0
  let qoderResets = 0
  const realTraeReset = trae.resetTraeCredentialCache
  const realQoderReset = qoder.resetQoderCredentialCache
  t.mock.method(trae, 'resetTraeCredentialCache', () => { traeResets += 1; realTraeReset() })
  t.mock.method(qoder, 'resetQoderCredentialCache', () => { qoderResets += 1; realQoderReset() })
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    const before = { trae: traeResets, qoder: qoderResets }
    await plugin.onPanelInvoke('xd.setSource', { source: 'trae', enabled: true })
    assert.ok(traeResets > before.trae,
      'switching Trae on must drop its cached sign-in read, or a sign-in made while it was off stays invisible')
    await plugin.onPanelInvoke('xd.setSource', { source: 'qoder', enabled: true })
    assert.ok(qoderResets > before.qoder,
      'and the same for Qoder')
    // Switching off must drop it too: the next switch-on is answered from
    // whatever the machine looks like then, not from the read taken before.
    const offTrae = traeResets
    await plugin.onPanelInvoke('xd.setSource', { source: 'trae', enabled: false })
    assert.ok(traeResets > offTrae, 'switching a source off drops the cache as well')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A sign-in that carries no expiry is live, not expired.
 *
 * Trae omits `expiresAt` on some installs, and `normalizeTraeCredential`
 * answers `0` when it is absent; Qoder answers `0` for an `expiresAt` that does
 * not parse as a date. `0` therefore means "no expiry known", not "expired at
 * the epoch". Read against `Date.now()` it came out expired, and the same
 * comparison inside `traeRowProbe`/`qoderRowProbe` skipped the probe outright,
 * so such an account was listed as expired and never carried its quota.
 * `sourceCredentialExpired` is the single place that decides, and it requires a
 * positive timestamp before it will call a sign-in expired.
 *
 * The claim under test: a `0`-expiry sign-in is listed as live, and it is still
 * probed. Both halves fail on a bare `<= Date.now()` comparison.
 */
test('a sign-in with no expiry is live, not expired', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-noexpiry-test-'))
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: true, sourceQoder: false,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] },
  }
  const trae = require('../src/trae-discovery.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  // `0` is what the discovery layer produces when the stored document has no
  // usable expiry - the value every sign-in of that shape arrives with.
  t.mock.method(trae, 'discoverTraeCredentials', async () => ({
    credentials: [{ accessToken: 'trae-token', userId: 'trae-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: 0 }],
    failures: [],
  }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ code: 0, enable: true, checkedIn: false, credits: 3 }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchUsageSummary', async () => ({ credits: [], packs: [] }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    // Filled by the refresh pass behind the load, so poll the way the panel does.
    let state
    for (let attempt = 0; attempt < 50; attempt += 1) {
      state = await plugin.onPanelInvoke('xd.state')
      if (state.trae.accounts.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(state.trae.accounts.length, 1, 'a sign-in with no expiry must be listed')
    assert.equal(state.trae.accounts[0].expired, false, 'an unknown expiry is not an expiry that has passed')
    assert.ok(state.trae.accounts[0].checkin, 'a sign-in with no expiry must still be probed for its check-in')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A Qoder round that has not opened yet must be collected when it does.
 *
 * Qoder re-issues its daily round at 10:00 Beijing, and the configured check-in
 * hour is 09:00. Before 10:00 the claim answers "nothing to claim" and carries
 * the opening time, which the tick uses to come back for Qoder alone. That
 * write-back lived in `autoCheckinTick` only; when the pass moved into
 * `runCheckinPass`, the tick kept the reader and lost the writer, so the opening
 * time was dropped, the slot counted as spent, and that day's Qoder credits were
 * never collected — silently, because a pass that finds nothing to claim is not
 * an error.
 *
 * The claim under test: after a pass that found Qoder's round unopened, the tick
 * runs Qoder again at the opening time. The opening time is the only thing that
 * can carry it across, so this fails on a pass that does not record it.
 */
test('a Qoder round that is not open yet is collected when its window opens', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-qoder-test-'))
  let now = Date.now()
  const opensAt = now + 60000
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: true,
    disabledRegions: [], autoCheckin: { enabled: true, hours: [9] },
  }
  const lines = []
  let opened = false
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  const qoder = require('../src/qoder-credentials.ts')
  t.mock.method(qoder, 'discoverQoderCredentials', async () => ({
    credentials: [{ region: 'cn', userID: 'qoder-user', token: 'qoder-token', name: '', email: '', expiresAtMs: now + 3600000, refreshTokenExpiresAtMs: now + 3600000 }],
    failures: [],
  }))
  // A round that exists but has not opened: exactly what an 09:00 pass sees.
  // The client reads the real clock, unlike the host's fake one, so the
  // deferred call flips this to a round already open and proves the claim.
  t.mock.method(QoderUpstreamClient.prototype, 'fetchCampaigns', async () => ({
    campaigns: [{ actionType: 'CLAIM_BENEFIT', campaignId: 'today',
      startAt: opened ? Date.now() - 1000 : opensAt }],
  }))
  t.mock.method(QoderUpstreamClient.prototype, 'claimCampaign', async () => ({ success: true, grantId: 'claim-1' }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchUsage', async () => ({ userQuota: { remaining: 5, total: 10 }, dedicatedPackages: [] }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const timers = new Set()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    // The tick reads `new Date()`, so the clock itself must be the fake one:
    // patching `Date.now` alone left the tick comparing a real timestamp
    // against the mocked one and skipping the branch under test.
    Date: class extends Date {
      constructor(...args) { super(...args.length === 0 ? [now] : args) }
      static now() { return now }
    },
    console: { log: (line) => lines.push(String(line)) }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    setInterval: (callback, ms) => { const timer = { callback, at: now + ms }; timers.add(timer); return timer },
    clearInterval: (timer) => timers.delete(timer),
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await plugin.onPanelInvoke('xd.runCheckinNow')
    assert.deepEqual(
      lines.filter((line) => line.includes('deferred Qoder check-in')), [],
      'a round that has not opened must not be reported as a deferred collection yet',
    )
    // A source-only click must not cancel the deferral the full pass just set.
    // The old unconditional write replaced it with the placeholder's zero.
    await plugin.onPanelInvoke('xd.checkinAll', { source: 'trae' })
    const slots = JSON.parse(fs.readFileSync(path.join(temporary, 'checkin-slots.json'), 'utf8'))
    assert.equal(slots._qoderRetryAt, opensAt,
      'the deferred Qoder time must survive another source and be written for a reload')
    // Now the window opens: the tick that was already scheduled must collect Qoder.
    opened = true
    now = opensAt + 1000
    for (const timer of timers) if (timer.at <= now) timer.callback()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const deferred = lines.filter((line) => line.includes('deferred Qoder check-in'))
    assert.equal(deferred.length, 1,
      'the tick must come back for Qoder at the opening time it was told about')
    assert.match(deferred[0], /"claimed":1/,
      'the deferred round must actually claim, not merely report another wait')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A caller that stops waiting is this plugin working, not an upstream failure.
 *
 * `res.on('close')` aborts the relay so a cancelled turn stops spending the
 * account's credits, and that abort reaches the body as an error. Recorded as
 * an upstream failure it wrote one warning per cancelled turn — 4484 of them on
 * one machine, a third of every line this plugin had ever logged — which buried
 * the failures worth reading.
 *
 * Both halves are asserted, because either alone is satisfiable by moving in
 * the wrong direction: a hang-up is silent, and an upstream that falls over on
 * its own still warns. The upstream stream is endless, so the caller's hang-up
 * is the only thing that can end it — without that, an upstream that answered
 * once and closed would satisfy the first half for the wrong reason.
 */
test('a caller hang-up is not logged as an upstream stream failure', async () => {
  const { createServer, request } = require('node:http')
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  const { createWorkBuddyShim } = require('../src/shim.ts')

  const WARNING = {
    trae: 'trae relay stream failed mid-flight',
    qoder: 'qoder relay stream failed mid-flight',
    workbuddy: 'upstream stream failed mid-flight',
  }
  // The first frame each upstream family reads as output.
  const OPENING = {
    trae: 'event: output\ndata: {"response":"hello"}\n\n',
    qoder: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
    workbuddy: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
  }
  const TRAE_ROSTER = { config_info_list: [{ config_name: 'fixture-model', display_config: { display_name: 'Fixture' } }] }
  const QODER_ROSTER = { chat: [{ key: 'fixture-model', display_name: 'Fixture', enable: true }] }
  const traeCredential = {
    accessToken: 'fixture-token', userId: 'fixture', host: '', expiresAtMs: Date.now() + 3600000,
    edition: 'cn', source: 'desktop',
  }
  const traeIdentity = { machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32', osVersion: 'fixture' }
  const qoderCredential = { userID: 'fixture', token: 'fixture-token', machineID: 'fixture' }
  const BODY = { model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }

  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  const stop = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const answers = (document) => createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(document))
  })
  /** Streams until the caller goes away, unless `fails` makes it fall over. */
  const upstream = (wire, fails) => createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(wire)
    if (fails) { setTimeout(() => { try { res.socket.destroy() } catch { /* already gone */ } }, 60); return }
    const keep = setInterval(() => { try { res.write(': keep-alive\n\n') } catch { clearInterval(keep) } }, 50)
    res.on('close', () => clearInterval(keep))
  })
  /** Re-point every upstream call at this box, so nothing leaves the machine. */
  const localFetch = (routes) => (url, init) => {
    const target = new URL(url)
    const host = routes.find((route) => route.match.test(target.pathname))
    return fetch(host === undefined ? url : `http://127.0.0.1:${host.port}${target.pathname}`, { ...init, redirect: 'error' })
  }
  // The caller's signal has to reach the upstream read: that forwarding is what
  // makes the hang-up abort the body, which is the path under test.
  const shimClient = (port) => ({
    prepareChatBody: (raw) => raw,
    chatStream: async (_credential, _prepared, signal) => ({
      ok: true,
      response: await fetch(`http://127.0.0.1:${port}/v2/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal,
      }),
    }),
  })
  const poolFixture = () => ({
    acquire: async () => ({ id: 'a', label: 'fixture', credential: { accessToken: 'x', domain: '', expiresAtMs: 0 } }),
    list: () => [], isDisabled: () => false, refreshAccount: async () => false, penalize() {},
  })
  const catalogFixture = { visible: () => [{ id: 'fixture-model' }], current: () => [{ id: 'fixture-model' }] }

  /** Hang up as soon as the first byte of the reply lands. */
  const hangUp = async (port) => {
    await new Promise((resolve) => {
      const sent = request({
        host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Authorization: 'Bearer x' },
      }, (response) => {
        response.once('data', () => { sent.destroy(); resolve() })
        response.on('end', resolve)
      })
      sent.on('error', () => resolve())
      sent.end(JSON.stringify(BODY))
      setTimeout(resolve, 2000)
    })
    await wait(300)
  }

  /** Run one turn against a real gateway; return the warnings it wrote. */
  const run = async (source, fails) => {
    const lines = []
    const logger = { info() {}, warn: (...args) => lines.push(args.map(String).join(' ')) }
    const stream = upstream(OPENING[source], fails)
    const streamPort = await listen(stream)
    const roster = answers(source === 'trae' ? TRAE_ROSTER : QODER_ROSTER)
    const rosterPort = await listen(roster)
    const fetchImpl = localFetch([
      { match: source === 'trae' ? /get_detail_param|remote\/v1\/models/ : /model\/list/, port: rosterPort },
      { match: /./, port: streamPort },
    ])
    const gateway = source === 'trae'
      ? createTraeGateway({ credentials: async () => [traeCredential], identity: async () => traeIdentity, logger, fetchImpl })
      : source === 'qoder'
        ? createQoderGateway({ region: 'cn', credentials: async () => [qoderCredential], logger, fetchImpl })
        : createWorkBuddyShim({ pool: poolFixture(), client: shimClient(streamPort), catalog: catalogFixture, logger })
    try {
      await gateway.ready
      if (fails) {
        // Read to completion: no hang-up here, the upstream itself falls over.
        const response = await fetch(`http://127.0.0.1:${gateway.port()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
          body: JSON.stringify(BODY),
        })
        await response.text().catch(() => {})
        await wait(250)
      } else {
        await hangUp(gateway.port())
      }
    } finally {
      await gateway.close()
      await stop(stream)
      await stop(roster)
    }
    return lines.filter((line) => line.includes(WARNING[source]))
  }

  for (const source of ['trae', 'qoder', 'workbuddy']) {
    assert.deepEqual(await run(source, false), [], `${source}: a hang-up must not be logged as an upstream failure`)
    assert.ok((await run(source, true)).length > 0, `${source}: a genuine upstream failure must still warn`)
  }
})

/**
 * Clicking an account the pool cannot serve must say so.
 *
 * The composer popup lists every account in the pool but marks the one the next
 * request would use, and those are not the same set: a cooling, switched-off or
 * reserve-held account is listed yet `pool.available` skips it. Storing the
 * preference for one of those changes nothing this session, so answering with a
 * bare success closed the popup on a click that switched nothing. The choice
 * still applies once the account recovers, which is why the answer keeps it and
 * flags it instead of refusing outright.
 */
test('switching to an account the pool cannot serve is reported, not silently accepted', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-unavailable-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const accounts = state.accounts.filter((account) => account.region === 'cn')
    assert.equal(accounts.length, 4)
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')

    const points = await plugin.onPanelInvoke('xd.composerPoints', { provider: 'wtqpool-cn', model: model.id })
    assert.equal(points.show, true)
    assert.equal(points.accounts.length, 4)
    const fourth = points.accounts[3]
    assert.equal(fourth.active, false, 'the fourth account starts out not serving')

    // Switch it off on the panel: still listed in the pool, no longer servable.
    await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'disabled' })

    const refused = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(refused.show, true, 'the click is answered, not dropped')
    assert.equal(refused.unavailable, true, 'an account the pool skips must be reported as unavailable')
    const active = refused.accounts.find((account) => account.active === true)
    assert.notEqual(active?.id, fourth.id, 'a switched-off account must not be marked as serving')
    assert.equal(settings.preferredAccountIds.cn, fourth.id, 'the choice is still stored for when it recovers')

    // A servable account is the control: it switches and is not flagged.
    const first = points.accounts[0]
    const switched = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: first.id, accountLabel: first.label,
    })
    assert.equal(switched.unavailable, undefined, 'a servable account must not be flagged')
    assert.equal(switched.accounts.find((account) => account.active === true)?.id, first.id)
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A rate limit on one model must not read as "switchable".
 *
 * A 429 cools one (account, model) pair - the upstream lets the same account
 * carry on with another model - so an account can be perfectly live while the
 * model the composer is showing is cooling on it. That is the pool's own answer
 * to `available(now, modelId, region)`, and the popup marks its rows with
 * exactly it, so a click handler asking anything looser (no model id, i.e.
 * account-wide cooldowns only) calls that account servable and closes the popup
 * on a switch that changed nothing.
 */
test('an account cooling on the selected model is reported, not silently accepted', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-modelcool-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // The first attempt is the account the preference just named, so exactly that
  // account is rate-limited and the rotation has to land on a healthy one behind
  // it. The 429 is driven through the gateway rather than `pool.penalize`
  // because keying the cooldown to the model is the shim's doing, and that is
  // the state under test.
  let attempts = 0
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async () => {
    attempts += 1
    if (attempts === 1) {
      return { ok: false, kind: 'soft_rate', status: 429, message: `{"resetAt":${Date.now() + 3600000}}` }
    }
    return { ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
  })
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    assert.equal(state.shims.cn.running, true, 'the cn gateway must be listening')
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')

    const points = await plugin.onPanelInvoke('xd.composerPoints', { provider: 'wtqpool-cn', model: model.id })
    assert.equal(points.show, true)
    assert.equal(points.accounts.length, 4)
    const fourth = points.accounts[3]

    const chosen = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(chosen.unavailable, undefined, 'a live account switches without a flag')
    assert.equal(chosen.accounts.find((account) => account.active === true)?.id, fourth.id)

    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: JSON.stringify({ model: model.id, stream: false, messages: [{ role: 'system', content: 'hi' }] }),
    })
    await answer.text()
    assert.equal(answer.status, 200, 'the healthy accounts behind the cooled one must still serve')
    assert.equal(attempts, 2, 'the request must rotate exactly once, past the cooled account')

    const cooled = await plugin.onPanelInvoke('xd.composerPoints', { provider: 'wtqpool-cn', model: model.id })
    assert.equal(cooled.accounts.find((account) => account.id === fourth.id).active, false,
      'a model-cooled account must not be marked as serving')

    const refused = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(refused.show, true, 'the click is answered, not dropped')
    assert.equal(refused.unavailable, true, 'an account the pool skips for this model must be reported as unavailable')
    assert.notEqual(refused.accounts.find((account) => account.active === true)?.id, fourth.id,
      'a model-cooled account must not be marked as serving')

    // The control: an account live on this same model switches and is not flagged.
    const other = points.accounts[0]
    const switched = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: other.id, accountLabel: other.label,
    })
    assert.equal(switched.unavailable, undefined, 'an account live on this model must not be flagged')
    assert.equal(switched.accounts.find((account) => account.active === true)?.id, other.id)
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * Switching accounts while a reply is in flight must not cut it off.
 *
 * The panel stores a preference and the host announces the merged settings
 * document back, which re-applies the selection and reconciles the gateways. A
 * parked region is meant to lose its listener there - but the region the reply
 * is streaming through is not parked, so its socket has to survive the pass.
 * Rebinding the endpoint under a running turn would close the stream the user is
 * reading, which reads as the model giving up mid-sentence.
 */
test('switching accounts during a reply does not cut the stream', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-midreply-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // A reply that lands its first chunk, then waits: the window in which the
  // user clicks another account.
  let opened
  const streaming = new Promise((resolve) => { opened = resolve })
  let release
  const held = new Promise((resolve) => { release = resolve })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async () => ({
    ok: true,
    response: new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        opened()
        await held
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }),
  }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  let onSettings
  installPi({
    getSettings: () => ({ ...settings }),
    setSettings: patch => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
    onSettingsChanged: handler => { onSettings = handler },
    offSettingsChanged: () => { onSettings = undefined },
  })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, ReadableStream,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(typeof onSettings, 'function', 'the host must be able to announce a settings change')

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const controller = new AbortController()
    const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'system', content: 'hi' }] }),
      signal: controller.signal,
    })
    assert.equal(answer.status, 200, 'the turn must start')
    await streaming

    // The user clicks another account mid-answer. That stores the preference and
    // the host echoes the document back, exactly as the desktop app does.
    const points = await plugin.onPanelInvoke("xd.composerPoints", { provider: "wtqpool-cn", model: model.id })
    const target = points.accounts.find((account) => account.active === false)
    const switched = await plugin.onPanelInvoke("xd.composerPrefer", {
      provider: "wtqpool-cn", model: model.id, source: "workbuddy", region: "cn", accountId: target.id, accountLabel: target.label,
    })
    assert.equal(switched.unavailable, undefined, "a live account switches while a reply is streaming")
    await onSettings({ ...settings, preferredAccountIds: { ...(settings.preferredAccountIds ?? {}), cn: target.id } })
    await new Promise((resolve) => setTimeout(resolve, 250))

    // The socket the turn is reading must still be open, and finishing it must
    // still reach the client. A closed socket raises here rather than draining,
    // so the read is caught and reported as the stream being cut.
    assert.equal(controller.signal.aborted, false, "the turn must not be aborted by the settings pass")
    release()
    const body = await answer.text().catch((error) => { throw new Error("the reply already in flight was cut off: " + error.message) })
    assert.ok(body.includes("hi"), "the reply already in flight must still be delivered")
    assert.ok(body.includes("[DONE]"), "the reply must still be terminated, not truncated")
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The account picked in the panel must be the account that serves.
 *
 * `xd.preferAccount` is the settings-side twin of the composer's switch, and it
 * has to end in the pool: storing the id alone leaves the choice on the page and
 * the previous account still taking every request, which looks like the picker
 * refusing to stick. Switching the chosen account off has to release the
 * preference too, or the pool keeps asking for an id it may not hand out.
 */
test('the account picked in the panel is the account that serves', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-pickaccount-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // Which token the gateway actually spent, in order, and which token belongs
  // to which account id — so an assertion can name an account rather than a
  // position in the queue.
  const served = []
  const { workbuddyAccountId } = require('../src/accounts.ts')
  const tokenOf = {}
  for (const index of [0, 1, 2, 3]) tokenOf[workbuddyAccountId({ uin: `90000000000${index}` })] = `token-${index}`
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'chatStream', async (credential) => {
    served.push(credential.accessToken)
    return { ok: true, response: new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) }
  })
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    const port = Number(new URL(state.shims.cn.baseUrl).port)
    const turn = async () => {
      const answer = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
        body: JSON.stringify({ model: model.id, stream: false, messages: [{ role: 'system', content: 'hi' }] }),
      })
      await answer.text()
      return served.at(-1)
    }

    const accounts = state.accounts.filter((account) => account.region === 'cn')
    assert.equal(accounts.length, 4)
    const fourth = accounts[3]
    const first = accounts[0]

    // Default distribution: the head of the queue serves.
    assert.equal(await turn(), tokenOf[first.id], 'the first account serves by default')

    // Pick the fourth in the panel, exactly as the picker does.
    const picked = await plugin.onPanelInvoke('xd.preferAccount', { region: 'cn', accountId: fourth.id })
    assert.equal(picked.preferredAccountIds.cn, fourth.id, 'the pick must be stored')
    const pickedRow = picked.accounts.find((account) => account.id === fourth.id)
    assert.equal(pickedRow.preferred, true, 'the panel must mark the picked account as selected')
    assert.equal(pickedRow.active, true, 'a stored pick must be the account the next request uses')
    assert.equal(await turn(), tokenOf[fourth.id], 'the picked account must be the one that serves')

    // Switching the chosen account off must release the choice, not pin the pool
    // to an id it is no longer allowed to hand out.
    const off = await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'disabled' })
    assert.equal(off.preferredAccountIds.cn, '', 'switching the chosen account off must release the pick')
    assert.equal(off.accounts.find((account) => account.id === fourth.id).preferred, false)
    assert.equal(await turn(), tokenOf[first.id], 'the pool must fall back to an account it can serve')

    // And switching it back on does not silently restore the old pin.
    const on = await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: fourth.id, state: 'enabled' })
    assert.equal(on.preferredAccountIds.cn, '', 'coming back on must stay on automatic')
    assert.equal(await turn(), tokenOf[first.id], 'the released choice must not come back with the account')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/*
 * A stored choice must never be reported as a refusal.
 *
 * `composerPoints` (and so the snapshot `composerPrefer` hands back) answers
 * `show: false` whenever the credits chip is switched off, which can happen
 * between the popup's read and the click. Reading that as a refusal told the
 * user "that account cannot be switched" about a preference that had in fact
 * just been saved and was already in force.
 */
test('a stored account choice is never reported as a refusal', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-saved-test-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'acc-0.info'), showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] },
  }
  for (const index of [0, 1, 2, 3]) {
    fs.writeFileSync(path.join(auth, `acc-${index}.info`), JSON.stringify({
      auth: { accessToken: `token-${index}`, expiresAt: Date.now() + 3600000, domain: 'codebuddy.cn', lastRefreshTime: Date.now() - index * 1000 },
      account: { uin: `90000000000${index}`, nickname: `account-${index + 1}` },
    }))
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 12345, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    await new Promise((resolve) => setTimeout(resolve, 200))

    const state = await plugin.onPanelInvoke('xd.state')
    const model = state.models.find((item) => item.region === 'cn')
    assert.ok(model !== undefined, 'the cn gateway must publish a model to switch against')
    const fourth = state.accounts.filter((account) => account.region === 'cn')[3]
    assert.ok(fourth !== undefined, 'the roster must list a fourth account to switch to')

    // The chip is switched off after the popup rendered, which is what leaves
    // the answer with no snapshot at all. Driven through the panel's own
    // channel, because the plugin keeps its own copy of the settings.
    await plugin.onPanelInvoke('xd.setComposerPoints', { enabled: false })
    const answered = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: fourth.id, accountLabel: fourth.label,
    })
    assert.equal(answered.saved, true, 'a stored choice must be reported as stored')
    assert.notEqual(answered.show, true, 'the snapshot really is unavailable, or this proves nothing')
    assert.equal(settings.preferredAccountIds.cn, fourth.id, 'the choice must really have been stored')

    // And a refusal still reports as one: the control.
    await plugin.onPanelInvoke('xd.setComposerPoints', { enabled: true })
    const refused = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-cn', model: model.id, source: 'workbuddy', region: 'cn', accountId: 'no-such-account', accountLabel: 'x',
    })
    assert.equal(refused.saved, undefined, 'a refused click must not claim anything was stored')
    assert.equal(refused.show, false, 'a refused click must show nothing')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('every composer string the popup asks for exists in both languages', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'client', 'composer.tsx'), 'utf8')
  const keysOf = (name) => {
    const start = source.indexOf(`export const ${name}`)
    assert.notEqual(start, -1, `${name} must exist`)
    const body = source.slice(source.indexOf('{', start), source.indexOf('\n}', start))
    return new Set([...body.matchAll(/'([^']+)':/g)].map((match) => match[1]))
  }
  const zh = keysOf('composerZh')
  const en = keysOf('composerEn')
  const asked = [...source.matchAll(/t\('(composer\.[^']+)'\)/g)].map((match) => match[1])
  assert.ok(asked.length > 0, 'the popup must ask for at least one string')
  for (const key of new Set(asked)) {
    assert.ok(zh.has(key), `${key} is asked for but missing from composerZh`)
    assert.ok(en.has(key), `${key} is asked for but missing from composerEn`)
  }
})

/**
 * Scrolling inside the popup does not close the popup.
 *
 * The dismissal listens for `scroll` in the capture phase so that a scroll in any
 * container carrying the trigger is seen. The popup is a scroll container itself
 * once it holds more rows than fit, so reading past the first screenful dismissed
 * the panel it was being read in - on the one control that exists to be read.
 */
test('the composer popup ignores a scroll that happens inside it', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'client', 'composer.tsx'), 'utf8')
  const at = source.indexOf('const onViewport')
  assert.notEqual(at, -1, 'the popup has to react to the viewport moving')
  const body = source.slice(at, source.indexOf('\n    }', at))
  assert.match(body, /panelRef\.current\?\.contains\(/,
    'a scroll inside the panel is the user reading it, not the trigger moving')
  assert.match(body, /setOpen\(false\)/, 'and a scroll anywhere else still dismisses')
})

/**
 * Every gateway answers the same three refusals, and the Host and Origin ones
 * had no caller of their own: each gateway spelled the sequence out separately,
 * so nothing failed when one of them answered a different status. They now
 * share `guardsPass`, and this is the caller that exercises all three codes
 * through a real listening gateway.
 *
 * `fetch` cannot forge `Host` or a non-loopback `Origin`, and a rebinding
 * attempt is exactly what these guards exist to stop, so the requests go out as
 * raw HTTP over a socket. They use `/healthz`: it is behind the same guards as
 * `/v1/models` but never reads a vendor directory, so the test stays offline
 * without injecting a `fetchImpl` into every gateway.
 */
test('every gateway refuses a non-loopback Host, a foreign Origin and a malformed bearer', async () => {
  const net = require('node:net')
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  const { createWorkBuddyShim } = require('../src/shim.ts')
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')

  /** Send one raw request and return its status and parsed body. */
  const raw = (port, headers) => new Promise((resolve, reject) => {
    // A gateway that accepts but never answers must fail this test, not hang
    // it: `end` is the only other exit, so the deadline is what turns a
    // silent-regression into a red test instead of an unbounded CI job.
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('no answer within 5s')) }, 5000)
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(['GET /healthz HTTP/1.1', ...headers, 'Connection: close', '', ''].join('\r\n'))
    })
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { text += chunk })
    socket.on('error', (error) => { clearTimeout(deadline); reject(error) })
    socket.on('end', () => {
      clearTimeout(deadline)
      const status = Number((text.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1])
      resolve({ status, body: text.slice(text.indexOf('\r\n\r\n') + 4) })
    })
  })

  const fixtures = {
    pool: {
      acquire: async () => ({ id: 'a', label: 'fixture', credential: { accessToken: 'x', domain: '', expiresAtMs: 0 } }),
      list: () => [], isDisabled: () => false, refreshAccount: async () => false, penalize() {}, status: () => ({}),
    },
    client: new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('{}') }),
    catalog: { visible: () => [{ id: 'fixture-model' }], current: () => [{ id: 'fixture-model' }] },
  }
  const gateways = [
    ['trae', createTraeGateway({
      port: 0,
      credentials: async () => [{ accessToken: 'test', edition: 'cn' }],
      identity: async () => ({ machineId: 'test', deviceId: 'test', platform: 'win32' }),
    })],
    ['qoder', createQoderGateway({ region: 'cn', port: 0, credentials: async () => [{ token: 'test', region: 'cn' }] })],
    ['workbuddy', createWorkBuddyShim({ pool: fixtures.pool, client: fixtures.client, catalog: fixtures.catalog })],
  ]
  try {
    for (const [source, gateway] of gateways) {
      await gateway.ready
      const port = gateway.port()
      // Control: the same raw shape with a loopback Host reaches the router and
      // answers 200, so the 403s below are the guards and not a malformed
      // request. Without this the refusals could pass for the wrong reason.
      const allowed = await raw(port, ['Host: 127.0.0.1'])
      assert.equal(allowed.status, 200, `${source}: a loopback Host must reach the router`)

      const host = await raw(port, ['Host: evil.example.com'])
      assert.equal(host.status, 403, `${source}: a non-loopback Host must be refused`)
      assert.equal(JSON.parse(host.body).error.type, 'host_not_allowed')

      const origin = await raw(port, ['Host: 127.0.0.1', 'Origin: https://evil.example.com'])
      assert.equal(origin.status, 403, `${source}: a foreign Origin must be refused`)
      assert.equal(JSON.parse(origin.body).error.type, 'origin_not_allowed')

      const bearer = await raw(port, ['Host: 127.0.0.1', 'Authorization: Basic abc'])
      assert.equal(bearer.status, 401, `${source}: a non-Bearer Authorization must be refused`)
      assert.equal(JSON.parse(bearer.body).error.type, 'unauthorized')
    }
  } finally {
    await Promise.all(gateways.map(([, gateway]) => gateway.close()))
  }
})

test('a credential echoed by an upstream never survives into the client body', () => {
  const { redactSecrets } = require('../src/loopback.ts')
  // A real base64 token carries `+`, `/`, `=` and `.`. A rule that stops at the
  // first of those redacts the head and leaves the tail in the response, so the
  // value is checked in every 8-character window, not as a whole.
  const secret = 'abcDEF123+/=ghiJKL456.mnoPQR789'
  const windows = Array.from({ length: secret.length - 7 }, (_, i) => secret.slice(i, i + 8))
  const shapes = [
    `Authorization: Bearer ${secret}`,
    `Cloud-IDE-JWT ${secret}`,
    `X-Refresh-Token: ${secret}`,
    // The vendor credential in the quoted form an upstream echo takes. The header
    // spelling and the JSON field spelling are two shapes, and the field form has
    // no space before its value.
    `{"Cosy-Key":"${secret}"}`,
    `{"Cloud-IDE-JWT":"${secret}"}`,
    `{"X-Api-Key":"${secret}"}`,
    `{"upstream":"{\\"Cosy-Key\\":\\"${secret}\\"}"}`,
    `{"accessToken":"${secret}"}`,
    `?access_token=${secret}&x=1`,
    `{"upstream":"{\\"accessToken\\":\\"${secret}\\"}"}`,
    `qoder-oauth-token-${secret}`,
    `rt_${secret}`,
    // The four identity headers the plugin sends that the scheme rule missed.
    // `Cosy-Machineid` carries the same value `Cosy-Machinetoken` does, and the
    // three `x-` headers are the Trae machine, device and account ids: an echoed
    // request that prints them identifies the account as surely as a token.
    `Cosy-Machineid: ${secret}`,
    `x-machine-id: ${secret}`,
    `x-device-id: ${secret}`,
    `x-uid: ${secret}`,
    `{"x-machine-id":"${secret}"}`,
  ]
  for (const shape of shapes) {
    const out = redactSecrets(shape)
    for (const window of windows) {
      assert.equal(out.includes(window), false, `a credential fragment leaked from: ${shape}`)
    }
  }
  // Redaction must not eat the rest of the line: the fields after a credential are
  // the actionable half of an upstream error body.
  assert.equal(redactSecrets(`{"Authorization":"Bearer ${secret}","next":1}`).includes('"next":1'), true)
  // Prose that merely contains a scheme word is not a credential.
  assert.equal(redactSecrets('the bearer of bad news arrived'), 'the bearer of bad news arrived')
  assert.equal(redactSecrets('invalid Bearer format'), 'invalid Bearer format')
  // The business code is the actionable half of an error and must survive.
  assert.equal(redactSecrets('{"code":6004}').includes('6004'), true)
  assert.equal(redactSecrets('{"code":"soft_rate"}').includes('soft_rate'), true)
  // A filesystem path is redacted in either spelling, quoted or not.
  assert.equal(redactSecrets('open /home/bob/.config/qoder/auth.v1.dat failed').includes('/home/bob'), false)
  assert.equal(redactSecrets('open /Users/bob/Library/Application Support/WorkBuddy/login.info failed').includes('/Users/bob'), false)
  assert.equal(redactSecrets('open C:\\Users\\bob\\AppData\\qoder\\auth.v1.dat failed').includes('C:\\Users'), false)
  // ...but a route or a ratio is not a path, and destroying it would trade a
  // disclosure for an undiagnosable error.
  assert.equal(redactSecrets('POST /v1/chat/completions returned 4001'), 'POST /v1/chat/completions returned 4001')
  assert.equal(redactSecrets('the request took 1/2 a second and/or failed'), 'the request took 1/2 a second and/or failed')
})

/**
 * A file the registry scan names is only run when its signature is valid.
 *
 * The scan reads `DisplayName`, `DisplayIcon` and `InstallLocation` out of the
 * user's own uninstall keys, so any process running as the user can add one. A
 * key naming an arbitrary executable was therefore enough to have this plugin
 * spawn it with the plugin's whole environment, inside a process holding every
 * WorkBuddy token. A `Valid` status requires the chain to resolve to a trusted
 * root, which a same-user process cannot produce for a file it wrote.
 */
test('a file the registry scan names is only run when its signature is valid', () => {
  const { signatureAccepts } = require('../src/at-rest.ts')
  assert.equal(signatureAccepts('Valid', 'CN=Tencent Technology (Shenzhen) Company Limited'), true,
    'a signature that chains to a trusted root is the only thing accepted')
  for (const status of ['NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', '', undefined]) {
    assert.equal(signatureAccepts(status, 'CN=someone'), false, `a ${String(status)} signature must be refused`)
  }
  // A status PowerShell reported but a signer it could not name, and the blank
  // and missing forms of the same.
  assert.equal(signatureAccepts('Valid', ''), false, 'a valid status with no signer is not enough')
  assert.equal(signatureAccepts('Valid', undefined), false)
  assert.equal(signatureAccepts('Valid', '   '), false, 'a blank signer is not a signer')
  assert.equal(signatureAccepts(undefined, undefined), false, 'an unreadable signature must be refused, not assumed')
})

/**
 * The doctor's "published address" row covers all three sources, and names the
 * port a held one fell back from.
 *
 * That table folds WorkBuddy, Trae and Qoder into one loop because all three
 * reserve a preferred port on the same terms, so all three can drift the same
 * way. Reporting only WorkBuddy - which is what it did before the other two
 * were folded in - left every Trae and Qoder provider row broken while the
 * report said everything passed. The text is user-facing in all three cases, so
 * a row that silently disappears is a diagnosis the user never sees.
 *
 * The claim under test: with all three sources running, each one has a
 * `published address` finding; and when one source's preferred port is held by
 * another process, that source still passes because its published row names
 * the fallback it actually bound, and the finding says which port was taken.
 */
test('the doctor reports a published address for all three sources and names the port a held one fell back from', async (t) => {
  const net = require('node:net')
  const { createServer } = require('node:http')
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-doctor-addr-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  fs.writeFileSync(path.join(auth, 'login.info'), JSON.stringify({
    auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 }, account: { uin: 'test-user' },
  }))
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: true, sourceQoder: true,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] }, authFile: path.join(auth, 'login.info'),
  }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [{ id: 'wb-model', name: 'WB', contextWindow: 128000, maxTokens: 4096 }])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchModels', async () => ({ models: [{ id: 'trae-model', name: 'Trae', function: 'chat' }], partial: false }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ code: 0, enable: true, checkedIn: false }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchUsageSummary', async () => ({ credits: [], packs: [] }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchModels', async () => [{ id: 'qoder-model', name: 'Qoder', function: 'chat' }])
  t.mock.method(QoderUpstreamClient.prototype, 'fetchUsage', async () => ({ userQuota: { remaining: 5, total: 10 }, dedicatedPackages: [] }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchCampaigns', async () => ({}))
  const trae = require('../src/trae-discovery.ts')
  const qoder = require('../src/qoder-credentials.ts')
  t.mock.method(trae, 'discoverTraeCredentials', async () => ({
    credentials: [{ accessToken: 'trae-token', userId: 'trae-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: 0 }],
    failures: [],
  }))
  t.mock.method(qoder, 'discoverQoderCredentials', async () => ({
    credentials: [{ region: 'cn', userID: 'qoder-user', token: 'qoder-token', name: '', email: '', expiresAtMs: 0 }],
    failures: [],
  }))
  // Trae CN's preferred slot in the port block, held by an unrelated process for
  // the whole check. Every other gateway keeps its own, so this is the one row
  // that has to report the fallback.
  const held = createServer((_req, res) => res.writeHead(503).end('port held'))
  // The preferred slot this test needs is a fixed one, and a user's running DSH
  // already listening there is not a defect in the doctor: skip the case rather
  // than report a failure the machine, not the code, caused.
  try {
    await new Promise((resolve, reject) => { held.once('error', reject); held.listen(42851, '127.0.0.1', resolve) })
  } catch (error) {
    held.close()
    if (error?.code === 'EADDRINUSE') {
      t.skip('Trae CN preferred port 42851 is already in use on this machine')
      return
    }
    throw error
  }
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  const address = (findings, id) => findings.find((finding) => finding.id === id)
  try {
    await plugin.onLoad()
    await startRegisteredService()
    // The gateways start behind the load's budget, so poll the way the panel does.
    let report
    for (let attempt = 0; attempt < 100; attempt += 1) {
      report = await plugin.onPanelInvoke('xd.doctor')
      if (report.findings.filter((finding) => finding.id.endsWith(': published address')).length >= 3) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
    for (const name of ['WTQ Pool (CN)', 'WTQ Pool Trae (CN)', 'WTQ Pool Qoder (CN)']) {
      assert.ok(byId.has(name + ': published address'), `${name} must have a published address row`)
    }
    const held = byId.get('WTQ Pool Trae (CN): published address')
    assert.equal(held.ok, true, 'a gateway serving the address it published is not drift')
    assert.ok(held.detail.includes('42851'), 'the fallback text must name the port it wanted')
    assert.ok(held.detail.includes('is held'), 'the fallback text must say why')
    // Control: the other two sources kept their own slots, so their rows pass and
    // name the address actually bound. Without this the Trae row could be the
    // only row left and the test would not notice two of them disappearing.
    for (const name of ['WTQ Pool (CN)', 'WTQ Pool Qoder (CN)']) {
      const row = byId.get(name + ': published address')
      assert.equal(row.ok, true, `${name} kept its preferred port and must pass`)
      assert.ok(row.detail.includes('matches the endpoint'), `${name} must name the address it bound`)
    }
    assert.ok(report.report.includes('published address'), 'the report text must carry the row too')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    held.closeAllConnections()
    await new Promise((resolve) => held.close(resolve))
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A Trae or Qoder preference must be stored, and a label nothing can match must
 * be refused.
 *
 * The WorkBuddy branch is covered above; the source branches were not, and the
 * two are not the same shape. Storing a label the panel never listed leaves the
 * picker falling back to its own default, so the click looks like it worked and
 * the same account keeps serving.
 *
 * The claim under test: a listed label is stored under its `source:region` key
 * and reported as saved, while an unlisted label is refused with `show: false`
 * and changes nothing.
 */
test('a source account preference is stored only for a label that exists', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-srcpref-test-'))
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: true, sourceQoder: false,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] }, showComposerPoints: true,
    preferredSourceAccounts: {},
  }
  const trae = require('../src/trae-discovery.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  t.mock.method(trae, 'discoverTraeCredentials', async () => ({
    credentials: [
      { accessToken: 'trae-token', userId: 'trae-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
      { accessToken: 'trae-token-2', userId: 'trae-user-2', edition: 'cn', host: '', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
    ],
    failures: [],
  }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ code: 0, enable: true, checkedIn: false }))
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchUsageSummary', async () => ({ credits: [], packs: [] }))
  // The composer only matches a model the gateway actually publishes, so the
  // directory has to answer with one. `cachedModels` is filled from here.
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchModels', async () => ({ models: [{ id: 'trae-model', name: 'Trae Model', function: 'chat' }], partial: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({ getSettings: () => ({ ...settings }), setSettings: patch => Object.assign(settings, patch), getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }) })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    let state
    for (let attempt = 0; attempt < 60; attempt += 1) {
      state = await plugin.onPanelInvoke('xd.state')
      if (state.trae.accounts.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const label = state.trae.accounts[0]?.label
    assert.ok(label, 'the Trae sign-in must be listed with a label')
    // Warm the gateway directory the way the host does before it reads the roster.
    const gateway = state.trae.gateways.find((entry) => entry.region === 'cn')
    await fetch(`http://127.0.0.1:${gateway.port}/v1/models`, { headers: { connection: 'close' } })
    state = await plugin.onPanelInvoke('xd.state')
    const modelId = state.trae.gateways.find((entry) => entry.region === 'cn')?.roster?.[0]?.id
    assert.ok(modelId, 'the gateway must publish the model the composer matches against')

    const stored = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-trae-cn', model: modelId, source: 'trae', region: 'cn', accountLabel: label,
    })
    assert.equal(stored.saved, true, 'a listed label must be reported as stored')
    assert.equal(settings.preferredSourceAccounts['trae:cn'], label, 'the choice must really have been stored')

    // A sign-in the gateway just refused is still listed and may still be
    // stored, but this session keeps serving another account. The popup has to
    // learn that instead of closing as though the switch took effect.
    vm.runInContext(`noteSourceFailure("trae", "cn", ${JSON.stringify(label)}, "60")`, context)
    const held = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-trae-cn', model: modelId, source: 'trae', region: 'cn', accountLabel: label,
    })
    assert.equal(held.saved, true, 'the choice is still worth storing for when the hold ends')
    assert.equal(held.unavailable, true, 'a held source account must be reported as unavailable')

    const refused = await plugin.onPanelInvoke('xd.composerPrefer', {
      provider: 'wtqpool-trae-cn', model: modelId, source: 'trae', region: 'cn', accountLabel: 'no-such-label',
    })
    assert.equal(refused.show, false, 'a label nothing can match must be refused')
    assert.equal(refused.saved, undefined, 'a refused click must not claim anything was stored')
    assert.equal(settings.preferredSourceAccounts['trae:cn'], label, 'a refused click must not overwrite the stored choice')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a Trae error frame never carries the credential it was sent with', () => {
  // The frame `describeTraeFailure` builds goes straight to the client, and an
  // upstream that quotes the request it was sent puts the live token in it.
  const { describeTraeFailure } = require('../src/trae-shim.ts')
  const secret = 'COSY.live-SUPERSECRETVALUE1234567890'
  const described = describeTraeFailure({
    code: 401,
    message: `rejected header Cloud-IDE-JWT ${secret}`,
    extra: { authorization: `Bearer ${secret}` },
  })
  assert.equal(described.includes(secret), false, 'the credential must not survive into the frame')
  assert.match(described, /redacted/i, 'the redacted form must still say what happened')
})

/**
 * A bridge that ran to completion still releases its upstream reader.
 *
 * The release has to sit in a `finally`: a stream that reaches EOF closes its
 * controller instead of erroring, so that exit never runs the catch, and with
 * the cancel in the catch the upstream reader stayed locked for every normal
 * turn. A source that closed itself never runs its own `cancel`, so the lock is
 * the observable here, not the source's callback.
 */
test('a relay that ends cleanly still releases its upstream reader', async () => {
  const { bridgeTraeStream } = require('../src/trae-shim.ts')
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()

  for (const [name, bridge, wire] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\nevent: done\ndata: {}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'],
  ]) {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire))
        controller.close()
      },
    })
    const decoder = new TextDecoder()
    const reader = bridge(upstream, 'model').getReader()
    let text = ''
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value)
    }
    assert.match(text, /hello/, `${name}: the reply must reach the client`)
    // The bridge's `finally` runs after it closes its controller, so the
    // release lands a tick after the caller sees EOF.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(upstream.locked, false, `${name}: a finished turn must still release the upstream reader`)
  }
})

test('a panel error never carries the credential an upstream echoed', async () => {
  const { registerPanelRoutes, PANEL_BASE } = require('../src/web-panel.ts')
  const { createServer, request } = require('node:http')

  // The credential shape a vendor echoes when it rejects a request: Trae's 401
  // quotes the header it was sent. This is the text the panel renders, so it is
  // the text that must not survive the trip.
  const echoed = 'upstream said: X-Cloudide-Token abcdefgh12345678 rejected'
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }
  registerPanelRoutes(ctx, {
    pluginRoot: path.resolve(__dirname, '..'),
    invoke: async () => { throw new Error(echoed) },
    logger: { warn() {} },
    effect: (callback) => callback(),
  })

  // Serve the registered handler through a real server, so the response the
  // panel would receive is the response under test.
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const body = JSON.stringify({ channel: 'xd.state', payload: {} })
  const answer = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method: 'POST', path: `${PANEL_BASE}/invoke`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode, raw }))
    })
    req.on('error', reject)
    req.end(body)
  })
  await new Promise((resolve) => server.close(resolve))

  assert.equal(answer.status, 500, 'a handler failure is the panel error path')
  assert.doesNotMatch(answer.raw, /abcdefgh12345678/, 'the echoed credential must not reach the panel')
  assert.match(answer.raw, /\[redacted\]/, 'the credential is replaced, not the whole message dropped')
})

/**
 * The connection report names no account.
 *
 * `doctor.txt` is the file a user pastes into a bug report, and it is written
 * from the same text the panel's check view shows. It listed every sign-in by
 * its display name, which is a nickname and can be an email address, so the one
 * artifact meant to leave the machine carried the user's identities.
 *
 * The claim under test: the accounts row reports how many sign-ins the pool
 * holds, and neither the finding nor the report text carries a display name.
 */
test('the connection report counts the accounts without naming them', async (t) => {
  const accountName = 'fixture.user@example.com'
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-doctor-names-'))
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth)
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: { accessToken: 'test', expiresAt: Date.now() + 3600000 },
    account: { uin: 'test-user', nickname: accountName },
  }))
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({ ...settings }), setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary, declareProviders: () => ({ ok: true, changed: false }),
  })
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')), module: { exports: {} }, exports: {},
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await startRegisteredService()
    const report = await plugin.onPanelInvoke('xd.doctor')
    const accounts = report.findings.find((finding) => finding.id === 'accounts')
    assert.equal(accounts.detail, '1 account(s)', 'the row reports the count')
    assert.equal(accounts.detail.includes(accountName), false, 'and carries no display name')
    assert.equal(report.report.includes(accountName), false,
      'neither does the report text, which is what doctor.txt holds')
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

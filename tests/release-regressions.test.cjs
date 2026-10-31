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

const { createServer, request } = require('node:http')
const encoder = new TextEncoder()

for (const source of ['trae', 'qoder']) {
  test(`${source} completes at its terminal marker without waiting for TCP EOF`, async () => {
    const bridge = source === 'trae' ? require('../src/trae-shim.ts').bridgeTraeStream : require('../src/qoder-shim.ts').bridgeQoderStream
    const opening = source === 'trae'
      ? 'event: output\ndata: {"response":"回复完成"}\n\nevent: done\ndata: {}\n\n'
      : 'data: {"choices":[{"delta":{"content":"回复完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    let released = false
    const upstream = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(opening)) },
      cancel() { released = true },
    })
    const reader = bridge(upstream, 'fixture').getReader()
    const read = (async () => { let body = ''; for (;;) { const next = await reader.read(); if (next.done) return body; body += new TextDecoder().decode(next.value) } })()
    let timer
    try {
      const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250) })])
      assert.notEqual(body, null, 'a finished reply must not stay in flight until the upstream closes its socket')
      assert.match(body, /回复完成/)
      assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(released, true, 'the finished upstream must be released')
    } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); await read.catch(() => {}) }
  })

  test(`${source} cancellation during catalog loading cannot start a billable chat`, async (t) => {
    const client = source === 'qoder' ? require('../src/qoder-client.ts').QoderUpstreamClient : require('../src/trae-upstream.ts').TraeSoloUpstreamClient
    let release, started
    const loading = new Promise(resolve => { started = resolve })
    t.mock.method(client.prototype, 'fetchModels', () => { started(); return new Promise(resolve => { release = resolve }) })
    const calls = []
    const upstream = createServer((req, res) => { calls.push(req.url); res.end('data: [DONE]\n\n') })
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const fetchImpl = (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}/spent-credit`, init)
    const gateway = source === 'qoder'
      ? require('../src/qoder-gateway.ts').createQoderGateway({ port: 0, region: 'cn', credentials: async () => [{ userID: 'fixture', token: 'fixture' }], fetchImpl })
      : require('../src/trae-gateway.ts').createTraeGateway({ port: 0, credentials: async () => [{ accessToken: 'fixture', userId: 'fixture', edition: 'cn' }], identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }), fetchImpl })
    let req
    try {
      await gateway.ready
      req = request(gateway.baseUrl() + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } })
      req.on('error', () => {})
      req.end('{"model":"fixture","messages":[{"role":"user","content":"cancel"}]}')
      await loading
      req.destroy()
      await new Promise(resolve => setTimeout(resolve, 50))
      release([{ id: 'fixture', name: 'Fixture', function: 'llm_utils_chat' }])
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.deepEqual(calls, [], 'the upstream must not receive a chat after the caller has left')
    } finally { req?.destroy(); release?.([]); await gateway.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)) }
  })
}

/**
 * A partial startup republishes only the rows of gateways that are still warming.
 *
 * A Qoder gateway whose directory has not answered yet is the one case a row is
 * republished for: dropping it would cost a roster the gateway already had. One
 * that has answered and published nothing is definitively signed out or
 * unreachable, so its saved row must go - keeping it published a stale model
 * list for as long as the source stayed switched on, and the client kept
 * picking a model the account could no longer serve.
 */
test('a partial startup keeps the row of a warming gateway and drops an answered one', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const fn = source.match(/^function syncDeclaration\(\) \{[^]*?^\}/m)[0]
  const old = { id: 'wtqpool-qoder-cn', models: [{ id: 'saved-qoder' }] }
  const byWarming = [
    // A Qoder gateway whose directory has not answered yet is the one case a row
    // is republished for; everything else that cannot publish drops its row.
    { warming: ['wtqpool-qoder-cn'], kept: ['wtqpool-cn', 'wtqpool-qoder-cn'], reason: 'a gateway still warming keeps the row it saved' },
    // Nothing is warming: the Qoder directory has answered, and the row it saved
    // is all that is left of a sign-in that is gone.
    { warming: [], kept: ['wtqpool-cn'], reason: 'a gateway that has answered drops the row it saved' },
  ]
  for (const { warming, kept, reason } of byWarming) {
    const writes = []
    const context = vm.createContext({
      runtimes: new Map([['cn', { signedIn: true }]]),
      activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => ['cn'],
      declarationModels: () => [{ id: 'workbuddy' }], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
      PROVIDER_ID_BY_REGION: { cn: 'wtqpool-cn' }, TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: { cn: old.id },
      descriptorFor: () => ({ id: 'wtqpool-cn', models: [{ id: 'workbuddy' }] }), descriptorForTrae() {}, descriptorForQoder() {},
      manifestProviders: () => [old], declaredProviders: () => [old], writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
      warmingGatewayIds: () => new Set(warming),
    })
    vm.runInContext(fn + '\nsyncDeclaration()', context)
    assert.deepEqual(Array.from(writes[0], row => row.id), kept, reason)
  }
})

/**
 * What "warming" means, decided by the real function rather than a stub of it.
 *
 * The case above pins `syncDeclaration` against a `warmingGatewayIds` it
 * provides itself, so it does not say which runtimes count as warming.
 * This one runs the shipped function over a fake runtime map: a runtime that is
 * still connecting has not landed its roster yet, so its row is worth
 * republishing; a runtime that has settled signed out has answered, and its row
 * is a stale model list for as long as the source stays switched on.
 */
test('a runtime still connecting is warming and a settled signed-out one is not', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const fn = source.match(/^function warmingGatewayIds\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(),
    gatewayStartFailures: new Map(),
    activeRegions: () => ['cn'],
    PROVIDER_ID_BY_REGION: { cn: 'wtqpool-cn' },
    traeGateways: new Map(), activeTraeRegions: () => [], TRAE_PROVIDER_ID_BY_REGION: {},
    qoderGateways: new Map(), activeQoderRegions: () => [], QODER_PROVIDER_ID_BY_REGION: {},
  })
  vm.runInContext(fn + '\nwarmingGatewayIds()', context)
  const warming = () => [...vm.runInContext('warmingGatewayIds()', context)]

  // Mid-connect: the roster is still on its way, so dropping the row would cost
  // a roster the gateway already had.
  context.runtimes = new Map([['cn', { signedIn: false, connecting: Promise.resolve() }]])
  assert.deepEqual(warming(), ['wtqpool-cn'],
    'a runtime that has not finished connecting must read as warming')
  // Settled: the connect answered and the sign-in is gone, which is a verdict
  // rather than a wait.
  context.runtimes = new Map([['cn', { signedIn: false, connecting: null }]])
  assert.deepEqual(warming(), [], 'a runtime that has settled signed out must not read as warming')
  // No runtime at all is still a roster on its way - the same row is at stake.
  context.runtimes = new Map()
  assert.deepEqual(warming(), ['wtqpool-cn'],
    'a region with no runtime yet is still waiting for its first roster')
  // A region whose start failed is not waiting for anything: its shim could not
  // bind, and nothing will bring the row it saved back to life.
  context.gatewayStartFailures = new Map([['cn', 'listen EADDRINUSE']])
  assert.deepEqual(warming(), [],
    'a region whose gateway could not start must not read as warming')
})

/**
 * A gateway that never bound is drift, not health.
 *
 * The address-drift row is the only thing that names `ERR_CONNECTION_REFUSED`
 * for what it is. A gateway whose `listen` lost the port race has no runtime at
 * all, which is the same shape as one still warming up, so the comparison
 * skipped it and the panel reported a healthy session over a provider row the
 * host kept sending requests to with nothing behind it.
 */
test('a gateway that could not bind is reported as address drift', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const fn = source.match(/^function addressDrift\(\) \{[^]*?^\}/m)[0]
  const context = vm.createContext({
    runtimes: new Map(),
    gatewayStartFailures: new Map(),
    sourceStartFailures: new Map(),
    publishedIds: new Set(),
    activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => [],
    PROVIDER_ID_BY_REGION: { cn: 'wtqpool-cn' },
    TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: {},
    traeGateways: new Map(), qoderGateways: new Map(),
    // The host holds a row for this region, and this run has nothing bound.
    declaredBaseUrl: () => 'http://127.0.0.1:37891/v1',
    declaredSourceBaseUrl: () => undefined,
    shimInfo: () => ({ running: false }),
  })
  vm.runInContext(fn + '\naddressDrift()', context)
  const drift = () => vm.runInContext('addressDrift()', context)

  assert.equal(drift(), false, 'with nothing failed and nothing bound there is no drift yet')
  context.gatewayStartFailures = new Map([['cn', 'listen EADDRINUSE']])
  assert.equal(drift(), false,
    'a first start that failed before any row was registered has nothing to drift from')
  context.publishedIds = new Set(['wtqpool-cn'])
  assert.equal(drift(), true,
    'once the host holds the row, a gateway with no shim is drift')

  // The same question for Trae/Qoder: their start failures have no map entry
  // either, so comparing the maps alone called a dead provider healthy.
  context.gatewayStartFailures = new Map()
  context.publishedIds = new Set()
  context.activeTraeRegions = () => ['cn']
  context.TRAE_PROVIDER_ID_BY_REGION = { cn: 'wtqpool-trae-cn' }
  context.sourceStartFailures = new Map([['trae:cn', 'listen EADDRINUSE']])
  assert.equal(drift(), false, 'a Trae first start that failed has nothing to drift from yet')
  context.declaredSourceBaseUrl = () => 'http://127.0.0.1:42851'
  assert.equal(drift(), true, 'once its row is published, a Trae gateway with no bind is drift')
})

test('DSH publishes the live gateway after its preferred port is occupied', async (t) => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-live-port-'))
  const auth = path.join(directory, 'auth')
  fs.mkdirSync(auth)
  const authFile = path.join(auth, 'fixture.info')
  fs.writeFileSync(authFile, JSON.stringify({ auth: { accessToken: 'fixture-token', expiresAt: Date.now() + 3600000 }, account: { uin: 'fixture-user' } }))
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const occupied = createServer((_req, res) => res.writeHead(503).end('port held'))
  await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(0, '127.0.0.1', resolve) })
  const { installPi } = require('../src/pi-compat.ts')
  let rows = []
  installPi({
    getSettings: () => ({ enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false, disabledRegions: ['workbuddy:global'], authFile, autoCheckin: { enabled: false } }),
    getDataPath: () => directory, declareProviders: next => { rows = next; return { ok: true, changed: true } },
  })
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require: (specifier) => { const load = createRequire(path.join(root, 'src/host.ts')); return specifier === './ids.ts' ? { ...load(specifier), PORT_BASE: occupied.address().port } : load(specifier) }, console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    const state = await plugin.onPanelInvoke('xd.state')
    const row = rows.find(row => row.id === 'wtqpool-cn')
    assert.ok(row)
    assert.equal(row.baseUrl, state.shims.cn.baseUrl, 'runtime registration must name the gateway that actually bound')
    assert.equal((await fetch(row.baseUrl.replace(/\/v1$/, '') + '/healthz')).status, 200)
  } finally { await plugin.onUnload(); occupied.closeAllConnections(); await new Promise(resolve => occupied.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }) }
})

for (const [source, terminal, expected] of [
  ['trae', 'event: done\ndata: {}\n\n', ''],
  ['qoder', 'data: [DONE]\n\n', ''],
  ['trae', 'event: done\ndata: {"response":"最后一段"}\n\n', '最后一段'],
]) {
  test(`${source} preflight completes a ${expected === '' ? 'blank' : 'content-bearing'} terminal reply without EOF`, async () => {
    const open = source === 'trae' ? require('../src/trae-shim.ts').openTraeResponse : require('../src/qoder-shim.ts').openQoderResponse
    let controller, released = false, timer
    const upstream = new ReadableStream({
      start(next) { controller = next; next.enqueue(encoder.encode(terminal)) },
      cancel() { released = true },
    })
    const read = open(new Response(upstream), 'fixture').then(response => response.text())
    try {
      const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 250) })])
      assert.notEqual(body, null, 'preflight and relay must both accept a terminal marker without TCP EOF')
      if (expected !== '') assert.ok(body.includes(expected), 'the terminal event must retain its final content')
      assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(released, true)
    } finally {
      clearTimeout(timer)
      try { controller.close() } catch {}
      await read.catch(() => {})
    }
  })
}

test('WorkBuddy closes at a split terminal frame without treating content as a marker', async () => {
  const { createWorkBuddyShim } = require('../src/shim.ts')
  let controller, released = false, timer
  const upstream = new ReadableStream({
    start(next) {
      controller = next
      next.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"正文中的 [DONE]"}}]}\n\ndata: [DO'))
      next.enqueue(encoder.encode('NE]\n\n'))
    },
    cancel() { released = true },
  })
  const gateway = createWorkBuddyShim({ port: 0,
    pool: { acquire: async () => ({ label: 'fixture', credential: {} }), list: () => [] }, catalog: { visible: () => [] },
    client: { prepareChatBody: raw => raw, chatStream: async () => ({ ok: true, response: new Response(upstream) }) },
  })
  const abort = new AbortController()
  let read
  try {
    await gateway.ready
    const response = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal,
      body: '{"model":"fixture","messages":[{"role":"user","content":"hello"}]}',
    })
    read = response.text()
    const body = await Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500) })])
    assert.notEqual(body, null, 'WorkBuddy must complete without waiting for TCP EOF')
    assert.ok(body.includes('正文中的 [DONE]'))
    assert.equal((body.match(/data: \[DONE\]/g) || []).length, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(released, true)
  } finally {
    clearTimeout(timer)
    abort.abort()
    try { controller.close() } catch {}
    await read?.catch(() => {})
    await gateway.close()
  }
})

test('WorkBuddy composer starts a background probe for cold credits without a panel open', async () => {
  const entry = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const fn = entry.match(/^function composerPoints\(args\) \{[^]*?^\}/m)[0]
  let total = null, scheduled = 0
  const context = vm.createContext({
    composerPointsEnabled: () => true,
    matchComposerModel: () => ({ source: 'workbuddy', region: 'cn', id: 'fixture' }),
    workbuddyComposerAccounts: () => [{ active: true, label: 'fixture', total }],
    probesStale: () => total === null,
    scheduleRefresh: () => { scheduled++; setImmediate(() => { total = 500 }) },
  })
  vm.runInContext(fn, context)
  assert.equal(context.composerPoints({ chip: 'fixture', provider: 'wtqpool-cn', model: 'fixture' }).total, null)
  assert.equal(scheduled, 1, 'cache-only composer reads must start the existing background refresh when cold')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.composerPoints({ chip: 'fixture', provider: 'wtqpool-cn', model: 'fixture' }).total, 500)
  assert.equal(scheduled, 1, 'fresh credits must not start another probe')
})

test('DSH account selection restarts credit polling after a successful preference save', async () => {
  const renderer = fs.readFileSync(path.join(root, 'src/client/composer.tsx'), 'utf8')
  const pick = renderer.match(/  const pick = \(account: ComposerAccount\): void => \{[^]*?\n  \}/)[0]
  let restarted = 0
  const context = vm.createContext({
    busy: false, routeRef: { current: {} }, provider: 'fixture-p', model: 'fixture-m', points: { source: 'workbuddy', region: 'cn' },
    invoke: async () => ({ saved: true, show: true, total: null }),
    setBusy() {}, setError() {}, setErrorFor() {}, setPoints() {}, setOpen() {}, t: key => key,
    restartPollRef: { current: () => { restarted++ } },
  })
  vm.runInContext(transpile(pick + '\npick({id: "fixture"})'), context)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(restarted, 1, 'a preference save must not leave unread credits on the old five-minute timer')
})

/**
 * The delete button shares the remove button's box.
 *
 * Both sit in one flex line at the right end of an account row. The delete
 * button inherited the default `button` padding while the remove button carried
 * the row's smaller one, so it stood taller and its top edge sat above the
 * control it belongs beside.
 */
test('the account row ships one box for the remove and delete buttons', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/panel.css'), 'utf8')
  const shared = css.match(/\.acct-remove,\s*\n\.acct-delete \{([^}]*)\}/)
  assert.ok(shared, 'the two buttons must be sized by one rule, not by the default button padding')
  assert.match(shared[1], /padding:\s*4px 10px/, 'and that rule must set the row padding both of them share')
  assert.match(shared[1], /font-size:\s*12\.5px/, 'with the row font size, so their heights match')
})

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { root, transpile } = require('./ts-loader.cjs')
const sourceFunction = (source, name) => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}$`, 'm'))
  assert.ok(match, `${name} must exist`)
  return match[0]
}

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
  const fn = sourceFunction(source, 'syncDeclaration')
  const rebound = sourceFunction(source, 'warmingDescriptor')
  const old = { id: 'wtqpool-qoder-cn', baseUrl: 'http://127.0.0.1:45110/v1', models: [{ id: 'saved-qoder' }] }
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
      qoderGateways: new Map([['cn', { baseUrl: 'http://127.0.0.1:41871' }]]),
      activeRegions: () => ['cn'], activeTraeRegions: () => [], activeQoderRegions: () => ['cn'],
      declarationModels: () => [{ id: 'workbuddy' }], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
      PROVIDER_ID_BY_REGION: { cn: 'wtqpool-cn' }, TRAE_PROVIDER_ID_BY_REGION: {}, QODER_PROVIDER_ID_BY_REGION: { cn: old.id },
      descriptorFor: () => ({ id: 'wtqpool-cn', models: [{ id: 'workbuddy' }] }), descriptorForTrae() {}, descriptorForQoder: () => ({ baseUrl: 'http://127.0.0.1:41871/v1' }),
      manifestProviders: () => [old], declaredProviders: () => [old], writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
      warmingGatewayIds: () => new Set(warming),
    })
    vm.runInContext(fn + '\n' + rebound + '\nsyncDeclaration()', context)
    assert.deepEqual(Array.from(writes[0], row => row.id), kept, reason)
    if (warming.length > 0) assert.equal(writes[0][1].baseUrl, 'http://127.0.0.1:41871/v1')
  }
})

test('a cold source keeps its saved row at the preferred port', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const functions = ['syncDeclaration', 'warmingDescriptor', 'warmingGatewayIds']
    .map(name => sourceFunction(source, name))
    .join('\n')
  const oldWorkBuddy = { id: 'wtqpool-cn', baseUrl: 'http://127.0.0.1:3/v1', models: [{ id: 'saved-workbuddy' }] }
  const oldTrae = { id: 'wtqpool-trae-cn', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'saved-trae' }] }
  const oldQoder = { id: 'wtqpool-qoder-cn', baseUrl: 'http://127.0.0.1:2/v1', models: [{ id: 'saved-qoder' }] }
  const writes = []
  const context = vm.createContext({
    runtimes: new Map(), gatewayStartFailures: new Map(),
    traeGateways: new Map(), qoderGateways: new Map(), sourceStartFailures: new Map(),
    sourceKey: (s, r) => s + ':' + r,
    PLACEHOLDER_BASE_URL: 'http://127.0.0.1:1/v1',
    activeRegions: () => ['cn'], activeTraeRegions: () => ['cn'], activeQoderRegions: () => ['cn'],
    PROVIDER_ID_BY_REGION: { cn: oldWorkBuddy.id }, TRAE_PROVIDER_ID_BY_REGION: { cn: oldTrae.id },
    QODER_PROVIDER_ID_BY_REGION: { cn: oldQoder.id },
    declarationModels: () => [], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
    descriptorFor: () => ({ baseUrl: 'http://127.0.0.1:41871/v1' }),
    descriptorForTrae: () => ({ baseUrl: 'http://127.0.0.1:42841/v1' }),
    descriptorForQoder: () => ({ baseUrl: 'http://127.0.0.1:45110/v1' }),
    declaredProviders: () => [oldWorkBuddy, oldTrae, oldQoder],
    writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
  })
  vm.runInContext(`${functions}\nsyncDeclaration()`, context)
  assert.deepEqual(Array.from(writes[0], row => row.id), [oldWorkBuddy.id, oldTrae.id, oldQoder.id])
  assert.deepEqual(Array.from(writes[0], row => row.baseUrl), [
    'http://127.0.0.1:41871/v1', 'http://127.0.0.1:42841/v1', 'http://127.0.0.1:45110/v1',
  ])
})

/**
 * A gateway that answered on the placeholder has nothing to republish.
 *
 * The placeholder is the address a runtime is created with, before its listener
 * binds. A gateway still sitting on it has tried and failed to bind, so
 * republishing its saved roster would point the host at a port nothing is
 * listening on - every request refused, while the panel reports no drift.
 * WorkBuddy's branch always refused that case; the Trae and Qoder branches
 * published their preferred port instead, which is the same dead address for
 * those sources.
 */
test('a gateway stuck on the placeholder does not republish its saved row', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const functions = ['syncDeclaration', 'warmingDescriptor']
    .map(name => sourceFunction(source, name))
    .join('\n')
  const placeholder = 'http://127.0.0.1:1/v1'
  for (const source_ of ['trae', 'qoder']) {
    const old = { id: `wtqpool-${source_}-cn`, baseUrl: 'http://127.0.0.1:9999/v1', models: [{ id: 'saved' }] }
    const writes = []
    // Only the source under test is active: it has a gateway that is still on
    // the placeholder, so its saved row must not be republished.
    const context = vm.createContext({
      runtimes: new Map(), gatewayStartFailures: new Map(),
      traeGateways: source_ === 'trae' ? new Map([['cn', { baseUrl: placeholder }]]) : new Map(),
      qoderGateways: source_ === 'qoder' ? new Map([['cn', { baseUrl: placeholder }]]) : new Map(),
      sourceStartFailures: new Map(),
      activeRegions: () => [],
      activeTraeRegions: () => (source_ === 'trae' ? ['cn'] : []),
      activeQoderRegions: () => (source_ === 'qoder' ? ['cn'] : []),
      PROVIDER_ID_BY_REGION: {},
      TRAE_PROVIDER_ID_BY_REGION: source_ === 'trae' ? { cn: old.id } : {},
      QODER_PROVIDER_ID_BY_REGION: source_ === 'qoder' ? { cn: old.id } : {},
      declarationModels: () => [], traeDeclarationModels: () => [], qoderDeclarationModels: () => [],
      descriptorFor: () => ({}),
      descriptorForTrae: () => ({ baseUrl: 'http://127.0.0.1:42841/v1' }),
      descriptorForQoder: () => ({ baseUrl: 'http://127.0.0.1:45110/v1' }),
      declaredProviders: () => [old], writeDeclaration: rows => { writes.push(rows); return { ok: true } }, runtimeState: {},
      warmingGatewayIds: () => new Set([old.id]),
    })
    vm.runInContext(`${functions}\nsyncDeclaration()`, context)
    assert.deepEqual(Array.from(writes[0], row => row.id), [], `${source_}: a dead port must not keep its row`)
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
  const fn = sourceFunction(source, 'warmingGatewayIds')
  const context = vm.createContext({
    runtimes: new Map(),
    gatewayStartFailures: new Map(),
    activeRegions: () => ['cn'],
    PROVIDER_ID_BY_REGION: { cn: 'wtqpool-cn' },
    traeGateways: new Map(), activeTraeRegions: () => [], TRAE_PROVIDER_ID_BY_REGION: {},
    qoderGateways: new Map(), activeQoderRegions: () => [], QODER_PROVIDER_ID_BY_REGION: {},
    core: { pool: { status: () => ({ lastScanAtMs: Date.now(), scanning: false }) } },
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
  // The gateway can settle before a slow at-rest account scan. Until that scan
  // has either found an account or finished with none, its saved roster is still
  // the only usable row for this provider.
  context.core = { pool: { status: () => ({ lastScanAtMs: 0, scanning: true }) } }
  assert.deepEqual(warming(), ['wtqpool-cn'],
    'a settled runtime whose first account scan is still running remains warming')
  context.core.pool.status = () => ({ lastScanAtMs: Date.now(), scanning: false })
  assert.deepEqual(warming(), [], 'the row is dropped once the account scan has finished')
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

function blockedScanFixture(t, blocked = 'scan') {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-scan-lifecycle-'))
  const auth = path.join(directory, 'auth')
  const data = path.join(directory, 'data')
  const oldData = path.join(directory, 'old-data')
  fs.mkdirSync(auth)
  const authFile = path.join(auth, 'workbuddy-desktop.info')
  const signIn = uin => JSON.stringify({ auth: { accessToken: `fixture-${uin}`, expiresAt: Date.now() + 3600000 }, account: { uin } })
  fs.writeFileSync(authFile, signIn('old'))
  const io = require('node:fs/promises')
  const original = io.readFile
  let release, reached, held = false
  const gate = new Promise(resolve => { release = resolve })
  const waiting = new Promise(resolve => { reached = resolve })
  t.mock.method(io, 'readFile', async (file, ...args) => {
    const answer = await original(file, ...args)
    if (blocked === 'scan' && !held && String(file) === authFile) {
      held = true
      reached()
      await gate
    }
    return answer
  })
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [{ id: 'fixture', name: 'Fixture', contextWindow: 128000, maxTokens: 4096 }])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  const { installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  let settingsReads = 0
  let dataPathReads = 0
  const listeners = new Set()
  const settings = { enabled: true, sourceWorkbuddy: true, sourceTrae: blocked === 'gateway' || blocked === 'close', sourceQoder: false,
    disabledRegions: ['workbuddy:global', 'trae:ai'], authFile, autoCheckin: { enabled: false } }
  installPi({
    getSettings: async () => {
      const snapshot = { ...settings }
      settingsReads += 1
      if (blocked === 'settings' && settingsReads === 2) {
        reached()
        await gate
      }
      if (blocked === 'event-read' && settingsReads === 3) {
        reached()
        await gate
      }
      return snapshot
    },
    setSettings: patch => Object.assign(settings, patch),
    getDataPath: async () => {
      dataPathReads += 1
      if (blocked === 'dataPath' && dataPathReads === 1) {
        reached()
        await gate
        return oldData
      }
      return data
    }, declareProviders: () => ({ ok: true, changed: false }),
    onSettingsChanged: handler => listeners.add(handler), offSettingsChanged: handler => listeners.delete(handler),
  })
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require: specifier => {
    if ((blocked === 'gateway' || blocked === 'close') && (specifier === './trae-gateway' || specifier === './trae-gateway.ts')) return {
      createTraeGateway: () => ({
        ready: blocked === 'gateway' ? (async () => { reached(); await gate })() : Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1/v1', port: () => 1, models: () => [],
        close: async () => {
          if (blocked === 'close' && !held) { held = true; reached(); await gate }
        },
      }),
    }
    return ownRequire(specifier)
  },
    console: { log() {} }, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8'))
    + '\nmodule.exports.__enqueueWrite = enqueueWrite\nmodule.exports.__saveSettings = saveSettings\nmodule.exports.__mutateSettings = mutateSettings\nmodule.exports.__onHostSettingsChanged = onHostSettingsChanged\nmodule.exports.__replaceActivation = (generation, next) => { loadGeneration = generation; serviceStopped = false; settings = next }\nmodule.exports.__settings = () => settings\n', context)
  const plugin = context.module.exports
  const load = plugin.onLoad()
  t.after(async () => {
    release()
    await load.catch(() => {})
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { authFile, data, signIn, settings, listeners, waiting, release, load, plugin, startRegisteredService, stopRegisteredService }
}

test('cancelled sign-in writes leave no sign-in or temporary file', async (t) => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-cancel-write-'))
  const target = path.join(directory, 'signins')
  const signIn = { uin: 'fixture', uid: '', accessToken: 'fixture' }
  try {
    const { writeOwnSignIn } = require('../src/accounts.ts')
    await t.test('before the directory is created', async () => {
      await assert.rejects(writeOwnSignIn(target, signIn, AbortSignal.abort()), { name: 'AbortError' })
      assert.equal(fs.existsSync(target), false)
    })
    await t.test('while the temporary file is being written', async () => {
      const io = require('node:fs/promises')
      const write = io.writeFile
      let release, reached
      const started = new Promise(resolve => { reached = resolve })
      const gate = new Promise(resolve => { release = resolve })
      t.mock.method(io, 'writeFile', async (file, ...args) => {
        reached()
        await gate
        return write(file, ...args)
      })
      const controller = new AbortController()
      const pending = writeOwnSignIn(target, signIn, controller.signal)
      await started
      controller.abort()
      release()
      await assert.rejects(pending, { name: 'AbortError' })
      assert.deepEqual(fs.readdirSync(target), [])
    })
    await t.test('after the atomic commit starts', async () => {
      const io = require('node:fs/promises')
      const rename = io.rename
      let release, reached
      const started = new Promise(resolve => { reached = resolve })
      const gate = new Promise(resolve => { release = resolve })
      t.mock.method(io, 'rename', async (from, to) => {
        reached()
        await gate
        return rename(from, to)
      })
      const controller = new AbortController()
      const pending = writeOwnSignIn(target, signIn, controller.signal)
      await started
      controller.abort()
      release()
      const file = await pending
      assert.deepEqual(fs.readdirSync(target), [path.basename(file)],
        'a completed rename must leave one complete sign-in and no temporary file')
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auth.accessToken, signIn.accessToken)
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('settings writes from a replaced activation cannot reach the new one', async (t) => {
  const fixture = blockedScanFixture(t, 'none')
  await fixture.load
  let releaseQueue
  const gate = new Promise(resolve => { releaseQueue = resolve })
  await fixture.plugin.__replaceActivation(100, { sourceWorkbuddy: true, authFile: '/old' })
  const queued = fixture.plugin.__enqueueWrite(() => gate)
  const saved = fixture.plugin.__saveSettings({ sourceWorkbuddy: false })
  const mutated = fixture.plugin.__mutateSettings('authFile', current => current + '/old')
  await fixture.plugin.__replaceActivation(101, { sourceWorkbuddy: true, authFile: '/new' })
  releaseQueue()
  await queued
  assert.equal(await saved, false)
  assert.equal(await mutated, false)
  assert.deepEqual(fixture.plugin.__settings(), { sourceWorkbuddy: true, authFile: '/new' })
  assert.deepEqual(fixture.settings, { enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global', 'trae:ai'], authFile: fixture.authFile, autoCheckin: { enabled: false } })
})

test('stopping the service retires an in-flight credential scan', async (t) => {
  const fixture = blockedScanFixture(t)
  await fixture.waiting
  await fixture.stopRegisteredService()
  fixture.release()
  await fixture.load
  assert.equal(fs.existsSync(path.join(fixture.data, 'credentials-archive.json')), false,
    'the stopped scan cannot write discovered credentials')
  await fixture.startRegisteredService()
  assert.equal(fs.existsSync(path.join(fixture.data, 'credentials-archive.json')), true,
    'restarting the service must still scan and keep the account')
})

test('reloading the plugin retires the previous credential scan', async (t) => {
  const fixture = blockedScanFixture(t)
  await fixture.waiting
  fs.writeFileSync(fixture.authFile, fixture.signIn('new'))
  await fixture.plugin.onLoad()
  fixture.release()
  await fixture.load
  const archive = JSON.parse(fs.readFileSync(path.join(fixture.data, 'credentials-archive.json'), 'utf8'))
  assert.deepEqual(archive.entries.map(entry => entry.uin), ['new'],
    'a retired activation must not archive its stale account after the replacement')
})

test('a stopped load cannot start a credential scan after reading settings', async (t) => {
  const fixture = blockedScanFixture(t, 'settings')
  await fixture.waiting
  await fixture.stopRegisteredService()
  fixture.release()
  await fixture.load
  assert.equal(fs.existsSync(path.join(fixture.data, 'credentials-archive.json')), false,
    'a retired load cannot restart credential discovery')
})

test('a stopped load cannot start a credential scan after a gateway starts', async (t) => {
  const fixture = blockedScanFixture(t, 'gateway')
  await fixture.waiting
  await fixture.stopRegisteredService()
  fixture.release()
  await fixture.load
  assert.equal(fs.existsSync(path.join(fixture.data, 'credentials-archive.json')), false,
    'a retired load cannot restart credential discovery')
})

test('a replaced load cannot overwrite the new activation settings', async (t) => {
  const fixture = blockedScanFixture(t, 'settings')
  await fixture.waiting
  fixture.settings.sourceWorkbuddy = false
  await fixture.plugin.onLoad()
  fixture.release()
  await fixture.load
  const state = await fixture.plugin.onPanelInvoke('xd.state')
  assert.equal(state.sources.workbuddy, false,
    'a stale settings read cannot switch the source back on')
})

test('a replaced load cannot redirect the new credential pool to its data path', async (t) => {
  const fixture = blockedScanFixture(t, 'dataPath')
  await fixture.waiting
  await fixture.plugin.onLoad()
  fs.rmSync(path.join(fixture.data, 'credentials-archive.json'), { force: true })
  fixture.release()
  await fixture.load
  await fixture.startRegisteredService()
  assert.equal(fs.existsSync(path.join(fixture.data, 'credentials-archive.json')), true)
  assert.equal(fs.existsSync(path.join(fixture.data, '..', 'old-data', 'credentials-archive.json')), false,
    'the old activation cannot repoint the new pool after getDataPath resolves')
})

test('an older unload does not detach the new activation settings listener', async (t) => {
  const fixture = blockedScanFixture(t, 'close')
  await fixture.load
  const unloading = fixture.plugin.onUnload()
  await fixture.waiting
  fixture.settings.sourceTrae = false
  await fixture.plugin.onLoad()
  fixture.release()
  await unloading
  assert.equal(fixture.listeners.size, 1, 'the new activation must still receive host settings edits')
  for (const listener of fixture.listeners) listener({ ...fixture.settings, sourceWorkbuddy: false })
  await fixture.plugin.__enqueueWrite(() => {})
  const state = await fixture.plugin.onPanelInvoke('xd.state')
  assert.equal(state.sources.workbuddy, false)
})

test('a queued settings event from a replaced activation cannot overwrite the new settings', async (t) => {
  const fixture = blockedScanFixture(t, 'none')
  await fixture.load
  let release
  const gate = new Promise(resolve => { release = resolve })
  const held = fixture.plugin.__enqueueWrite(() => gate)
  t.after(() => release())
  for (const listener of fixture.listeners) listener({ ...fixture.settings, sourceWorkbuddy: true })
  fixture.settings.sourceWorkbuddy = false
  const loading = fixture.plugin.onLoad()
  release()
  await loading
  await held
  await fixture.plugin.__enqueueWrite(() => {})
  const state = await fixture.plugin.onPanelInvoke('xd.state')
  assert.equal(state.sources.workbuddy, false, 'the retired event must not switch the source back on')
})

test('a settings read from a replaced event cannot overwrite the new settings', async (t) => {
  const fixture = blockedScanFixture(t, 'event-read')
  await fixture.load
  let releaseWrite, startWrite
  const writeStarted = new Promise(resolve => { startWrite = resolve })
  const held = fixture.plugin.__enqueueWrite(() => new Promise(resolve => { releaseWrite = resolve; startWrite() }))
  await writeStarted
  const saving = fixture.plugin.__saveSettings({ cooldownSeconds: 120 })
  const event = fixture.plugin.__onHostSettingsChanged({ ...fixture.settings, sourceWorkbuddy: true })
  releaseWrite()
  await saving
  await fixture.waiting
  fixture.settings.sourceWorkbuddy = false
  const loading = fixture.plugin.onLoad()
  fixture.release()
  await loading
  await Promise.all([held, event])
  const state = await fixture.plugin.onPanelInvoke('xd.state')
  assert.equal(state.sources.workbuddy, false, 'a stale event read must not replace the new activation settings')
})

test('gateway restarts share a bounded wait for previous ports to close', async (t) => {
  const net = require('node:net')
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = server => new Promise(resolve => server.close(resolve))
  for (const scenario of ['stop', 'parallel', 'newer-close', 'stalled', 'failure', 'starting', 'late', 'stale-failure']) {
    await t.test(scenario, async () => {
      const oldServer = net.createServer()
      await listen(oldServer, 0)
      const preferred = oldServer.address().port
      let release, releaseClose
      const gate = new Promise(resolve => { release = resolve })
      const closeGate = new Promise(resolve => { releaseClose = resolve })
      const previous = { region: 'cn', shim: { close: () => {
        if (scenario === 'failure') throw new Error('close failed')
        return (async () => { await (scenario === 'late' ? closeGate : gate); await close(oldServer) })()
      } } }
      const created = []
      let attempts = 0
      const context = vm.createContext({ module: { exports: {} }, exports: {},
        require: createRequire(path.join(root, 'src/host.ts')), console: { log() {} },
        AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
      context.exports = context.module.exports
      const hooks = `
        module.exports.__ports = {
          setup(previous, create) {
            serviceStopped = false; loadGeneration += 1;
            core.pool = { clear() {} };
            runtimes.set('cn', previous);
            activeRegions = () => ['cn'];
            createRuntime = create;
          },
          stop: onServiceStop,
          start: startRuntimes,
          restart() { serviceStopped = false; loadGeneration += 1 },
          clearRuntimes() { runtimes.clear() },
          refresh() {
            adoptHostSettings = async () => true; applySettingsToCore = () => {};
            poolNeedsScan = false; reconcileTraeGateways = async () => {};
            reconcileQoderGateways = async () => {}; refreshSourceAccounts = async () => {};
            syncDeclaration = () => ({ ok: true }); statusDocument = async () => ({});
            budget = () => ({ left: () => 0, settle: async () => undefined });
            return refreshAll('fixture', true);
          },
          hold(previous) { trackRuntimeStop(previous); runtimes.clear() },
          runtime() { return runtimes.get('cn') },
          failure() { return gatewayStartFailures.get('cn') },
          reserve: reservePort,
        }`
      vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')) + hooks, context)
      const host = context.module.exports.__ports
      host.setup(previous, async () => {
        attempts += 1
        if (['starting', 'late', 'stale-failure'].includes(scenario) && attempts === 1) { await gate; return previous }
        if (scenario === 'stale-failure') throw new Error('new activation bind failed')
        const bound = await host.reserve(preferred)
        const server = net.createServer()
        await listen(server, bound)
        created.push(server)
        return { region: 'cn', port: server.address().port, shim: { close: () => close(server) } }
      })
      let stopping, first, second, deadlineTimer, releaseNewer
      try {
        if (scenario === 'stale-failure') {
          host.clearRuntimes()
          first = host.start()
          stopping = host.stop()
          host.restart()
          second = host.start()
          await second
          assert.equal(host.failure(), 'new activation bind failed')
          release()
          await first
          assert.equal(host.failure(), 'new activation bind failed', 'retiring an old bind must not erase the new failure')
          return
        } else if (scenario === 'late') {
          host.clearRuntimes()
          await host.refresh()
          stopping = host.stop()
          host.restart()
          first = host.start()
          release()
          releaseClose()
        } else if (scenario === 'starting') {
          host.clearRuntimes()
          first = host.start()
          stopping = host.stop()
          host.restart()
          second = host.start()
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(attempts, 1, 'the replacement must wait for the retired start')
          release()
        } else if (scenario === 'parallel') host.hold(previous)
        else { stopping = host.stop(); stopping.catch(() => {}); host.restart() }
        if (scenario === 'newer-close') {
          const newer = new Promise(resolve => { releaseNewer = resolve })
          host.hold({ region: 'cn', shim: { close: () => newer } })
        }
        if (scenario !== 'starting' && scenario !== 'late') first = host.start()
        if (scenario === 'parallel') second = host.start()
        if (scenario === 'stop' || scenario === 'parallel') {
          await new Promise(resolve => setImmediate(resolve))
          assert.equal(attempts, 0, 'the replacement must wait for the previous port to close')
          release()
        }
        if (scenario === 'newer-close') {
          release()
          await stopping
          await new Promise(resolve => setTimeout(resolve, 30))
          assert.equal(attempts, 0, 'an older close cannot erase a later in-flight close')
          releaseNewer()
        }
        await Promise.race([
          Promise.all([first, second]),
          new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error('restart did not finish')), 5000) }),
        ])
        const actual = host.runtime().port
        if (scenario === 'stalled' || scenario === 'failure') assert.notEqual(actual, preferred, 'a failed close must not block startup indefinitely')
        else assert.equal(actual, preferred, 'the old port must be reused when it closes inside the wait budget')
        if (scenario === 'failure') await stopping
      } finally {
        clearTimeout(deadlineTimer)
        release()
        releaseClose()
        releaseNewer?.()
        await Promise.allSettled([stopping, first, second])
        for (const server of created) if (server.listening) await close(server)
        if (oldServer.listening) await close(oldServer)
      }
    })
  }
})

test('a failed bind from a retired refresh cannot mark the new activation as failed', async () => {
  let rejectBind, began
  const started = new Promise(resolve => { began = resolve })
  const context = vm.createContext({ module: { exports: {} }, exports: {},
    require: createRequire(path.join(root, 'src/host.ts')), console: { log() {} },
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
  context.exports = context.module.exports
  const hooks = `
    module.exports.__staleBind = {
      setup(create) {
        serviceStopped = false; loadGeneration += 1;
        core.pool = { clear() {} }; activeRegions = () => ['cn']; createRuntime = create;
        adoptHostSettings = async () => true; applySettingsToCore = () => {};
        poolNeedsScan = false; reconcileTraeGateways = async () => {};
        budget = () => ({ left: () => 1000, settle: async work => await work });
      },
      refresh: () => refreshAll('fixture', true),
      stop: onServiceStop,
      restart() { serviceStopped = false; loadGeneration += 1 },
      failure: () => gatewayStartFailures.get('cn'),
    }`
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')) + hooks, context)
  const host = context.module.exports.__staleBind
  host.setup(() => new Promise((_, reject) => { rejectBind = reject; began() }))
  const refreshing = host.refresh()
  try {
    await started
    await host.stop()
    host.restart()
    rejectBind(new Error('old activation bind failed'))
    await refreshing
    assert.equal(host.failure(), undefined)
  } finally {
    rejectBind?.(new Error('fixture finished'))
    await refreshing.catch(() => {})
  }
})

test('source gateways reuse their ports after a concurrent stop or switch', async (t) => {
  const net = require('node:net')
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = server => new Promise(resolve => server.close(resolve))
  for (const source of ['trae', 'qoder']) {
    for (const reason of source === 'trae' ? ['switch', 'stop', 'stalled'] : ['switch', 'stop', 'failure']) {
      await t.test(`${source} ${reason}`, async () => {
        const oldServer = net.createServer()
        await listen(oldServer, 0)
        const preferred = oldServer.address().port
        let release
        const gate = new Promise(resolve => { release = resolve })
        const previous = { source, region: 'cn', gateway: { close: () => {
          if (reason === 'failure') throw new Error('close failed')
          return (async () => { await gate; await close(oldServer) })()
        } } }
        const created = []
        const context = vm.createContext({ module: { exports: {} }, exports: {},
          require: createRequire(path.join(root, 'src/host.ts')), console: { log() {} },
          AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
        context.exports = context.module.exports
        const hooks = `
          let sourceOn = true;
          module.exports.__sourcePorts = {
            setup(previous, create) {
              serviceStopped = false; loadGeneration += 1;
              core.pool = { clear() {} };
              activeTraeRegions = () => sourceOn && previous.source === 'trae' ? ['cn'] : [];
              activeQoderRegions = () => sourceOn && previous.source === 'qoder' ? ['cn'] : [];
              createTraeRuntime = create; createQoderRuntime = create;
              (previous.source === 'trae' ? traeGateways : qoderGateways).set('cn', previous);
            },
            toggle(on) { sourceOn = on },
            stop: onServiceStop,
            restart() { serviceStopped = false; loadGeneration += 1 },
            reconcile: source => source === 'trae' ? reconcileTraeGateways() : reconcileQoderGateways(),
            entry: source => (source === 'trae' ? traeGateways : qoderGateways).get('cn'),
            reserve: reservePort,
          }`
        vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')) + hooks, context)
        const host = context.module.exports.__sourcePorts
        host.setup(previous, async () => {
          const bound = await host.reserve(preferred)
          const server = net.createServer()
          await listen(server, bound)
          created.push(server)
          return { source, region: 'cn', baseUrl: `http://127.0.0.1:${server.address().port}`,
            gateway: { close: () => close(server) } }
        })
        let stopping, starting, deadline
        try {
          if (reason === 'switch') {
            host.toggle(false)
            stopping = host.reconcile(source)
            host.toggle(true)
          } else {
            stopping = host.stop()
            host.restart()
          }
          starting = host.reconcile(source)
          if (reason === 'stalled' || reason === 'failure') {
            await Promise.race([starting, new Promise((_, reject) => {
              deadline = setTimeout(() => reject(new Error('restart did not finish')), 5000)
            })])
            assert.notEqual(new URL(host.entry(source).baseUrl).port, String(preferred),
              'a stuck close must eventually permit a temporary port')
            release()
            await stopping
          } else {
            await new Promise(resolve => setImmediate(resolve))
            release()
            await Promise.all([stopping, starting])
            assert.equal(new URL(host.entry(source).baseUrl).port, String(preferred),
              'the released preferred port must be reused')
          }
        } finally {
          clearTimeout(deadline)
          release()
          await Promise.allSettled([stopping, starting])
          for (const server of created) if (server.listening) await close(server)
          if (oldServer.listening) await close(oldServer)
        }
      })
    }
  }
})

test('a source gateway still starting is retired before its replacement', async (t) => {
  const net = require('node:net')
  const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const close = server => new Promise(resolve => server.close(resolve))
  for (const source of ['trae', 'qoder']) {
    for (const reason of ['switch', 'stop']) {
    await t.test(`${source} ${reason}`, async () => {
      const preferred = await new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
          const port = probe.address().port
          probe.close(() => resolve(port))
        })
      })
      let releaseCreate, createdFirst, startedClose, releaseClose
      const createGate = new Promise(resolve => { releaseCreate = resolve })
      const closeGate = new Promise(resolve => { releaseClose = resolve })
      const ready = new Promise(resolve => { createdFirst = resolve })
      const closing = new Promise(resolve => { startedClose = resolve })
      let created = 0
      const servers = []
      const context = vm.createContext({ module: { exports: {} }, exports: {},
        require: createRequire(path.join(root, 'src/host.ts')), console: { log() {} },
        AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
      context.exports = context.module.exports
      const hooks = `
        let sourceOn = true;
        module.exports.__unfinishedSource = {
          setup(create) {
            serviceStopped = false; loadGeneration += 1;
            core.pool = { clear() {} };
            activeTraeRegions = () => sourceOn && '${source}' === 'trae' ? ['cn'] : [];
            activeQoderRegions = () => sourceOn && '${source}' === 'qoder' ? ['cn'] : [];
            createTraeRuntime = create; createQoderRuntime = create;
          },
          toggle(on) { sourceOn = on },
          stop: onServiceStop,
          restart() { serviceStopped = false; loadGeneration += 1 },
          reconcile: source => source === 'trae' ? reconcileTraeGateways() : reconcileQoderGateways(),
          entry: source => (source === 'trae' ? traeGateways : qoderGateways).get('cn'),
          reserve: reservePort,
        }`
      vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')) + hooks, context)
      const host = context.module.exports.__unfinishedSource
      host.setup(async () => {
        created += 1
        const firstAttempt = created === 1
        const bound = await host.reserve(preferred)
        const server = net.createServer()
        await listen(server, bound)
        servers.push(server)
        if (firstAttempt) {
          createdFirst()
          await createGate
        }
        return { source, region: 'cn', baseUrl: `http://127.0.0.1:${server.address().port}`,
          gateway: { close: async () => { if (firstAttempt) { startedClose(); await closeGate } await close(server) } } }
      })
      let first, second, third, stopping
      try {
        first = host.reconcile(source)
        await ready
        if (reason === 'switch') {
          second = host.reconcile(source)
          third = host.reconcile(source)
          await new Promise(resolve => setImmediate(resolve))
          host.toggle(false)
          releaseCreate()
          await closing
          host.toggle(true)
          releaseClose()
        } else {
          stopping = host.stop()
          host.restart()
          releaseClose()
          second = host.reconcile(source)
          await new Promise(resolve => setImmediate(resolve))
          releaseCreate()
        }
        await Promise.all([first, second, third, stopping])
        assert.ok(host.entry(source), 're-enabling must leave a live gateway after the first start was retired')
        assert.equal(created, 2, 'the joined reconcile must retry after the retired start closes')
        assert.equal(new URL(host.entry(source).baseUrl).port, String(preferred), 'the replacement must reuse the released port')
      } finally {
        releaseCreate()
        releaseClose()
        await Promise.allSettled([first, second, third, stopping])
        for (const server of servers) if (server.listening) await close(server)
      }
    })
    }
  }
})

test('a region disabled while another start waits does not block the remaining region', async (t) => {
  for (const source of ['trae', 'qoder']) {
    await t.test(source, async () => {
      let release
      const gate = new Promise(resolve => { release = resolve })
      const previous = { source, region: 'cn', gateway: { close: () => gate } }
      const context = vm.createContext({ module: { exports: {} }, exports: {},
        require: createRequire(path.join(root, 'src/host.ts')), console: { log() {} },
        AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval })
      context.exports = context.module.exports
      const hooks = `
        let active = [];
        module.exports.__sourceRegions = {
          setup(previous) {
            serviceStopped = false; loadGeneration += 1;
            activeTraeRegions = () => previous.source === 'trae' ? active : [];
            activeQoderRegions = () => previous.source === 'qoder' ? active : [];
            const create = async region => ({ source: previous.source, region, gateway: { close: async () => {} } });
            createTraeRuntime = create; createQoderRuntime = create;
            (previous.source === 'trae' ? traeGateways : qoderGateways).set('cn', previous);
          },
          active(value) { active = value },
          reconcile: source => source === 'trae' ? reconcileTraeGateways() : reconcileQoderGateways(),
          entry: source => (source === 'trae' ? traeGateways : qoderGateways).get('global'),
        }`
      vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')) + hooks, context)
      const host = context.module.exports.__sourceRegions
      host.setup(previous)
      let stopping, starting
      try {
        stopping = host.reconcile(source)
        host.active(['cn', 'global'])
        starting = host.reconcile(source)
        host.active(['global'])
        release()
        await Promise.all([stopping, starting])
        assert.ok(host.entry(source), 'the still-enabled region must start')
      } finally {
        release()
        await Promise.allSettled([stopping, starting])
      }
    })
  }
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

/**
 * A source label does not depend on which other regions are switched on.
 *
 * Labels are the row key for holds, pack expiry and the panel's account state.
 * Computing them after the region filter renamed the surviving account whenever
 * another region was disabled: the duplicate suffix appeared or vanished with a
 * setting that says nothing about this account.
 */
test('Discovering source labels ignores the enabled-region filter', async () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const match = source.match(/^async function refreshSourceAccounts\([^]*?^}$/m)
  assert.ok(match, 'refreshSourceAccounts must exist')
  const fn = transpile(match[0])
  const { uniqueSourceLabels } = require('../src/source-pool.ts')
  const { traeRegionOfCredential } = require('../src/trae-discovery.ts')
  const credentials = [
    { userId: 'user-cn', accountName: 'Same Name', edition: 'cn', source: 'desktop', expiresAtMs: 0 },
    { userId: 'user-ai', accountName: 'Same Name', edition: 'sg', source: 'desktop', expiresAtMs: 0 },
  ]
  const run = async (regions) => {
    const context = vm.createContext({
      activeTraeRegions: () => regions,
      activeQoderRegions: () => [],
      discoverTraeCredentials: async () => ({ credentials: credentials.map((item) => ({ ...item })), failures: [] }),
      discoverQoderCredentials: async () => ({ credentials: [], failures: [] }),
      uniqueSourceLabels,
      traeRegionOfCredential,
      traeBaseLabel: (credential) => credential.accountName ?? credential.userId,
      traeLabelKey: (credential) => traeRegionOfCredential(credential) + '\n' + credential.userId,
      traeAppLabelOf: () => 'Trae',
      traeRowProbe: async () => undefined,
      noteSourceExpiry() {},
      sourceCredentialExpired: () => false,
      regionEnabled: () => true,
      log() {},
      safeMessage: (error) => String(error),
      loadGeneration: 1,
      traeAccountRows: [],
      traeLabelOverrides: new Map(),
      qoderAccountRows: [],
      qoderLabelOverrides: new Map(),
      pruneSourceState() {},
    })
    vm.runInContext(fn, context)
    await context.refreshSourceAccounts(1)
    return context.traeAccountRows.filter((row) => row.region === 'cn')
  }
  const both = (await run(['cn', 'ai'])).find((row) => row.region === 'cn')
  const cnOnly = await run(['cn'])
  assert.ok(both)
  assert.equal(cnOnly.length, 1)
  assert.equal(cnOnly[0].label, both.label,
    'switching the other region off must not rename this account')
  assert.match(cnOnly[0].label, /#usercn$/u, 'the duplicate suffix is what keeps the two rows apart')
})

/**
 * A failing model roster is retried a bounded number of times per gateway.
 *
 * The previous chain re-armed itself every retry, and each retry triggered a
 * refresh pass whose failures started the chain from attempt one again. A
 * gateway stuck on a bad sign-in therefore retried without end.
 */
test('A failing model roster retries per gateway and stops at the attempt cap', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const body = transpile(sourceFunction(source, 'scheduleModelRetries') + '\n' + sourceFunction(source, 'clearModelRetries'))
  const timers = []
  let refreshes = 0
  const runtime = { retired: false, catalogRetryAttempt: 0, catalogRetryTimer: null }
  const context = vm.createContext({
    serviceStopped: false,
    MODEL_RETRY_ATTEMPTS: 4,
    CATALOG_RETRY_MS: 15,
    runtimes: new Map([['cn', runtime]]),
    modelRetryTimers: new Set(),
    scheduleRefresh: () => { refreshes += 1 },
    setTimeout: (callback) => { const timer = { callback }; timers.push(timer); return timer },
    clearTimeout() {},
  })
  vm.runInContext(body, context)
  context.scheduleModelRetries(runtime)
  context.scheduleModelRetries(runtime)
  assert.equal(timers.length, 1, 'a second failing pass must not arm a second timer for the same gateway')
  let fired = 0
  while (timers.length > 0 && fired < 10) {
    timers.shift().callback()
    fired += 1
    // The pass this retry triggered fails the same way and asks again.
    context.scheduleModelRetries(runtime)
  }
  assert.equal(fired, 4, 'the initial read plus three retries, then the gateway stops retrying')
  assert.equal(refreshes, 4, 'every retry runs exactly one pass')
})

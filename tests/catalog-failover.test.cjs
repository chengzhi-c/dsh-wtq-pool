const { transpile } = require('./ts-loader.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
const { WorkBuddyCatalog } = require('../src/catalog.ts')
const { QoderUpstreamClient } = require('../src/qoder-client.ts')
const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
const { createQoderGateway } = require('../src/qoder-gateway.ts')
const { createTraeGateway } = require('../src/trae-gateway.ts')

function requestModels(url, force = false) {
  let sent
  const sentPromise = new Promise(resolve => { sent = resolve })
  const response = new Promise((resolve, reject) => {
    const request = http.get(url, {
      headers: force ? { 'Cache-Control': 'no-cache' } : {},
    }, answer => {
      let body = ''
      answer.setEncoding('utf8')
      answer.on('data', chunk => { body += chunk })
      answer.on('end', () => resolve(JSON.parse(body)))
    })
    request.once('error', reject)
    request.once('finish', sent)
  })
  return { response, sent: sentPromise }
}

test('WorkBuddy reads the live model directory after the first sign-in times out', async () => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-catalog-'))
  const authDirs = ['expired', 'healthy'].map((name) => {
    const dir = path.join(temporary, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'login.info'), JSON.stringify({
      auth: { accessToken: name, expiresAt: Date.now() + 3600000 }, account: { uin: name },
    }))
    return dir
  })
  let timedOutToken
  let requests = 0
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (_url, options) => {
    requests++
    if (options.headers.Authorization === 'Bearer ' + timedOutToken) {
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }
    return Response.json({ code: 0, data: { models: [{
      id: 'live-model', name: 'Live model', maxInputTokens: 128000, maxOutputTokens: 8192,
    }] } })
  } })
  const pool = new WorkBuddyAccountPool({ authDirs, cooldownMs: 60000, client })
  try {
    await pool.scan()
    timedOutToken = pool.list('cn')[0].credential.accessToken
    const entry = path.resolve(__dirname, '../src/host.ts')
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const context = vm.createContext({
      require: createRequire(entry), module: { exports: {} }, __dirname: temporary,
      console: { log() {} }, AbortController, AbortSignal: { timeout: () => timeout(5) }, fetch,
      setTimeout, clearTimeout, setInterval, clearInterval,
    })
    context.exports = context.module.exports
    vm.runInContext(transpile(fs.readFileSync(entry, 'utf8')), context)
    context.testPool = pool
    context.testClient = client
    vm.runInContext('core.pool = testPool; core.client = testClient', context)
    const runtime = { region: 'cn', catalog: new WorkBuddyCatalog(), catalogRetryAttempt: 0 }
    await context.connect(runtime, true)
    assert.equal(runtime.catalog.hasLiveRoster(), true, runtime.lastWarning)
    assert.deepEqual(runtime.catalog.current().map(model => model.id), ['live-model'])
    assert.equal(runtime.lastWarning, '')
    assert.equal(requests, 2, 'the timeout applies to one sign-in, not the whole rotation')
    requests = 0
    pool.applyConfig({ disabledAccountIds: pool.list('cn').map(account => account.id) })
    await context.connect(runtime, true)
    assert.equal(requests, 0, 'disabled sign-ins do not read the directory')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('Qoder account totals include every dedicated resource package', async (t) => {
  t.mock.method(QoderUpstreamClient.prototype, 'fetchUsage', async () => ({
    dedicatedPackages: [1, 2, 3, 4].map(index => ({ name: 'Pack ' + index, total: 10, remaining: 10 })),
  }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchCampaigns', async () => ({ campaigns: [] }))
  const entry = path.resolve(__dirname, '../src/host.ts')
  const context = vm.createContext({
    require: createRequire(entry), module: { exports: {} }, __dirname,
    console: { log() {} }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
    vm.runInContext(transpile(fs.readFileSync(entry, 'utf8')), context)
  const row = await context.qoderRowProbe({ region: 'cn', userID: 'fixture', token: 'fixture', name: '', email: '' })
  assert.equal(row.usage.credits.total, 40)
  assert.equal(row.usage.credits.packages.length, 4)
})

for (const source of ['trae', 'qoder']) test(`${source} manual model refresh bypasses the directory cache`, async (t) => {
  let id = 'old-model'
  const client = source === 'trae' ? TraeSoloUpstreamClient : QoderUpstreamClient
  t.mock.method(client.prototype, 'fetchModels', async () => {
    if (id === 'unavailable') throw new Error('HTTP 401: session expired; access_token=fixture-private-token')
    const models = [{ id, name: id, function: 'chat_v3' }]
    return source === 'trae' ? { models, partial: false } : models
  })
  const gateway = source === 'trae'
    ? createTraeGateway({ credentials: async () => [{ accessToken: 'fixture' }], identity: async () => ({}) })
    : createQoderGateway({ region: 'cn', credentials: async () => [{ userID: 'fixture', token: 'fixture' }] })
  try {
    await gateway.ready
    const entry = path.resolve(__dirname, '../src/host.ts')
    const context = vm.createContext({
      require: createRequire(entry), module: { exports: {} }, __dirname,
      console: { log() {} }, AbortController, AbortSignal, fetch,
      setTimeout, clearTimeout, setInterval, clearInterval,
    })
    context.exports = context.module.exports
    vm.runInContext(transpile(fs.readFileSync(entry, 'utf8')), context)
    const runtime = { source, region: 'cn', gateway, baseUrl: gateway.baseUrl() }
    id = 'unavailable'
    await context.warmSourceDirectory(runtime)
    assert.match(runtime.lastError, /session expired/)
    assert.doesNotMatch(runtime.lastError, /fixture-private-token/)
    id = 'old-model'
    await context.warmSourceDirectory(runtime, undefined, true)
    assert.equal(runtime.lastError, '')
    await context.warmSourceDirectory(runtime)
    assert.equal(gateway.models()[0].id, 'old-model')
    id = 'unavailable'
    assert.equal(await context.warmSourceDirectory(runtime, undefined, true), false)
    assert.match(runtime.lastError, /session expired/)
    assert.doesNotMatch(runtime.lastError, /fixture-private-token/)
    const cached = await fetch(gateway.baseUrl() + '/v1/models')
    assert.equal(cached.status, 200)
    assert.equal((await cached.json()).data[0].id, 'old-model')
    id = 'new-model'
    await context.warmSourceDirectory(runtime, undefined, true)
    assert.equal(gateway.models()[0].id, 'new-model')
  } finally {
    await gateway.close()
  }
})
for (const source of ['trae', 'qoder']) test(`${source} manual refresh does not reuse an ordinary directory read`, async (t) => {
  let finishFirst
  let reads = 0
  let started
  const firstStarted = new Promise(resolve => { started = resolve })
  const client = source === 'trae' ? TraeSoloUpstreamClient : QoderUpstreamClient
  t.mock.method(client.prototype, 'fetchModels', async () => {
    reads += 1
    const id = reads === 1 ? 'old-model' : 'new-model'
    const models = [{ id, name: id, function: 'chat_v3' }]
    if (reads === 1) {
      started()
      await new Promise(resolve => { finishFirst = resolve })
    }
    return source === 'trae' ? { models, partial: false } : models
  })
  const gateway = source === 'trae'
    ? createTraeGateway({ credentials: async () => [{ accessToken: 'fixture' }], identity: async () => ({}) })
    : createQoderGateway({ region: 'cn', credentials: async () => [{ userID: 'fixture', token: 'fixture' }] })
  try {
    await gateway.ready
    const ordinary = requestModels(gateway.baseUrl() + '/v1/models')
    await firstStarted
    const forced = requestModels(gateway.baseUrl() + '/v1/models', true)
    await forced.sent
    await new Promise(resolve => setImmediate(resolve))
    finishFirst()
    const bodies = await Promise.all([ordinary.response, forced.response])
    const ids = bodies.map(body => body.data[0].id)
    assert.deepEqual(ids, ['old-model', 'new-model'])
    assert.equal(reads, 2)
    assert.equal(gateway.models()[0].id, 'new-model')
  } finally {
    await gateway.close()
  }
})

for (const source of ['trae', 'qoder']) test(`${source} composer refresh preserves new balances and lets both account rosters update`, async (t) => {
  const credential = name => ({ region: 'cn', edition: 'cn', source: 'desktop', userId: name, userID: name, accountName: name, name })
  const abroad = { ...credential('existing'), region: 'global', edition: 'sg', userId: 'overseas', userID: 'overseas' }
  let credentials
  const discover = async () => ({ credentials, failures: [] })
  t.mock.method(require('../src/trae-discovery.ts'), 'discoverTraeCredentials', discover)
  t.mock.method(require('../src/qoder-credentials.ts'), 'discoverQoderCredentials', discover)
  const entry = path.resolve(__dirname, '../src/host.ts')
  const context = vm.createContext({
    require: createRequire(entry), module: { exports: {} }, __dirname,
    console: { log() {} }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(entry, 'utf8')), context)
  vm.runInContext('loadGeneration = 1', context)
  context.delay = async () => {}
  const other = source === 'trae' ? 'qoder' : 'trae'
  const probe = total => ({ usage: { credits: { total, packages: [{ remain: total, expiresAtMs: Date.now() + total * 1000 }] } } })
  const balances = source => Object.fromEntries(vm.runInContext(source + 'AccountRows', context).map(row => [row.label, row.usage.credits.total]))
  for (const order of [[0, 1], [1, 0]]) {
    credentials = [credential('existing'), abroad]
    vm.runInContext('settings.disabledRegions = []', context)
    context.traeRowProbe = context.qoderRowProbe = async () => probe(3)
    await context.refreshSourceAccounts(1)
    assert.deepEqual(balances(source), { 'existing#existing': 3, 'existing#overseas': 3 })
    credentials.push(credential('added'))
    vm.runInContext('settings.disabledRegions = ["trae:ai", "qoder:global"]', context)
    const release = []
    context[source + 'RowProbe'] = item => item.name === 'added' ? Promise.resolve(probe(8)) : new Promise(resolve => release.push(resolve))
    context[other + 'RowProbe'] = async () => probe(11)
    const work = [context.refreshSourceAccounts(1)]
    await new Promise(resolve => setImmediate(resolve))
    work.push(context.composerRefreshWork({ source, region: 'cn' }))
    await new Promise(resolve => setImmediate(resolve))
    for (const index of order) { release[index](probe(index === 0 ? 1 : 42)); await work[index] }
    assert.deepEqual(balances(source), { 'existing#existing': 42, added: 8 })
    assert.deepEqual(balances(other), { 'existing#existing': 11, added: 11 })
    const row = vm.runInContext(source + 'AccountRows', context)[0]
    assert.equal(vm.runInContext(`sourceCreditExpiry.get(accountStateKey('${source}', 'cn', '${row.id}'))`, context), row.usage.credits.packages[0].expiresAtMs)
    const refreshing = context.composerRefreshWork({ source, region: 'cn' })
    await new Promise(resolve => setImmediate(resolve))
    context.markSourceCheckinRow(source, row.id, row.region, { outcome: 'claimed' })
    release[2]({ ...probe(1), checkin: { todayCheckedIn: false } })
    await refreshing
    assert.equal(row.checkin.todayCheckedIn, true, 'a read started before the claim cannot restore the unclaimed status')
  }
})
for (const source of ['trae', 'qoder']) test(`${source} closing the gateway cancels its directory requests`, async () => {
  const signals = [], pending = []
  let started, cleaning = false
  const firstStarted = new Promise(resolve => { started = resolve })
  const fetchImpl = async (_url, { signal }) => {
    if (cleaning) throw new Error('test cleanup')
    signals.push(signal)
    signal.throwIfAborted()
    started()
    return new Promise((_, reject) => {
      const fail = () => reject(signal.reason)
      signal.addEventListener('abort', fail, { once: true })
      pending.push(() => { signal.removeEventListener('abort', fail); reject(new Error('test cleanup')) })
    })
  }
  const gateway = source === 'trae'
    ? createTraeGateway({ fetchImpl,
      credentials: async () => ['first', 'second'].map(userId => ({ userId, accessToken: 'fixture', edition: 'cn', source: 'desktop' })),
      identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }),
    })
    : createQoderGateway({ fetchImpl, region: 'cn',
      credentials: async () => ['first', 'second'].map(userID => ({ userID, token: 'fixture' })),
    })
  let request
  try {
    await gateway.ready
    request = requestModels(gateway.baseUrl() + '/v1/models').response.catch(() => {})
    await firstStarted
    const count = signals.length
    await gateway.close()
    assert.ok(signals.every(signal => signal.aborted), 'no upstream request may outlive its gateway')
    await new Promise(setImmediate)
    assert.equal(signals.length, count, 'closing must not start a directory read with another account')
  } finally {
    cleaning = true
    for (const release of pending) release()
    await gateway.close()
    await request
  }
})

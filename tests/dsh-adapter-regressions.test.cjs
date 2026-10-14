const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { createServer, request } = require('node:http')
const ts = require('typescript')
const { SettingsForms } = require('@deepseek-ai/dsh-settings')
const { WebServer } = require('@deepseek-ai/dsh-host-webserver')

const root = path.resolve(__dirname, '..')
const json = value => JSON.parse(JSON.stringify(value))
const sourceOf = file => fs.readFileSync(path.join(root, file), 'utf8')
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

function loadSource(file, overrides = {}, globals = {}) {
  const ownRequire = createRequire(path.join(root, file))
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, URL, Buffer, console, ...globals,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : ownRequire(name) })
  vm.runInContext(transpile(sourceOf(file)), context, { filename: file })
  return module.exports
}

function indexFixture() {
  // Run the actual activation and its helpers without starting desktop discovery or gateways.
  const file = ts.createSourceFile('index.ts', sourceOf('src/index.ts'), ts.ScriptTarget.Latest, true)
  const functions = new Set(['unwrapVolatile', 'unwrapVolatileDeep', 'settingsNamespaceOf', 'registrationFingerprint', 'apply'])
  const selected = file.statements.filter(node =>
    ts.isFunctionDeclaration(node) && functions.has(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(row => row.name.getText(file) === 'lastRows'))
  let installing
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, console, FALLBACK_SETTINGS_NS: 'fixture',
    installPi: bridge => { installing.bridge = bridge },
    buildAdapter: rows => ({ adapter: {}, providerIds: rows.map(row => row.id) }),
    onLoad: async () => {}, onUnload: async () => {},
    startRegisteredService: async () => {}, stopRegisteredService: async () => {},
    registerPanelRoutes() {},
  })
  vm.runInContext(transpile(selected.map(node => node.getText(file)).join('\n')), context)
  return (settings = {}, config = {}, fiber = { entry: { options: { id: 'fixture' } } }) => {
    const effects = []
    const volatileListeners = []
    const state = { fail: null, adapters: 0, providers: 0, bridge: null, discovery: null, volatileListeners }
    installing = state
    module.exports.apply({
      settings, logger: { info() {}, warn() {}, error() {} }, get: () => undefined,
      fiber,
      // `loader/volatile-update` is captured because DSH answers a plugin's own
      // volatile write by emitting it straight back at that plugin's fiber, and
      // a test has to be able to reproduce that echo.
      on(name, listener) {
        if (name === 'loader/volatile-update') volatileListeners.push(listener)
        return () => {
          const index = volatileListeners.indexOf(listener)
          if (index >= 0) volatileListeners.splice(index, 1)
        }
      },
      effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose) },
      inject() {}, emit() {},
      llm: {
        registerAdapter() {
          if (state.fail === 'adapter') throw new Error('fixture adapter registration failure')
          state.adapters += 1
          return () => { state.adapters -= 1 }
        },
        registerConfigurableProviders() {
          if (state.fail === 'rows') throw new Error('fixture provider registration failure')
          state.providers += 1
          return () => { state.providers -= 1 }
        },
        registerModelDiscovery(_ns, callback) { state.discovery = callback; return () => {} },
      },
    }, config)
    state.dispose = async () => { for (const dispose of effects.splice(0).reverse()) await dispose() }
    return state
  }
}

test('DSH settings replace patched dictionaries, preserve other settings, and survive reload', async () => {
  const untouched = { enabled: false, sourceTrae: false, showComposerPoints: true,
    autoCheckin: { enabled: false, hours: [9] }, sourceDistributions: { trae: 'priority' } }
  const otherPlugin = { secret: 'fixture-only', preference: { keep: true } }
  let persisted = { fixture: json(untouched), other: json(otherPlugin) }
  const config = {}
  const sync = () => {
    for (const key of Object.keys(config)) delete config[key]
    for (const key of Object.keys(persisted.fixture)) config[key] = { get: () => persisted.fixture[key] }
  }
  sync()
  const settings = {
    // Keep the SDK's recursive update and path mutation, mocking only its persistence seam.
    update: SettingsForms.prototype.update,
    mutate: SettingsForms.prototype.mutate,
    async write(ns, change) {
      assert.equal(ns, 'fixture')
      persisted[ns] = json(change(persisted[ns], {}, {}))
      persisted = json(persisted)
      sync()
    },
  }
  const activate = indexFixture()
  const state = activate(settings, config)
  const filled = {
    creditReserves: { 'fixture-a': 100, 'fixture-b': 200 },
    preferredAccountIds: { cn: 'fixture-a', global: 'fixture-b' },
    preferredSourceAccounts: { 'trae:cn': 'fixture-a', 'qoder:global': 'fixture-b' },
    modelSelection: { cn: { listedIds: ['m'], overrides: { m: { alias: 'custom', contextWindow: 8192 } } },
      global: { overrides: { stale: { alias: 'remove-me' } } } },
  }
  const cleared = { creditReserves: {}, preferredAccountIds: {}, preferredSourceAccounts: {},
    modelSelection: { cn: { listedIds: ['m'], overrides: {} } } }
  try {
    await state.bridge.setSettings(filled)
    assert.deepEqual(persisted.fixture, { ...untouched, ...filled })
    assert.deepEqual(json(await state.bridge.getSettings()), persisted.fixture)
    await state.bridge.setSettings(cleared)
    assert.deepEqual(persisted.fixture, { ...untouched, ...cleared })
    assert.deepEqual(json(await state.bridge.getSettings()), persisted.fixture)
    assert.deepEqual(persisted.other, otherPlugin)
    await state.dispose()
    const reloaded = activate(settings, json(persisted.fixture))
    try { assert.deepEqual(json(await reloaded.bridge.getSettings()), { ...untouched, ...cleared }) }
    finally { await reloaded.dispose() }
  } finally { await state.dispose() }
})

test('settings writes carry options.id, the name the settings service resolves entries by', async () => {
  // A bundled entry has a longer canonical id (`include:<id>`) while the
  // settings service still looks the entry up by `options.id`. Preferring the
  // canonical id made every write fail with `No configurable plugin entry`.
  const namespaces = []
  const settings = {
    update: SettingsForms.prototype.update,
    mutate: SettingsForms.prototype.mutate,
    async write(ns, change) { namespaces.push(ns); change({}, {}, {}) },
  }
  const activate = indexFixture()
  const state = activate(settings, {}, { entry: { id: 'include:fixture', options: { id: 'fixture' } } })
  try {
    await state.bridge.setSettings({ showComposerPoints: true })
  } finally { await state.dispose() }
  assert.deepEqual(namespaces, ['fixture'])
})

async function composerFixture(documents) {
  const effects = [], cleanups = [], states = [], timers = new Map(), calls = []
  let now = 0, nextTimer = 0
  const React = {
    useRef: value => ({ current: value }),
    useState(value) { const index = states.push(value) - 1; return [value, next => { states[index] = next }] },
    useEffect: callback => effects.push(callback), createElement: () => null,
  }
  const { ComposerPoints } = loadSource('src/client/composer.tsx', { react: React }, {
    Date: class extends Date { static now() { return now } },
    AbortSignal,
    window: {
      setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id },
      clearTimeout: id => timers.delete(id),
    },
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ result: documents[Math.min(calls.length - 1, documents.length - 1)] }) }
    },
  })
  ComposerPoints({ useProjection: () => ({ next: { provider: 'fixture-p', model: 'fixture-m' } }) })
  for (const effect of effects) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
  const flush = () => new Promise(resolve => setImmediate(resolve))
  await flush()
  return { states, timers, calls,
    async tick(elapsed) {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      now += elapsed ?? timer.ms
      timer.callback()
      await flush()
    },
    dispose() { for (const cleanup of cleanups) cleanup() },
  }
}

test('composer polls a hidden plugin roster after five seconds, then settles on a balance', async () => {
  const visible = { show: true, ours: true, total: 42, accounts: [] }
  const fixture = await composerFixture([{ show: false, ours: true }, { show: false, ours: true }, visible])
  try {
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [5000])
    assert.equal(fixture.states[0], null, 'the hidden document must not be displayed')
    await fixture.tick()
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [5000])
    await fixture.tick()
    assert.deepEqual(json(fixture.states[0]), visible)
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [300000])
    assert.equal(fixture.calls.length, 3)
    assert.deepEqual(fixture.calls[0], { channel: 'xd.composerPoints', payload: { provider: 'fixture-p', model: 'fixture-m' } })
  } finally { fixture.dispose() }
  assert.equal(fixture.timers.size, 0)
})

test('composer uses the long polling interval for a non-plugin model', async () => {
  const fixture = await composerFixture([{ show: false, ours: false }])
  try {
    assert.equal(fixture.states[0], null)
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [300000])
    await fixture.tick()
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [300000])
  } finally { fixture.dispose() }
})

test('composer limits hidden-roster warmup to its startup window', async () => {
  const fixture = await composerFixture([{ show: false, ours: true }])
  try {
    await fixture.tick(120000)
    assert.equal(fixture.states[0], null)
    assert.deepEqual([...fixture.timers.values()].map(timer => timer.ms), [300000])
  } finally { fixture.dispose() }
})

function panelFixture() {
  const loopback = loadSource('src/loopback.ts')
  const { registerPanelRoutes, PANEL_BASE } = loadSource('src/web-panel.ts', { './loopback.ts': loopback,
    './panel-route.ts': loadSource('src/panel-route.ts') })
  const ledger = { exact: new Map(), prefixes: new Map() }, calls = []
  let dispose
  let enabled = true
  registerPanelRoutes({ webServer: { register: route => WebServer.prototype.register.call(ledger, route) } }, {
    pluginRoot: root, logger: { warn() {} }, effect: callback => { dispose = callback() },
    invoke: async (channel, payload) => {
      calls.push({ channel, payload })
      if (channel === 'xd.setSource') enabled = payload.enabled
      return { enabled }
    },
  })
  return { base: PANEL_BASE, calls, dispose,
    route: pathname => WebServer.prototype.match.call(ledger, pathname),
    async send(suffix, { address = '127.0.0.1', headers = {}, body } = {}) {
      const req = new EventEmitter()
      Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: PANEL_BASE + suffix,
        headers: { host: 'localhost:3000', 'content-type': 'application/json', ...headers },
        socket: { remoteAddress: address === null ? undefined : address } })
      const res = { status: undefined, body: '', writeHead(status) { this.status = status },
        end(chunk) { this.body = chunk === undefined ? '' : String(chunk) } }
      const pending = this.route(PANEL_BASE + suffix).handler(req, res)
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
      await pending
      return res
    },
  }
}

test('all panel resources and RPC reject remote peers even with absent or forged local headers', async () => {
  const fixture = panelFixture()
  const routes = [
    ['/invoke', { channel: 'xd.setSource', payload: { source: 'workbuddy', enabled: false } }],
    ['/invoke', { channel: 'xd.state' }], ['/invoke', { channel: 'app.getAppearance' }],
    ['/panel'], ['/panel.css'], ['/panel.js'],
  ]
  try {
    for (const address of ['192.0.2.20', '::ffff:192.0.2.20', '::ffff:c000:214', '2001:db8::20', null]) {
      for (const headers of [{}, { origin: 'http://localhost:3000', 'x-forwarded-for': '127.0.0.1' }]) {
        for (const [suffix, body] of routes) {
          const res = await fixture.send(suffix, { address, headers, body })
          assert.equal(res.status, 403, `${address} must not reach ${suffix}/${body?.channel ?? 'asset'}`)
        }
      }
    }
    assert.deepEqual(fixture.calls, [], 'remote requests must never reach the pool')
  } finally { fixture.dispose() }
})

test('loopback IPv4, IPv6 and mapped peers can read assets and state and mutate the pool', async () => {
  const fixture = panelFixture()
  try {
    for (const address of ['127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
      for (const suffix of ['/panel', '/panel.css', '/panel.js']) {
        assert.equal((await fixture.send(suffix, { address })).status, 200, `${address}/${suffix}`)
      }
      const written = await fixture.send('/invoke', { address, headers: { origin: 'http://localhost:3000',
        'x-forwarded-for': '192.0.2.20' }, body: { channel: 'xd.setSource', payload: { enabled: false } } })
      assert.equal(written.status, 200)
      const read = await fixture.send('/invoke', { address, body: { channel: 'xd.state' } })
      assert.equal(read.status, 200)
      assert.deepEqual(JSON.parse(read.body), { result: { enabled: false } })
    }
    const before = fixture.calls.length
    const hostile = await fixture.send('/invoke', { headers: { origin: 'https://remote.example' },
      body: { channel: 'xd.setSource', payload: { enabled: true } } })
    assert.equal(hostile.status, 403, 'a local peer must still pass the Origin guard')
    assert.equal(fixture.calls.length, before)
  } finally { fixture.dispose() }
})

test('a local host iframe keeps working when the HTTP server binds all IPv4 interfaces', async () => {
  const fixture = panelFixture()
  const server = createServer((req, res) => {
    const route = fixture.route(new URL(req.url, 'http://localhost').pathname)
    if (!route) { res.writeHead(404); res.end(); return }
    route.handler(req, res)
  })
  try {
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve))
    const port = server.address().port
    const send = (suffix, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = request({ hostname: '127.0.0.1', port, path: fixture.base + suffix,
        method: data === undefined ? 'GET' : 'POST', headers: { host: `localhost:${port}`,
          ...data === undefined ? {} : { origin: `http://localhost:${port}`, 'content-type': 'application/json' } } }, res => {
        let raw = ''
        res.on('data', chunk => { raw += chunk })
        res.on('end', () => resolve({ status: res.statusCode, raw }))
      })
      req.on('error', reject)
      req.end(data)
    })
    assert.equal((await send('/panel?base=dark&lang=en')).status, 200)
    assert.equal((await send('/invoke', { channel: 'xd.setSource', payload: { enabled: false } })).status, 200)
    const read = await send('/invoke', { channel: 'xd.state' })
    assert.equal(read.status, 200)
    assert.deepEqual(JSON.parse(read.raw), { result: { enabled: false } })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fixture.dispose()
  }
})

const provider = model => ({ id: 'fixture-p', name: 'Fixture', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: model }] })

test('discovery clears failed adapter or directory replacements and recovers on the next registration', async () => {
  for (const failure of ['adapter', 'rows']) {
    const state = indexFixture()()
    try {
      assert.equal(state.bridge.declareProviders([provider('old-m')]).ok, true)
      assert.deepEqual(json(await state.discovery({ provider: 'fixture-p' })).map(row => row.id), ['old-m'])
      state.fail = failure
      assert.equal(state.bridge.declareProviders([provider('new-m')]).ok, false)
      assert.equal(state.adapters, 0)
      assert.equal(state.providers, 0)
      assert.deepEqual(json(await state.discovery({ provider: 'fixture-p' })), [], `${failure}: no removed model may be advertised`)
      state.fail = null
      assert.equal(state.bridge.declareProviders([provider('new-m')]).ok, true)
      assert.deepEqual(json(await state.discovery({ provider: 'fixture-p' })).map(row => row.id), ['new-m'])
      assert.equal(state.adapters, 1)
      assert.equal(state.providers, 1)
      assert.equal(state.bridge.declareProviders([provider('new-m')]).changed, false)
      assert.equal(state.adapters, 1, 'an identical declaration must keep its registration')
    } finally { await state.dispose() }
  }
})

test('discovery rows belong to one activation and are empty as soon as it is disposed', async () => {
  const activate = indexFixture()
  const first = activate(), second = activate()
  try {
    assert.equal(first.bridge.declareProviders([provider('first-m')]).ok, true)
    assert.deepEqual(json(await second.discovery({})), [], 'a fresh activation must not inherit another registration')
    assert.equal(second.bridge.declareProviders([provider('second-m')]).ok, true)
    assert.deepEqual(json(await first.discovery({})).map(row => row.id), ['first-m'])
    const disposing = first.dispose()
    assert.deepEqual(json(await first.discovery({})), [], 'teardown must not advertise rows while services are closing')
    await disposing
    assert.equal(first.adapters, 0)
    assert.equal(first.providers, 0)
    assert.equal(first.bridge.declareProviders([provider('late-m')]).ok, false)
    assert.deepEqual(json(await second.discovery({})).map(row => row.id), ['second-m'])
    await second.dispose()
    assert.deepEqual(json(await second.discovery({})), [])
  } finally { await first.dispose(); await second.dispose() }
})

test('a settings write this plugin made is not read as an edit from the host', async () => {
  // DSH answers a plugin's volatile write by emitting `loader/volatile-update`
  // back at the writer's own fiber, and the loader delivers it synchronously
  // inside `mutate`. Taken for a host edit it cleared the whole credit cache, so
  // every account switch from the popup blanked the readout to `—` until a
  // warm-up poll refilled it. PI's host does not echo a plugin's own write,
  // which is why only the DSH build showed it.
  const activate = indexFixture()
  let echo = () => {}
  const written = {}
  const settings = {
    update: SettingsForms.prototype.update,
    async mutate(_ns, ops) {
      for (const op of ops) written[op.path[0]] = op.value
      echo()
    },
    async write() {},
  }
  const state = activate(settings)
  try {
    echo = () => { for (const listener of state.volatileListeners) listener() }
    let applied = 0
    state.bridge.onSettingsChanged(() => { applied += 1 })

    await state.bridge.setSettings({ showComposerPoints: true })
    assert.deepEqual(written, { showComposerPoints: true }, 'the write must reach the settings service')
    assert.equal(applied, 0, 'the write this plugin made must not read as an edit from the host')

    // The same event outside a write is the host's own settings UI, and still has
    // to land: dropping it unconditionally would ignore real edits.
    echo()
    assert.equal(applied, 1, 'an edit made in the host settings UI must still reach the plugin')
  } finally { await state.dispose() }
})

/**
 * Regressions for the panel's client/host contract.
 *
 * The panel is two halves that cannot see each other: the page inside the frame
 * calls `xd.*` channels over HTTP, and the host half answers whichever ones it
 * knows. Nothing checks one half against the other at runtime, so the faults
 * here would surface as dead controls rather than as errors - a channel the page
 * called that no half accepted, routes left behind in the server table when one
 * of them failed to mount, and rows the popup could not tell apart.
 *
 * Each case is stated as what the user sees, and each is reachable from the
 * shipped panel rather than from a synthetic call.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { WebServer } = require('@deepseek-ai/dsh-host-webserver')

const { root, transpile } = require('./ts-loader.cjs')
const sourceOf = file => fs.readFileSync(path.join(root, file), 'utf8')

/** Every channel the panel page and the composer component actually call. */
function uiChannels() {
  const channels = new Set()
  for (const file of ['renderer/panel.js', 'src/client/composer.tsx']) {
    for (const match of sourceOf(file).matchAll(/["'](xd\.[A-Za-z]+)["']/g)) channels.add(match[1])
  }
  return channels
}

/** The channels the route admits, read from the shipped allowlist. */
function routeChannels() {
  const channels = new Set()
  for (const block of sourceOf('src/web-panel.ts')
    .matchAll(/const CHANNELS = new Set\(\[([\s\S]*?)\]\)/g)) {
    for (const match of block[1].matchAll(/'(xd\.[A-Za-z]+)'/g)) channels.add(match[1])
  }
  return channels
}

test('every channel the panel calls is admitted by the route and answered by the host', () => {
  const ui = [...uiChannels()].sort()
  const admitted = routeChannels()
  const handled = new Set([...sourceOf('src/host.ts').matchAll(/case\s+["'](xd\.\w+)["']\s*:/g)].map(match => match[1]))
  assert.ok(ui.length > 0, 'the scan must find the panel\'s channels, or it proves nothing')
  assert.deepEqual(ui.filter(channel => !admitted.has(channel)), [],
    'a channel the page calls but the route does not admit is refused with 400, so the control is dead')
  assert.deepEqual(ui.filter(channel => !handled.has(channel)), [], 'a panel channel has no host handler')
})

test('the Trae batch skips only the edition whose device is spent', async () => {
  const source = sourceOf('src/host.ts')
  const claims = []
  const marked = []
  const context = vm.createContext({
    activeTraeRegions: () => ['cn'],
    traeStorageCandidates: () => [],
    discoverTraeCredentials: async () => ({
      credentials: [
        { label: 'cn-1', edition: 'cn' },
        { label: 'cn-2', edition: 'cn' },
        { label: 'solo-1', edition: 'solo' },
      ],
    }),
    traeRegionOfCredential: () => 'cn',
    checkinDelay: async () => {},
    currentCheckinSignal: () => ({ aborted: false }),
    traeClaimFor: async (credential) => {
      claims.push(credential.label)
      return credential.edition === 'cn'
        ? { outcome: 'claimed', deviceCheckedIn: true }
        : { outcome: 'claimed' }
    },
    traeAccountId: (credential) => credential.label,
    markSourceCheckinRow: (...args) => marked.push(args),
    TRAE_ACCOUNT_DELAY_MS: 0,
    TRAE_ACCOUNT_JITTER_MS: 0,
    log: () => {},
  })
  vm.runInContext(liftFunction(source, 'traeCheckinAll'), context)
  const counts = await vm.runInContext('traeCheckinAll()', context)
  assert.deepEqual(claims, ['cn-1', 'solo-1'],
    'the second CN account is skipped, the other edition is still claimable')
  assert.equal(counts.claimed, 2)
  assert.equal(counts.skipped, 1)
  const skipped = marked.find((args) => args[1] === 'cn-2')
  assert.equal(skipped[3].outcome, 'skipped')
  assert.equal(skipped[3].deviceCheckedIn, true)
})

/**
 * Qoder's claim answer carries `replayed: true` on the call that collects the
 * round. The campaign read before the POST already proved it CLAIMABLE, so the
 * receipt is a claim; treating the flag as "skipped" made the first successful
 * click read as already collected until the panel was refreshed.
 */
test('a Qoder claim receipt is a claim even when marked replayed', async () => {
  const source = sourceOf('src/host.ts')
  class QoderClient {
    async fetchCampaigns() { return {} }
    async claimCampaign() { return {} }
  }
  const context = vm.createContext({
    QoderUpstreamClient: QoderClient,
    loadGeneration: 0,
    regionEnabled: () => true,
    sourceCredentialExpired: () => false,
    qoderClientCredential: (credential) => credential,
    qoderClaimableCampaignIdOf: () => 'daily',
    qoderCheckinStateFrom: () => ({}),
    qoderNormalizeClaimResult: () => ({ claimed: true, replayed: true }),
    qoderRowLabel: () => 'fixture',
    accountLogTag: () => 'acct-fixture',
    qoderFailureRetryable: () => false,
    safeMessage: String,
    log: () => {},
    Object, Number, String,
  })
  vm.runInContext(liftFunction(source, 'qoderClaimFor'), context)
  const result = await vm.runInContext('qoderClaimFor({ region: "cn" })', context)
  assert.equal(result.outcome, 'claimed')
  assert.equal(result.todayCheckedIn, undefined,
    'the card is already marked collected by the claimed outcome')
})

/**
 * A Qoder sign-in whose token has expired is skipped before the network.
 *
 * The panel already disables its button for an expired row, but the batch pass
 * still read the campaign list with the dead token and counted the 401 as a
 * failed account: a retry the account could not satisfy, and a failure the user
 * could not act on. Trae's pass has always parked the same case.
 */
test('an expired Qoder sign-in is skipped before any upstream read', async () => {
  const source = sourceOf('src/host.ts')
  let reads = 0
  class QoderClient {
    async fetchCampaigns() { reads += 1; return {} }
    async claimCampaign() { reads += 1; return {} }
  }
  const context = vm.createContext({
    QoderUpstreamClient: QoderClient,
    loadGeneration: 0,
    regionEnabled: () => true,
    sourceCredentialExpired: (credential, now) => credential.expiresAtMs <= now,
    qoderClientCredential: (credential) => credential,
    qoderClaimableCampaignIdOf: () => 'daily',
    qoderCheckinStateFrom: () => ({}),
    qoderNormalizeClaimResult: () => ({ claimed: true }),
    qoderRowLabel: () => 'fixture',
    accountLogTag: () => 'acct-fixture',
    qoderFailureRetryable: () => false,
    safeMessage: String,
    log: () => {},
    Object, Number, String,
  })
  vm.runInContext(liftFunction(source, 'qoderClaimFor'), context)
  const result = await vm.runInContext('qoderClaimFor({ region: "cn", expiresAtMs: 1 })', context)
  assert.equal(result.outcome, 'skipped', 'an expired sign-in is not a failed account')
  assert.match(result.reason, /expired/i)
  assert.equal(reads, 0, 'and it costs no upstream read at all')
})

/**
 * A log line is not a place for an account label or a credential.
 *
 * Logs are copied into bug reports; an email address or nickname there is
 * personal data. The tag keeps lines about one account correlatable without
 * carrying the label, and the logger strips the same credential and path shapes
 * the gateway answers use.
 */
test('a log line carries no account label or credential', () => {
  const source = sourceOf('src/host.ts')
  const lines = []
  const context = vm.createContext({
    console: { log: (line) => lines.push(String(line)) },
    redactSecrets: require('../src/loopback.ts').redactSecrets,
    accountLogTag: require('../src/log.ts').accountLogTag,
    String,
  })
  vm.runInContext(liftFunction(source, 'log'), context)
  const tag = vm.runInContext('accountLogTag("lin.cn@example.com")', context)
  assert.equal(tag, vm.runInContext('accountLogTag("lin.cn@example.com")', context), 'the tag is stable')
  assert.notEqual(tag, vm.runInContext('accountLogTag("other@example.com")', context), 'different labels differ')
  assert.doesNotMatch(tag, /lin\.cn|@/, 'the tag carries neither the local part nor the domain')
  vm.runInContext(
    'log("warn", "Bearer abcdefghij failed for lin.cn@example.com at C:\\\\Users\\\\fixture\\\\signins\\\\a.info")',
    context,
  )
  const line = lines.join('\n')
  assert.doesNotMatch(line, /lin\.cn@example\.com/, 'the address is redacted')
  assert.doesNotMatch(line, /C:\\\\Users/, 'the path is redacted')
  assert.doesNotMatch(line, /abcdefghij/, 'the credential is redacted')
})

test('a panel route that fails to mount releases the routes that already registered', () => {
  const { registerPanelRoutes } = loadSource('src/web-panel.ts')
  // The real server table: a duplicate (kind, path) throws, which is exactly
  // what a half-mounted panel looks like to the next activation.
  const table = { exact: new Map(), prefixes: new Map() }
  let calls = 0
  const failing = {
    register(route) {
      calls += 1
      if (calls === 4) throw new Error('duplicate exact route')
      return WebServer.prototype.register.call(table, route)
    },
  }
  let mounted
  let thrown
  registerPanelRoutes({ webServer: failing }, {
    pluginRoot: root, logger: { warn() {} },
    effect: callback => { try { mounted = callback() } catch (error) { thrown = error } },
    invoke: async () => ({}),
  })
  assert.ok(thrown, 'a mount failure must not be swallowed into a silent half-mounted panel')
  assert.equal(mounted, undefined, 'a failed mount must not hand back a disposer it cannot honour')
  assert.equal(table.exact.size, 0,
    'routes that registered before the failure must be released, or every later activation fails on them')
  assert.equal(table.prefixes.size, 0)
  // Nothing is left claimed, so a retry can take the same paths.
  const retry = { exact: new Map(), prefixes: new Map() }
  registerPanelRoutes({ webServer: { register: route => WebServer.prototype.register.call(retry, route) } }, {
    pluginRoot: root, logger: { warn() {} }, effect: callback => { mounted = callback() },
    invoke: async () => ({}),
  })
  assert.ok(retry.exact.size > 0, 'a retry must be able to mount the panel')
  mounted()
})

test('panel assets cannot escape the package through a junction', (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-panel-assets-'))
  const pluginRoot = path.join(temporary, 'package')
  const renderer = path.join(pluginRoot, 'renderer')
  const outside = path.join(temporary, 'outside')
  fs.mkdirSync(pluginRoot)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'panel.js'), 'outside')
  try {
    fs.symlinkSync(outside, renderer, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    t.skip(`directory links are unavailable: ${error.message}`)
    return
  }
  try {
    const { panelAsset } = require('../src/web-panel.ts')
    assert.equal(panelAsset(pluginRoot, 'panel.js'), undefined)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

function loadSource(file, overrides = {}) {
  const ownRequire = createRequire(path.join(root, file))
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, URL, Buffer, console,
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : ownRequire(name)) })
  vm.runInContext(transpile(sourceOf(file)), context, { filename: file })
  return module.exports
}

/** One function lifted out of a host module, for a path that needs no gateway. */
function liftFunction(source, name) {
  const from = source.indexOf(`function ${name}(`)
  assert.notEqual(from, -1, `${name} must exist in the host module`)
  const modifier = source.slice(Math.max(0, from - 6), from) === 'async ' ? 'async ' : ''
  let depth = 0
  let quote = ''
  let index = source.indexOf('{', from)
  for (; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== '') {
      if (character === '\\') index += 1
      else if (character === quote) quote = ''
      continue
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') { depth -= 1; if (depth === 0) break }
  }
  return modifier + source.slice(from, index + 1)
}

/**
 * The host half, loaded with a scratch data directory and a stub bridge.
 *
 * Cases that have to dispatch a channel need the real module, not a slice of its
 * text, so this loads `src/host.ts` whole the way the other suites do.
 */
function loadHost(overrides = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-panel-'))
  const settings = { enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false }
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  ownRequire('./pi-compat.ts').installPi({
    getSettings: () => ({ ...settings }),
    setSettings: patch => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })
  const module = { exports: {} }
  const login = {
    startDeviceLogin: async () => ({ state: 'fixture-login', authUrl: 'https://copilot.tencent.com/login' }),
    pollDeviceLogin: async () => ({ status: 'pending' }),
  }
  const context = vm.createContext({
    require: name => Object.hasOwn(overrides, name) ? overrides[name]
      : name === './login' ? login : ownRequire(name), module, exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Buffer, process, TextEncoder, TextDecoder,
  })
  context.exports = module.exports
  vm.runInContext(transpile(sourceOf('src/host.ts')), context, { filename: 'src/host.ts' })
  return { plugin: module.exports, context, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) }
}

/** The slice of an `<input>` the panel touches, with listeners a case can fire. */
function fakeInput() {
  const listeners = {}
  return {
    type: '', className: '', max: '', min: '', step: '', value: '',
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler) },
    dispatch(type) { for (const handler of listeners[type] || []) handler({ target: this }) },
  }
}

/**
 * Named panel declarations, evaluated together and callable.
 *
 * `renderer/panel.js` boots on load, so it cannot be evaluated whole. Lifting
 * the named functions out with brace matching is what lets a case drive the real
 * control rather than scan its text: a bound the page never wires up, or a guard
 * whose `return` was dropped, then fails the case where a source match would
 * still pass.
 */
function panelFunctions(names, source, extra) {
  const parts = []
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(from, index + 1))
  }
  const ceiling = /var MAX_TOKEN_BUDGET = 0x[0-9a-f]+;/.exec(source)
  const context = vm.createContext({
    document: { createElement: () => fakeInput() },
    String, Number, Math, console,
    ...extra,
  })
  if (ceiling) parts.unshift(ceiling[0])
  vm.runInContext(parts.join('\n'), context)
  return context
}

/**
 * A single claim has to change the row the next document serves.
 *
 * `xd.sourceCheckin` answers with `statusDocument`, and that document reads
 * the source row cache rather than probing again. A claim that only updated
 * the upstream left the card on "check in" after a successful click.
 */
test('a single claim records today on the cached source row', () => {
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, console,
    require: name => ownRequire(name),
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer, process,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(sourceOf('src/host.ts'))
    + '\nmodule.exports.__rows = (trae, qoder) => { traeAccountRows = trae; qoderAccountRows = qoder }\n'
    + '\nmodule.exports.__mark = markSourceCheckinRow\n', context)
  const rows = context.module.exports.__rows
  rows([{ id: 'B-id', label: 'B', region: 'cn', checkin: { active: true, todayCheckedIn: false } }],
    [{ id: 'A-id', label: 'A', region: 'cn', checkin: { active: true, todayCheckedIn: false } }])
  context.module.exports.__mark('qoder', 'A-id', 'cn', { outcome: 'claimed' })
  assert.equal(vm.runInContext('qoderAccountRows[0].checkin.todayCheckedIn', context), true,
    'the document the panel reads back has to say the claim happened')
  context.module.exports.__mark('trae', 'B-id', 'cn', { outcome: 'skipped', deviceCheckedIn: true })
  assert.equal(vm.runInContext('traeAccountRows[0].checkin.deviceCheckedIn', context), true,
    'a device-level refusal has to reach the card too')
  rows([], [{ id: 'C-id', label: 'C', region: 'cn', checkin: { active: true, todayCheckedIn: false } }])
  context.module.exports.__mark('qoder', 'C-id', 'cn', { outcome: 'skipped', todayCheckedIn: true })
  assert.equal(vm.runInContext('qoderAccountRows[0].checkin.todayCheckedIn', context), true,
    'a round already collected in the app has to reach the card as collected')
})

/**
 * A panel.css that 404s while the host half is still loading is waited out.
 *
 * The card probes `panel.css` to tell a panel the host half is not serving from
 * one whose assets are missing, and the only thing that separates the two is how
 * long the 404s last. A host half that has not registered its routes yet answers
 * 404 for a moment, so the probe retries before it concludes: three 404s in a
 * row are a verdict, and one is a wait.
 *
 * There is no DOM harness in this repo, so the effect is driven through the
 * `React.useEffect` seam the same way the composer cases in the sibling build
 * drive theirs - the shipped effect body, run against a stubbed `fetch` and a
 * `setTimeout` that fires immediately and records the wait it was asked for.
 */
test('a panel.css that 404s twice before it loads is waited out, not reported missing', async () => {
  const source = sourceOf('src/client/index.tsx')
  const anchor = source.indexOf('const probe = (remaining')
  assert.notEqual(anchor, -1, 'the card must probe panel.css, or there is nothing to wait out')
  const open = source.lastIndexOf('React.useEffect(() => {', anchor)
  assert.notEqual(open, -1, 'the probe has to live inside an effect, or it runs on every render')
  const close = '}, [view, generation])'
  const end = source.indexOf(close, anchor)
  assert.notEqual(end, -1, 'the probe effect must be scoped to the frame generation')
  const effect = transpile(source.slice(open, end + close.length))

  /** The effect, run once against the answers `fetch` gives and the waits it asks for. */
  const drive = (answers, view) => {
    const waits = []
    const missing = []
    const failures = []
    let asked = 0
    const context = vm.createContext({
      React: { useEffect: run => run() },
      view, generation: 0,
      t: key => key,
      setRecoveries() {},
      setMissing: value => missing.push(value),
      setProbeFailure: value => failures.push(value),
      PANEL_BASE: '/panel-base',
      fetch: async () => {
        const answer = answers[Math.min(asked, answers.length - 1)] ?? new Response('', { status: 404 })
        asked += 1
        if (answer instanceof Error) throw answer
        return answer
      },
      setTimeout: (callback, ms) => { waits.push(ms); callback(); return 1 },
      clearTimeout: () => {},
    })
    vm.runInContext(effect, context, { filename: 'src/client/index.tsx' })
    return { waits, missing, failures, asked: () => asked }
  }

  const notFound = new Response('', { status: 404 })
  const served = new Response('body', { status: 200 })

  // The case: two 404s and then the stylesheet, which is a host half still
  // loading rather than a panel that is not installed.
  const waited = drive([notFound, notFound, served], 'full')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(waited.asked(), 3, 'the third attempt is the one that has to be made')
  assert.deepEqual(waited.waits, [500, 500], 'the retries wait between attempts rather than hammering the route')
  assert.deepEqual(waited.missing, [false, false],
    'a stylesheet that arrives on the third try must not leave the card saying the assets are missing')

  // The control: three 404s are the verdict, so the retry above is not a probe
  // that never concludes.
  const concluded = drive([notFound, notFound, notFound], 'full')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(concluded.missing, [false, true],
    'three 404s in a row are the missing-assets verdict, and it must still be reachable')

  const recovered = drive([new Error('network'), served], 'full')
  const offline = drive([new Error('network')], 'full')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([recovered.asked(), offline.asked()], [2, 3], 'rejected requests must be retried')
  assert.deepEqual(recovered.waits, [500])
  assert.deepEqual(recovered.missing, [false, false])
  assert.deepEqual(offline.missing, [false, true])
  assert.equal(offline.failures.at(-1), 'card.networkError')

  // A refusal that is not 404 carries the reason: reinstalling cannot fix a
  // browser address or origin the host's loopback guard turned away.
  const forbidden = new Response(JSON.stringify({ error: 'peer-not-loopback' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  })
  const denied = drive([forbidden], 'full')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(denied.asked(), 3, 'a transient host-half error is still retried before concluding')
  assert.deepEqual(denied.missing, [false, true], 'the error is a verdict after the retries')
  assert.match(denied.failures.at(-1), /HTTP 403: peer-not-loopback/,
    'the card names the status and the host\'s own reason')

  // And the probe costs nothing on the list's inline summary, where there is no
  // frame to tell anything about.
  const summary = drive([notFound], 'summary')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(summary.asked(), 0, 'the summary view has no frame, so it must not probe at all')
})

/**
 * The composer refresh must leave room for its own answer.
 *
 * The readout aborts its call at `INVOKE_TIMEOUT_MS`; a host pass that spends
 * that same figure re-probing accounts (or the wider panel-step budget) finishes
 * after the client has already given up, so the click reports a timeout even
 * though the reads succeeded. The pass is bounded below the call deadline, and
 * the probe it abandons still writes the cache the readout polls.
 */
for (const source of ['trae', 'qoder']) {
  test(`${source} composer refresh answers before its last slow probe finishes`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const rows = ['A', 'B', 'C'].map(label => ({ id: label, label, region: 'cn' }))
    const discover = async () => ({ credentials: rows })
    const probe = credential => new Promise(resolve => {
      setTimeout(() => resolve({ usage: { credits: { total: 42 } } }), credential.label === 'B' ? 16000 : 8000)
    })
    const host = loadHost({
      './trae-discovery': { discoverTraeCredentials: discover, traeRegionOfCredential: credential => credential.region },
      './qoder-credentials': { discoverQoderCredentials: discover },
    })
    Object.assign(host.context, { Date, fixtureRows: rows, fixtureSource: source, discover, probe })
    vm.runInContext(`
      matchComposerModel = () => ({ source: fixtureSource, region: 'cn' });
      composerPoints = () => ({ show: true });
      traeAccountRows = qoderAccountRows = fixtureRows;
      traeAccountId = qoderAccountId = credential => credential.id;
      traeRowProbe = qoderRowProbe = probe;
    `, host.context)
    t.after(() => host.cleanup())
    let answer
    const pending = host.plugin.onPanelInvoke('xd.composerRefresh', {}).then(value => {
      answer = value
    })
    const flush = () => new Promise(resolve => setImmediate(resolve))
    try {
      await flush()
      t.mock.timers.tick(8000)
      await flush()
      assert.equal(rows[0].usage.credits.total, 42)
      assert.equal(rows[2].usage.credits.total, 42, 'a slow account must not delay the other probes')
      t.mock.timers.tick(7000)
      await flush()
      assert.equal(answer?.show, true, 'the refresh must answer within its 15-second budget')
      assert.equal(rows[1].usage, undefined, 'the second probe is still waiting')
      t.mock.timers.tick(1000)
      await flush()
      assert.equal(rows[1].usage.credits.total, 42, 'a late probe still updates the popup cache')
    } finally {
      t.mock.timers.tick(30000)
      await flush()
      await pending
    }
  })
}

/**
 * The model sheet's numeric fields must refuse a value the host will not store.
 *
 * `parseOverride` rejects the whole selection payload when one window exceeds
 * the host's ceiling, so a single impossible number discarded every other edit
 * in the same save and reported only "invalid selection payload". The browser
 * bound keeps the figure inside the range the host can store, which is the only
 * place the user can be told which field is at fault.
 *
 * The field is driven, not read: a bound the page never wires up, or a ceiling
 * check that accepts everything, fails here even though the source still names
 * both.
 */
test('a token budget past the host ceiling is refused by the field itself', () => {
  const hostCeiling = /const MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(sourceOf('src/host.ts'))
  assert.ok(hostCeiling, 'the host must declare the ceiling it stores against')
  const ceiling = Number(hostCeiling[1])

  const panel = sourceOf('renderer/panel.js')
  const declared = /var MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(panel)
  assert.ok(declared, 'the panel must carry the same ceiling the host enforces')
  assert.equal(Number(declared[1]), ceiling,
    'a panel ceiling that drifts from the host one rejects a figure the host would store, or offers one it will not')

  // The real field, built and driven the way the sheet builds it.
  const context = panelFunctions(['numberInput'], panel)
  const input = context.numberInput(1000, value => { input.accepted = value })
  assert.equal(input.max, String(ceiling), 'without the attribute the browser offers no bound at all')
  assert.equal(input.value, '1000', 'the field opens on the stored value')

  input.value = String(ceiling + 1)
  input.dispatch('change')
  assert.equal(input.accepted, undefined,
    'a value past the ceiling must not reach the save, or the host discards every other edit with it')
  assert.equal(input.value, '1000', 'a refused value leaves the stored figure in the field')

  input.value = '2000'
  input.dispatch('change')
  assert.equal(input.accepted, 2000, 'a value inside the ceiling must still save')
})

/**
 * A refused number goes back to what is committed, not to what the field showed.
 *
 * The sheet is rebuilt on every repaint, and the field a keypress lands in can be
 * a half-typed number: the row holds the draft's figure, the field holds whatever
 * the user has typed so far. After one accepted edit those two differ, so a
 * refusal that restored the field's own opening text put back a number nobody had
 * finished typing - and one more Enter then saved it.
 */
test('a refused figure goes back to the committed one, not the half-typed text', () => {
  const panel = sourceOf('renderer/panel.js')
  const context = panelFunctions(['numberInput'], panel)
  const input = context.numberInput(
    '50000',                          // what the rebuilt field opened on
    (value) => { input.accepted = value },
    2000000,
    () => {},
    () => {},
    1000,                             // what is actually stored
  )
  input.value = '5000000'
  input.dispatch('change')
  assert.equal(input.accepted, undefined, 'the impossible figure must not be saved')
  assert.equal(input.value, '1000',
    'and the field shows the committed figure, not the half-typed one a repaint left behind')
})

/**
 * Switching the automatic check-in off must not depend on the hours box.
 *
 * The box can hold stale text from an earlier edit. Requiring it to parse before
 * an OFF would report a failure and leave the timer running while the panel went
 * on showing the schedule as off, which is the one state the user cannot see.
 */
test('switching the automatic check-in off survives an unreadable hours box', async () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const context = panelFunctions(['parseCheckinHours', 'setAutoCheckin'], source)
  const calls = []
  Object.assign(context, {
    state: { autoCheckin: { hours: [9, 18] } },
    autoHoursDraft: 'invalid', render() {}, note() {}, t: key => key,
    runBusy: (_name, work) => work(),
    invoke: async (channel, payload) => { calls.push({ channel, ...payload }); return {} },
  })
  const invalid = context.parseCheckinHours('9, invalid')
  await context.setAutoCheckin(false, invalid)
  assert.deepEqual(calls, [{ channel: 'xd.setAutoCheckin', enabled: false, hours: [9, 18] }])
  assert.equal(context.autoHoursDraft, null)
  await context.setAutoCheckin(true, invalid)
  assert.equal(calls.length, 1, 'invalid hours must still prevent enabling the schedule')
})

/**
 * An expired account is listed in the preference picker but cannot be chosen.
 *
 * The host refuses an expired account as the preferred one, so offering it turned
 * a click into an error with nothing on screen to explain it. It stays listed
 * rather than dropped: the user needs to see the account is there and why it
 * cannot serve.
 *
 * The picker is built and its options read back, not scanned: a `disabled` write
 * the option never receives leaves the source text unchanged and the control live.
 */
test('an expired account is listed but not selectable as the preferred one', () => {
  const record = (tagName, className, text) => ({
    tagName, className, textContent: text === undefined ? '' : String(text), children: [],
    appendChild(node) { this.children.push(node) },
    setAttribute() {}, addEventListener() {},
  })
  // The reason comes from the panel's own English table rather than a copy here:
  // a case that spells the sentence itself still passes after the entry is gone.
  const source = sourceOf('renderer/panel.js')
  const english = source.slice(source.indexOf('var EN = {'), source.indexOf('\n}', source.indexOf('var EN = {')))
  const reason = /"acct\.expired": "([^"]+)"/.exec(english)?.[1]
  assert.ok(reason, 'the English table has to name why the row cannot be chosen')
  const context = panelFunctions(['sourcePreferredPicker'], source, {
    el: record,
    t: key => key === 'acct.expired' ? reason : key,
    state: {},
    busy: null,
    distributionControl: () => null,
    setPreferredSourceAccount: () => {},
  })
  const card = context.sourcePreferredPicker('workbuddy', 'cn', [
    { label: 'Live', expired: false },
    { label: 'Expired', expired: true },
  ])
  const picker = card.children.find(child => child.tagName === 'select')
  assert.ok(picker, 'the picker has to be in the card it builds')
  const options = picker.children.filter(child => child.tagName === 'option')
  const live = options.find(option => option.textContent === 'Live')
  const expired = options.find(option => option.textContent.startsWith('Expired'))
  assert.ok(live && expired, 'both accounts have to be listed')
  assert.notEqual(live.disabled, true, 'a live account stays selectable')
  assert.equal(expired.disabled, true, 'an expired account must not be selectable')
  assert.equal(expired.textContent, 'Expired · ' + reason, 'and the row has to say why, in the reader\'s language')
})

test('the panel\'s check-in goes through the one pass, not a second copy of it', async () => {
  // The per-source "check in all" button used to run its own fan-out: no pause
  // between the check-in burst and the growth burst, and no record in
  // `autoCheckin.last`, so the panel's "last run" stayed on the previous pass
  // while the upstream saw two request clusters back to back.
  const host = loadHost()
  await host.plugin.onLoad()
  try {
    const before = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(before.autoCheckin.last, undefined, 'no pass has run yet')
    const answer = await host.plugin.onPanelInvoke('xd.checkinAll', { source: 'workbuddy' })
    assert.equal(typeof answer.claimed, 'number', 'the answer still carries the counts the panel reads')
    assert.equal(answer.state.autoCheckin.last.manual, true,
      'a check-in started from the panel has to record itself, or "last run" names an older pass')
    assert.equal(typeof answer.state.autoCheckin.last.at, 'string', 'and it has to carry the time it ran')
    const after = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(after.autoCheckin.last.manual, true, 'the record has to survive the next document read too')
  } finally {
    await host.plugin.onUnload()
    host.cleanup()
  }
})


/**
 * The panel page boots on its own, and its whole script has to stay at the top
 * level for that to mean anything.
 *
 * An unclosed function body swallows every declaration after it: the file still
 * parses, so a syntax check passes, and the page dies on the first call to a
 * name that is now nested inside some other function. That is what happened to
 * `selectTab` and `labelTabs` once, and nothing caught it because every other
 * case here lifts individual functions out of the text.
 */
test('the panel page boots whole, with its controls at the top level', () => {
  const element = () => ({
    childElementCount: 0, children: [], appendChild() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null }, remove() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
    textContent: '', value: '', hidden: false, disabled: false, checked: false,
    scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    tagName: 'DIV', className: '', type: '', title: '', href: '',
  })
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: () => element(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => element(),
      createRange: () => ({ selectNodeContents() {} }),
      body: element(), documentElement: { dataset: {} },
    },
    window: {
      addEventListener() {},
      getSelection: () => ({ removeAllRanges() {}, addRange() {}, toString: () => '' }),
    },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  })
  assert.doesNotThrow(() => vm.runInContext(sourceOf('renderer/panel.js'), context),
    'the page threw while booting, so the panel never paints')
  for (const name of ['boot', 'selectTab', 'labelTabs', 'renderAutoCheckin', 'autoNoteRows',
    'runKeepAliveNow']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'function',
      `${name} is not at the top level, so an unclosed body above it swallowed the declaration`)
  }
})
/**
 * Every string the panel asks for is in both languages.
 *
 * A missing entry is not a visible error: `t()` falls back to the key, so the
 * user reads `pool.noAccounts` in the middle of a Chinese sentence.
 *
 * A key counts as asked for when it appears in the panel outside the two tables,
 * or when something outside the panel drives it: the four view tabs and the four
 * footer links come from `data-` attributes in the page, and the two pack names
 * come from the host. Those three sources are read here rather than exempted by
 * hand, so the link itself is what the check verifies.
 */
test('every string the panel asks for exists in both languages', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  const tables = ['EN', 'ZH'].map((dictionary) => {
    const from = source.indexOf(`var ${dictionary} = {`)
    assert.notEqual(from, -1, `the ${dictionary} table has to be in the panel`)
    return { dictionary, body: source.slice(from, source.indexOf('\n}', from)) }
  })
  const definedIn = (body) => [...body.matchAll(/^\s*"([a-zA-Z]+\.[a-zA-Z0-9]+)":/gm)].map((match) => match[1])
  const defined = [...new Set(tables.flatMap((table) => definedIn(table.body)))]
  assert.ok(defined.length > 0, `the panel has its tables (found ${defined.length} keys)`)

  // The keys the page drives, and the two the host names.
  const fromPage = [
    ...[...page.matchAll(/data-tab="([\w-]+)"/g)].map((match) => 'tab.' + match[1]),
    ...[...page.matchAll(/data-foot-label="([\w-]+)"/g)].map((match) => 'foot.' + match[1]),
  ]
  const fromHost = ['credits.planQuota', 'credits.addOnQuota']

  const outside = source.replace(tables[0].body, '').replace(tables[1].body, '')
  const asked = new Set([
    ...defined.filter((key) => outside.includes('"' + key + '"')),
    ...fromPage,
    ...fromHost,
  ])
  assert.ok(asked.size > 0, `the panel asks for its strings (found ${asked.size})`)

  for (const { dictionary, body } of tables) {
    const missing = [...asked].filter((key) => !body.includes('"' + key + '"'))
    assert.deepEqual(missing, [], `${dictionary} is missing ${missing.join(', ')}`)
  }
})

/**
 * The four view tabs and the four panels they switch between are wired to each
 * other, in both directions.
 *
 * A tab that names nothing, or a panel nothing names, is not visible as a break:
 * the panel still switches on click, because the switching is done in JavaScript
 * by `data-tab`. What breaks is the accessibility tree, where the four views read
 * as four unrelated regions and a screen reader cannot say which tab is showing.
 */
test('every view tab names the panel it controls, and that panel names it back', () => {
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  // The source tabs carry data-source; the four view tabs carry data-tab and
  // switch between the sections below them.
  const tabs = [...page.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('role="tab"') && tag.includes('data-tab='))
  assert.equal(tabs.length, 4, 'the page has four view tabs')
  for (const tab of tabs) {
    const id = /id="([^"]+)"/.exec(tab)?.[1]
    const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1]
    assert.ok(id !== undefined, `a view tab needs an id so its panel can name it: ${tab}`)
    assert.ok(controls !== undefined, `a view tab has to name the panel it switches to: ${tab}`)
    const panel = new RegExp(`<section[^>]*id="${controls}"[^>]*>`).exec(page)?.[0]
    assert.ok(panel !== undefined, `aria-controls="${controls}" names no section`)
    assert.ok(panel.includes('role="tabpanel"'), `${controls} has to be a tabpanel`)
    assert.ok(panel.includes(`aria-labelledby="${id}"`), `${controls} has to name ${id} back`)
  }
})

test('source and region selectors expose pressed buttons instead of orphan tabs', () => {
  const page = sourceOf('renderer/index.html')
  const panel = sourceOf('renderer/panel.js')
  const sourceGroup = /<(?:div|nav)[^>]*id="sourceTabs"[^>]*>/.exec(page)?.[0]
  assert.ok(sourceGroup?.includes('role="group"'), 'source selectors do not control a tabpanel')
  assert.match(sourceGroup, /aria-label=/, 'the source button group has a name')
  for (const source of ['workbuddy', 'trae', 'qoder']) {
    const button = [...page.matchAll(/<button[^>]*>/g)].map(match => match[0])
      .find(tag => tag.includes(`data-source="${source}"`))
    assert.ok(button?.includes('aria-pressed='), `${source} exposes its selected state`)
    assert.ok(!button.includes('role="tab"'), `${source} does not claim an unrelated tab panel`)
  }
  assert.match(page, /id="regionTabs" role="group" aria-label=/)
  assert.match(page, /id="modelRegionTabs" role="group" aria-label=/)
  const regionStart = panel.indexOf('function fillRegionNav(')
  let depth = 0
  let regionEnd = panel.indexOf('{', regionStart)
  for (; regionEnd < panel.length; regionEnd += 1) {
    if (panel[regionEnd] === '{') depth += 1
    else if (panel[regionEnd] === '}' && --depth === 0) break
  }
  const context = vm.createContext({
    busy: null,
    clear: node => { node.children = [] },
    el: (_tag, className, text) => ({
      className,
      textContent: text || '',
      attributes: {},
      children: [],
      setAttribute(name, value) { this.attributes[name] = value },
      appendChild(child) { this.children.push(child) },
      addEventListener() {},
    }),
    regionParked: () => false,
    render() {},
    setActiveRegion() {},
    sourceRegionLabel: region => region === 'cn' ? 'China' : 'Global',
    t: key => key === 'tabs.regions' ? 'Account region' : key,
  })
  vm.runInContext(panel.slice(regionStart, regionEnd + 1), context)
  const nav = { children: [], setAttribute(name, value) { this[name] = value }, appendChild(child) { this.children.push(child) } }
  context.nav = nav
  vm.runInContext('fillRegionNav(nav, "qoder", ["cn", "global"], [{region:"cn"}], "cn")', context)
  assert.equal(nav.role, 'group', 'generated region controls are exposed as a group')
  assert.equal(nav['aria-label'], 'Account region')
  assert.deepEqual(nav.children.map(button => button.attributes['aria-pressed']), ['true', 'false'])
})

test('view tabs support manual arrow navigation and wrap without activating panels', () => {
  const panel = sourceOf('renderer/panel.js')
  const start = panel.indexOf('function moveTabFocus(')
  assert.notEqual(start, -1, 'the panel has a view-tab keyboard handler')
  let depth = 0
  let end = panel.indexOf('{', start)
  for (; end < panel.length; end += 1) {
    if (panel[end] === '{') depth += 1
    else if (panel[end] === '}' && --depth === 0) break
  }
  const context = vm.createContext({})
  vm.runInContext(panel.slice(start, end + 1), context)
  const focused = []
  const tabs = [
    { hidden: false, disabled: false, tabIndex: 0, attributes: { 'aria-selected': 'true' },
      getAttribute(name) { return this.attributes[name] }, setAttribute(name, value) { this.attributes[name] = value },
      focus() { focused.push(this) } },
    { hidden: true, disabled: false, tabIndex: -1, focus() { focused.push(this) } },
    { hidden: false, disabled: true, tabIndex: -1, focus() { focused.push(this) } },
    { hidden: false, disabled: false, tabIndex: -1, attributes: { 'aria-selected': 'false' },
      getAttribute(name) { return this.attributes[name] }, setAttribute(name, value) { this.attributes[name] = value },
      focus() { focused.push(this) } },
  ]
  context.list = { querySelectorAll: () => tabs }
  context.tabs = tabs

  assert.equal(vm.runInContext('moveTabFocus(list, tabs[0], "ArrowRight")', context), true)
  assert.equal(focused.at(-1), tabs[3], 'right arrow skips hidden and disabled tabs')
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, -1, -1, 0])
  assert.deepEqual(tabs.map(tab => tab.getAttribute?.('aria-selected')), ['true', undefined, undefined, 'false'],
    'arrow navigation leaves the selected tab unchanged')
  assert.equal(vm.runInContext('moveTabFocus(list, tabs[3], "ArrowRight")', context), true)
  assert.equal(focused.at(-1), tabs[0], 'right arrow wraps to the first tab')
  assert.equal(vm.runInContext('moveTabFocus(list, tabs[0], "ArrowLeft")', context), true)
  assert.equal(focused.at(-1), tabs[3], 'left arrow wraps to the last tab')
  assert.equal(vm.runInContext('moveTabFocus(list, tabs[3], "Home")', context), true)
  assert.equal(focused.at(-1), tabs[0])
  assert.equal(vm.runInContext('moveTabFocus(list, tabs[0], "End")', context), true)
  assert.equal(focused.at(-1), tabs[3])
})

/**
 * The check-in button stays out of the way while a pass is already running.
 *
 * A finished pass leaves the host with `autoCheckin.last.pending` set, and the
 * growth flag stays up until the pass returns. A button painted as ready in
 * that window accepts a click, asks for a second pass, and is repainted by the
 * host's "already running" answer — it flashes and does nothing. The button has
 * to report the pass instead, and come back when the state says it ended.
 */
test('the check-in button waits for a running pass', () => {
  const source = sourceOf('renderer/panel.js')
  const nodes = {}
  const node = () => ({
    childElementCount: 0,
    children: [],
    textContent: '', className: '',
    title: '',
    disabled: false,
    value: '',
    placeholder: '',
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return this.attrs[name] ?? null },
    addEventListener() {},
    appendChild(child) { this.children.push(child); this.childElementCount = this.children.length },
  })
  const get = (id) => nodes[id] || (nodes[id] = node())
  const control = get('autoControl')
  control.childElementCount = 2
  control.children = ['true', 'false'].map((value) => {
    const button = node()
    button.setAttribute('data-auto', value)
    return button
  })

  const paint = (state) => {
    const context = panelFunctions(['renderAutoCheckin', 'iconLabel', 'el'], source, {
      state,
      busy: null,
      checkinBusy: null,
      autoHoursDraft: null,
      $: get,
      t: (key) => key,
      document: { activeElement: null, createElement: node },
      paintAutoNote() {},
      paintKeepAliveNote() {},
    })
    context.renderAutoCheckin()
    return get('autoRunNow')
  }

  const idle = paint({
    autoCheckin: { enabled: true, hours: [9], last: { pending: false } },
    growth: { running: false },
  })
  assert.equal(idle.disabled, false, 'an idle panel leaves the button ready')
  assert.equal(idle.textContent, 'auto.runNow')

  const pending = paint({
    autoCheckin: { enabled: true, hours: [9], last: { pending: true } },
    growth: { running: false },
  })
  assert.equal(pending.disabled, true, 'a pass answered as pending owns the button')
  assert.equal(pending.textContent, 'auto.running')

  const inPass = paint({
    autoCheckin: { enabled: true, hours: [9], last: { pending: false } },
    growth: { running: true },
  })
  assert.equal(inPass.disabled, true, 'the same pass still shows in the growth flag')
  assert.equal(inPass.textContent, 'auto.running')
})

/**
 * Behaviour outside the shared core: relay seams, body limits, settings, check-in.
 *
 * Each case names the observable the user sees, and each is built so it fails
 * if the fix it covers is reverted: a fixture that reads the same either way
 * proves nothing. Every upstream is a stub and every auth directory is a
 * scratch one, so nothing here reaches the network or a real install.
 */
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

const scratch = (label) => fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), `dsh-${label}-`))

/** One readable WorkBuddy sign-in file, the shape the desktop app writes. */
function writeSignIn(dir, document = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'workbuddy-desktop.info')
  fs.writeFileSync(file, JSON.stringify({
    auth: { accessToken: 'original-token', refreshToken: '', expiresAt: Date.now() + 3600000 },
    account: { uin: 'u-1', nickname: 'Fixture' },
    ...document,
  }))
  return file
}

// The service table is process-wide and the host registers into it, so the two
// cases that read it run before anything has loaded a host.
test('every registered service is started and stopped', async () => {
  const { pi, installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({})
  const events = []
  const service = (id) => ({ id, start: () => events.push(`start ${id}`), stop: () => events.push(`stop ${id}`) })
  pi.services.register(service('round-first'))
  pi.services.register(service('round-second'))
  await startRegisteredService()
  assert.deepEqual(events.filter((line) => line.includes('round-')), ['start round-first', 'start round-second'],
    'both registered services must run, not only the one registered last')
  await stopRegisteredService()
  assert.deepEqual(events.filter((line) => line.includes('round-')),
    ['start round-first', 'start round-second', 'stop round-first', 'stop round-second'],
    'each service must be stopped by its own stop, or a gateway outlives its plugin')
})

test('detaching one settings handler leaves the other one attached', () => {
  const { pi, installPi } = require('../src/pi-compat.ts')
  const attached = new Set()
  installPi({
    onSettingsChanged: (handler) => attached.add(handler),
    offSettingsChanged: (handler) => attached.delete(handler),
  })
  const seen = []
  const first = (next) => seen.push(`first:${next.revision}`)
  const second = (next) => seen.push(`second:${next.revision}`)
  pi.events.on('plugin:settingsChanged', first)
  pi.events.on('plugin:settingsChanged', second)
  pi.events.off('plugin:settingsChanged', first)
  for (const handler of attached) handler({ revision: 1 })
  assert.deepEqual(seen, ['second:1'],
    'the handler that was detached must not fire, and the one that was not must')
})

/**
 * A refreshed token must not be swapped back out on the next scan.
 *
 * The on-disk snapshot keeps the issue time it was written with, so without a
 * stamp of its own a refreshed credential ties with the very file it replaced
 * and then loses the expiry tiebreaker to it: the next scan put the revoked
 * token back and every request rode it until it was refreshed again.
 */
test('a refreshed token is not swapped back for the dead one on disk', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const temporary = scratch('refresh-stamp')
  const auth = path.join(temporary, 'auth')
  // A dead token, a far-future expiry and an hour-old issue time: the snapshot
  // wins every tiebreaker except issue time, which is what the refresh stamps.
  writeSignIn(auth, {
    auth: {
      accessToken: 'dead-token', refreshToken: 'refresh-one',
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      lastRefreshTime: Date.now() - 60 * 60 * 1000,
    },
  })
  let refreshes = 0
  const pool = new WorkBuddyAccountPool({
    authDirs: [auth],
    client: {
      refreshToken: async () => {
        refreshes += 1
        return { accessToken: 'fresh-token', refreshToken: 'refresh-two', expiresInSec: 3600 }
      },
    },
  })
  try {
    assert.equal((await pool.scan()).length, 1)
    const id = pool.list()[0].id
    assert.equal(pool.list()[0].credential.accessToken, 'dead-token')
    assert.equal(await pool.refreshAccount(id), true, 'the refresh must be seen to change the token')
    assert.equal(pool.list()[0].credential.accessToken, 'fresh-token')
    // The rescan reads the file again, so this is the whole case.
    assert.equal((await pool.scan()).length, 1)
    assert.equal(pool.list()[0].credential.accessToken, 'fresh-token',
      'a rescan must not put the revoked token back in place of the working one')
    assert.equal(refreshes, 1, 'the scan must not need a second refresh to undo the first')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * A sealed sign-in the at-rest key cannot open is not a sign-out.
 *
 * WorkBuddy 5.6+ seals `accessToken` in a `$wbEncrypted` envelope whose key
 * lives in the installed app. With the app not running the field reads as
 * empty, which used to read as "not signed in": the pool reported an empty
 * pool for an account that was usable a moment ago.
 */
test('a sealed sign-in the key cannot open keeps the account the pool already has', async (t) => {
  // The key fetch asks the installed desktop app; there is none here and the
  // case is about what the pool does with an unopenable field.
  t.mock.method(require('../src/at-rest.ts'), 'encryptedFieldOpener', async () => undefined)
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const temporary = scratch('sealed')
  const auth = path.join(temporary, 'auth')
  const file = writeSignIn(auth)
  const pool = new WorkBuddyAccountPool({ authDirs: [auth] })
  try {
    assert.equal((await pool.scan()).length, 1, 'the readable snapshot must be listed')
    // The app seals the same file while its key is unavailable.
    fs.writeFileSync(file, JSON.stringify({
      auth: { accessToken: { $wbEncrypted: 1, envelope: 'sealed-envelope' }, refreshToken: '', expiresAt: Date.now() + 3600000 },
      account: { uin: 'u-1', nickname: 'Fixture' },
    }))
    assert.equal((await pool.scan()).length, 1,
      'a sealed file must not erase the account the panel is showing')
    assert.equal(pool.list()[0].credential.accessToken, 'original-token',
      'the credential already held must stay in force until the key is back')
    assert.equal(pool.list()[0].archived, undefined,
      'a file this build cannot open says nothing about the account: it is not a lost sign-in')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * The signature scan is handed a module path its own edition can load.
 *
 * `powershell` is Windows PowerShell 5.1, and it binds
 * `Microsoft.PowerShell.Security` by walking `PSModulePath` in order. Any machine
 * with a Store-installed PowerShell 7 carries that build's Modules directory
 * ahead of the system one, because the Store install prepends it to the variable
 * the desktop host inherited. 5.1 then binds the 7 build's copy of the module, the
 * import dies on a type-data conflict, and `Get-AuthenticodeSignature` throws for
 * every candidate. The scan's own catch swallows that, the policy function is
 * handed an empty status, and the at-rest key reads as "no WorkBuddy executable
 * found" on a machine holding two signed installs - which is what it read as
 * here, until the scan was given a path of its own.
 *
 * The chain is driven from a stubbed `node:child_process` and an environment
 * built here, so the case proves the child is handed a path of our own rather
 * than the ambient one, and that the path puts the system directory ahead of the
 * Store one. Dropping the option, or restoring the ambient order, fails it.
 */
test('the signature scan is handed a module path 5.1 can load', async () => {
  const spawns = []
  const ownRequire = createRequire(path.join(root, 'src/at-rest.ts'))
  const modules = path.join('C:\\Windows', 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
  const store = path.join('C:\\Program Files', 'WindowsApps', 'microsoft.powershell_7.6.7.0_x64__8wekyb3d8bbwe', 'Modules')
  const ambient = [
    path.join('C:\\Users\\fixture', 'Documents', 'PowerShell', 'Modules'),
    path.join('C:\\Program Files', 'PowerShell', 'Modules'),
    store,
    modules,
  ].join(';')
  const context = vm.createContext({
    require: (specifier) => specifier === 'node:child_process'
      ? { execFileSync: (file, args, options) => { spawns.push({ file, args, options }); return '' } }
      : ownRequire(specifier),
    // No install root the scan would find, so the only candidate source left is
    // the registry, and the only registry is the stub above.
    process: { env: { SystemRoot: 'C:\\Windows', PSModulePath: ambient }, platform: 'win32' },
    module: { exports: {} }, exports: {}, console: { log() {} }, Buffer,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/at-rest.ts'), 'utf8')), context)
  const { signatureScanEnv, encryptedFieldOpener } = context.module.exports
  assert.equal(typeof signatureScanEnv, 'function')
  await encryptedFieldOpener()
  assert.equal(spawns.length, 1, 'the scan runs exactly once')
  // Pinned by absolute path rather than resolved through PATH: the scan exists
  // because a user-level process can plant what runs, and a user-writable
  // directory is on the default PATH.
  assert.equal(spawns[0].file, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  const handed = spawns[0].options.env
  assert.notEqual(handed, undefined, 'the child must be handed an environment of our own, not the ambient one')
  const order = handed.PSModulePath.split(';')
  assert.equal(order[0], modules, 'the 5.1 modules directory leads the path the child is given')
  assert.ok(order.indexOf(modules) < order.indexOf(store),
    'the system modules directory precedes the Store PowerShell 7 one, which is the whole fix')
  assert.equal(order.length, ambient.split(';').length + 1,
    'nothing is dropped: a user\'s own modules still resolve behind the system one')
  assert.equal(signatureScanEnv({ SystemRoot: 'C:\\Windows', PSModulePath: ambient, PATH: 'unchanged' }).PATH, 'unchanged',
    'the rest of the environment is passed through untouched')
  assert.equal(signatureScanEnv({ SystemRoot: 'C:\\Windows', PSModulePath: order.join(';') }).PSModulePath, order.join(';'),
    'building it twice is a no-op, so the path cannot grow on every scan')
  assert.equal(signatureScanEnv({ PATH: 'unchanged' }).PATH, 'unchanged',
    'with no SystemRoot to derive from the environment is left as it is rather than given an invented path')
})

/**
 * Two sign-ins with no identity at all are two accounts.
 *
 * A credential with no `uin`, `uid` or `nickname` has nothing to key on but
 * where it came from. Hashing a shared constant instead folded every such
 * sign-in into one pool entry and silently dropped all but the first.
 */
test('two sign-ins with no identity at all stay two accounts', async () => {
  const { WorkBuddyAccountPool, workbuddyAccountId } = require('../src/accounts.ts')
  const temporary = scratch('idless')
  const dirs = [path.join(temporary, 'one'), path.join(temporary, 'two')]
  for (const dir of dirs) writeSignIn(dir, { account: {} })
  const pool = new WorkBuddyAccountPool({ authDirs: dirs })
  try {
    assert.equal((await pool.scan()).length, 2,
      'two identity-less sign-ins must not collapse into one pool entry')
    const idOf = (dir) => workbuddyAccountId({ sourcePath: path.join(dir, 'workbuddy-desktop.info') })
    assert.notEqual(idOf(dirs[0]), idOf(dirs[1]),
      'the source path is the only identity these carry, so it must key them apart')
    assert.equal(idOf(dirs[0]), workbuddyAccountId({ sourcePath: path.join(dirs[0], 'workbuddy-desktop.info') }),
      'the same file must still key to the same account')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * One cooldown policy, three bounds.
 *
 * The configured window is the user's own choice and is honoured even past the
 * parse layer's 2h ceiling. A raw timestamp handed in by a caller is not, and
 * must be clamped to the same ceiling - otherwise one mis-parsed reset sleeps
 * the whole pool for a day. The per-model map is bounded too: the key is
 * whatever model string the request carried, so a client that sprays distinct
 * ids could otherwise grow one map per account forever.
 */
test('cooldown policy honours the configured window, clamps a caller reset, and bounds the per-model map', async () => {
  const HOUR = 60 * 60 * 1000
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const temporary = scratch('penalize')
  const auth = path.join(temporary, 'auth')
  writeSignIn(auth)
  const configured = new WorkBuddyAccountPool({ authDirs: [auth], cooldownMs: 3 * HOUR })
  const supplied = new WorkBuddyAccountPool({ authDirs: [auth] })
  try {
    for (const pool of [configured, supplied]) await pool.scan()
    const id = supplied.list()[0].id

    configured.penalize(id)
    assert.ok(configured.list()[0].cooldownUntilMs > Date.now() + 2 * HOUR,
      'a configured cooldown past the 2h ceiling must be honoured, not clamped to it')

    supplied.penalize(id, Date.now() + 5 * HOUR)
    assert.ok(supplied.list()[0].cooldownUntilMs <= Date.now() + 2 * HOUR,
      'a caller-supplied reset past the ceiling must be clamped')
    assert.ok(supplied.list()[0].cooldownUntilMs > Date.now() + HOUR,
      'the clamp must still leave the account cooling')

    const account = supplied.list()[0]
    account.modelCooldowns['stale-model'] = Date.now() - 1000
    supplied.penalize(id, undefined, 'fresh-model')
    assert.equal(account.modelCooldowns['stale-model'], undefined,
      'a per-model cooldown that has passed must be dropped, not kept forever')
    assert.ok(account.modelCooldowns['fresh-model'] > Date.now(),
      'the model that was just limited must be cooling')
    for (let index = 0; index < 200; index += 1) {
      account.modelCooldowns[`model-${index}`] = Date.now() + 60_000 + index
    }
    supplied.penalize(id, undefined, 'model-199')
    assert.equal(Object.keys(account.modelCooldowns).length, 128,
      'the per-model map must be capped, not grown once per distinct model id')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

/**
 * A marker in the body only refines a status that is itself undecided.
 *
 * A 429 routinely quotes quota text, a 400 or 404 is a verdict on the request
 * whose body routinely quotes the quota it measured against, and a 5xx is an
 * upstream fault. Reading a marker on any of those as billing exhaustion
 * answered 402 for a limit that clears on its own, or rotated the whole pool
 * over prose. Only a status the upstream itself uses for "this account cannot
 * pay" takes a credit marker, and a session marker only means something on a
 * status about the sign-in: on a 500 it is prose, and rotating without cooling
 * the account meant every later attempt met the same wall.
 */
test('a marker in the body only refines a status that is itself undecided', () => {
  const { classifyUpstreamError } = require('../src/upstream.ts')
  const byBody = [
    // A limit is the upstream's own verdict, whatever quota text its body quotes.
    [429, 'insufficient credit, quota exceeded', 'soft_rate', 'a rate limit that quotes quota text must not read as billing exhaustion'],
    [429, '', 'soft_rate', 'the status the upstream uses for a limit still reads as one'],
    [503, '频率限制', 'soft_rate', 'a 503 that quotes a limit is the upstream shedding load, which reads as one'],
    // A request-side status is not refined by the quota its body quotes.
    [400, '积分不足', 'client', 'a 400 that quotes a quota is still a verdict on the request'],
    [400, '频率限制', 'client', 'a 400 that quotes a limit is a verdict on the request'],
    [400, '"code":6004', 'client', 'and so is its business-code spelling'],
    [422, 'insufficient credit', 'client'],
    [404, 'soft_rate', 'not_found', 'a model that does not exist stays a not-found'],
    // An upstream fault stays one whatever its body quotes.
    [500, '频率限制', 'server', 'an upstream fault stays one whatever its body quotes'],
    [500, '额度用尽', 'server', 'and so is a server error that quotes one'],
    [500, 'Offline user session not found', 'server', 'a session marker on a server error is prose, not a dead sign-in'],
    // Only a status the upstream uses for a spent account takes a credit marker.
    [402, '积分不足', 'hard_credit', 'the status the upstream uses for a spent account still reads as one'],
    [403, '额度用尽', 'hard_credit', 'and so does a 403 that quotes the quota'],
    // A session marker only means something on a status about the sign-in.
    [401, 'Offline user session not found', 'session_dead'],
    [401, '{"code": 12153}', 'session_dead', 'the envelope spelling of the session code must still be recognised'],
  ]
  for (const [status, body, kind, reason] of byBody) {
    assert.equal(classifyUpstreamError(status, body), kind,
      reason ?? `${status} with ${JSON.stringify(body)} must read as ${kind}`)
  }
})

/**
 * An oversized body is refused without breaking the socket that carries the
 * refusal.
 *
 * A destroy under a large upload mid-stream is answered by the OS with an RST,
 * and the 413 the caller is about to write is discarded with the socket - so
 * the client sees a reset rather than the answer. The drain listeners are
 * attached once as well: re-running that branch attached a fresh pair per
 * chunk, so a long upload grew the listener list without bound.
 */
test('an oversized body is refused without destroying the socket or piling up listeners', async () => {
  const { readRequestBody } = require('../src/loopback.ts')
  const listeners = new Map()
  const req = {
    destroyed: false,
    on(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
      return this
    },
    emit(type, ...args) { for (const handler of listeners.get(type) ?? []) handler(...args) },
    destroy() { this.destroyed = true },
  }
  const reading = readRequestBody(req)
  // 64MiB + 1: past the limit in one chunk, so nothing is buffered.
  req.emit('data', Buffer.alloc(64 * 1024 * 1024 + 1))
  assert.equal(req.destroyed, false,
    'the socket must not be destroyed under a large upload, or the 413 never reaches the client')
  // The rest of the upload keeps arriving chunk by chunk.
  for (let index = 0; index < 4; index += 1) req.emit('data', Buffer.alloc(1024))
  assert.equal(listeners.get('data').length, 1, 'the data listener must not be re-attached per chunk')
  assert.equal(listeners.get('end').length, 2, 'the drain listeners must be attached once, not per chunk')
  assert.equal(listeners.get('error').length, 2)
  req.emit('end')
  await assert.rejects(reading, /request body too large/,
    'a body past the limit must be refused, not buffered')
})

/**
 * The panel's own body cap is a thousand times tighter than a gateway's.
 *
 * The panel's requests are a channel name and a handful of settings, so it
 * accepts 64 KiB where a chat body may be 64 MiB. Sharing one reader between
 * them must not quietly hand the panel the gateway's figure: the cap is what
 * keeps a hung upload from pinning memory in a process that serves the whole
 * UI, and a thousand-fold loosening is invisible until it is not.
 */
test('the panel body cap is tighter than the gateway one, and both still parse', async () => {
  const { readJsonBody, readRequestBody } = require('../src/loopback.ts')
  const fakeRequest = () => {
    const listeners = new Map()
    return {
      destroyed: false,
      headers: {},
      on(type, handler) {
        const list = listeners.get(type) ?? []
        list.push(handler)
        listeners.set(type, list)
        return this
      },
      emit(type, ...args) { for (const handler of listeners.get(type) ?? []) handler(...args) },
      destroy() { this.destroyed = true },
      listeners,
    }
  }

  const gateway = fakeRequest()
  const gatewayRead = readRequestBody(gateway)
  gateway.emit('data', Buffer.from('{"ok":true}'))
  gateway.emit('end')
  assert.deepEqual(JSON.parse((await gatewayRead).toString('utf8')), { ok: true },
    'the gateway reader still takes a full-size body')

  const panel = fakeRequest()
  const panelRead = readJsonBody(panel, 65_536)
  panel.emit('data', Buffer.alloc(65_537))
  panel.emit('end')
  await assert.rejects(panelRead, /request body too large/,
    'a panel body past 64 KiB must be refused')

  const small = fakeRequest()
  const smallRead = readJsonBody(small, 65_536)
  small.emit('data', Buffer.from('{"channel":"xd.state"}'))
  small.emit('end')
  assert.deepEqual(await smallRead, { channel: 'xd.state' },
    'and a panel body inside it still parses')

  const empty = fakeRequest()
  const emptyRead = readJsonBody(empty, 65_536)
  empty.emit('end')
  assert.deepEqual(await emptyRead, {}, 'a body-less panel call reads as an empty object')
})

/**
 * A subscription gate is a failure wherever the frame chose to put its code.
 *
 * Trae has delivered code 1005 as `event: error`, as a bare top-level `code`
 * under `event: message`, nested under `error`/`details`, and as a JSON
 * document inside `message`. Keying on the event name alone let it through as
 * content, which answered the client with an empty 200 turn and no error.
 */
test('a Trae subscription gate is a failure wherever the frame put its code', () => {
  const { SseDecoder, decodeTraeEvent } = require('../src/trae-sse.ts')
  const { traeFailureOf } = require('../src/trae-shim.ts')
  const failureOf = (wire) => traeFailureOf(decodeTraeEvent(new SseDecoder().push(wire)[0]))

  assert.equal(failureOf('event: message\ndata: {"code":1005}\n\n')?.code, 1005)
  assert.equal(failureOf('data: {"error":{"code":1005,"message":"gate"}}\n\n')?.code, 1005)
  assert.equal(failureOf('data: {"details":{"errorCode":"1005"}}\n\n')?.code, 1005)
  assert.equal(failureOf('data: {"message":"{\\"code\\":1005}"}\n\n')?.code, 1005)

  // Controls: a keepalive and a content frame are not refusals.
  assert.equal(failureOf('event: message\ndata: {"code":0}\n\n'), undefined,
    'a keepalive that happens to carry code 0 is not a refusal')
  assert.equal(failureOf('event: output\ndata: {"response":"hello"}\n\n'), undefined,
    'a content frame is not a refusal')
  assert.equal(failureOf('event: done\ndata: {"finish_reason":"stop"}\n\n'), undefined,
    'a terminal frame is not a refusal')
})

/**
 * An empty `choices` means two different things and only one of them is a
 * refusal.
 *
 * Qoder's token-accounting frame carries `choices: []` with a top-level
 * `usage`, and it must be forwarded as a chunk. A frame with an empty
 * `choices`, no usage and an error code is a refusal wearing a chunk's
 * clothes: forwarding it answered the client with an empty turn.
 */
test('a Qoder token-accounting frame is forwarded and an empty refusal is not', () => {
  const { decodeQoderFrame } = require('../src/qoder-sse.ts')
  const refused = decodeQoderFrame('{"choices":[],"errorCode":"10605","message":"quota reached"}')
  assert.equal(refused.type, 'failure')
  assert.equal(refused.code, '10605')
  // The code buried one level down is the same refusal.
  assert.equal(decodeQoderFrame('{"choices":[],"error":{"code":10605}}').type, 'failure')
  const accounting = decodeQoderFrame('{"choices":[],"usage":{"total_tokens":42}}')
  assert.equal(accounting.type, 'chunk', 'the token-accounting frame must still be forwarded')
})

/**
 * A sign-in that answers 401 hands the turn to the next one in the list.
 *
 * Both gateways walk their ordered credentials and rotate past a failure that
 * belongs to the sign-in rather than to the request. The header each attempt
 * sent is what proves which credential served: a rotation that retried the
 * same dead sign-in, or one that never rotated at all, is visible there.
 */
test('a sign-in that answers 401 hands the turn to the next one in the list', async (t) => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  // The directory is stubbed so nothing here walks a vendor endpoint; the
  // `fetchImpl` below only ever sees the chat call.
  t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchModels',
    async () => ({ models: [{ id: 'fixture-model', name: 'Fixture', function: 'chat' }], partial: false }))
  t.mock.method(QoderUpstreamClient.prototype, 'fetchModels',
    async () => [{ id: 'fixture-model', name: 'Fixture', supportsImages: false }])
  const WIRE = {
    trae: 'event: output\ndata: {"response":"hello"}\n\nevent: done\ndata: {}\n\n',
    qoder: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  }

  for (const source of ['trae', 'qoder']) {
    // Trae spells its credential into `Authorization`; Qoder seals it and
    // names the user in `Cosy-User`. Either way the attempt is identifiable.
    const identify = source === 'trae'
      ? (headers) => headers['Authorization']
      : (headers) => headers['Cosy-User']
    const dead = source === 'trae' ? 'Cloud-IDE-JWT dead-token' : 'dead-user'
    const live = source === 'trae' ? 'Cloud-IDE-JWT live-token' : 'live-user'
    const credentials = source === 'trae'
      ? [{ accessToken: 'dead-token', userId: 'dead-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
        { accessToken: 'live-token', userId: 'live-user', edition: 'cn', host: '', source: 'desktop', expiresAtMs: Date.now() + 3600000 }]
      : [{ region: 'cn', userID: 'dead-user', token: 'dead-token', name: '', email: '', expiresAtMs: Date.now() + 3600000, refreshTokenExpiresAtMs: Date.now() + 3600000 },
        { region: 'cn', userID: 'live-user', token: 'live-token', name: '', email: '', expiresAtMs: Date.now() + 3600000, refreshTokenExpiresAtMs: Date.now() + 3600000 }]
    const sent = []
    const fetchImpl = async (url, init) => {
      const who = identify(init?.headers ?? {})
      sent.push(who)
      return who === dead
        ? new Response('sign-in expired', { status: 401 })
        : new Response(WIRE[source], { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    const gateway = source === 'trae'
      ? createTraeGateway({ port: 0, credentials: async () => credentials, identity: async () => ({ machineId: 'm', deviceId: 'd', platform: 'win32' }), fetchImpl })
      : createQoderGateway({ region: 'cn', port: 0, credentials: async () => credentials, fetchImpl })
    try {
      await gateway.ready
      const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', connection: 'close', Authorization: 'Bearer x' },
        body: JSON.stringify({ model: 'fixture-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(answer.status, 200, `${source}: the second sign-in must serve the turn`)
      assert.match(await answer.text(), /hello/)
      assert.deepEqual(sent, [dead, live],
        `${source}: the dead sign-in must be tried first and the live one must serve`)
    } finally { await gateway.close() }
  }
})

/**
 * A discovery answer is reused inside its TTL and dropped by a rescan.
 *
 * The read walks and decrypts every candidate file, so a short TTL keeps it
 * off the chat path. What the TTL must not do is outlive the user's rescan:
 * the panel's rescan is exactly the moment the answer on disk has changed.
 */
test('a discovery answer is reused inside its TTL and dropped by a rescan', async () => {
  const trae = require('../src/trae-discovery.ts')
  const qoder = require('../src/qoder-credentials.ts')
  const { qoderStorageCandidates } = require('../src/qoder-discovery.ts')
  // Both readers probe the machine's own app directories. Pointing every root
  // they consult at one scratch tree makes the candidate set hermetic.
  const temporary = scratch('discovery')
  const restore = {}
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME']) {
    restore[key] = process.env[key]
    process.env[key] = temporary
  }
  // A CLI token is the one sign-in shape that needs no key or blob: a
  // three-part JWT whose payload names the user.
  const cli = trae.traeStorageCandidates().find((candidate) => candidate.source === 'cli')
  const payload = Buffer.from(JSON.stringify({ data: { user_id: 'cli-user' } })).toString('base64url')
  fs.mkdirSync(path.dirname(cli.path), { recursive: true })
  const authBlob = qoderStorageCandidates().find((candidate) => candidate.kind === 'auth-v1')
  fs.mkdirSync(path.dirname(authBlob.path), { recursive: true })
  try {
    trae.resetTraeCredentialCache()
    qoder.resetQoderCredentialCache()
    fs.writeFileSync(cli.path, ['header', payload, 'signature'].join('.'))
    fs.writeFileSync(authBlob.path, Buffer.from('v10-sealed-blob'))
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 1,
      'the scratch sign-in must be discovered')
    assert.equal((await qoder.discoverQoderCredentials()).failures.length, 1,
      'the scratch Qoder slot must be walked too')

    // The desktop app signs out: both files go away.
    fs.rmSync(cli.path)
    fs.rmSync(authBlob.path)
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 1,
      'the cached answer must still be served inside its TTL')
    // Qoder's empty answer is the one case the TTL does not hold: a read that
    // found nothing is re-read, so a chat is never answered from an empty cache
    // a transient failure left behind.
    assert.equal((await qoder.discoverQoderCredentials()).failures.length, 0,
      'an answer that found nothing is re-read rather than cached')

    trae.resetTraeCredentialCache()
    qoder.resetQoderCredentialCache()
    assert.equal((await trae.discoverTraeCredentials()).credentials.length, 0,
      'a rescan must re-read the directories')
    assert.equal((await qoder.discoverQoderCredentials()).failures.length, 0,
      'a rescan must re-read the Qoder directories too')
  } finally {
    for (const key of Object.keys(restore)) {
      if (restore[key] === undefined) delete process.env[key]
      else process.env[key] = restore[key]
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A settings document an earlier version wrote still reaches the editor.
 *
 * The schema is `z.any()`, so the host does not strip the top-level
 * `imageModelIds` / `contextBudgets` an older build wrote. Without the fold
 * they were read as nothing: a hand-edited or older settings file silently
 * lost the user's per-model image toggle and context window. The bar is the
 * one `parseOverride` applies on save, so a figure no save could have produced
 * is refused here too rather than stored.
 */
test('a settings document written by an earlier version still reaches the editor', async () => {
  const host = loadHost()
  try {
    const folded = host.internals.normalizeSelection({
      imageModelIds: ['model-a', 'model-b', 7],
      contextBudgets: { 'model-a': 4096, 'model-c': 0, 'model-d': 4096.5, 'model-e': 0xffffffff + 1 },
      overrides: { 'model-a': { alias: 'Renamed' } },
    })
    assert.deepEqual(JSON.parse(JSON.stringify(folded)), {
      overrides: {
        'model-a': { alias: 'Renamed', supportsImages: true, contextWindow: 4096 },
        'model-b': { supportsImages: true },
      },
    }, 'the legacy fields must be folded into the overrides the editor reads')
    // A value no save could have produced is refused on the same terms.
    assert.equal(folded.overrides['model-c'], undefined, 'a zero budget must be refused')
    assert.equal(folded.overrides['model-d'], undefined, 'a fractional budget must be refused')
    assert.equal(folded.overrides['model-e'], undefined, 'a budget past the ceiling must be refused')
    // Controls: nothing to fold still folds to nothing.
    assert.deepEqual(JSON.parse(JSON.stringify(host.internals.normalizeSelection({}))), {})
    assert.deepEqual(JSON.parse(JSON.stringify(host.internals.normalizeSelection(null))), {})
  } finally { host.cleanup() }
})

/**
 * The collected check-in slots live on disk, and the record stays shallow.
 *
 * `autoCheckinSlots` is this process's own copy; without a record under the
 * data root a restart after the morning hour forgot every slot and re-ran the
 * whole pass. The file holds one array per campaign day and is pruned on the
 * way out, so a machine that runs for months does not grow it without bound.
 */
test('the collected check-in slots survive a restart and stay three days deep', async () => {
  const temporary = scratch('checkin-slots')
  const dayKey = (offset) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - offset * 86400000))
  // Five days of earlier runs, in the shape the file holds.
  fs.writeFileSync(path.join(temporary, 'checkin-slots.json'), JSON.stringify(
    Object.fromEntries([5, 4, 3, 2, 1].map((offset) => [dayKey(offset), [`${dayKey(offset)}T09`]])),
  ))
  const settings = {
    enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false,
    disabledRegions: [], autoCheckin: { enabled: false, hours: [9] },
  }
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
    await plugin.onPanelInvoke('xd.runCheckinNow')
    const written = JSON.parse(fs.readFileSync(path.join(temporary, 'checkin-slots.json'), 'utf8'))
    assert.deepEqual(Object.keys(written).sort(), [dayKey(2), dayKey(1), dayKey(0)].sort(),
      'a day older than the keep window can never be due again, so the record must not grow past three days')
    assert.ok(written[dayKey(0)].length > 0,
      "today's pass must be recorded, or a restart after the morning hour runs it twice")
  } finally {
    await stopRegisteredService()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The panel page is served with a strict policy, and a page on another site
 * cannot frame it.
 *
 * The policy is a response header rather than the page's own `<meta>`, which
 * `panelHtml` strips: one copy serves both embeddings, and a meta that
 * survived the strip would intersect with the header and block the bridge's
 * inline script. `frame-ancestors 'self'` is what stops a foreign page from
 * framing the panel's mutating controls - the host card frames it same-origin.
 */
test('the panel page carries a strict policy and refuses a cross-site asker', async () => {
  const { registerPanelRoutes, PANEL_BASE } = require('../src/web-panel.ts')
  const { createServer, request } = require('node:http')
  const routes = new Map()
  registerPanelRoutes({
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }, {
    pluginRoot: root, invoke: async () => ({}), logger: { warn() {} }, effect: (callback) => callback(),
  })
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const ask = (headers) => new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: `${PANEL_BASE}/panel`, method: 'GET',
      headers: { Host: `127.0.0.1:${port}`, ...headers },
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }))
    })
    req.on('error', reject)
    req.end()
  })
  try {
    const page = await ask({})
    assert.equal(page.status, 200, 'the panel page must be served')
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/,
      'a page on another site must not be able to frame the panel\'s mutating controls')
    assert.match(page.headers['content-security-policy'], /default-src 'none'/,
      'the policy must be the strict one, not a permissive default')
    assert.equal(page.headers['x-content-type-options'], 'nosniff',
      'the panel document must never be sniffed')
    // A browser framing the panel from another site says so in
    // `Sec-Fetch-Site`; a client that is not a browser sends neither header.
    assert.equal((await ask({ 'Sec-Fetch-Site': 'cross-site' })).status, 403,
      'a cross-site asker must be refused')
    assert.equal((await ask({ 'Sec-Fetch-Site': 'same-origin' })).status, 200,
      'the host card frames the panel same-origin')
    assert.equal((await ask({ 'Sec-Fetch-Site': 'none' })).status, 200,
      'a non-browser client sends neither header and must pass')
    assert.equal((await ask({ Origin: 'https://evil.example.com' })).status, 403,
      'a foreign Origin must still be refused')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

/**
 * The attachment store is resolved per call, not captured at build time.
 *
 * The contract resolves the store at request time, and the harness can
 * re-provide `attachments` between the build and the first request that needs
 * it. Reading it once while the adapter is constructed answered every image
 * turn with "no store" on a host that had one by then.
 */
test('the attachment store is resolved per call, not captured at build time', async () => {
  const { createProvider } = await import('@earendil-works/pi-ai')
  const { resolveRetryPolicy } = require('@deepseek-ai/dsh-llm')
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  const functions = ['toPiModel', 'buildAdapter'].map((name) => {
    const match = source.match(new RegExp('^function ' + name + '\\([^]*?^}$', 'm'))
    assert.ok(match, name + ' factory must exist')
    return match[0]
  }).join('\n')
  // A stub that records the options the real adapter is constructed with, so
  // the resolver can be called the way the contract calls it.
  class RecordingAdapter {
    constructor(options) {
      if (options.resolveAttachments !== undefined) this.resolveAttachments = options.resolveAttachments
    }
  }
  RecordingAdapter.prototype.resolveModel = async () => ({})
  RecordingAdapter.prototype.prepareCall = async () => ({ model: {}, stream: () => {} })
  RecordingAdapter.prototype.stream = () => {}
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, PiAiAdapter: RecordingAdapter, createProvider, resolveRetryPolicy,
    withDelegateShape: (value) => value, openAICompletionsApi: () => ({}),
    resolveImageAttachmentAccess: () => { throw new Error('this case must not touch images') },
    THINKING_LEVELS: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    NO_COST: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, STREAM_IDLE_TIMEOUT_MS: 300000,
    REQUEST_IMAGE_BUDGETS: {}, INERT_AUTH: { credentials: {}, authContext: {} }, LOOPBACK_BEARER: 'test',
    CONSERVATIVE_CONTEXT_WINDOW: 128000, DEFAULT_MAX_TOKENS: 32000,
  })
  vm.runInContext(transpile(functions + '\nmodule.exports = buildAdapter;'), context)
  const stores = {}
  const { adapter } = context.module.exports([{
    id: 'test-provider', name: 'test-provider', baseUrl: 'http://127.0.0.1:1/v1',
    models: [{ id: 'first', thinkingLevels: ['off', 'low'], defaultThinkingLevel: 'low' }],
  }], { get: (key) => stores[key], logger: { error() {} } })
  assert.equal(typeof adapter.resolveAttachments, 'function',
    'the adapter must be given an attachment resolver')
  assert.equal(adapter.resolveAttachments(), undefined,
    'a host that has provided no store yet answers undefined')
  stores.attachments = { id: 'first-store' }
  assert.equal(adapter.resolveAttachments()?.id, 'first-store')
  // The store the harness provides after the build must still be seen.
  stores.attachments = { id: 'second-store' }
  assert.equal(adapter.resolveAttachments()?.id, 'second-store',
    'a store provided after the build must still be seen by the request that needs it')
})

/**
 * `src/host.ts` in an isolated context, with the internals a case needs.
 *
 * The core is loaded whole rather than as a slice of its text, so a case drives
 * the shipped module. `settings` is the document the bridge starts with; the
 * bridge is a stub, so nothing here touches a real install.
 */
function loadHost(overrides = {}) {
  const temporary = scratch('host')
  const settings = { enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false, ...overrides }
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  ownRequire('./pi-compat.ts').installPi({
    getSettings: () => ({ ...settings }), setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary, declareProviders: () => ({ ok: true, changed: false }),
  })
  const module = { exports: {} }
  const context = vm.createContext({
    require: ownRequire, module, exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Buffer, process, TextEncoder, TextDecoder,
  })
  context.exports = module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8'))
    + '\nmodule.exports.__internals = { normalizeSelection }\n', context, { filename: 'src/host.ts' })
  return { plugin: module.exports, internals: module.exports.__internals, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) }
}

/**
 * A transport failure is a 502 the client can act on, not a 500 about a status
 * code.
 *
 * A fetch that never reaches the upstream reports status 0, and `writeHead(0)`
 * throws: the answer the client got was a 500 carrying `Invalid status code: 0`
 * instead of the transport error that actually happened. That regression came
 * back once already, so the mapping is pinned against a `fetchImpl` that throws
 * for every credential.
 */
test('a Trae transport failure is answered 502 with the transport message', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const credentials = [
    { accessToken: 'token-a', userId: 'user-a', edition: 'cn', host: 'https://api.trae.cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
    { accessToken: 'token-b', userId: 'user-b', edition: 'cn', host: 'https://api.trae.cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 },
  ]
  const chats = []
  const fetchImpl = async (url) => {
    const target = String(url)
    // The directory is served so the request gets as far as the chat call: the
    // 503 a cold directory answers says nothing about the status mapping.
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats.push(target)
    throw new Error('fixture transport collapse')
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => credentials, fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 502, 'a transport failure must be answered as a bad gateway, not as a plugin bug')
    assert.equal(chats.length, 2, 'a transport failure belongs to no sign-in, so every one of them is tried')
    assert.match(body, /fixture transport collapse/, 'the answer must carry the reason the transport gave')
    assert.doesNotMatch(body, /Invalid status code/,
      'writeHead(0) throws, and that 500 hides the refusal the client could act on')
  } finally { await gateway.close() }
})

/**
 * The credit readout stops polling for good when the feature is switched off.
 *
 * `show: false` alone is indistinguishable from another plugin's model, which is
 * a wait rather than a stop: the readout would keep asking every five minutes
 * for a balance that is never coming. `enabled: false` is the one field that
 * tells it to give up, and it has to come from the channel the readout polls.
 */
test('the composer readout is told to stop polling when the feature is off', async () => {
  // `onLoad` is what adopts the bridge's document into the module, so both halves
  // go through it; the readout then answers from the document the user saved.
  const host = loadHost({ showComposerPoints: false })
  try {
    await host.plugin.onLoad()
    // Cross-realm: the host runs in its own context, so the answer is round-tripped
    // through JSON before it is compared.
    const off = await host.plugin.onPanelInvoke('xd.composerPoints', {})
    assert.deepEqual(JSON.parse(JSON.stringify(off)), { show: false, ours: false, enabled: false },
      'the switched-off answer must say so, or the readout waits on a balance that will never arrive')
  } finally {
    await host.plugin.onUnload()
    host.cleanup()
  }

  // The control: the same channel with the feature on answers `enabled: true`,
  // so the field above is the switch and not a constant.
  const on = loadHost({ showComposerPoints: true })
  try {
    await on.plugin.onLoad()
    const answer = await on.plugin.onPanelInvoke('xd.composerPoints', {})
    assert.equal(answer.enabled, true, 'with the feature on the readout must keep polling')
    assert.equal(answer.show, false, 'nothing is published for this fixture, so there is still no balance to show')
  } finally {
    await on.plugin.onUnload()
    on.cleanup()
  }
})

/**
 * A directory read that just failed is not walked again inside the backoff.
 *
 * Each attempt walks five upstream functions, each with its own 30s timeout, so
 * a black-holed directory host otherwise stalled every chat request for the
 * length of the whole walk before it could answer 503. The backoff is what makes
 * the second request inside the window answer at once, and it has to be visible
 * in the calls the upstream actually receives.
 */
test('a Trae directory read that just failed is not retried inside the backoff', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  let directoryReads = 0
  const fetchImpl = async () => {
    directoryReads += 1
    return new Response('upstream down', { status: 500 })
  }
  const gateway = createTraeGateway({
    port: 0,
    credentials: async () => [{ accessToken: 'fixture', userId: 'fixture', edition: 'cn', host: 'https://api.trae.cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }],
    identity: async () => ({ machineId: 'm', deviceId: 'd', platform: 'win32' }),
    fetchImpl,
  })
  const ask = () => fetch(gateway.baseUrl() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  try {
    await gateway.ready
    const first = await ask()
    assert.equal(first.status, 503, 'a directory that answers nothing leaves no roster to call with')
    assert.ok(directoryReads > 0, 'the first request must really have walked the directory')
    const afterFirst = directoryReads

    const started = Date.now()
    const second = await ask()
    const elapsed = Date.now() - started
    assert.equal(second.status, 503, 'the second request must still be refused, just not slowly')
    assert.equal(directoryReads, afterFirst,
      'a directory read that failed a moment ago must not be walked again inside the backoff window')
    assert.ok(elapsed < 5000,
      `the backoff must answer fast rather than walk five upstream functions again (took ${elapsed}ms)`)
  } finally { await gateway.close() }
})

/**
 * A `choices` that is not a list is not a chunk.
 *
 * The decoder reads output off `Array.isArray(choices)`, and a payload whose
 * `choices` arrived as an object has neither output nor usage to forward.
 * Forwarding it anyway answered the client with an empty turn wearing a 200.
 */
test('a Qoder frame whose choices is not a list is not forwarded as a chunk', () => {
  const { decodeQoderFrame } = require('../src/qoder-sse.ts')
  const frame = decodeQoderFrame('{"choices":{}}')
  assert.notEqual(frame.type, 'chunk',
    'a choices that is not a list carries no output, so it must not be relayed as one')
  assert.equal(frame.type, 'unknown', 'with no code and no usage there is nothing to report either')
  // The control: the same field as a list is still a chunk, or the case above
  // would pass for a decoder that forwards nothing at all.
  assert.equal(decodeQoderFrame('{"choices":[{"delta":{"content":"hi"}}]}').type, 'chunk')
})



/**
 * The cached OSCrypt key survives the reader that zeroes its own copy.
 *
 * The reader zeroes the buffer it was handed, and the cache used to hand out
 * the very buffer it kept: the first read in a process worked and every later
 * one decrypted with an empty key, which reads as an unopenable sign-in for
 * the rest of the process. A machine only saw it once the discovery TTL had
 * expired, because until then the cached answer was served without a read.
 *
 * The blob is a real AES-256-GCM ciphertext under a known key, and the DPAPI
 * unwrap is the stubbed seam (the one that would need the installed app), so
 * the decipher and the cache are the real code.
 */
test('a second Qoder read in one process still opens the sealed session', async () => {
  const { EventEmitter } = require('node:events')
  const { createCipheriv } = require('node:crypto')
  const { readQoderCredential, resetQoderCredentialCache } = require('../src/qoder-credentials.ts')
  const { qoderStorageCandidates } = require('../src/qoder-discovery.ts')
  const temporary = scratch('xdpool-qoder-key-')
  const restore = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
  process.env.APPDATA = temporary
  process.env.USERPROFILE = temporary
  process.env.HOME = temporary
  const key = Buffer.alloc(32, 7)
  const nonce = Buffer.alloc(12, 3)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify({ token: 'qoder-token', user: { id: 'user-1' } }), 'utf8'),
    cipher.final(),
  ])
  const blob = Buffer.concat([Buffer.from('v10'), nonce, sealed, cipher.getAuthTag()])
  const child = require('node:child_process')
  const realSpawn = child.spawn
  child.spawn = () => {
    const fake = new EventEmitter()
    fake.stdout = new EventEmitter()
    fake.stdout.setEncoding = () => {}
    fake.stderr = new EventEmitter()
    fake.stderr.setEncoding = () => {}
    fake.kill = () => {}
    // The unwrap writes the blob on stdin and reads the key on stdout; both
    // listeners are attached by the time stdin is ended.
    fake.stdin = {
      end: () => {
        fake.stdout.emit('data', key.toString('base64'))
        fake.emit('close', 0)
      },
    }
    return fake
  }
  try {
    const candidates = qoderStorageCandidates()
    const auth = candidates.find((candidate) => candidate.kind === 'auth-v1')
    const local = candidates.find((candidate) => candidate.kind === 'local-state')
    fs.mkdirSync(path.dirname(auth.path), { recursive: true })
    fs.writeFileSync(auth.path, blob)
    // A Local State whose encrypted_key is a DPAPI blob, so the unwrap reaches
    // the stubbed spawn rather than refusing the file.
    fs.writeFileSync(local.path, JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(48)]).toString('base64') },
    }))
    resetQoderCredentialCache()
    const group = candidates.filter((candidate) => candidate.appDir === auth.appDir)
    const first = await readQoderCredential(group)
    assert.equal(first.credential?.token, 'qoder-token', 'the first read must open the session')
    const second = await readQoderCredential(group)
    assert.equal(second.credential?.token, 'qoder-token',
      'the second read must open it too: the reader zeroes its own copy, not the cached key')
  } finally {
    child.spawn = realSpawn
    for (const name of Object.keys(restore)) {
      if (restore[name] === undefined) delete process.env[name]
      else process.env[name] = restore[name]
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The response-headers deadline is not the stream's deadline.
 *
 * A signal handed to `fetch` stays attached to the response body: undici errors
 * the body when it fires, so a deadline meant for the headers phase cut every
 * turn that ran longer than the deadline. Measured on this machine, WorkBuddy
 * turns died at 60s and Trae and Qoder turns at 120s, the client meeting a
 * reset connection with the reply half-read. The fixture drips its body slower
 * than the headers deadline on purpose: the whole stream must still arrive.
 */
test('a chat stream outlives its response-headers deadline', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const pieces = ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n', 'data: [DONE]\n\n']
  let served = 0
  const fetchImpl = async (_url, init) => {
    served += 1
    const signal = init?.signal
    return new Response(new ReadableStream({
      async start(next) {
        // Faithful to what undici does with the signal it is handed: it stays
        // attached to the body, and firing it errors the stream. A fixture that
        // ignored the signal could not tell a headers deadline from a stream
        // deadline, which is the whole difference under test.
        signal?.addEventListener('abort', () => next.error(signal.reason))
        for (const piece of pieces) {
          await new Promise((resolve) => setTimeout(resolve, 30))
          if (signal?.aborted === true) { next.error(signal.reason); return }
          next.enqueue(new TextEncoder().encode(piece))
        }
        next.close()
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 40, idleMs: 5000 })
  assert.equal(result.ok, true, 'the request itself must succeed')
  if (!result.ok) return
  const body = await result.response.text()
  assert.match(body, /"content":"he"/, 'the first piece of the stream must arrive')
  assert.match(body, /"content":"llo"/, 'and so must the last: the headers deadline may not cut the body')
  assert.match(body, /\[DONE\]/, 'the stream must run to its own end')
  assert.equal(served, 1, 'one request, one stream')
})

/**
 * A body that stops sending mid-turn fails the stream, through the client.
 *
 * The watchdog was reachable only by lifting the function out of the shipped
 * module, which proved the function and nothing about the wiring: the fetch's
 * own deadline always fired first, so the watchdog never ran at all. This goes
 * through the client, so the body really is the one the watchdog wraps.
 */
test('a silent body fails the stream through the client that opened it', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const fetchImpl = async () => new Response(new ReadableStream({
    start(next) { next.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')) },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 5000, idleMs: 40 })
  assert.equal(result.ok, true, 'the headers arrived, so the stream is open')
  if (!result.ok) return
  await assert.rejects(result.response.text(), /upstream stream went idle/,
    'a body that stops sending must end the relay in an error the client can see')
})

/**
 * A chat request that never answers is cut at the headers deadline.
 *
 * The deadline exists for the upstream that accepts the POST and then goes
 * quiet, which used to hold the turn until the host's own fetch timeout. It has
 * to fire while the request is still waiting for headers, and it has to surface
 * as the transport failure the failover rotates on.
 */
test('a chat request that never answers is cut at the headers deadline', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason))
  })
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const result = await client.chatStream(credential, '{}', undefined, { headersMs: 40 })
  assert.equal(result.ok, false, 'a request that never answers must fail rather than hang')
  if (result.ok) return
  assert.equal(result.status, 0, 'the failure is a transport one, which is what rotates')
  assert.match(result.message, /transport error/, 'the answer must carry the deadline as its reason')
})

/**
 * A connection that dies during the peek still rotates to the next sign-in.
 *
 * The peek reads ahead before anything reaches the client, and a transport
 * failure inside it escaped `attemptOnce` altogether: the turn was answered
 * with a plugin-level 500 and the second sign-in was never tried, even though a
 * transport failure belongs to no sign-in and every one of them is worth a try.
 */
test('a connection that dies during the peek still rotates to the next sign-in', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const first = { accessToken: 'token-a', userId: 'user-a', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const second = { accessToken: 'token-b', userId: 'user-b', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  let chats = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats += 1
    if (chats === 1) {
      // 200 headers, then the connection dies before the peek has a frame.
      return new Response(new ReadableStream({
        start(next) { next.error(new TypeError('terminated')) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('data: {"response":"served by the second sign-in"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [first, second], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.equal(answer.status, 200, 'the sign-in behind the broken connection must serve the turn')
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
    assert.equal(chats, 2, 'the broken connection must cost one attempt, not the whole turn')
  } finally { await gateway.close() }
})

/**
 * A Trae refusal is recognised on the event names the shape decoder files as
 * content and as a terminator.
 *
 * The refusal recogniser only looked at frames the decoder could not place, and
 * Trae sends the subscription gate on `event: output` and `event: done` as
 * readily as on a bare frame: those were answered as an empty 200 turn with no
 * error at all. The other direction matters just as much - a bare code in the
 * 400..1004 band is bookkeeping, and reading it as a refusal turned healthy
 * turns into 4xx answers.
 */
test('a Trae refusal is recognised wherever the frame put it, and only there', () => {
  const { decodeTraeEvent } = require('../src/trae-sse.ts')
  const { traeFailureOf } = require('../src/trae-shim.ts')
  const of = (data, event) => traeFailureOf(decodeTraeEvent({ data, ...event === undefined ? {} : { event } }))
  // A refusal on the two event names that decode as an empty delta and as a
  // terminator, plus the bare spelling.
  assert.equal(of('{"code":1005,"message":"subscription gate"}', 'output')?.code, 1005,
    'a refusal riding on the output event name must not pass as an empty turn')
  assert.equal(of('{"code":4001,"message":"bad config"}', 'done')?.code, 4001,
    'a refusal riding on the done event name must not pass as a clean finish')
  assert.equal(of('{"code":1005,"response":"","message":"gate"}')?.code, 1005,
    'the bare spelling of the same refusal is still a refusal')
  // The other direction: a code with no words in the undocumented band is
  // bookkeeping, and Trae's own codes above 1005 speak for themselves.
  assert.equal(of('{"code":429}'), undefined, 'a bare 429 is a usage figure until it says otherwise')
  assert.equal(of('{"code":400}'), undefined, 'a bare 400 is metadata until it says otherwise')
  assert.equal(of('{"code":1005}')?.code, 1005, 'a code in Trae\'s own range is a refusal on its own')
  assert.equal(of('{"prompt_tokens":10,"code":429}', 'token_usage'), undefined,
    'a usage frame is bookkeeping whatever code it carries')
  assert.equal(of('{"response":"hi","code":1005}', 'output'), undefined,
    'a frame that carries output is content, whatever else it says')
})

/**
 * A Qoder refusal spelled as a bare string is still a failure.
 *
 * The unwrap read the code from `errorCode`/`code` and the message from
 * `message`/`errorMessage`, and only descended into `error`/`details` when they
 * were objects. Qoder spells a refusal `{"choices":[],"error":"Login expired"}`
 * as often as it spells one with a code, and those frames were dropped as
 * unnamed, which answered the client with an empty turn and no error.
 */
test('a Qoder refusal spelled as a bare string is still a failure', () => {
  const { decodeQoderFrame } = require('../src/qoder-sse.ts')
  assert.equal(decodeQoderFrame('{"choices":[],"error":"Login expired"}').type, 'failure',
    'a refusal whose only text sits in a bare error string must not be dropped')
  assert.equal(decodeQoderFrame('{"choices":[],"details":"quota spent"}').type, 'failure',
    'the same text under details is the same refusal')
  assert.equal(decodeQoderFrame('{"choices":[],"errcode":"110"}').type, 'failure',
    'the errcode spelling is a code like any other')
  // The controls: the token-accounting frame is still a chunk, and a keepalive
  // with neither a code nor words is still unnamed.
  assert.equal(decodeQoderFrame('{"choices":[],"usage":{"total_tokens":42}}').type, 'chunk')
  assert.equal(decodeQoderFrame('{"success":true}').type, 'unknown')
})

/**
 * An upstream rate limit carries its own wait time to the client.
 *
 * The in-stream path relays the wait the upstream put in its frame; the
 * non-2xx path dropped the `Retry-After` header, so a client told to wait had
 * no wait to read and retried straight back into the limited account.
 */
test('an upstream rate limit carries its own wait time to the client', async () => {
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  const limited = { userID: 'limited-user', token: 'limited-token', name: '', email: '' }
  const fetchImpl = async (url) => {
    if (String(url).includes('/model/list')) {
      return new Response(JSON.stringify({ chat: [{ key: 'qoder-model', display_name: 'Qoder', enable: true }] }))
    }
    return new Response(JSON.stringify({ code: 429, message: 'slow down' }), {
      status: 429, headers: { 'retry-after': '120' },
    })
  }
  const gateway = createQoderGateway({ region: 'cn', port: 0, credentials: async () => [limited], fetchImpl })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'qoder-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 429, 'the upstream\'s own status is what the client is answered with')
    assert.equal(answer.headers.get('retry-after'), '120',
      'the wait the upstream named must reach the client instead of being dropped')
  } finally { await gateway.close() }
})

/**
 * A Qoder session that records no expiry is not read as long dead.
 *
 * The numeric fallback ran `Date.parse` over whatever was left, and `0` parses
 * as the year 2000: a layout that spells "no expiry" as 0 had its sign-in
 * dropped out of rotation for looking decades old.
 */
test('a Qoder session that records no expiry stays in rotation', () => {
  const { parseQoderAuthSession } = require('../src/qoder-credentials.ts')
  const session = (expiresAt) => JSON.stringify({ token: 'fixture-token', user: { id: 'fixture-user' }, expiresAt })
  assert.equal(parseQoderAuthSession(session(0))?.expiresAtMs, 0, 'a numeric 0 is no expiry, not the year 2000')
  assert.equal(parseQoderAuthSession(session('0'))?.expiresAtMs, 0, 'the string spelling of 0 is the same')
  assert.equal(parseQoderAuthSession(session(-5))?.expiresAtMs, 0, 'a nonsense number is no expiry either')
  assert.equal(parseQoderAuthSession(session(1794032368000))?.expiresAtMs, 1794032368000,
    'a millisecond timestamp is still read as one')
  assert.equal(parseQoderAuthSession(session(1794032368))?.expiresAtMs, 1794032368000,
    'a second timestamp is still read as one')
  const iso = '2027-01-01T00:00:00Z'
  assert.equal(parseQoderAuthSession(session(iso))?.expiresAtMs, Date.parse(iso),
    'a date string is still read as one')
})

/**
 * A Qoder claim that paid nothing carries no amount.
 *
 * `amount` fell back to the campaign's advertised figure whenever the answer
 * was not a replay, so a claim that never reached CLAIMED reported credits that
 * never landed.
 */
test('a Qoder claim that paid nothing carries no amount', () => {
  const { qoderNormalizeClaimResult } = require('../src/qoder-client.ts')
  const campaign = { benefit: { amount: 30 } }
  const unpaid = qoderNormalizeClaimResult({}, campaign)
  assert.equal(unpaid.claimed, false, 'an empty answer granted nothing')
  assert.equal(unpaid.amount, undefined, 'and must not name the credits it did not pay')
  const replayed = qoderNormalizeClaimResult({ data: { status: 'CLAIMED', replayed: true } }, campaign)
  assert.equal(replayed.replayed, true, 'a repeat is still a success')
  assert.equal(replayed.amount, undefined, 'but it paid nothing, so it names no amount')
  const paid = qoderNormalizeClaimResult({ data: { status: 'CLAIMED' } }, campaign)
  assert.equal(paid.claimed, true)
  assert.equal(paid.amount, 30, 'a claim that paid out names what it paid')
})

/**
 * A promo window that runs past midnight is promised only as far as the rule's
 * last day allows.
 *
 * The night window is 23:00 to 08:00, so on the rule's final day the hours
 * after midnight are outside it. The badge used to answer "free from 00:00"
 * for the whole last evening, which is wrong in both directions: the model IS
 * free from 23:00, and 00:00 is past the rule so it is not free then either.
 */
test('a promo window is not promised past the rule\'s last day', () => {
  const { promoStatusFor } = require('../src/promo.ts')
  const model = { id: 'hy4-preview' }
  const lastDay = { day: '2026-10-31', hour: 23 }
  assert.deepEqual(promoStatusFor(model, lastDay, 'cn'), { kind: 'night', untilHour: 24 },
    'on the last day the window is promised up to midnight, not past it')
  assert.equal(promoStatusFor(model, { day: '2026-10-30', hour: 23 }, 'cn')?.untilHour, 8,
    'the day before, the same window is promised in full')
  assert.equal(promoStatusFor(model, { day: '2026-10-31', hour: 2 }, 'cn')?.untilHour, 8,
    'and inside the rule\'s last day the window still ends before midnight')
  assert.equal(promoStatusFor(model, { day: '2026-10-31', hour: 22 }, 'cn')?.kind, 'night-later',
    'before the window opens on the last day it is still offered as opening later')
  assert.equal(promoStatusFor(model, { day: '2026-11-01', hour: 2 }, 'cn'), undefined,
    'past the rule there is no window at all')
})

/**
 * A Trae install holding two sign-ins says its device id is a fallback.
 *
 * The device number is what the check-in endpoint accepts, and one install with
 * two device-center ids has none to send: the fallback is a hash, which the
 * endpoint answers 9074. That used to arrive as a bare code with nothing said
 * about why.
 */
test('a Trae install with two sign-ins reports a fallback device id', async () => {
  const { readTraeIdentity } = require('../src/trae-identity.ts')
  const temporary = scratch('xdpool-trae-identity-')
  try {
    const storagePath = path.join(temporary, 'User', 'globalStorage', 'storage.json')
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, JSON.stringify({
      'telemetry.machineId': 'fixture-machine',
      'telemetry.devDeviceId': '11111111-2222-3333-4444-555555555555',
      'iCubeAuthInfo://icube-dc:1000000000000001': '{}',
      'iCubeAuthInfo://icube-dc:1000000000000002': '{}',
    }))
    const identity = await readTraeIdentity({ path: storagePath, edition: 'cn', source: 'desktop' })
    assert.equal(identity.deviceIdIsFallback, true,
      'two device-center ids leave no persisted device number, and the caller must be able to say so')
    assert.notEqual(identity.deviceId, '1000000000000001',
      'the id of one of the two accounts must not be sent as the machine\'s')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A Trae storage file that is not an object fails as unreadable, not as a
 * TypeError.
 *
 * `null` on disk read as a crash about reading a property of null, which lost
 * the one thing worth knowing: the file is there and will not parse.
 */
test('a Trae storage file that is not an object fails as unreadable', async () => {
  const { readTraeIdentity } = require('../src/trae-identity.ts')
  const temporary = scratch('xdpool-trae-storage-')
  try {
    const storagePath = path.join(temporary, 'User', 'globalStorage', 'storage.json')
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, 'null')
    await assert.rejects(readTraeIdentity({ path: storagePath, edition: 'cn', source: 'desktop' }),
      /not a JSON object/, 'a storage file holding null must be reported as unreadable')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A stream whose lines end on a bare carriage return is still read.
 *
 * The SSE grammar allows a lone `\r` as a line separator, and Trae's decoder
 * learned it. Qoder's reader looked for `\n` only, so a CR-terminated stream
 * buffered whole until the line guard threw: twenty thousand frames, none of
 * them delivered.
 */
test('a Qoder stream whose lines end on a bare carriage return is read', () => {
  const { QoderFrameDecoder } = require('../src/qoder-sse.ts')
  const decoder = new QoderFrameDecoder()
  const payloads = []
  for (let frame = 0; frame < 3; frame += 1) {
    payloads.push(...decoder.push('data: {"choices":[{"delta":{"content":"x"}}]}\r\r'))
  }
  assert.equal(payloads.length, 3, 'a lone CR ends a line exactly as a newline does')
  // The control: the newline spelling still works, and `[DONE]` still ends it.
  const plain = new QoderFrameDecoder()
  assert.deepEqual(plain.push('data: {"a":1}\ndata: [DONE]\n'), ['{"a":1}'])
  assert.equal(plain.ended, true)
})

/**
 * A stream that ends on a bare carriage release still carries its `[DONE]`.
 *
 * The tail of the buffer was handed to the line consumer with the `\r` still
 * attached, so the literal did not match and the turn ran to EOF instead of
 * ending on the upstream's own marker.
 */
test('a Trae stream ending on a bare carriage return still ends on its marker', () => {
  const { SseDecoder, decodeTraeEvent } = require('../src/trae-sse.ts')
  const decoder = new SseDecoder()
  const events = [...decoder.push('data: [DONE]\r'), ...decoder.finish()]
  assert.equal(events.length, 1, 'the trailing marker must survive the carriage return')
  assert.equal(decodeTraeEvent(events[0]).type, 'done', 'and it must read as the end of the turn')
})

/**
 * An upstream refusal that carries no sentence lifts to nothing.
 *
 * `{}`, `{"error":{}}` and a page of HTML all lifted to themselves, and the
 * gateway's own fallback sentence never fired because the lifted text was not
 * empty: the client read a serialized document where a reason should be.
 */
test('an upstream refusal that carries no sentence lifts to nothing', () => {
  const { liftUpstreamMessage } = require('../src/loopback.ts')
  assert.equal(liftUpstreamMessage('{}'), '', 'an empty document has no sentence to lift')
  assert.equal(liftUpstreamMessage('{"error":{}}'), '', 'an empty error object has none either')
  assert.equal(liftUpstreamMessage('{"code":429}'), '', 'a bare code is not a sentence')
  assert.equal(liftUpstreamMessage('{"error":"service busy"}'), 'service busy',
    'a refusal whose error arrived as a string is lifted like any other')
  assert.equal(liftUpstreamMessage('service busy'), 'service busy',
    'and a body that is already a sentence survives unchanged')
})

/**
 * A caller that already hung up gets no upstream request.
 *
 * The deadline controller only forwarded aborts that arrived after it was
 * built, so a hang-up that landed in the window between the gateway's check and
 * the fetch still sent the request: the turn was paid for by nobody, and the
 * relay kept writing to a socket the client had closed.
 */
test('a caller that already hung up gets no upstream request', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const credential = {
    accessToken: 'fixture-token', refreshToken: '', expiresAtMs: Date.now() + 3600000,
    domain: 'fixture.example', sourcePath: 'fixture',
  }
  let served = 0
  const fetchImpl = async (_url, init) => {
    // Faithful to undici: a signal that is already aborted refuses the request
    // before it is made. A fixture that ignored the signal could not tell a
    // hang-up that arrived in time from one that arrived too late.
    if (init?.signal?.aborted === true) throw init.signal.reason
    served += 1
    return new Response('data: [DONE]\n\n', { status: 200 })
  }
  const client = new WorkBuddyUpstreamClient({ fetchImpl })
  const hung = AbortSignal.abort(new Error('the client is gone'))
  const result = await client.chatStream(credential, '{}', hung, { headersMs: 40 })
  assert.equal(result.ok, false, 'the request must not be made for a turn nobody is reading')
  assert.equal(served, 0, 'and the upstream must see nothing at all')
  // The control: a live caller still gets its request.
  const live = await client.chatStream(credential, '{}', undefined, { headersMs: 40 })
  assert.equal(live.ok, true, 'a caller that is still there must be served')
  assert.equal(served, 1)
})

/**
 * A stream that ends releases its watchdog timer.
 *
 * The timer was armed again after every chunk and never cleared on the last
 * one, so every finished turn left one counting down for the full idle window,
 * holding the reader and the upstream response with it.
 */
test('a stream that ends releases its watchdog timer', async () => {
  // The dsh suite runs the sources themselves, so the watchdog is called as
  // shipped - with its idle window passed in - and the timers it uses are
  // counted by standing in for the globals it reads them from.
  const { withIdleWatchdog } = require('../src/upstream.ts')
  const encoder = new TextEncoder()
  let armed = 0
  let cleared = 0
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = () => { armed += 1; return { unref() {} } }
  globalThis.clearTimeout = () => { cleared += 1 }
  try {
    const closing = new ReadableStream({
      start(next) { next.enqueue(encoder.encode('data: {"choices":[]}\n\n')); next.close() },
    })
    const reader = withIdleWatchdog(closing, 40).getReader()
    await reader.read()
    await reader.read()
    assert.ok(armed > 0, 'the watchdog must have armed at least once')
    assert.equal(cleared, armed,
      'every timer the watchdog armed must be cleared, including the one the last chunk armed')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

/**
 * A `Retry-After` is validated and bounded before it is sent.
 *
 * The upstream's wait time was forwarded as it arrived. An empty string, prose
 * or a number of years is enough to park a client - or a whole model pool - for
 * as long as it chooses to honour the header.
 */
test('a retry-after is validated and bounded before it is sent', () => {
  const { retryAfterHeader } = require('../src/loopback.ts')
  assert.equal(retryAfterHeader('120'), '120', 'a plain wait is forwarded as it is')
  assert.equal(retryAfterHeader(42), '42', 'and so is a numeric one')
  assert.equal(retryAfterHeader('1e9'), '7200', 'a wait of thirty years is bounded to two hours')
  assert.equal(retryAfterHeader(''), undefined, 'an empty value is dropped rather than sent')
  assert.equal(retryAfterHeader('soon'), undefined, 'and so is prose')
  assert.equal(retryAfterHeader('-5'), undefined, 'a negative wait is not a wait')
  assert.equal(retryAfterHeader(undefined), undefined, 'and an absent one is simply absent')
})

/**
 * A Trae refusal spelled with a bare string is still a refusal.
 *
 * The recogniser read the message out of `message`/`errorMessage` and only
 * descended into `error`/`details` when they were objects. Trae spells a refusal
 * `{"error":"Login expired"}` as often as it spells one with a code, and those
 * frames passed as an empty turn.
 */
test('a Trae refusal spelled with a bare string is still a refusal', () => {
  const { decodeTraeEvent } = require('../src/trae-sse.ts')
  const { traeFailureOf, describeTraeFailure } = require('../src/trae-shim.ts')
  const of = (data, event) => traeFailureOf(decodeTraeEvent({ data, ...event === undefined ? {} : { event } }))
  assert.equal(of('{"error":"Login expired"}')?.message, 'Login expired',
    'a refusal whose only text sits in a bare error string must not pass as an empty turn')
  assert.equal(of('{"details":"quota spent"}')?.message, 'quota spent',
    'the same text under details is the same refusal')
  // And a refusal with neither a code nor words still says something.
  const silent = of('{}', 'error')
  assert.notEqual(silent, undefined, 'an error event with no payload is still a refusal')
  assert.notEqual(describeTraeFailure(silent), '', 'and its message must not be empty')
})

/**
 * A Trae queue frame is answered as the rate limit it is.
 *
 * The wait rides inside the message as a JSON document. Reading it as a server
 * failure told the client to retry at once and kept the sign-in out of the
 * rotation, where the Qoder path answers 429 with the wait and moves on.
 */
test('a Trae queue frame is answered as the rate limit it is', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const first = { accessToken: 'token-a', userId: 'user-a', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  const second = { accessToken: 'token-b', userId: 'user-b', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }
  let chats = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    chats += 1
    if (chats === 1) {
      const frame = JSON.stringify({ code: '10605', message: JSON.stringify({ queueType: 'q', retryAfterSeconds: 45 }) })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('data: {"response":"served by the second sign-in"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [first, second], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200, 'the sign-in behind the queued one must serve the turn')
    assert.equal(chats, 2, 'a queue belongs to the sign-in, so it rotates')
    const body = await answer.text()
    assert.ok(body.includes('served by the second sign-in'), 'the reply must come from the second sign-in')
  } finally { await gateway.close() }
})

/**
 * A refusal the vendor fragments across many chunks is still a refusal.
 *
 * The relay reads ahead a bounded number of chunks looking for a failure before
 * it commits a status, and a peek that stops early answers a failure as a
 * truncated success: the client gets a 200 whose body ends mid-sentence, which
 * reads as an upstream outage rather than as the sign-in it is about. Neither
 * vendor promises a refusal in one piece - a chunk boundary can fall anywhere -
 * so the peek has to keep reading until it has actually seen one.
 */
test('a Trae refusal the vendor fragments across many chunks is still a refusal', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const signin = {
    accessToken: 'token', userId: 'user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop',
    expiresAtMs: Date.now() + 3600000,
  }
  const encode = (text) => new TextEncoder().encode(text)
  const frame = (data) => `data: ${data}\n\n`
  // Two bytes at a time: no single chunk carries a whole frame, so the refusal
  // only exists once the peek has read enough of them and reassembled it.
  const refusal = frame(JSON.stringify({ error: 'Login expired' }))
  const pieces = []
  for (let at = 0; at < refusal.length; at += 2) pieces.push(encode(refusal.slice(at, at + 2)))
  pieces.push(encode(frame('[DONE]')))
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    return new Response(new ReadableStream({
      start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close() },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [signin], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 401,
      'a refusal split across chunks must be answered as the sign-in failure it is, not as a truncated success')
    const body = await answer.text()
    assert.ok(!body.includes('[DONE]'),
      'and it must not be relayed as a stream that merely stopped early')
  } finally { await gateway.close() }
})

/**
 * A refusal that arrives after the first content byte is relayed, not re-spelled.
 *
 * Once the client has bytes, the status is committed: HTTP cannot change it, and
 * answering a second status mid-body would be the client's bug to parse. The
 * refusal is still forwarded as an event so the client can act on it.
 *
 * This boundary is enforced twice, and the redundancy is deliberate rather than
 * accidental: the peek's event loop stops looking as soon as it has seen output,
 * and the relay separately refuses to re-spell a status once output has started.
 * Either alone is enough, which is why removing only one of them leaves this case
 * green - the pair is what makes the boundary survive a change to either.
 */
test('a Trae refusal after the first content byte is forwarded, not re-spelled', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const signin = {
    accessToken: 'token', userId: 'user', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop',
    expiresAtMs: Date.now() + 3600000,
  }
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: [{ config_name: 'trae-model', display_config: { display_name: 'Trae' } }] }))
    }
    if (target.includes('/models')) return new Response(JSON.stringify({ data: { list: [] } }))
    return new Response(
      'data: {"response":"the first words"}\n\ndata: {"error":"Login expired"}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const gateway = createTraeGateway({
    port: 0, credentials: async () => [signin], fetchImpl,
    identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'trae-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 200,
      'the status is committed once the first content byte is on the wire')
    const body = await answer.text()
    assert.ok(body.includes('the first words'), 'the content the vendor sent is relayed')
    assert.ok(body.includes('Login expired'),
      'and the refusal that followed it is forwarded too, so the client can act on it')
  } finally { await gateway.close() }
})

/**
 * A Qoder acknowledgement is not a refusal.
 *
 * `{"code":0}` is how Qoder acks, and reading it as a failure answered a healthy
 * turn with a 502 naming code 0. The error spellings carry business codes below
 * the success range and keep them.
 */
test('a Qoder acknowledgement is not read as a refusal', () => {
  const { decodeQoderFrame } = require('../src/qoder-sse.ts')
  assert.equal(decodeQoderFrame('{"choices":[],"code":0}').type, 'unknown',
    'a bare success code is an acknowledgement, not a refusal')
  assert.equal(decodeQoderFrame('{"choices":[],"code":200}').type, 'unknown',
    'and so is a 2xx one')
  assert.equal(decodeQoderFrame('{"choices":[],"errcode":"110"}').type, 'failure',
    'a business code under the error spelling is still a refusal')
  assert.equal(decodeQoderFrame('{"choices":[],"code":105,"message":"Login expired"}').type, 'failure',
    'and a code that carries words is a refusal whatever its number')
})



/**
 * The daily check-in decision, in Beijing time whatever the host's zone is.
 *
 * The reward windows are defined in Beijing time, so an hour has to mean the
 * same instant everywhere: reading the host's local hour would make "9 o'clock"
 * slip by a day on a laptop set to another zone, and the day's credits would
 * either never collect or collect twice. This rule had no test at all - breaking
 * the hour list, the slot id and the due-slot decision together left both suites
 * green.
 *
 * The instants below are chosen because at least one other zone disagrees with
 * Shanghai about the calendar day or the hour, which is what makes them prove
 * anything. The comparison is computed rather than assumed, so the test says so
 * itself if it ever stops being discriminating.
 */
test('the check-in hour is read in Beijing time, not the host zone', () => {
  const { zonedDayHour, checkinSlotId, dueCheckinSlot, normaliseCheckinHours, CHECKIN_TIME_ZONE } = require('../src/checkin-time.ts')
  assert.equal(CHECKIN_TIME_ZONE, 'Asia/Shanghai', 'the zone is the one the reward windows are defined in')

  const localIn = (date, zone) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
    const pick = (type) => parts.find((part) => part.type === type)?.value ?? '00'
    return pick('year') + '-' + pick('month') + '-' + pick('day') + 'T' + Number(pick('hour'))
  }

  // Instant, and the Shanghai day/hour it must read as.
  const cases = [
    ['2026-10-16T16:30:00Z', '2026-10-17', 0], // 00:30 the next day in Shanghai
    ['2026-10-16T15:59:59Z', '2026-10-16', 23], // 23:59, one second before the day turns
    ['2026-10-16T00:00:00Z', '2026-10-16', 8],
    ['2026-10-16T16:00:00Z', '2026-10-17', 0], // exactly midnight in Shanghai
  ]
  let discriminating = 0
  for (const [iso, day, hour] of cases) {
    const date = new Date(iso)
    const zoned = zonedDayHour(date)
    assert.equal(zoned.day, day, `${iso} must read as ${day} in the check-in zone`)
    assert.equal(zoned.hour, hour, `${iso} must read as hour ${hour} in the check-in zone`)
    // Some other zone has to disagree, or this case proves nothing about which
    // zone was read.
    for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland']) {
      if (localIn(date, zone) !== `${day}T${hour}`) { discriminating += 1; break }
    }
  }
  assert.ok(discriminating >= 3,
    'at least three of these instants must distinguish Shanghai from another zone, or the test is vacuous')

  assert.equal(checkinSlotId('2026-10-17', 0), '2026-10-17T00', 'a single-digit hour is zero-padded')
  assert.equal(checkinSlotId('2026-10-17', 9), '2026-10-17T09')
  assert.equal(checkinSlotId('2026-10-17', 23), '2026-10-17T23')
})

/**
 * What the configured hours mean, and which slot is due.
 *
 * Catch-up is deliberate: a machine that slept through 09:00 still collects when
 * it wakes instead of waiting for tomorrow. The earliest unconsumed hour wins,
 * so two configured hours still give two passes a day, and a future hour is
 * never due however the list is ordered.
 */
test('a check-in slot is due once its hour has passed, earliest unconsumed first', () => {
  const { dueCheckinSlot, normaliseCheckinHours } = require('../src/checkin-time.ts')

  // Whole hours only, in order, deduplicated; anything unreadable is dropped
  // rather than guessed at, and an empty list falls back to the default.
  assert.deepEqual([...normaliseCheckinHours([5, 1, 3, 23, 1])], [1, 3, 5, 23])
  assert.deepEqual([...normaliseCheckinHours([])], [9], 'an empty list falls back to the default hour')
  assert.deepEqual([...normaliseCheckinHours([25, -1, 'nonsense', 9.7])], [9],
    'an out-of-range or unreadable hour is dropped, not rounded into range')
  assert.deepEqual([...normaliseCheckinHours([0, 23, 12])], [0, 12, 23], 'midnight and the last hour are valid')

  const at = (iso) => new Date(iso)
  const SH_0800 = '2026-10-17T00:00:00Z' // 08:00 Shanghai
  const SH_1000 = '2026-10-17T02:00:00Z' // 10:00 Shanghai
  const SH_0830 = '2026-10-17T00:30:00Z' // 08:30 Shanghai

  assert.equal(dueCheckinSlot(at(SH_0830), [9], new Set()), undefined,
    'an hour that has not arrived yet is not due')
  assert.equal(dueCheckinSlot(at(SH_0800), [9], new Set()), undefined,
    'and the exact start of the hour is not due either')
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set()), '2026-10-17T09',
    'a past hour is due: a machine that slept through 09:00 still collects')
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set(['2026-10-17T09'])), undefined,
    'a slot already collected is not due again')
  assert.equal(dueCheckinSlot(at(SH_1000), [21], new Set()), undefined,
    'a later configured hour is not due while an earlier one has not been reached')
  assert.equal(dueCheckinSlot(at(SH_1000), [21, 9], new Set()), '2026-10-17T09',
    'the list order does not matter: the earliest due hour wins')
  assert.equal(dueCheckinSlot(at(SH_1000), [9, 21], new Set(['2026-10-17T09'])), undefined,
    'with the first hour spent and the second not yet reached, nothing is due')
  // Two hours, both past: the second becomes due only once the first is spent,
  // which is what gives a two-hour configuration two passes a day.
  const bothPast = at('2026-10-17T14:00:00Z') // 22:00 Shanghai
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set()), '2026-10-17T09',
    'with both hours past, the earlier one is due first')
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set(['2026-10-17T09'])), '2026-10-17T21',
    'and once it is spent, the later one becomes due')
  assert.equal(dueCheckinSlot(bothPast, [9, 21], new Set(['2026-10-17T09', '2026-10-17T21'])), undefined,
    'and with both spent the day is done')
  // Yesterday's slot is never today's: the day comes from the instant, not the set.
  assert.equal(dueCheckinSlot(at(SH_1000), [9], new Set(['2026-10-16T09'])), '2026-10-17T09',
    "a slot spent yesterday does not spend today's")
})

/**
 * The zone is read from the constant, not from the machine.
 *
 * The assertion above cannot prove this on its own: a machine already set to
 * UTC+8 gives the same answer whether the code reads Shanghai or reads the local
 * zone, so a regression there would look green. This runs the same instants in
 * child processes under four other zones and requires the Shanghai answer every
 * time, which is the only form of the claim that is falsifiable everywhere.
 */
test('the check-in zone holds on a machine set to any other zone', () => {
  const { execFileSync } = require('node:child_process')
  const { zonedDayHour } = require('../src/checkin-time.ts')
  const cases = [
    ['2026-10-16T16:30:00Z', '2026-10-17', 0], // 00:30 the next day in Shanghai
    ['2026-10-16T15:59:59Z', '2026-10-16', 23], // one second before the day turns
    ['2026-10-16T00:00:00Z', '2026-10-16', 8],
  ]
  const expected = cases.map(([iso, day, hour]) => `${iso} ${day} ${hour}`).join('\n')
  for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Pacific/Auckland', 'UTC']) {
    const out = execFileSync(process.execPath, ['-e', `
      const { zonedDayHour } = require(${JSON.stringify(path.join(root, 'src/checkin-time.ts'))})
      const cases = ${JSON.stringify(cases)}
      for (const [iso, day, hour] of cases) {
        const zoned = zonedDayHour(new Date(iso))
        console.log(iso + ' ' + zoned.day + ' ' + zoned.hour)
      }
    `], { env: { ...process.env, TZ: zone }, encoding: 'utf8' })
    assert.equal(out.trim(), expected,
      `under TZ=${zone} the check-in zone must still read as Beijing time`)
  }
  // And the in-process answer agrees with all of them, so the two tests cannot
  // drift apart.
  for (const [iso, day, hour] of cases) {
    const zoned = zonedDayHour(new Date(iso))
    assert.equal(`${iso} ${zoned.day} ${zoned.hour}`, `${iso} ${day} ${hour}`)
  }
})

/**
 * A check-in pass that starts after a stop runs, instead of reporting zero.
 *
 * The service stop aborts the flag every account loop reads, so an entry that
 * starts afterwards must re-arm it. Without the re-arm the pass broke out of
 * every loop at once, reported "checked in 0 account(s)" and marked the day's
 * slot as spent: the day's credits were lost silently.
 */
test('a check-in pass that starts after a stop still collects', async () => {
  const source = transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8'))
  // The same brace-aware walk the pi suite uses, on the transpiled text.
  const from = source.indexOf('function runCheckinPass(')
  assert.notEqual(from, -1, 'runCheckinPass must exist in the host entry')
  const modifier = source.slice(Math.max(0, from - 6), from) === 'async ' ? 'async ' : ''
  // The check-in time rules are imported now, and the transpiled text reaches
  // them through the module variable TypeScript generates for that import. Its
  // name is read from the text rather than assumed, so reordering the imports
  // does not silently break this case.
  const moduleName = /const (\w+) = require\("\.\/checkin-time"\)/.exec(source)?.[1]
  assert.notEqual(moduleName, undefined, 'the check-in-time import must be present')
  const claims = { workbuddy: 0, travel: 0, qoder: 0, trae: 0, growth: 0 }
  const slots = new Set()
  const context = vm.createContext({
    AbortController,
    GROWTH_AFTER_CHECKIN_MS: 0,
    checkinAbort: new AbortController(),
    checkinScope: { enterWith() {} },
    checkinPassRunning: false,
    checkinPassToken: 0,
    // Nothing is in growth, which is the state the guard has to let through.
    growthPassRunning: false,
    serviceStopped: false,
    checkinHours: () => [9],
    autoCheckinSlots: slots,
    autoCheckinLast: null,
    qoderRetryAt: 0,
    loadGeneration: 7,
    stillLoaded: () => true,
    [moduleName]: {
      zonedDayHour: () => ({ day: '2026-10-15', hour: 9 }),
      dueCheckinSlot: () => undefined,
      checkinSlotId: (day, hour) => `${day}T${hour}`,
      normaliseCheckinHours: (raw) => raw,
      CHECKIN_POLL_MS: 60000,
    },
    saveCheckinSlots: () => { slots.add('2026-10-15T9') },
    isolatedCheckinWorker: (work) => work,
    claimAllCheckins: async () => { claims.workbuddy += 1; return { claimed: 2, skipped: 0, failed: 0 } },
    travelAllAccounts: async () => { claims.travel += 1; return { departed: 0, claimed: 0, adopted: 0 } },
    qoderCheckinAll: async () => { claims.qoder += 1; return { claimed: 1, skipped: 0, failed: 0 } },
    traeCheckinAll: async () => { claims.trae += 1; return { claimed: 1, skipped: 0, failed: 0 } },
    checkinDelay: async () => {},
    claimAllGrowth: async () => { claims.growth += 1; return { streak: 0, credit: 0 } },
    scheduleRefresh: () => {},
    log: () => {},
    safeMessage: (error) => String(error),
  })
  vm.runInContext(modifier + balanced(source, from), context)
  // Aborted, exactly as a stop leaves it.
  context.checkinAbort.abort(new Error('the service stopped'))
  const answer = await context.runCheckinPass({ manual: true })
  assert.equal(answer.running, undefined, 'the pass must have run rather than reported one in flight')
  assert.equal(claims.workbuddy, 1, 'the WorkBuddy worker must have been called')
  assert.equal(claims.qoder, 1, 'and so must Qoder and Trae')
  assert.equal(claims.trae, 1)
  assert.equal(claims.growth, 1, 'the growth pass runs after the accounts')
  assert.equal(answer.claimed, 2, 'the counts the workers returned must reach the answer')
  assert.equal(context.checkinAbort.signal.aborted, false,
    'the pass must have re-armed the flag, or the next one inherits this stop')
})

/**
 * A reload installs a new controller while a pass is still between accounts.
 * The pause has to keep the signal that pass captured. Reading the global
 * instead returned at once, and the pass walked the rest of the pool.
 */
test('a check-in pause follows the pass that started it', async () => {
  const { AsyncLocalStorage } = require('node:async_hooks')
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const scope = new AsyncLocalStorage()
  const stopped = new AbortController()
  stopped.abort()
  const context = vm.createContext({
    AbortController,
    checkinAbort: stopped,
    checkinScope: scope,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(
    balanced(source, source.indexOf('function currentCheckinSignal(')) + '\n' +
      balanced(source, source.indexOf('function checkinDelay(')),
    context,
  )
  const pass = new AbortController()
  const started = Date.now()
  await scope.run(pass.signal, () => context.checkinDelay(40))
  assert.ok(Date.now() - started >= 30, 'the pause must wait on the pass signal, not the aborted global')
  const cut = new AbortController()
  const cutAt = Date.now()
  const pending = scope.run(cut.signal, () => context.checkinDelay(5000))
  cut.abort()
  await pending
  assert.ok(Date.now() - cutAt < 500, 'aborting the pass signal must cut the pause')
})

/**
 * The growth streak is lit by a chat report, and only by one that names the
 * account's uid.
 *
 * `uin` is a different identifier from `uid`, and the upstream answers 200
 * while dropping a report that carries the wrong one. Substituting it made
 * the whole streak chain a silent no-op, which is why the tiers never opened.
 */
test('the activity report refuses to substitute the uin for the uid', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const calls = []
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (url) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  } })
  await assert.rejects(
    () => client.reportChatActivity({ accessToken: 't', refreshToken: 'r', expiresAtMs: 0, uin: '900000000000', domain: 'www.workbuddy.cn', sourcePath: '' }, 'c1'),
    /uid/,
    'a credential with no uid must fail loudly rather than send the uin',
  )
  assert.equal(calls.length, 0, 'and no request may go out with the wrong id')
})

/**
 * A transport failure rotates; a caller hang-up does not.
 *
 * DNS, reset and TLS failures are the network path's, not the account's, and
 * answering them as `server` broke the rotation out with the healthy accounts
 * behind it untried. The caller hanging up is the client's own doing, and
 * must not spend a rotation or look like a network fault in the log.
 */
test('a transport failure rotates and a caller hang-up does not', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const hangUp = new AbortController()
  hangUp.abort()
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED') } })
  const failed = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', hangUp.signal,
  )
  assert.equal(failed.kind, 'aborted', 'a cancelled turn is the client doing')
  const open = new AbortController()
  const transport = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', open.signal,
  )
  assert.equal(transport.kind, 'transport',
    'a network failure must be classed so the shim tries the next sign-in')
})

/**
 * The upstream's own `Retry-After` reaches the pool.
 *
 * The body parser only covers the spellings it knows, so a 429 that states
 * its window in the standard header fell back to the configured cooldown:
 * the account came back into rotation while the limit was still standing and
 * the next request hit the same wall.
 */
test('an upstream Retry-After header reaches the pool', async () => {
  const { WorkBuddyUpstreamClient, retryAfterSeconds } = require('../src/upstream.ts')
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '90' })), 90)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': '0' })), undefined,
    'a zero is not a wait worth honouring')
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': 'soon' })), undefined)
  assert.equal(retryAfterSeconds(new Headers()), undefined)
  assert.equal(retryAfterSeconds(new Headers({ 'retry-after': String(99 * 60 * 60) })), 2 * 60 * 60,
    'an absurd header is bounded to the same ceiling the sender uses')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('quota', {
    status: 429, headers: { 'retry-after': '120' },
  }) })
  const limited = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', new AbortController().signal,
  )
  assert.equal(limited.kind, 'soft_rate')
  assert.equal(limited.retryAfter, 120, 'the header must ride along with the failure')
})

/**
 * A spent account is held, not put back at the head of the queue each minute.
 *
 * A 402 and a dead session do not clear by themselves, and the configured
 * cooldown window is sized for a limit that expires. Using it here returned
 * the spent account to rotation every minute, where it failed again and
 * burned the attempts of the healthy accounts behind it.
 */
test('a spent account is held out of rotation instead of returning each minute', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const SPENT_HOLD_MS = 6 * 60 * 60 * 1000
  const dir = scratch('spent-hold')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uid: 'u1', nickname: 'A' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000 })
  await pool.scan()
  const account = pool.list()[0]
  const before = Date.now()
  pool.penalize(account.id, before + SPENT_HOLD_MS, undefined, 'spent')
  assert.ok(account.cooldownUntilMs - before > 60 * 60 * 1000,
    'the hold must far outlast the configured cooldown window')
  assert.deepEqual(pool.available(Date.now(), undefined, 'cn'), [],
    'and the account must be out of rotation for the whole of it')
})

/**
 * The reset time is read in the spellings the upstream actually sends.
 *
 * A quoted value and a seconds-level one both occur, and either fell through to
 * the default cooldown while the upstream had named the exact window.
 */
test('the rate-limit reset is read quoted and in seconds', () => {
  const { parseRateLimitReset } = require('../src/upstream.ts')
  // A whole second, so the seconds-level spelling below loses nothing.
  const soon = (Math.floor(Date.now() / 1000) + 30 * 60) * 1000
  assert.equal(parseRateLimitReset(JSON.stringify({ resetAt: soon })), soon,
    'the epoch-millisecond form still parses')
  assert.equal(parseRateLimitReset(JSON.stringify({ resetAt: String(soon) })), soon,
    'and so does the quoted one')
  assert.equal(parseRateLimitReset(JSON.stringify({ resetAt: Math.floor(soon / 1000) })), soon,
    'a seconds-level value is normalised, not read as milliseconds')
  // One hour out, inside the two-hour ceiling a parsed reset is clamped to.
  const moment = new Date(Date.now() + 60 * 60 * 1000)
  const beijing = new Date(moment.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  assert.equal(parseRateLimitReset(`将在 ${beijing} 解除限制`), Math.floor(moment.getTime() / 1000) * 1000,
    'the Beijing wall clock is read as UTC+8, not as the host machine\'s zone')
})

/**
 * The pool the two hold cases below drive, built from the real module.
 *
 * The two cases differ only in the cooldown they stub, so the pool and its
 * readers are shared. The scheduler lives in `source-pool.ts` and is required
 * directly rather than lifted out of the host entry: a rename there used to fail
 * these cases with "must exist in the host entry", and the stub list below used
 * to be a second copy of the pool's dependencies that could drift.
 */
function sourceFailureContext(cooldownMs) {
  const { createSourcePool } = require('../src/source-pool.ts')
  return createSourcePool({
    cooldownMs,
    preferredSourceAccount: () => '',
    sourceDistribution: () => 'priority',
    sourceRegionKey: (source_, region) => source_ + ':' + region,
  })
}

/**
 * A sign-in the upstream just refused is not the one the next request pays for.
 *
 * The WorkBuddy pool cools an account the moment the upstream refuses it. The
 * Trae and Qoder gateways rotated only inside one request, so with a single
 * sign-in every request paid one failed round trip while the client was being
 * told to wait hours. The hold is demotion, not exclusion: the request still
 * falls back to a held sign-in when it is all there is.
 */
test('a sign-in the upstream just refused leads no request until its wait ends', () => {
  const context = sourceFailureContext(() => 60_000)
  const live = [
    { label: 'account-a', expiresAtMs: 0 },
    { label: 'account-b', expiresAtMs: 0 },
  ]
  const labelOf = (credential) => credential.label
  const first = context.orderSourceCredentials('trae', 'cn', live, labelOf, true).map(labelOf)
  assert.deepEqual(first, ['account-a', 'account-b'], 'with nothing held the order is the discovery order')
  // A two-hour wait, the figure a Qoder daily limit states.
  context.noteSourceFailure('trae', 'cn', 'account-a', '7200')
  const held = context.orderSourceCredentials('trae', 'cn', live, labelOf, true).map(labelOf)
  assert.deepEqual(held, ['account-b', 'account-a'],
    'the refused sign-in moves behind the healthy one instead of every request paying for it again')

})

/**
 * A sign-in held for nothing leads again.
 *
 * A failure with no stated wait takes the user's own cooldown, and once that
 * has passed the sign-in is back in front: a hold that never ended would park
 * an account for the life of the process.
 */
test('a hold with no stated wait ends at the cooldown', () => {
  const context = sourceFailureContext(() => 0)
  const live = [{ label: 'account-a', expiresAtMs: 0 }, { label: 'account-b', expiresAtMs: 0 }]
  const labelOf = (credential) => credential.label
  context.noteSourceFailure('qoder', 'cn', 'account-a', undefined)
  const ordered = context.orderSourceCredentials('qoder', 'cn', live, labelOf, true).map(labelOf)
  assert.deepEqual(ordered, ['account-a', 'account-b'],
    'a hold whose wait has passed leads again, and the expired entry is dropped')
  assert.equal(context.sourceFailureHold.size, 0, 'the expired entry does not linger in the map')
})

/**
 * A caller hang-up on Trae and Qoder is the client's doing, not the sign-in's.
 *
 * Both clients answered every transport error as `server`, so a cancelled turn
 * read as a network fault, spent a rotation on a request the client had already
 * dropped, and wrote a 502 to a socket that was gone.
 */
test('a caller hang-up on Trae and Qoder is classed as the client\'s doing', async () => {
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  const hangUp = new AbortController()
  hangUp.abort()
  const throwing = { fetchImpl: async () => { throw new Error('connect ECONNREFUSED') } }
  const trae = await new TraeSoloUpstreamClient({
    credential: async () => ({ accessToken: 't', userId: 'u', host: 'https://api.trae.cn', edition: 'cn', source: 'desktop', expiresAtMs: Date.now() + 3600000 }),
    identity: async () => ({ machineId: 'm', deviceId: 'd' }),
    ...throwing,
  }).chatStream('{}', hangUp.signal)
  assert.equal(trae.ok, false)
  if (!trae.ok) assert.equal(trae.kind, 'aborted', 'a cancelled Trae turn is not a Trae failure')
  const qoder = await new QoderUpstreamClient({
    region: 'cn',
    credential: async () => ({ userID: 'u', token: 't', machineID: 'm' }),
    ...throwing,
  }).chatStream('{}', 'fixture-model', { signal: hangUp.signal })
  assert.equal(qoder.ok, false)
  if (!qoder.ok) assert.equal(qoder.kind, 'aborted', 'and neither is a cancelled Qoder one')
})

/**
 * The order a source region's sign-ins are tried in, which is the whole of
 * "which account serves this region".
 *
 * The gateways take the first usable entry and re-read this list per request, so
 * a wrong order is not a cosmetic problem: leading with an expired token spends
 * every request on a guaranteed 401 before rotation reaches a live one, and
 * leading with one the upstream just refused makes every request pay that
 * failure again. The expired-last rule had no test at all - forcing the rank's
 * expired term to zero left the whole suite green.
 */
function orderingContext(overrides = {}) {
  const { createSourcePool } = require('../src/source-pool.ts')
  return createSourcePool({
    cooldownMs: () => 60_000,
    preferredSourceAccount: () => '',
    sourceDistribution: () => 'priority',
    sourceRegionKey: (source, region) => source + ':' + region,
    ...overrides,
  })
}

const sourceLabel = (credential) => credential.name

test('a live sign-in is tried before an expired one, whatever the list order', () => {
  const pool = orderingContext()
  const now = Date.now()
  const dead = { name: 'dead', expiresAtMs: now - 60_000 }
  const live = { name: 'live', expiresAtMs: now + 3_600_000 }
  // Dead first in the input: the order is the pool's to decide, not the reader's.
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, live], sourceLabel, false).map(sourceLabel), ['live', 'dead'],
    'an expired sign-in must never lead, even when the discovery read lists it first')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [live, dead], sourceLabel, false).map(sourceLabel), ['live', 'dead'],
    'and the same the other way round')
  // A sign-in with no expiry at all is live, not expired.
  const unknown = { name: 'unknown' }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, unknown], sourceLabel, false).map(sourceLabel), ['unknown', 'dead'],
    'a sign-in that states no expiry is still usable')
  // An expiry of exactly now is dead: the comparison is `<=`.
  const edge = { name: 'edge', expiresAtMs: now }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [edge, live], sourceLabel, false).map(sourceLabel), ['live', 'edge'],
    'an expiry equal to now has passed')
})

test('a sign-in the upstream just refused is tried after the healthy ones but before the expired', () => {
  const pool = orderingContext()
  const now = Date.now()
  const healthy = { name: 'healthy', expiresAtMs: now + 3_600_000 }
  const held = { name: 'held', expiresAtMs: now + 3_600_000 }
  const dead = { name: 'dead', expiresAtMs: now - 60_000 }
  pool.noteSourceFailure('trae', 'cn', 'held', undefined)
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, held, healthy], sourceLabel, false).map(sourceLabel),
    ['healthy', 'held', 'dead'],
    'healthy first, then the refused one, then the expired one')
  // With nothing healthy left it still answers: the request falls back to it.
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [dead, held], sourceLabel, false).map(sourceLabel),
    ['held', 'dead'],
    'a held sign-in is still used when it is all there is')
})

/**
 * A hold belongs to one region's sign-in, not to its name.
 *
 * The scanner keys its rows by label *and* region because one Trae account keeps
 * a copy in each region (and two different accounts can share a numeral). Keying
 * the hold by the label alone handed a 429 in one region to the other region's
 * copy, which then sorted behind a healthy account it had never failed against.
 */
test('a hold in one region does not reach the same name in the other', () => {
  const pool = orderingContext()
  const now = Date.now()
  const cnCopy = { name: 'same-name', expiresAtMs: now + 3_600_000 }
  const aiCopy = { name: 'same-name', expiresAtMs: now + 3_600_000 }
  const aiHealthy = { name: 'other', expiresAtMs: now + 3_600_000 }
  pool.noteSourceFailure('trae', 'cn', 'same-name', '7200')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [cnCopy, aiHealthy], sourceLabel, false).map(sourceLabel),
    ['other', 'same-name'],
    'the refused copy in this region sorts behind the healthy one')
  assert.deepEqual(pool.orderSourceCredentials('trae', 'ai', [aiCopy, aiHealthy], sourceLabel, false).map(sourceLabel),
    ['same-name', 'other'],
    "the other region's copy of that name never failed, so it leads")
})

test('the picked account leads in every mode, and a retired pick does not', () => {
  const now = Date.now()
  const a = { name: 'a', expiresAtMs: now + 3_600_000 }
  const b = { name: 'b', expiresAtMs: now + 3_600_000 }
  for (const distribution of ['priority', 'round-robin', 'expiry']) {
    const pool = orderingContext({ preferredSourceAccount: () => 'b', sourceDistribution: () => distribution })
    assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false).map(sourceLabel), ['b', 'a'],
      `the picked account leads under ${distribution} too`)
  }
  // A label no credential still carries is not a preference: renaming or
  // re-signing in retires it, and honouring it returned it before the expiry
  // sort could run, so the panel showed round-robin while one account served
  // every chat. The observable damage is that a truthy `preferred` also switches
  // rotation off, so a retired pick freezes the pool on one account.
  const retired = orderingContext({ preferredSourceAccount: () => 'gone' })
  assert.deepEqual(retired.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false).map(sourceLabel), ['a', 'b'],
    'a pick naming an account that is no longer there does not lead')
  const spinning = orderingContext({ preferredSourceAccount: () => 'gone', sourceDistribution: () => 'round-robin' })
  const turns = []
  for (let turn = 0; turn < 3; turn += 1) {
    turns.push(spinning.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(','))
  }
  assert.deepEqual(turns, ['a,b', 'b,a', 'a,b'],
    'a retired pick must not switch rotation off, or one account serves every chat')
})

test('the expiry mode spends the soonest-expiring pack first, and never an expired one', () => {
  const pool = orderingContext({ sourceDistribution: () => 'expiry' })
  const now = Date.now()
  // The urgency comes from the recorded credit pack, not from the token expiry:
  // a one-off pack has to be spent before it lapses, and a monthly pack can
  // wait. `packUrgency` returns Infinity for a sign-in with nothing recorded, so
  // both of these carry a pack.
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'soon'), now + 3_600_000)
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'later'), now + 86_400_000)
  const soon = { name: 'soon', expiresAtMs: now + 7 * 86_400_000 }
  const later = { name: 'later', expiresAtMs: now + 3_600_000 }
  const dead = { name: 'dead', expiresAtMs: now - 60_000 }
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [later, soon, dead], sourceLabel, false).map(sourceLabel),
    ['soon', 'later', 'dead'],
    'the pack that expires soonest is spent first, so a one-off pack is not wasted - and the token expiry says the opposite, which is the point')
  // An expired sign-in is last even when its pack is the most urgent.
  pool.sourceCreditExpiry.set(pool.accountStateKey('trae', 'cn', 'dead'), now + 60_000)
  assert.deepEqual(pool.orderSourceCredentials('trae', 'cn', [later, soon, dead], sourceLabel, false).map(sourceLabel),
    ['soon', 'later', 'dead'],
    'an expired sign-in is never spent first however urgent its pack is')
})

test('round-robin rotates only among the sign-ins that can still answer', () => {
  const pool = orderingContext({ sourceDistribution: () => 'round-robin' })
  const now = Date.now()
  const a = { name: 'a', expiresAtMs: now + 3_600_000 }
  const b = { name: 'b', expiresAtMs: now + 3_600_000 }
  const dead = { name: 'dead', expiresAtMs: now - 60_000 }
  const seen = []
  for (let turn = 0; turn < 4; turn += 1) {
    seen.push(pool.orderSourceCredentials('trae', 'cn', [a, b, dead], sourceLabel, true).map(sourceLabel).join(','))
  }
  assert.deepEqual(seen, ['a,b,dead', 'b,a,dead', 'a,b,dead', 'b,a,dead'],
    'the cursor walks the live accounts one per chat and leaves the expired one last')
  // A read that is not a chat must not advance the cursor: it would make the
  // account a chat lands on depend on whichever read ran last. An odd number of
  // non-rotating reads is what makes the difference observable - an even number
  // lands back on the same step either way.
  const first = pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(',')
  for (let read = 0; read < 3; read += 1) pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, false)
  const second = pool.orderSourceCredentials('trae', 'cn', [a, b], sourceLabel, true).map(sourceLabel).join(',')
  assert.notEqual(first, second, 'two rotating calls with nothing in between give two different orders')
  assert.equal(second, first === 'a,b' ? 'b,a' : 'a,b',
    'a model-list or health read must not consume a rotation step')
  // With one live account there is nothing to rotate.
  const single = orderingContext({ sourceDistribution: () => 'round-robin' })
  assert.deepEqual(single.orderSourceCredentials('trae', 'cn', [dead, a], sourceLabel, true).map(sourceLabel), ['a', 'dead'],
    'a single live account leads and rotation is a no-op')
})

/** The balanced block that starts at `from`, for the extractions above. */
function balanced(source, from) {
  let depth = 0
  let quote = ''
  for (let index = source.indexOf('{', from); index < source.length; index += 1) {
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
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(from, index + 1)
    }
  }
  throw new Error('unbalanced block at ' + from)
}

/**
 * A forced refresh does not free the slot the background pass is still using.
 *
 * The click runs its own pass so it answers with figures it fetched itself, but
 * releasing the slot when ITS work ended left the background pass running with
 * nothing marking the slot as taken. A panel open or a settings change landing
 * in that window started a third pass beside it: the two reconciled the same
 * gateways, both wrote the declaration, and every account was probed twice.
 */
test('a forced refresh holds the pass slot until the background pass has finished', async () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const from = source.indexOf('async function refreshAll(')
  assert.notEqual(from, -1, 'refreshAll must exist in the host entry')
  let release;
  const gate = new Promise((resolve) => { release = resolve });
  let documents = 0;
  const context = vm.createContext({
    setTimeout, clearTimeout, setInterval, clearInterval,
    serviceStopped: false,
    loadGeneration: 1,
    refreshInflight: null,
    refreshTimer: null,
    REFRESH_PASS_BUDGET_MS: 18000,
    activeRegions: () => [],
    runtimes: new Map(), traeGateways: new Map(), qoderGateways: new Map(),
    poolNeedsScan: false, pendingRuntimeStops: [],
    core: { pool: { scan: async () => {} } },
    stillLoaded: () => true,
    stalePass: () => ({ stale: true }),
    adoptHostSettings: async () => {},
    applySettingsToCore: () => {},
    reconcileTraeGateways: async () => {},
    reconcileQoderGateways: async () => {},
    refreshSourceAccounts: async () => {},
    warmSourceDirectory: async () => {},
    refreshRuntime: async () => ({ ok: true }),
    syncDeclaration: () => {},
    settleWithin: (work, budgetMs) => {
      // The race is what makes a bounded handover time out, so the timer has to
      // be real; it is cleared the moment the race settles, or the test file
      // would hold the event loop open for the length of a pass budget.
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      return Promise.race([Promise.resolve(work), timeout])
        .finally(() => clearTimeout(timer));
    },
    // The first pass to reach its document stops there, which is the state a slow
    // background pass is in when a Refresh click lands on top of it.
    statusDocument: async () => {
      documents += 1;
      return documents === 1 ? gate : { pass: documents };
    },
  })
  vm.runInContext(balanced(source, from), context)
  // The real deadline helper, paired with the stubbed race above: a copy here
  // would let the extraction drift from the helper `refreshAll` calls.
  vm.runInContext(balanced(source, source.indexOf('function budget(ms)')), context)
  const slot = () => vm.runInContext('refreshInflight', context)

  const background = context.refreshAll('panel', false)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(slot(), null, 'the background pass holds the slot while it runs')

  const forced = context.refreshAll('click', true)
  // Past the handover window: releasing the slot when the
  // click's own work ended happened inside that window, which is exactly what
  // let a third caller start a pass beside the background one.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.notEqual(slot(), null,
    'the forced pass must not free the slot while the background pass is still running')

  release({ pass: 0 })
  assert.deepEqual(JSON.parse(JSON.stringify(await forced)), { pass: 2 },
    'the click still ran a pass of its own rather than answering with the background figures')
  assert.deepEqual(JSON.parse(JSON.stringify(await background)), { pass: 0 },
    'the background pass answers with the document it fetched')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(slot(), null, 'the slot is freed once both passes have finished')
})

/**
 * A sealed field the at-rest key was written with opens, and one written under
 * another key does not.
 *
 * The envelope is built here rather than mocked, because the layout is the
 * contract: the AAD names the suite and the key id, which is what makes a field
 * sealed under a rotated key refuse by name instead of decrypting into garbage,
 * and what makes an edited ciphertext fail the GCM tag instead of yielding a
 * token nobody issued. Nothing here asks the installed app for its key, so the
 * case runs on a machine with no WorkBuddy install at all.
 */
test('a WorkBuddy field sealed under the at-rest key opens, and one sealed under another does not', () => {
  const { createCipheriv, createHash } = require('node:crypto')
  const { openEncryptedField } = require('../src/at-rest.ts')
  const uint32 = (value) => {
    const bytes = Buffer.allocUnsafe(4)
    bytes.writeUInt32BE(value)
    return bytes
  }
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([uint32(bytes.length), bytes])
  }
  // The AAD the opener binds, spelled out so a change to the layout on either
  // side of the wire fails this case rather than reading as an unavailable key.
  const fieldAad = (keyId, suite) => Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lengthPrefixed('WBEV1'),
    lengthPrefixed('sym-v1'),
    uint32(suite),
    lengthPrefixed(keyId),
    Buffer.from([2, 0, 0]),
  ])
  const seal = (key, plaintext) => {
    const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const nonce = Buffer.alloc(12, 9)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(fieldAad(keyId, 1))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    })).toString('base64') }
  }
  const key = createHash('sha256').update('fixture at-rest secret').digest()
  const field = seal(key, 'fixture-access-token')
  assert.equal(openEncryptedField(field, key), 'fixture-access-token',
    'a field sealed under the key the app derived must open to the token it holds')
  // The app re-derives its at-rest key when it is reinstalled or upgraded, and
  // the field names the key it was sealed with: the refusal has to say which
  // key is missing, because that name is the signal the reader drops its cache
  // on. An auth failure instead reads as a foreign field and keeps the old key.
  const rotated = createHash('sha256').update('a later at-rest secret').digest()
  assert.throws(() => openEncryptedField(field, rotated), /belongs to key/,
    'a field sealed under a key this process does not hold must be refused by key id')
  const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  const edited = Buffer.from(record.ciphertext, 'base64')
  edited[0] ^= 0xff
  assert.throws(() => openEncryptedField({
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({ ...record, ciphertext: edited.toString('base64') })).toString('base64'),
  }, key), /authenticate/i, 'an edited ciphertext must fail the tag, not decrypt to a token nobody issued')
})

/**
 * A credential whose refresh token has expired still reaches the pool.
 *
 * The two tokens expire on their own clocks, and the access token routinely has
 * hours left when the refresh one is spent. Reading the whole document as
 * unreadable then took the account out of the pool for that window, and the
 * panel reported "no WorkBuddy sign-in found" over a token that was still
 * serving. Blanking the refresh token lands the request path in the no-refresh
 * branch instead, which warns once and keeps serving.
 */
test('a credential whose refresh token has expired still reaches the pool', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const HOUR = 3600000
  const temporary = scratch('refresh-spent')
  const spentDir = path.join(temporary, 'spent')
  const liveDir = path.join(temporary, 'live')
  const future = Date.now() + HOUR
  const past = Date.now() - HOUR
  writeSignIn(spentDir, {
    auth: { accessToken: 'live-token', refreshToken: 'refresh-me', expiresAt: future, refreshExpiresAt: past },
  })
  writeSignIn(liveDir, {
    auth: { accessToken: 'live-token', refreshToken: 'refresh-me', expiresAt: future, refreshExpiresAt: future },
  })
  const spentPool = new WorkBuddyAccountPool({ authDirs: [spentDir] })
  const livePool = new WorkBuddyAccountPool({ authDirs: [liveDir] })
  try {
    assert.equal((await spentPool.scan()).length, 1,
      'a sign-in whose refresh token is spent must still be listed, not discarded whole')
    const spent = spentPool.list()[0].credential
    assert.equal(spent.accessToken, 'live-token',
      'the access token beside a spent refresh token is still a usable sign-in')
    assert.equal(spent.refreshToken, '',
      'a refresh token past its own expiry renews nothing, so it must not be carried')
    assert.equal(spent.refreshExpiresAtMs, undefined,
      'and the expiry that disqualified it must not be published either')
    // The control: the same file with time left on the refresh token keeps it.
    assert.equal((await livePool.scan()).length, 1, 'the control must list the same sign-in')
    const live = livePool.list()[0].credential
    assert.equal(live.accessToken, 'live-token', 'the control must read the same access token')
    assert.equal(live.refreshToken, 'refresh-me', 'a refresh token with time left is still carried')
    assert.equal(live.refreshExpiresAtMs, future, 'and so is the expiry it carries')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The upstream's own default effort reaches the model row it belongs to.
 *
 * `defaultEffort` is the level the upstream opens a new session on, and
 * dropping it published the plugin's own fallback instead: a model that starts
 * at `high` opened at the lowest offered level, and the first turn of every
 * session was answered at the wrong depth. A model that declares no default
 * must carry no field at all, or the host would publish a level the upstream
 * never named.
 */
test('the upstream default effort reaches the model row it belongs to', () => {
  const { toModelInfo, catalogFromUpstream, FALLBACK_WORKBUDDY_MODELS } = require('../src/catalog.ts')
  const declared = toModelInfo({
    id: 'fixture-model',
    name: 'Fixture',
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: { supportedEfforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'high' },
  })
  assert.equal(declared.defaultThinkingLevel, 'high',
    'a model that opens at a non-minimum level must publish that level, not the plugin fallback')
  assert.deepEqual(declared.supportedEfforts, ['minimal', 'low', 'medium', 'high'],
    'the offered levels must survive the mapping alongside the default')
  const bare = toModelInfo({ id: 'bare-model', name: 'Bare', contextWindow: 200_000, maxTokens: 32_000 })
  assert.equal('defaultThinkingLevel' in bare, false,
    'a model that declares no default must carry no field, or the host invents a level upstream never named')
  assert.deepEqual(catalogFromUpstream([{
    id: 'fixture-model', name: 'Fixture', contextWindow: 200_000, maxTokens: 32_000,
    reasoning: { defaultEffort: 'high' },
  }]).map(row => row.defaultThinkingLevel), ['high'],
    'the live list is mapped through the same function, so the default reaches the picker either way')
  // A read that failed is not the upstream saying it has no models, and the
  // fallback is what a fresh install serves, so an empty list must keep it.
  assert.equal(catalogFromUpstream([]), FALLBACK_WORKBUDDY_MODELS,
    'an empty live list must keep the static fallback rather than publish an empty picker')
})

/**
 * A refusal is answered in the class the upstream actually used.
 *
 * All four classifiers are pure and each one decides the status the client is
 * answered with, so a class read one band off turns a rate limit into a client
 * error the client never retries, or an upstream outage into the caller's own
 * mistake. Trae reports its outages inside the stream on the same `event: error`
 * frame a bad request uses, so the leading digit of its code is the class; Qoder
 * spells its own as strings and delivers a spent allowance together with queue
 * markers, so the daily check has to run before the queue one.
 */
test('a Trae or Qoder refusal is answered in the class the upstream used', () => {
  const { classifyTraeUpstreamError } = require('../src/trae-upstream.ts')
  const { classifyQoderUpstreamError } = require('../src/qoder-client.ts')
  const { classifyTraeFailure } = require('../src/trae-shim.ts')
  const { classifyQoderFailure, QoderQueueRejection, QoderDailyLimitRejection, QoderSignInExpiredError } = require('../src/qoder-shim.ts')

  const byStatus = [
    [401, 'authentication'],
    [403, 'authentication'],
    [402, 'hard_credit'],
    [429, 'soft_rate'],
    [404, 'not_found'],
    [500, 'server'],
    [503, 'server'],
    [400, 'client'],
    [422, 'client'],
  ]
  for (const classify of [classifyTraeUpstreamError, classifyQoderUpstreamError]) {
    for (const [status, kind] of byStatus) {
      assert.equal(classify(status), kind, `${classify.name}(${status}) must read as ${kind}`)
    }
  }

  // The subscription gate is the one code answered 402 outright: 402 is what
  // makes a client stop rather than retry, and it is truthful.
  assert.deepEqual(classifyTraeFailure({ code: 1005, message: 'subscription gate' }),
    { status: 402, kind: 'hard_credit' }, 'the Trae subscription gate is a 402, not a client error')
  // A queue frame names its own wait inside its message as a JSON document.
  const queued = classifyTraeFailure({ code: 4001, message: JSON.stringify({ retryAfterSeconds: 45 }) })
  assert.equal(queued.status, 429, 'a queued Trae account is a rate limit, which rotates')
  assert.equal(queued.kind, 'soft_rate')
  assert.equal(queued.retryAfterSeconds, 45, 'and the wait the frame named must reach the client')
  // Trae's own codes are >= 4000 on the wire, so the leading digit is the class:
  // a 5xxx is upstream's fault and a 4xxx is the caller's, and the 429x band is
  // a limit rather than a malformed request.
  assert.deepEqual(classifyTraeFailure({ code: 5001, message: 'upstream is down' }),
    { status: 502, kind: 'server' }, 'a 5xxx code is an upstream outage, which a client retries')
  assert.deepEqual(classifyTraeFailure({ code: 4295, message: 'throttled' }),
    { status: 429, kind: 'client' }, 'the 429x band is a limit wearing a 4xx code')
  assert.deepEqual(classifyTraeFailure({ code: 4001, message: 'bad config' }),
    { status: 400, kind: 'client' }, 'a 4xxx code is the request the caller sent')
  // A frame with no code at all is upstream's fault too: there is no client
  // mistake the gateway could name.
  assert.deepEqual(classifyTraeFailure({ message: 'refused' }),
    { status: 502, kind: 'server' }, 'a refusal with no code cannot be blamed on the caller')

  // A spent allowance arrives WITH queue markers and a multi-hour wait, so the
  // daily check runs first: reading it as a queue turned it into a long sleep
  // instead of a failover.
  const spent = classifyQoderFailure({ code: '110', message: 'daily quota spent', retryAfterSeconds: 7200 })
  assert.equal(spent.status, 429)
  assert.equal(spent.kind, 'hard_credit', 'a spent daily allowance is not a queue to wait out')
  assert.ok(spent.error instanceof QoderDailyLimitRejection)
  assert.equal(spent.error.retryAfterSeconds, 7200,
    'the stated wait must ride along, or the client retries at once against the same exhausted quota')
  const qoderQueued = classifyQoderFailure({ code: '10605', message: 'queued', retryAfterSeconds: 30 })
  assert.equal(qoderQueued.status, 429)
  assert.equal(qoderQueued.kind, 'soft_rate')
  assert.ok(qoderQueued.error instanceof QoderQueueRejection)
  assert.equal(qoderQueued.error.retryAfterSeconds, 30)
  // The sign-in spellings are matched before the bare code, so a stray field
  // name never shadows an expired sign-in.
  assert.equal(classifyQoderFailure({ code: '105', message: 'Login expired' }).status, 401)
  assert.equal(classifyQoderFailure({ code: '999', message: 'token is not active' }).kind, 'authentication')
  assert.ok(classifyQoderFailure({ code: '999', message: 'TOKEN_EXPIRE' }).error instanceof QoderSignInExpiredError)
  // And the bare code on its own, for the answer that names no marker at all.
  assert.equal(classifyQoderFailure({ code: '105', message: 'sign-in is no longer valid' }).status, 401,
    'the code alone must read as an expired sign-in, not as an upstream fault')
  // Two co-occurring queue descriptors are a queue even with no code the
  // decoder names, and one marker on its own is not.
  assert.equal(classifyQoderFailure({ code: '9999', message: '{"queueType":"q","isQueued":true}' }).kind, 'soft_rate')
  assert.equal(classifyQoderFailure({ code: '9999', message: '{"queueType":"q"}' }).status, 502,
    'a lone queue marker is not a queue')
  // A fabricated thinking flag is the caller's own mistake, and a bare code the
  // gateway does not know is an upstream fault it cannot place.
  assert.equal(classifyQoderFailure({ code: '1210', message: 'reasoning_effort is not supported' }).status, 400,
    'a request the upstream refused for its own shape is the caller\'s mistake')
  assert.equal(classifyQoderFailure({ code: '1210', message: 'reasoning_effort is not supported' }).kind, 'client')
  assert.equal(classifyQoderFailure({ code: '9999', message: 'something went wrong' }).status, 502)
  assert.equal(classifyQoderFailure({ code: '429', message: 'slow down' }).kind, 'soft_rate')
  assert.equal(classifyQoderFailure({ code: '402', message: 'payment required' }).kind, 'hard_credit')
})

/**
 * A service that throws costs the ones registered after it nothing.
 *
 * The registrations are independent, so a throwing `stop` that skipped the rest
 * left a gateway bound with nothing left to close it: the panel kept reporting
 * a live endpoint for a plugin that had already been torn down. The hooks are
 * kept rather than cleared, because disabling and re-enabling the plugin runs
 * stop and then start with no load in between, and an empty map would leave the
 * re-enable with nothing to start.
 */
test('a service that throws costs the ones registered after it nothing', async () => {
  const { pi, installPi, startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  installPi({})
  const warn = console.warn
  console.warn = () => {}
  const events = []
  const throwing = (id) => ({
    id,
    start: () => { throw new Error('fixture start collapse') },
    stop: () => { throw new Error('fixture stop collapse') },
  })
  try {
    pi.services.register(throwing('round-throwing'))
    pi.services.register({ id: 'round-survivor', start: () => events.push('start'), stop: () => events.push('stop') })
    await startRegisteredService()
    assert.deepEqual(events, ['start'],
      'a service whose start throws must not skip the one registered after it, or a gateway never binds')
    await stopRegisteredService()
    assert.deepEqual(events, ['start', 'stop'],
      'and neither must one whose stop throws, or the survivor outlives its plugin')
    // A re-enable runs start again over the same registrations: the hooks are
    // kept, so the gateways come back without a reload.
    await startRegisteredService()
    assert.deepEqual(events, ['start', 'stop', 'start'],
      'the hooks survive the teardown, or a re-enable has nothing left to start')
  } finally {
    console.warn = warn
  }
})

// ---------------------------------------------------------- third round

/**
 * A loopback server stops listening and aborts a turn that is still in flight.
 *
 * Teardown makes two calls and each buys a different thing, so dropping either
 * one is a hang the user sees as the plugin staying alive after they disabled
 * it:
 *
 * - no `server.close()`: the endpoint keeps listening, so the process never
 *   exits. Caught by `port()` still being non-zero afterwards.
 * - no `closeAllConnections()`, or it sequenced after the wait: `close()` waits
 *   for its connections to end and a chat mid-stream does not end until the
 *   upstream does, so teardown blocks on the upstream instead of on the user.
 *   Caught by the close itself not returning.
 *
 * An idle keep-alive socket is NOT what decides this: `close()` drops those on
 * its own, and all four orderings resolve with nothing in flight. A turn that
 * is still streaming is what makes the difference, so that is the fixture here.
 */
test('a loopback server stops listening and aborts a turn that is still in flight', async () => {
  const http = require('node:http')
  const { createLoopbackServer } = require('../src/loopback.ts')
  const server = createLoopbackServer({
    label: 'teardown probe',
    port: 0,
    // One route answers, one never does: a turn that is still streaming.
    handle: (req, res) => { if (req.url === '/hang') return; res.writeHead(200); res.end('ok') },
  })
  await server.ready
  let streaming
  const inFlight = new Promise((resolve) => {
    streaming = http.get(`http://127.0.0.1:${server.port()}/hang`, (response) => {
      response.resume()
      response.on('end', () => resolve('ended'))
    })
    streaming.on('error', (error) => resolve('errored:' + error.code))
  })
  // Give the request time to reach the handler, so it really is in flight
  // rather than not yet sent.
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    // The close itself is what has to return: it waits for its connections to
    // end, and this one does not end on its own. The timer is unref'd because a
    // lost race leaves it pending, and a pending timer holds the whole test
    // process open long after the case is over.
    const outcome = await Promise.race([
      server.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 10_000).unref()),
    ])
    assert.equal(outcome, 'closed',
      'teardown must not wait on a turn that is still streaming: a chat mid-stream does not end until the upstream does')
    assert.equal(server.port(), 0,
      'the endpoint must stop listening, or the plugin keeps accepting after the user disabled it')
  } finally {
    // Drop the client end first, so a teardown that is still waiting on this
    // connection can finish, then close through the public API. Only the public
    // API is used and a second close is safe - its callback resolves either way.
    streaming.destroy()
    await server.close()
  }
})

/**
 * The refresh path's own contracts, which nothing pinned.
 *
 * `ensureFresh`'s doc says a failed refresh keeps a token that has not yet
 * expired so an unreachable refresh endpoint never takes down a working session,
 * and that a desktop re-login during the refresh supersedes the response. Both
 * were untested: dropping the still-valid guard, discarding the token on failure,
 * removing the object-identity check and removing the once-per-account warning
 * each left the whole suite green.
 */
const nearExpiryInfo = (name, extra = {}) => JSON.stringify({
  auth: { accessToken: 'token-' + name, refreshToken: 'refresh-' + name, expiresAt: Date.now() + 120_000, domain: 'www.workbuddy.cn', ...extra },
  account: { uin: 'uin-' + name, nickname: name },
})

test('a failed refresh keeps a token that has not yet expired', async () => {
  const dir = scratch('refresh-keeps-token')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), nearExpiryInfo('keeper'))
  const warnings = []
  const client = { refreshToken: async () => { throw new Error('the refresh endpoint is unreachable') } }
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir], client, cooldownMs: 60_000,
    logger: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
  })
  const account = await pool.acquire()
  assert.ok(account !== undefined, 'an account inside the refresh margin is still handed out')
  assert.equal(account.credential.accessToken, 'token-keeper',
    'a failed refresh must keep the token it had, so one bad round trip does not take the session down')
  assert.ok(warnings.some((args) => String(args[0]).includes('still valid')),
    'and it is reported as the recoverable failure it is, not as an expired token')
  assert.ok(!warnings.some((args) => String(args[0]).includes('token expired')),
    'a token with two minutes left is not an expired token')
})

test('a desktop re-login during the refresh is not overwritten by the stale response', async () => {
  const dir = scratch('refresh-relogin')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), nearExpiryInfo('relogin'))
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  let swapped = false
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir],
    // The refresh is in flight; the desktop app rewrites its file and a scan
    // lands the new credential while this response is still on the wire.
    client: {
      refreshToken: async () => {
        if (!swapped) {
          swapped = true
          pool.accounts[0].credential = { ...pool.accounts[0].credential, accessToken: 'from-the-new-login' }
        }
        return { accessToken: 'from-the-stale-refresh' }
      },
    },
    cooldownMs: 60_000,
  })
  await pool.acquire()
  assert.equal(pool.accounts[0].credential.accessToken, 'from-the-new-login',
    'the response the refresh was answering must not replace the credential the re-login installed')
})

test('a region-scoped caller never picks an account from the other region', async () => {
  const dir = scratch('region-scope')
  fs.writeFileSync(path.join(dir, 'cn.info'), JSON.stringify({
    auth: { accessToken: 'cn-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'cn-uin', nickname: 'cn' },
  }))
  fs.writeFileSync(path.join(dir, 'global.info'), JSON.stringify({
    auth: { accessToken: 'global-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.ai' },
    account: { uin: 'global-uin', nickname: 'global' },
  }))
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000 })
  const cn = await pool.acquire(undefined, 'cn')
  assert.equal(cn?.credential.accessToken, 'cn-token', 'a CN caller gets the CN sign-in')
  const global = await pool.acquire(undefined, 'global')
  assert.equal(global?.credential.accessToken, 'global-token', 'a global caller gets the global sign-in')
  // An account whose domain the other gateway cannot reach would answer every
  // request with a 403 or 404, which reads as an upstream outage.
  const scoped = await pool.acquire(undefined, 'cn')
  assert.notEqual(scoped?.credential.accessToken, 'global-token',
    'and it must keep doing so, not drift to whichever account is at the head')
})

test('a removed account stops being handed out without waiting for a rescan', async () => {
  const dir = scratch('removed-account')
  fs.writeFileSync(path.join(dir, 'a.info'), JSON.stringify({
    auth: { accessToken: 'a-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'a-uin', nickname: 'a' },
  }))
  fs.writeFileSync(path.join(dir, 'b.info'), JSON.stringify({
    auth: { accessToken: 'b-token', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'b-uin', nickname: 'b' },
  }))
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000 })
  await pool.acquire()
  const first = pool.accounts[0].id
  pool.applyRemoved([first])
  const after = await pool.acquire()
  assert.notEqual(after?.id, first,
    'a removed account must not come back the next time the desktop app rewrites its sign-in file')
  pool.applyRemoved([])
  const restored = await pool.acquire()
  assert.ok(pool.accounts.some((account) => account.id === first),
    'and restoring it takes effect at once too, without waiting for the next scan')
  assert.ok(restored !== undefined, 'the pool still answers after a restore')
})

test('the no-refresh-token warning fires once per account, not once per request', async () => {
  const dir = scratch('no-refresh-warning')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'token', refreshToken: '', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'uin', nickname: 'no-refresh' },
  }))
  const warnings = []
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir], cooldownMs: 60_000,
    // A client has to be present for `ensureFresh` to run at all; this branch
    // returns before it is used, because there is no refresh token to spend.
    client: { refreshToken: async () => ({ accessToken: 'unused' }) },
    logger: { warn: (...args) => warnings.push(String(args[0])), error: () => {} },
  })
  for (let turn = 0; turn < 3; turn += 1) await pool.acquire()
  const hits = warnings.filter((line) => line.includes('no refresh token'))
  assert.equal(hits.length, 1,
    'this branch is reached on every turn, so a warning per request buries every real failure in the log')
})

test('a sticky conversation keeps the account it started on', async () => {
  const dir = scratch('sticky-distribution')
  for (const name of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(dir, name + '.info'), JSON.stringify({
      auth: { accessToken: 'token-' + name, refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
      account: { uin: 'uin-' + name, nickname: name },
    }))
  }
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60_000, distribution: 'sticky' })
  const first = await pool.acquire(undefined, undefined, 'conversation-a')
  const again = await pool.acquire(undefined, undefined, 'conversation-a')
  const other = await pool.acquire(undefined, undefined, 'conversation-b')
  assert.equal(again?.id, first?.id,
    'the same conversation must keep its account, or the upstream prompt cache is discarded mid-conversation')
  assert.notEqual(other?.id, first?.id,
    'and a different conversation takes a different one, which is what spreads the spend')
})

/**
 * A 401 the upstream spells without a session marker still rotates.
 *
 * The loopback endpoint authenticates nothing, so the upstream is the only
 * party that could refuse the bearer, and a 401 is always about this account's
 * sign-in. Reading the unrecognised ones as `client` answered 400 and broke the
 * rotation on the first account: a stale sign-in then served every turn as a
 * hard failure while the refresh-and-retry path written for exactly this never
 * ran, and the healthy accounts behind it were never tried.
 */
test('a 401 without a session marker rotates and refreshes', async () => {
  const { WorkBuddyUpstreamClient, classifyUpstreamError } = require('../src/upstream.ts')
  assert.equal(classifyUpstreamError(401, ''), 'session_dead',
    'a bare 401 is about the sign-in, not about the request')
  assert.equal(classifyUpstreamError(401, '{"code":1001,"msg":"token expired"}'), 'session_dead',
    'and so is one the upstream answers with a business envelope')
  assert.equal(classifyUpstreamError(401, '<html><body>openresty</body></html>'), 'session_dead',
    'and so is the gateway page that refuses a credential it no longer honours')
  assert.equal(classifyUpstreamError(403, '{"code":7,"msg":"insufficient credit"}'), 'hard_credit',
    'a 403 the upstream judges on credits stays a credit verdict')

  // End to end through the shim: the refused account is refreshed, and when the
  // refresh cannot change the answer the next sign-in serves instead.
  const dir = scratch('rotate-401')
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (String(url).endsWith('/v2/plugin/auth/token/refresh')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'refreshed' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('<html>openresty</html>', { status: 401 })
    },
  })
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  for (const name of ['first', 'second']) {
    const home = path.join(dir, name)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: name, refreshToken: 'r-' + name, expiresAt: 0, domain: 'www.workbuddy.cn' },
      account: { uin: 'u-' + name, nickname: name },
    }))
  }
  const pool = new WorkBuddyAccountPool({ client, cooldownMs: 60000 })
  const { createWorkBuddyShim } = require('../src/shim.ts')
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(answer.status, 401,
      'every sign-in refused is a sign-in problem, not a 400 the client caused')
    assert.match(await answer.text(), /gateway rejected this credential/,
      'the answer names what to do about a stale sign-in instead of relaying the page')
    assert.ok(calls.some((url) => url.endsWith('/v2/plugin/auth/token/refresh')),
      'the refused sign-in must be refreshed, which is the one thing that can fix it')
    assert.ok(calls.filter((url) => url.endsWith('/v2/chat/completions')).length >= 2,
      'and the next sign-in must be tried, not only the one that failed')
  } finally {
    await shim.close()
  }
})

/**
 * A rate-limit reset that has already passed does not shadow a live header.
 *
 * The body parse is read first and returns a past timestamp unchanged, so a
 * stale or clock-skewed reset won the `??` and the header was never consulted.
 * `penalize` then took the "already past" branch and applied the 60 s default,
 * which returned a still-limited account to the head of the queue.
 */
test('a reset that has already passed does not shadow a live Retry-After', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async () => new Response('{"resetAt":1}', {
    status: 429, headers: { 'retry-after': '300' },
  }) })
  const limited = await client.chatStream(
    { accessToken: 't', refreshToken: 'r', expiresAtMs: 0, domain: 'www.workbuddy.cn', sourcePath: '' },
    '{}', new AbortController().signal,
  )
  assert.equal(limited.retryAfter, 300, 'the header is what the shim has to honour')

  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('past-reset')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], cooldownMs: 60000 })
  await pool.scan()
  const id = pool.list()[0].id
  pool.penalize(id, 1, 'hy3')
  assert.equal(pool.list()[0].cooldownUntilMs, 0,
    'a reset in the past is not a cooldown; the caller has to fall back to the header')
  pool.penalize(id, Date.now() + 300000)
  assert.ok(pool.list()[0].cooldownUntilMs > Date.now() + 4 * 60 * 1000,
    'a live wait lands as the account-wide cooldown the shim sends')
})

/**
 * A stream that fails mid-turn ends in a shape the client can finish on.
 *
 * Destroying the socket left a 200 with a truncated body and no terminator,
 * which is a turn the caller can only end by timing out and cannot tell from a
 * cancel. The two sibling gateways already end theirs with an in-band error
 * frame, a finish chunk and `[DONE]`.
 */
test('a WorkBuddy stream that fails mid-flight ends with a terminator', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('midflight')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir] })
  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
      controller.error(new Error('Bearer eyJhbGciOi.real.token.value rejected'))
    },
  })
  const client = {
    prepareChatBody: (raw) => raw,
    chatStream: async () => ({ ok: true, response: new Response(failing, { status: 200 }) }),
  }
  const { createWorkBuddyShim } = require('../src/shim.ts')
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const shim = createWorkBuddyShim({ pool, client, catalog: new WorkBuddyCatalog() })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const body = await answer.text()
    assert.match(body, /"error"\s*:\s*\{/, 'the failure must reach the client in band')
    assert.match(body, /upstream_error/, 'and it must be named as the upstream\'s doing')
    assert.match(body, /data: \[DONE\]/, 'and the stream must still carry its terminator')
    assert.doesNotMatch(body, /eyJhbGciOi\.real\.token\.value/,
      'the relayed error text is redacted before it leaves the process')
  } finally {
    await shim.close()
  }
})

/**
 * A credential that has died with nothing to refresh it is not picked.
 *
 * `available()` filtered cooldowns and switches but not expiry, so an expired
 * sign-in with no refresh token led every request: each one paid a failed
 * refresh round trip and then a guaranteed 401 before the hold moved traffic
 * to the healthy account behind it.
 */
test('an expired sign-in with no refresh token leads no request', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('expired-lead')
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'dead', refreshToken: '', expiresAt: Date.now() - 60000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-dead', nickname: 'Dead' },
  }))
  const live = path.join(dir, 'live')
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(live, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-live', nickname: 'Live' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir, live] })
  await pool.scan()
  const available = pool.available(Date.now())
  assert.equal(available.length, 1, 'only the sign-in that can serve a request is eligible')
  assert.equal(available[0].label, 'Live')
  assert.equal((await pool.acquire()).label, 'Live', 'and it is the one the pool hands out')
  // A sign-in that is merely near its expiry stays eligible: `ensureFresh`
  // renews it on the way through, which is the only thing that puts it back.
  fs.writeFileSync(path.join(live, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() - 60000, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-live', nickname: 'Live' },
  }))
  await pool.scan()
  assert.equal(pool.available(Date.now()).length, 1,
    'an expired token that still has a refresh token stays eligible')
})


/**
 * A sign-in that leaves the pool takes its balance and expiry with it.
 *
 * Both maps are keyed by account id and were never pruned, so a signed-out and
 * re-signed-in account inherited its old figures: the reserve floor kept it
 * unpickable and `expiry` mode ranked it on a pack that no longer existed.
 */
test('a departing account leaves no balance or expiry behind', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('departed')
  const gone = path.join(dir, 'gone')
  fs.mkdirSync(gone, { recursive: true })
  fs.writeFileSync(path.join(gone, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-gone', nickname: 'Gone' },
  }))
  // A reserve floor and an expiry ranking: the two settings that make the
  // balance and the pack expiry matter to the picker at all.
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir, gone],
    distribution: 'expiry',
    creditReserves: {},
  })
  await pool.scan()
  const id = pool.list()[0].id
  pool.setCreditBalance(id, 3, Date.now() + 3600000)
  pool.applyConfig({ creditReserves: { [id]: 5000 } })
  assert.equal(pool.available(Date.now()).length, 0,
    'the reserve floor holds the account back while its balance is below it')
  fs.rmSync(path.join(gone, 'workbuddy-desktop.info'))
  await pool.scan()
  assert.deepEqual(pool.list(), [], 'the deleted sign-in is dropped from the pool')
  // The same id signs back in: nothing it left behind may still apply to it.
  fs.writeFileSync(path.join(gone, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't2', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-gone', nickname: 'Gone' },
  }))
  await pool.scan()
  assert.equal(pool.list().length, 1, 'the re-signed-in account is back')
  assert.equal(pool.available(Date.now()).length, 1,
    'and it is pickable: no stale balance, reserve floor or pack expiry is inherited')
  // The expiry ranking too: a pack that expired with the old sign-in must not
  // still be what ranks the new one.
  assert.ok((await pool.acquire()).label === 'Gone',
    'the account is served, which only holds while no stale pack expiry ranks it out')
})

/**
 * The caller's abort listener is detached once the headers phase is over.
 *
 * One listener was added per `chatStream` call and never removed. A rotation
 * that exhausts its attempts adds one per account on the same caller signal,
 * which is how Node's listener warning used to fire on every exhausted turn.
 */
test('a headers deadline detaches the caller abort listener it added', () => {
  const { headersDeadline } = require('../src/upstream.ts')
  const caller = new AbortController()
  const { getEventListeners } = require('node:events')
  const before = getEventListeners(caller.signal, 'abort').length
  for (let round = 0; round < 9; round += 1) {
    headersDeadline(caller.signal, 50).arrived()
  }
  assert.equal(getEventListeners(caller.signal, 'abort').length, before,
    'every deadline that has arrived must take its listener with it, or the signal piles them up')
  // A deadline that has NOT arrived keeps forwarding the hang-up.
  const pending = headersDeadline(caller.signal, 50)
  assert.equal(getEventListeners(caller.signal, 'abort').length, before + 1,
    'the forwarding listener is still armed while the request is in flight')
  pending.arrived()
})

/**
 * The idle watchdog releases its timer when it fires.
 *
 * The watchdog cancels the reader, which resolves the pending read as an end,
 * so `pull` ran once more and re-armed. The timer that had just fired was
 * never cleared, so it outlived the stream it was watching and fired again
 * into a released reader on every watchdog-cancelled turn.
 */
test('an idle watchdog that fires releases its timer', async () => {
  const { withIdleWatchdog } = require('../src/upstream.ts')
  // The watchdog reads its timers from the globals, so they are counted by
  // standing in for them - the same way the clean-end case above does it. The
  // stub fires on the next turn, which is what reaches the fire branch.
  let armed = 0
  let cleared = 0
  let fired = 0
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (handler) => {
    armed += 1
    return realSetTimeout(() => { fired += 1; handler() }, 0)
  }
  globalThis.clearTimeout = (handle) => { cleared += 1; realClearTimeout(handle) }
  try {
    // A stream that never sends and never ends is the only way to reach the
    // fire branch at all.
    const relayed = withIdleWatchdog(new ReadableStream({ start() { /* never sends */ } }), 20)
    const reader = relayed.getReader()
    await assert.rejects(() => reader.read(), /went idle/,
      'the quiet stream fails instead of hanging')
    assert.equal(fired, 1, 'the watchdog fired exactly once')
    assert.equal(cleared, armed,
      'the timer that fired must be cleared, or it outlives the stream it watched')
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

/**
 * A Trae refusal that carries no code still rotates.
 *
 * Trae answers a stale login inside the stream, on the same `event: error`
 * frame a bad request uses, and often with no code at all. Answering it as a
 * 502 server failure is the one class the gateway does not rotate on, so every
 * request paid one round trip and the healthy sign-ins beside it were never
 * tried. The Qoder path in this same plugin classifies the identical frame as
 * an authentication failure.
 */
test('a code-less Trae login refusal rotates', () => {
  const { classifyTraeFailure } = require('../src/trae-shim.ts')
  const expired = classifyTraeFailure({ message: 'Login expired' })
  assert.equal(expired.status, 401, 'the status must say the sign-in, not the server')
  assert.equal(expired.kind, 'authentication', 'and the kind must be one the gateway rotates on')
  const unnamed = classifyTraeFailure({ message: 'upstream had an issue' })
  assert.equal(unnamed.kind, 'server', 'a refusal that names nothing stays the upstream\'s fault')
  assert.equal(classifyTraeFailure({ code: 1005, message: '' }).kind, 'hard_credit',
    'the subscription gate keeps its own class')
  assert.equal(classifyTraeFailure({ code: 10605, message: '{"retryAfterSeconds":30}' }).kind, 'soft_rate',
    'and a queue frame keeps naming its own wait')
})

/**
 * A Trae refusal with neither a code nor words is not assembled with a leading
 * separator.
 *
 * `parts.join(' · ')` is empty in that case, so the text began with a stray
 * bullet that reached the client in the error frame and in the peeked 502 body.
 */
test('a Trae refusal with no code carries no leading separator', () => {
  const { describeTraeFailure } = require('../src/trae-shim.ts')
  assert.equal(describeTraeFailure({ message: 'Login expired' }), 'upstream: Login expired',
    'a code-less refusal reads as a sentence, not as a separator and then one')
  assert.equal(describeTraeFailure({ message: '' }), 'Trae SOLO refused the request',
    'a refusal with nothing at all still says something')
  assert.equal(describeTraeFailure({ code: 1005, message: 'gate' }), 'code 1005 · upstream: gate')
})

/**
 * The model directory is read with the next sign-in when the first is refused.
 *
 * The directory is a per-account read like any other: a revoked sign-in answers
 * 401 on every one of its five functions, and reading with the first one only
 * left the whole gateway answering 503 and publishing no provider row while a
 * healthy sign-in sat beside it unused.
 */
test('a Trae directory read falls back to the next sign-in', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  let refused = 0
  const gateway = createTraeGateway({
    credentials: async () => [
      { accessToken: 'dead', refreshToken: '', expiresAtMs: 0, userId: 'dead', edition: 'cn', source: 'desktop', sourcePath: '' },
      { accessToken: 'live', refreshToken: '', expiresAtMs: 0, userId: 'live', edition: 'cn', source: 'desktop', sourcePath: '' },
    ],
    identity: async () => ({ machineId: 'm', deviceId: 'd' }),
    fetchImpl: async (_url, init) => {
      if (init?.headers?.['x-uid'] === 'dead') {
        refused += 1
        return new Response('nope', { status: 401 })
      }
      return new Response(JSON.stringify({
        config_info_list: [{ config_name: 'solo-pro', display_config: { display_name: 'Solo Pro' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/models', { headers: { host: '127.0.0.1' } })
    assert.equal(answer.status, 200, 'the gateway answers instead of reporting itself unavailable')
    const body = await answer.json()
    assert.equal(body.data.length, 1, 'the second sign-in\'s roster is served')
    assert.equal(body.data[0].id, 'solo-pro')
    assert.equal(gateway.models().length, 1, 'and the roster is cached for the next read')
    assert.equal(refused, 5,
      'the refused sign-in is given up on after its five directory functions, not retried forever')
  } finally {
    await gateway.close()
  }
})

test('a Qoder directory read falls back to the next sign-in', async () => {
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  let served = 0
  const gateway = createQoderGateway({
    region: 'cn',
    credentials: async () => [
      { token: 'dead', userID: 'dead', name: 'dead' },
      { token: 'live', userID: 'live', name: 'live' },
    ],
    fetchImpl: async () => {
      served += 1
      if (served === 1) return new Response('nope', { status: 401 })
      return new Response(JSON.stringify({ chat: [{ key: 'qmodel', display_name: 'Q Model', enable: true }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    },
  })
  try {
    await gateway.ready
    const answer = await fetch(gateway.baseUrl() + '/v1/models', { headers: { host: '127.0.0.1' } })
    assert.equal(answer.status, 200, 'the gateway answers instead of reporting itself unavailable')
    const body = await answer.json()
    assert.equal(body.data.length, 1, 'the second sign-in\'s roster is served')
    assert.equal(body.data[0].id, 'qmodel')
    assert.equal(served, 2, 'and the refused sign-in is not retried forever')
  } finally {
    await gateway.close()
  }
})

/**
 * A nested acknowledgement does not erase the outer business code.
 *
 * The walk reassigned `codeFromPlainKey` at every level, so the
 * `{"code":0}`-is-an-ack guard fired on the nested value and blanked the
 * outer `errorCode`. A classifiable refusal then read as unnamed, which the
 * gateway answered 502 for instead of rotating.
 */
test('a nested acknowledgement does not erase the outer refusal code', () => {
  const { unwrapFailure } = require('../src/qoder-sse.ts')
  assert.equal(unwrapFailure({ errorCode: '110', details: { code: 0, reqId: 1 } }).code, '110',
    'a container the upstream acknowledged in its own terms says nothing about the refusal that carries it')
  assert.equal(unwrapFailure({ code: 0 }).code, '', 'a bare acknowledgement is still not a refusal')
  assert.equal(unwrapFailure({ code: '10605', message: '{"retryAfterSeconds":30}' }).code, '10605',
    'and a code the frame names itself still comes through')
})

/**
 * One event's accumulated data lines may not grow without bound.
 *
 * The line guard measures the unterminated tail, which stays small on a stream
 * that keeps ending its lines: every `data:` line lands in `data` and only a
 * blank line drains it, so a stream that framed events without ever separating
 * them grew the array with no ceiling touching it.
 */
test('an SSE event that never separates is bounded', () => {
  const { SseDecoder } = require('../src/trae-sse.ts')
  const decoder = new SseDecoder()
  assert.throws(() => {
    for (let round = 0; round < 60000; round += 1) decoder.push('data: {"x":1}\n'.repeat(20))
  }, /exceeded/, 'a stream that never separates its events is stopped, not buffered')
})


/**
 * Each Trae storage file is probed once, under the first edition that names it.
 *
 * Two editions spell the same path on a case-sensitive filesystem, and probing
 * it twice produced two credentials from one install. When the storage document
 * named neither a region nor a host, the candidate's edition decided, so one
 * install published two provider rows and one region's gateway routed a foreign
 * token to the wrong endpoint.
 */
test('a Trae storage file is probed under one edition only', () => {
  const { traeStorageCandidates } = require('../src/trae-discovery.ts')
  for (const [platform, home, env] of [
    ['linux', '/home/fixture', {}],
    ['win32', 'C:\\Users\\fixture', { APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' }],
    ['darwin', '/Users/fixture', {}],
  ]) {
    const paths = traeStorageCandidates(platform, home, env).map((candidate) => candidate.path)
    assert.equal(new Set(paths).size, paths.length,
      platform + ': no physical file may be probed twice')
  }
  const bare = traeStorageCandidates('linux', '/home/fixture', {})
    .filter((candidate) => candidate.path.split(path.sep).includes('trae'))
  assert.equal(bare.length, 1, 'the bare `trae` spelling belongs to the first edition that claims it')
  // An international install on Linux still has to be discoverable.
  assert.ok(traeStorageCandidates('linux', '/home/fixture', {}).some((candidate) => candidate.edition === 'sg'),
    'the international edition keeps its own candidates')
})

/**
 * A Qoder model publishes the window it can actually be handed.
 *
 * `context_config` lists the sizes Qoder's own client can select (1M / 400K /
 * 200K) and marks the one currently chosen. Publishing the chosen one capped a
 * model that offers a million tokens at a fifth of it, and the host compacts
 * against exactly this number, so every conversation was trimmed at 200K no
 * matter which model served it. Verified against the live directory: a prompt
 * of a million tokens was accepted by `qmodel`.
 */
test('a Qoder model publishes the largest window its catalog offers', () => {
  const { qoderModelOf } = require('../src/qoder-client.ts')
  const row = (key, maxInputTokens, config) => qoderModelOf({
    key,
    display_name: key,
    max_input_tokens: maxInputTokens,
    context_config: config,
  })
  const full = row('qmodel', 180000, {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
    '400K': { token_count: 400000 },
  })
  assert.equal(full.contextWindow, 1000000,
    'the selected size is not the ceiling; the largest on offer is what the model takes')
  const only = row('mmodel', 180000, { '200K': { token_count: 200000, is_default: true } })
  assert.equal(only.contextWindow, 200000, 'a model with one size keeps that size')
  assert.equal(qoderModelOf({ key: 'bare', display_name: 'Bare', max_input_tokens: 300000 }).contextWindow,
    300000, 'no config at all falls back to the stated input budget')
  // The selected input budget must not be read as a smaller window either.
  const small = row('dmodel', 96000, {
    '1M': { token_count: 1000000 },
    '200K': { token_count: 200000, is_default: true },
  })
  assert.equal(small.contextWindow, 1000000,
    'a small selected budget is the current selection, not the model\'s limit')
})

/**
 * The global directory's unnamed routes never reach the picker.
 *
 * Qoder lists four entries under its own codenames — Ultimate, Efficient,
 * Sonus, Cantus — beside the named models, with nothing in the payload marking
 * them as different. Read as models they put four opaque rows above Qwen3.8-Max
 * in the picker. The body below is the live `chat` group, trimmed to one row per
 * kind: the four routes, the `auto` route that stays, and two named models.
 */
test('a Qoder directory publishes its named models and drops the unnamed routes', async () => {
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  const directory = {
    chat: [
      { key: 'auto', display_name: 'Auto', enable: true, is_default: true, max_input_tokens: 200000 },
      { key: 'ultimate', display_name: 'Ultimate', enable: true, is_reasoning: true, max_input_tokens: 1000000 },
      { key: 'efficient', display_name: 'Efficient', enable: true, max_input_tokens: 200000 },
      { key: 'smodel', display_name: 'Sonus', enable: true, is_new: true, max_input_tokens: 180000 },
      { key: 'cmodel', display_name: 'Cantus', enable: true, max_input_tokens: 180000 },
      { key: 'qmodel_38max', display_name: 'Qwen3.8-Max', enable: true, max_input_tokens: 180000 },
      { key: 'gmodel', display_name: 'GLM-5.3', enable: true, max_input_tokens: 180000 },
    ],
  }
  const client = new QoderUpstreamClient({
    region: 'global',
    credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
    fetchImpl: async () => new Response(JSON.stringify(directory), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const ids = (await client.fetchModels()).map((model) => model.id)
  assert.deepEqual(ids, ['auto', 'qmodel_38max', 'gmodel'],
    'the four codenames are dropped; Auto and the named models are published')
})

/**
 * A forced pass does not collapse onto a background read that skipped the roster.
 *
 * `connect` skips the fetch whenever the cached roster is still fresh, so a
 * forced click that returned the background pass's promise answered with the
 * figures it already had. The button exists precisely for the case where a
 * background read failed, and `catalogFetchedAtMs` is stamped even on failure,
 * which kept the roster stale for the whole TTL.
 */
test('a forced pass re-reads a roster the background pass skipped', async () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  // `connect` is the seam: it records the `force` flag it was handed, and the
  // first read stays in flight until the test releases it, which is what puts a
  // forced pass on top of a background one.
  const runs = []
  const events = []
  // One gate per read: the forced pass awaits the read in flight, so its own
  // read cannot be released from inside the call that started it.
  const gates = []
  const openNextGate = () => { const next = gates.shift(); if (next !== undefined) next() }
  const context = vm.createContext({
    console,
    connect: async (_runtime, force) => {
      const tag = force === true ? 'forced' : 'background'
      runs.push(force === true)
      events.push(tag + '-read')
      await new Promise((resolve) => { gates.push(resolve) })
      events.push(tag + '-done')
      return true
    },
  })
  const from = source.indexOf('async function refreshRuntime(')
  assert.notEqual(from, -1, 'refreshRuntime must exist in the host entry')
  vm.runInContext(balanced(source, from), context)

  const runtime = { connecting: null }
  // The background pass starts and stays in flight.
  const background = context.refreshRuntime(runtime, 'panel', false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, 'the background pass has started its read')
  // The user clicks Refresh while it is still reading.
  const forced = context.refreshRuntime(runtime, 'click', true)
  await new Promise((resolve) => setImmediate(resolve))
  openNextGate()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(runs, [false, true],
    'the forced pass must run its own read, not await the one that skipped it')
  // And it waits for the read it found in flight before starting its own: a
  // second concurrent read answers the click with figures that are no fresher
  // than the ones the click was meant to replace.
  assert.deepEqual(events, ['background-read', 'background-done', 'forced-read'],
    'the forced read starts only once the background read has finished')
  openNextGate()
  const answer = await forced
  assert.equal(answer.ok, true)
  await background
})

/**
 * A repointed auth file schedules the scan that refills the pool.
 *
 * `applyConfig` empties the pool when the directory set changes, and nothing
 * downstream reads the disk on its own. Without this both WorkBuddy provider
 * rows dropped out of the picker and the panel reported "no sign-in found"
 * until a chat request happened to scan, or the user pressed the rescan button.
 */
test('a repointed auth file schedules the scan that refills the pool', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const first = scratch('authfile-first')
  const second = scratch('authfile-second')
  fs.writeFileSync(path.join(first, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [first] })
  await pool.scan()
  assert.equal(pool.list().length, 1)
  assert.equal(pool.applyConfig({ authDirs: [second] }), true,
    'the pool must report that it was emptied')
  assert.deepEqual(pool.list(), [], 'and it is empty until something reads the new directory')
  await pool.scan()
  assert.deepEqual(pool.list(), [], 'the new directory holds no sign-in yet')
  fs.writeFileSync(path.join(second, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 't2', refreshToken: 'r', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-2', nickname: 'Second' },
  }))
  await pool.scan()
  assert.equal(pool.list().length, 1, 'the scan the flag schedules is what brings it back')
  assert.equal(pool.applyConfig({ cooldownMs: 120000 }), false,
    'a change that empties nothing reports nothing')
})

/**
 * An error body is bounded in time as well as in size.
 *
 * The headers deadline is disarmed before the caller reaches a non-2xx answer,
 * so an upstream that answered 429 and then trickled its error page held the
 * attempt until undici's own body timeout, and a rotation pays that once per
 * account before it can answer at all.
 */
test('a failed response body is bounded in time', async () => {
  const { readErrorBody, ERROR_BODY_TIMEOUT_MS } = require('../src/upstream.ts')
  assert.ok(ERROR_BODY_TIMEOUT_MS >= 1000 && ERROR_BODY_TIMEOUT_MS <= 12000,
    'the shipped deadline has to stay inside the range a rotation can pay')
  let cancelled = false
  const stalled = new Response(new ReadableStream({
    start() { /* never sends, never ends */ },
    cancel() { cancelled = true },
  }), { status: 429 })
  const started = Date.now()
  assert.equal(await readErrorBody(stalled, 4096, undefined, 50), '',
    'a body that never completes is abandoned rather than awaited')
  // The bound is a parameter so this case does not sit out the shipped 10 s
  // window; what matters is that the reader is cancelled, not how long it took.
  assert.ok(Date.now() - started < 2000, 'and it is abandoned without waiting for undici\'s body timeout')
  assert.equal(cancelled, true, 'and the reader is cancelled, which is what releases the socket')
  assert.equal(await readErrorBody(new Response('upstream said 429', { status: 429 }), 4096),
    'upstream said 429', 'a body that arrives is read')
  assert.equal((await readErrorBody(new Response('x'.repeat(20000), { status: 429 }), 100)).length, 100,
    'and the size bound holds too')
})

/**
 * A refusal that merely contains the word "already" is a failure, not a skip.
 *
 * The substring match counted any upstream text carrying "already" as the day
 * having been collected, which hid real breakages from the last-run line and
 * from the summary the user reads.
 */
test('a refusal that merely contains "already" is a failure', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'host.ts'), 'utf8')
  const start = source.indexOf('function isAlreadyCheckin(')
  assert.ok(start > 0, 'the classifier is where it is expected')
  const body = balanced(source, start)
  const mod = { exports: {} }
  new Function('module', 'exports', 'require',
    'const safeMessage = (error) => String((error && error.message) || error);\n' + body
    + '\nmodule.exports = { isAlreadyCheckin };')(mod, mod.exports, require)
  assert.equal(mod.exports.isAlreadyCheckin(new Error('already')), false,
    'a bare word is not the sentence the upstream uses for a collected day')
  assert.equal(mod.exports.isAlreadyCheckin(new Error('the account already exists')), false,
    'and neither is a refusal about the account')
  assert.equal(mod.exports.isAlreadyCheckin(new Error('already checked in today')), true)
  assert.equal(mod.exports.isAlreadyCheckin(new Error('您今天已经签到')), true)
})

/**
 * The panel keeps polling while every account is cooling.
 *
 * `probesStale` skips cooling accounts by design, so an all-cooling pool read
 * as "nothing to refresh" and the panel stopped polling: the figures stayed
 * stale until the user clicked Refresh or the poll hit its attempt cap.
 */
test('the panel keeps polling while every account is cooling', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'host.ts'), 'utf8')
  const grab = (name) => {
    const start = source.indexOf('function ' + name + '(')
    assert.ok(start > 0, name + ' is where it is expected')
    return balanced(source, start)
  }
  const mod = { exports: {} }
  const core = { pool: { list: () => accounts, isDisabled: () => false } }
  new Function('module', 'exports', 'require', 'core', 'regionEnabled', 'regionOf', 'probeCache', 'PROBE_TTL_MS',
    grab('cooldownPending') + '\n' + grab('probesStale') + '\nmodule.exports = { cooldownPending, probesStale };',
  )(mod, mod.exports, require, core, () => true, () => 'cn', new Map(), 60000)
  const accounts = [{ id: 'a', cooldownUntilMs: Date.now() + 60000 }]
  assert.equal(mod.exports.probesStale(accounts), false, 'a cooling account is never probed')
  assert.equal(mod.exports.cooldownPending(accounts), true,
    'but the cooldown is still something the panel is waiting for')
  accounts[0].cooldownUntilMs = 0
  assert.equal(mod.exports.cooldownPending(accounts), false,
    'and nothing at all when nothing is cooling')
})

/**
 * A chat request carries the conversation header family.
 *
 * The international gateway runs a channel check that refuses a request
 * carrying no conversation id at all: business code 11128,
 * `conversation id missing`, answered as a 400 whose tip says the call failed
 * channel verification. A request carrying the header family below is answered
 * instead of refused; one without a conversation id is refused every time.
 *
 * The shapes and the pairings follow the 5.8.4 client capture, and every id is
 * fresh per request: the upstream keeps no history by the conversation id, so
 * there is nothing to gain from deriving it and a stable value would be one
 * more thing for the check to notice.
 */
test('a chat request carries the conversation header family', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const international = {
    accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAtMs: 0,
    uid: 'fixture-uid', domain: 'www.workbuddy.ai', sourcePath: '',
  }
  let headers = {}
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      headers = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await client.chatStream(international, JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), undefined, { headersMs: 50 })

  const family = [
    'X-Conversation-ID', 'X-Conversation-Request-ID', 'X-Root-Request-ID',
    'X-Conversation-Message-ID', 'X-Request-ID',
  ]
  for (const name of family) {
    assert.ok(headers[name], name + ' must be present: the channel check refuses without it')
  }
  assert.equal(headers['X-Root-Request-ID'], headers['X-Conversation-Request-ID'],
    'the root request id carries the value the conversation request id states')
  assert.equal(headers['X-Request-ID'], headers['X-Conversation-Message-ID'],
    'and the request id carries the message id')
  // The conversation id is a dashed UUID; the four request ids are 32 hex.
  assert.match(headers['X-Conversation-ID'], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  for (const name of family.slice(1)) {
    assert.match(headers[name], /^[0-9a-f]{32}$/, name + ' is 32 hex characters')
  }
  // Fresh per request: nothing is derived, so two turns never share an id.
  let second = {}
  const again = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      second = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await again.chatStream(international, JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }), undefined, { headersMs: 50 })
  assert.notEqual(second['X-Conversation-ID'], headers['X-Conversation-ID'],
    'a second turn gets its own conversation id')

  // The CN gateway accepts the family too, so it is sent there as well rather
  // than branched on region.
  let cnHeaders = {}
  const cn = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      cnHeaders = { ...init?.headers }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  await cn.chatStream({
    accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAtMs: 0,
    uid: 'fixture-uid', domain: 'www.workbuddy.cn', sourcePath: '',
  }, JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    undefined, { headersMs: 50 })
  assert.ok(cnHeaders['X-Conversation-ID'], 'the CN request carries the family too')
  // CN keeps the UA it has always been sent: the gateway reads its roster with
  // that spelling, and there is no capture to align it to.
  // One client build, named the same way in the header and in the UA.
  assert.equal(cnHeaders['User-Agent'], 'WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0')
  assert.equal(cnHeaders['X-IDE-Version'], '5.8.4')
  assert.equal(headers['User-Agent'], 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    'the international request uses the captured desktop UA')
})

/**
 * An international turn opens with a system prompt even when the host did not.
 *
 * The international gateway refuses a request whose first message is not a
 * system prompt (code 11128, "first message is not system prompt"), and a host
 * that starts with the user's turn sends none. The injected prompt is empty on
 * purpose: it satisfies the check without adding an instruction the model would
 * follow, so the model still sees exactly what the host sent. The CN gateway
 * asks for neither, so the body it is sent is left alone.
 */
test('an international turn opens with a system prompt', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const sent = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (_url, init) => {
      sent.push({ domain: 'x', body: String(init?.body ?? '') })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const raw = JSON.stringify({
    model: 'hy3', stream: true, messages: [{ role: 'user', content: 'hi' }],
  })
  const international = {
    accessToken: 't', refreshToken: 'r', expiresAtMs: 0,
    uid: 'u', domain: 'www.workbuddy.ai', sourcePath: '',
  }
  await client.chatStream(international, raw, undefined, { headersMs: 50 })
  const messages = JSON.parse(sent[0].body).messages
  assert.equal(messages[0].role, 'system', 'the first message is a system prompt')
  assert.equal(messages[0].content, '', 'and it says nothing, so the model sees only the host\'s turn')
  assert.equal(messages[1].role, 'user', 'the host\'s own turn follows it unchanged')
  assert.equal(messages.length, 2, 'and nothing else is added')

  // A host that already opens with a system prompt is left exactly as it is.
  const withSystem = JSON.stringify({
    model: 'hy3', stream: true,
    messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
  })
  await client.chatStream(international, withSystem, undefined, { headersMs: 50 })
  assert.deepEqual(JSON.parse(sent[1].body).messages, JSON.parse(withSystem).messages,
    'a system prompt the host sent is not replaced or duplicated')

  // The CN gateway does not ask for one, so its body is untouched.
  await client.chatStream({
    accessToken: 't', refreshToken: 'r', expiresAtMs: 0,
    uid: 'u', domain: 'www.workbuddy.cn', sourcePath: '',
  }, raw, undefined, { headersMs: 50 })
  assert.deepEqual(JSON.parse(sent[2].body).messages, JSON.parse(raw).messages,
    'the CN request carries the host\'s body exactly')
})

/**
 * A request that names no thinking effort is not refused for the omission.
 *
 * `glm-5.1` rejects the whole request with HTTP 400 / 11133 ("the request
 * parameters were rejected by the model provider") when `reasoning_effort` is
 * absent, while the same request carrying `off` or any rung of its ladder is
 * served. A client that expresses no preference - a plain OpenAI client, or the
 * host on a model whose off level is not a name its map carries - therefore got
 * a refusal where an answer was due. The gateway retries once with the model's
 * own declared default, and only for that refusal: a genuinely malformed request
 * keeps its 400 and is not spent upstream twice.
 */
test('a request that names no thinking effort gets the model default, once', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const { createWorkBuddyShim } = require('../src/shim.ts')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'effort-token', refreshToken: 'effort-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-effort', nickname: 'effort' },
  }))

  // The refusal the upstream really answers with, verbatim enough for the code.
  const refusal = JSON.stringify({
    code: 11133,
    msg: 'the request parameters were rejected by the model provider',
    extError: { code: '1210', type: 'invalid_request_error', StatusCode: 400 },
  })
  const bodies = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url, init) => {
      // Only the chat calls are counted: the pool also refreshes the token for a
      // sign-in whose expiry has passed, and that POST is not a model request.
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'effort-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const body = JSON.parse(String(init?.body ?? '{}'))
      bodies.push(body)
      // The upstream's rule, as measured: any named effort is served (glm-5.1
      // even takes names outside its own ladder), and the field merely being
      // absent - or present but empty, which is not a level either - is what it
      // rejects.
      if (typeof body.reasoning_effort !== 'string' || body.reasoning_effort === '') {
        return new Response(refusal, { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  // The declared ladder comes from the upstream roster; the static fallback
  // states none, so the fixture states the row the live directory really carries.
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    supportedEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], defaultThinkingLevel: 'medium',
  }])
  // The pool must read THIS file and nothing else. Without `authDirs` it falls
  // back to the real desktop profile directories, so the case would pass on a
  // machine with a live WorkBuddy sign-in and fail everywhere else - a test that
  // reads the developer's own tokens.
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  const ask = async () => {
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    return { status: answer.status, text: await answer.text() }
  }
  try {
    await shim.ready
    const served = await ask()
    assert.equal(served.status, 200, 'the turn is served instead of refused for the missing field')
    assert.match(served.text, /pong/, 'and the upstream answer reaches the caller')
    assert.equal(bodies.length, 2, 'exactly one retry: the refusal, then the same request with a default')
    assert.equal(bodies[0].reasoning_effort, undefined, 'the first attempt is the caller\'s body, unchanged')
    assert.equal(bodies[1].reasoning_effort, 'medium',
      'the retry carries the default the catalog declares for this model')
    assert.deepEqual(bodies[1].messages, bodies[0].messages, 'and nothing else about the request changes')

    // A caller that named an effort is served on the first attempt: nothing is
    // sent twice on behalf of a request that was already complete.
    bodies.length = 0
    const named = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, reasoning_effort: 'off',
      }),
    })
    assert.equal(named.status, 200, 'a request that names its effort is served as sent')
    assert.equal(bodies.length, 1, 'and is not spent upstream a second time')
    assert.equal(bodies[0].reasoning_effort, 'off', 'the caller\'s own choice is what reaches the upstream')

    // An empty string is "no preference" spelled differently, so it is filled in
    // rather than read as a named level.
    bodies.length = 0
    const blank = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({
        model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, reasoning_effort: '',
      }),
    })
    assert.equal(blank.status, 200, 'an empty effort is filled in, not passed through as a refusal')
    assert.equal(bodies.length, 2, 'the empty string is retried, not accepted as a named level')
    assert.equal(bodies[1].reasoning_effort, 'medium', 'the declared default replaces the empty string')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A 400 that is not the parameter refusal is answered as it came.
 *
 * 11133 is a general invalid-parameter code, so the retry is gated on it being
 * that code *and* the request having named no effort. A different refusal - a
 * bad `temperature`, an unsupported field - must reach the caller after one
 * upstream call: retrying it would spend an account's request to produce the
 * same error, and would replace the first answer with the second.
 */
test('a refusal that is not the parameter rejection is not retried', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const { createWorkBuddyShim } = require('../src/shim.ts')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-skip-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'skip-token', refreshToken: 'skip-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-skip', nickname: 'skip' },
  }))

  let chatCalls = 0
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'skip-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      return new Response(JSON.stringify({ code: 11128, msg: 'the first message is not a system prompt' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    supportedEfforts: ['off', 'low', 'medium', 'high'], defaultThinkingLevel: 'medium',
  }])
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    assert.equal(answer.status, 400, 'a different refusal keeps its own status')
    assert.equal(chatCalls, 1, 'and is spent upstream exactly once')
    assert.match(await answer.text(), /11128/, 'the caller sees the upstream\'s own reason, not a rewritten one')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A declared default the model does not accept is not sent.
 *
 * Answering the refusal with a level the upstream also refuses would spend a second
 * call to produce the same error. The catalog is the only source of the default, and
 * it can disagree with the ladder it states - a row written by hand, or an upstream
 * that lists a level its own default is not on.
 */
test('a default outside the model ladder is not retried with', async () => {
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const { createWorkBuddyShim } = require('../src/shim.ts')

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-effort-ladder-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'ladder-token', refreshToken: 'ladder-refresh', expiresAt: 0, domain: 'www.workbuddy.cn' },
    account: { uin: 'u-ladder', nickname: 'ladder' },
  }))

  let chatCalls = 0
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url) => {
      if (!String(url).endsWith('/v2/chat/completions')) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: 'ladder-token', expiresIn: 3600 } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      chatCalls += 1
      return new Response(JSON.stringify({ code: 11133, msg: 'the request parameters were rejected by the model provider' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    },
  })
  const catalog = new WorkBuddyCatalog()
  catalog.update([{
    id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxOutputTokens: 48000,
    // The declared default is not on the ladder this row states.
    supportedEfforts: ['off', 'low', 'high'], defaultThinkingLevel: 'max',
  }])
  const pool = new WorkBuddyAccountPool({ authDirs: [home], client, cooldownMs: 60000 })
  const shim = createWorkBuddyShim({ pool, client, catalog })
  try {
    await shim.ready
    const answer = await fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: '127.0.0.1' },
      body: JSON.stringify({ model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }),
    })
    assert.equal(answer.status, 400, 'the refusal is passed through')
    await answer.text()
    assert.equal(chatCalls, 1,
      'and not retried: a default the model states it does not accept would be refused again')
  } finally {
    await shim.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A sign-in that is gone takes its hold and pack expiry with it.
 *
 * A label is not unique to one sign-in: a departed account's hold was inherited
 * by the next one that happened to carry the same name, which demoted it for the
 * rest of the hold despite never having failed, and its pack expiry corrupted
 * expiry-mode ordering. The keys come from the engine's own `sourceRegionKey`, so
 * the fixture cannot drift from the format `pruneSourceState` builds.
 */
test('a departed sign-in leaves no hold or pack expiry behind', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const rows = {
    traeAccountRows: [{ label: 'kept', region: 'cn' }],
    qoderAccountRows: [{ label: 'kept', region: 'cn' }],
    sourceFailureHold: new Map(),
    sourceCreditExpiry: new Map(),
  }
  const context = vm.createContext({ console, ...rows })
  const keyAt = source.indexOf('function sourceRegionKey(')
  const pruneAt = source.indexOf('function pruneSourceState(')
  assert.notEqual(keyAt, -1, 'sourceRegionKey must exist in the host entry')
  assert.notEqual(pruneAt, -1, 'pruneSourceState must exist in the host entry')
  vm.runInContext(balanced(source, keyAt) + balanced(source, pruneAt), context)
  context.accountStateKey = (from, region, label) => context.sourceRegionKey(from, region) + '\n' + label
  const keptTrae = context.accountStateKey('trae', 'cn', 'kept')
  const goneTrae = context.accountStateKey('trae', 'cn', 'gone')
  const keptQoder = context.accountStateKey('qoder', 'cn', 'kept')
  const goneQoder = context.accountStateKey('qoder', 'cn', 'gone')
  const until = Date.now() + 60000
  rows.sourceFailureHold.set(keptTrae, until).set(goneTrae, until)
  rows.sourceCreditExpiry.set(keptQoder, until).set(goneQoder, until)
  context.pruneSourceState()
  assert.equal(context.sourceFailureHold.size, 1, 'the hold of the departed sign-in is dropped')
  assert.ok(context.sourceFailureHold.has(keptTrae), 'and the one that is still signed in keeps its hold')
  assert.equal(context.sourceCreditExpiry.size, 1, 'the same for the pack expiry')
  assert.ok(context.sourceCreditExpiry.has(keptQoder), 'the surviving sign-in keeps its expiry')
})

/**
 * A service stop releases the refresh slot.
 *
 * The pass that holds the slot releases it when its own work ends, but a pass
 * suspended in a network await keeps it for up to the remainder of its budget.
 * The freshly loaded plugin's first background pass was dropped for that whole
 * window while the panel polled for something that was never coming.
 */
test('a service stop releases the refresh slot', async () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')
  const state = {
    serviceStopped: false,
    loadGeneration: 1,
    refreshTimer: null,
    refreshInflight: { held: true },
  }
  const stopped = []
  const context = vm.createContext({
    console,
    ...state,
    clearTimeout: () => { stopped.push('timer') },
    stopAutoCheckin: () => stopped.push('checkin'),
    stopAccountWatch: () => stopped.push('accountWatch'),
    abortWarmups: () => stopped.push('warmups'),
    clearModelRetries: () => stopped.push('modelRetries'),
    checkinAbort: { abort: () => stopped.push('checkinAbort') },
    runtimes: new Map(),
    runtimeStarts: new Map(),
    traeGateways: new Map(),
    qoderGateways: new Map(),
    // The teardown also drops the start failures of the activation it ends.
    gatewayStartFailures: new Map([['cn', 'listen EADDRINUSE']]),
    sourceStartFailures: new Map([['trae:cn', 'listen EADDRINUSE']]),
    stopRuntime: async () => {},
    log: () => {},
    safeMessage: (error) => String(error?.message ?? error),
  })
  const at = source.indexOf('async function onServiceStop(')
  assert.notEqual(at, -1, 'onServiceStop must exist in the host entry')
  vm.runInContext(balanced(source, at), context)
  await context.onServiceStop()
  assert.equal(context.refreshInflight, null,
    'the slot must be free for the freshly loaded plugin\'s first background pass')
  assert.equal(context.refreshTimer, null, 'and the deferred timer with it')
  assert.ok(stopped.includes('modelRetries'),
    'and the roster retries, which would otherwise fire into the next activation')
  assert.equal(context.gatewayStartFailures.size, 0,
    'a start failure belongs to the activation that produced it')
  assert.equal(context.sourceStartFailures.size, 0,
    'the same for the Trae/Qoder regions that could not bind')
})

/**
 * The vendor's channel check is answered as a cause, not as a wall of tips.
 *
 * WorkBuddy's domestic host refuses any request whose prompt names DeepSeek
 * Harness as the client (code 11128), on every account of that region. Rotation
 * cannot clear it, so the pool must not spend four upstream calls pretending to
 * try; and the body it returns is a block of mixed Chinese and English advice
 * that names no cause and no way forward. This pins the sentence the user reads.
 */
test('the channel refusal names its cause and the way forward', () => {
  const { unapprovedChannelRefusal } = require('../src/loopback.ts')
  const body = '{"code":11128,"msg":"Illegal API invocation from an unapproved channel","displayTips":{"zh":"这次调用没通过渠道校验"}}'
  const sentence = unapprovedChannelRefusal(body)
  assert.ok(typeof sentence === 'string', 'the refusal has to be recognised')
  assert.match(sentence, /DeepSeek Harness/, 'it names the identity the vendor rejected')
  assert.match(sentence, /international|Trae|Qoder/, 'and the sources that do serve it')
  assert.doesNotMatch(sentence, /unapproved channel|displayTips/, 'the vendor block of tips is not what the user reads')
  // A 400 that is not this one keeps the ordinary sentence, or the mapping would
  // swallow every real client error.
  assert.equal(unapprovedChannelRefusal('{"code":4003,"msg":"messages must not be empty"}'), undefined)
  assert.equal(unapprovedChannelRefusal('nothing structured'), undefined)
})

/**
 * The panel's "add account" login: the device-authorization flow the WorkBuddy
 * CLI signs in with, and the sign-in file it leaves behind.
 *
 * The upstream is an injected `fetchImpl` that records what it was sent, which
 * is the only place a wrong realm, origin or user agent shows up: the real
 * endpoints answer a browser-shaped request with the login page. The one case
 * that is not stubbed is the pool read-back, because a sign-in nothing can read
 * is not an account at all.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
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

const scratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-login-${label}-`))

/** An envelope answer, in the shape every WorkBuddy endpoint uses. */
function envelope(data, code = 0, msg = 'OK') {
  return new Response(JSON.stringify({ code, msg, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A stub upstream that answers the three login endpoints.
 *
 * `token` decides what the token endpoint says: `pending` is the ordinary
 * answer while the browser has not finished, anything else is the bundle.
 */
function loginStub(options = {}) {
  const seen = []
  const fetchImpl = async (url, init) => {
    const address = String(url)
    seen.push({
      url: address,
      method: init?.method,
      origin: init?.headers?.Origin,
      referer: init?.headers?.Referer,
      ua: init?.headers?.['User-Agent'],
    })
    if (address.includes('/v2/plugin/auth/state')) {
      return envelope({ state: options.state ?? 'st-1', authUrl: options.authUrl ?? 'https://example.invalid/login?state=st-1' })
    }
    if (address.includes('/v2/plugin/auth/token')) {
      if (options.token === 'pending') return envelope({}, 11217, '11217:login ing...')
      return envelope(options.token ?? { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 7200 })
    }
    return envelope(options.account ?? { uid: 'u-1', uin: '90000000001', nickname: 'Panel' })
  }
  return { fetchImpl, seen }
}

test('a panel login asks the CLI endpoints of its own realm', async () => {
  const { startDeviceLogin } = require('../src/login.ts')
  const { fetchImpl, seen } = loginStub()
  const start = await startDeviceLogin('cn', fetchImpl)
  assert.equal(start.state, 'st-1')
  assert.equal(start.authUrl, 'https://example.invalid/login?state=st-1')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'POST')
  assert.match(seen[0].url, /^https:\/\/copilot\.tencent\.com\/v2\/plugin\/auth\/state\?platform=CLI$/)
  assert.equal(seen[0].origin, 'https://www.codebuddy.cn',
    'the domestic endpoints are answered for the billing origin, not the gateway one')
  assert.equal(seen[0].referer, 'https://www.codebuddy.cn/')
  assert.equal(seen[0].ua, 'CLI/2.63.2 CodeBuddy/2.63.2', 'the CLI user agent is the one they answer')
})

test('a login started on the international realm uses its own gateway', async () => {
  const { startDeviceLogin } = require('../src/login.ts')
  const { fetchImpl, seen } = loginStub()
  await startDeviceLogin('global', fetchImpl)
  assert.match(seen[0].url, /^https:\/\/www\.workbuddy\.ai\/v2\/plugin\/auth\/state/)
  assert.equal(seen[0].origin, 'https://www.workbuddy.ai')
})

test('a business error while the browser has not finished reads as pending', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  const { fetchImpl } = loginStub({ token: 'pending' })
  assert.deepEqual(await pollDeviceLogin('cn', 'st-1', fetchImpl), { status: 'pending' },
    'the upstream has no wording for "no such login", so an unknown state waits too')
})

test('a finished login carries the domain its gateway needs', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  const { fetchImpl, seen } = loginStub({
    token: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 7200, domain: 'www.workbuddy.ai' },
    account: { uid: 'u-2', uin: '90000000002', nickname: 'Global' },
  })
  const answer = await pollDeviceLogin('global', 'st-1', fetchImpl)
  assert.equal(answer.status, 'ok')
  assert.equal(answer.signIn.region, 'global', 'the region follows the domain, so the token reaches its own gateway')
  assert.equal(answer.signIn.domain, 'www.workbuddy.ai')
  assert.equal(answer.signIn.accessToken, 'at-2')
  assert.equal(answer.signIn.uin, '90000000002')
  assert.ok(answer.signIn.expiresAtMs > Date.now() + 60_000, 'a real expiresIn is honoured, not the assumed lifetime')
  const account = seen.find((entry) => entry.url.includes('/v2/plugin/login/account'))
  assert.ok(account !== undefined, 'the identity is read once the token is in hand')
  assert.match(account.url, /^https:\/\/www\.workbuddy\.ai\/v2\/plugin\/login\/account\?state=/)
})

test('a login answer with no domain is stamped for its realm', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  const { fetchImpl } = loginStub({ token: { accessToken: 'at-3', refreshToken: 'rt-3' }, account: {} })
  const answer = await pollDeviceLogin('global', 'st-1', fetchImpl)
  assert.equal(answer.status, 'ok')
  assert.equal(answer.signIn.domain, 'www.workbuddy.ai',
    'an empty domain reads as CN, which would file an international token under the domestic gateway')
  assert.equal(answer.signIn.region, 'global')
  assert.ok(answer.signIn.expiresAtMs > Date.now(), 'a missing expiresIn falls back to the assumed lifetime, not to never')
})

test('an answer that is not one is a failure rather than a wait', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  for (const status of [401, 500, 502]) {
    const fetchImpl = async () => new Response('refused', { status })
    await assert.rejects(() => pollDeviceLogin('cn', 'st-1', fetchImpl),
      `HTTP ${status} must throw, or the panel waits on a login that cannot finish`)
  }
  const page = async () => new Response('<html>sign in</html>', { status: 200 })
  await assert.rejects(() => pollDeviceLogin('cn', 'st-1', page), 'the login page itself is not an answer')
})

test('a token answer with no access token is still pending', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  const { fetchImpl } = loginStub({ token: { refreshToken: 'rt-4' } })
  assert.deepEqual(await pollDeviceLogin('cn', 'st-1', fetchImpl), { status: 'pending' },
    'an unusable bundle is the same as no answer, and the panel keeps waiting rather than storing it')
})

test('an identity that cannot be read costs the name, not the sign-in', async () => {
  const { pollDeviceLogin } = require('../src/login.ts')
  const { fetchImpl } = loginStub({
    token: { accessToken: 'at-5', refreshToken: 'rt-5', domain: 'www.codebuddy.cn' },
  })
  const broken = async (url, init) => (String(url).includes('/v2/plugin/auth/token')
    ? fetchImpl(url, init)
    : new Response('gateway error', { status: 500 }))
  const answer = await pollDeviceLogin('cn', 'st-1', broken)
  assert.equal(answer.status, 'ok', 'the token is already good, so a failed identity read must not lose it')
  assert.equal(answer.signIn.nickname, '')
  assert.equal(answer.signIn.uin, '')
})

test('a panel sign-in is read back as an ordinary pool account', async () => {
  const { writeOwnSignIn, ownSignInDir, WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dataPath = path.join(scratch('signin'), 'data')
  const target = ownSignInDir(dataPath)
  assert.equal(target, path.join(dataPath, 'signins'), 'the plugin writes beside its own data, never the app\'s')
  const signIn = {
    region: 'cn', accessToken: 'at-panel', refreshToken: 'rt-panel',
    expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    uid: 'u-panel', uin: '90000000003', enterpriseId: '', nickname: 'Panel Account',
  }
  const file = await writeOwnSignIn(target, signIn)
  assert.match(path.basename(file), /^workbuddy-panel-90000000003\.info$/,
    'the file name carries the billing identity, so re-adding the account rewrites its own file')
  // The mode is a POSIX guarantee: Windows applies no such bits to a file it
  // creates, and what protects one there is the ACL on the directory.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600,
      'a sign-in file holds tokens and is not world-readable')
  } else {
    assert.ok(fs.existsSync(file), 'the sign-in file was written')
  }
  const pool = new WorkBuddyAccountPool({ authDirs: [target], cooldownMs: 60000 })
  const accounts = await pool.scan()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].credential.nickname, 'Panel Account')
  assert.equal(accounts[0].credential.uin, '90000000003')
  // The same account again, with a newer token.
  await writeOwnSignIn(target, { ...signIn, accessToken: 'at-panel-2' })
  assert.equal(fs.readdirSync(target).length, 1, 're-adding the same account must not leave a second file')
  const again = await pool.scan()
  assert.equal(again.length, 1, 'and so it stays one pool account')
  assert.equal(again[0].credential.accessToken, 'at-panel-2', 'the newer token is the one served')
})

test('a panel sign-in dedupes with the desktop sign-in for the same account', async () => {
  const { writeOwnSignIn, WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('dedupe')
  const desktop = path.join(dir, 'desktop')
  const own = path.join(dir, 'signins')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop.info'), JSON.stringify({
    auth: {
      accessToken: 'from-the-desktop', refreshToken: 'rt-shared',
      expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    },
    account: { uin: '90000000004', nickname: 'Shared' },
  }))
  await writeOwnSignIn(own, {
    region: 'cn', accessToken: 'from-the-panel', refreshToken: 'rt-shared',
    expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    uid: 'u-shared', uin: '90000000004', enterpriseId: '', nickname: 'Shared',
  })
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop, own], cooldownMs: 60000 })
  const accounts = await pool.scan()
  assert.equal(accounts.length, 1, 'one account, whichever surface signed it in')
  assert.equal(accounts[0].credential.accessToken, 'from-the-desktop',
    'the live desktop sign-in wins, so a panel login cannot shadow the app the user is actually using')
})

/**
 * Deleting a panel-added sign-in: the file goes, and the archive entry with it.
 *
 * The archive half is the one that matters. It keeps a copy of every credential
 * a walk has seen and reads it back for every directory the walk can still
 * read, which includes the plugin's own — so a delete that only unlinks the
 * file brings the account straight back on the next scan.
 */
test('deleting a panel sign-in removes the file and the archive entry', async () => {
  const { writeOwnSignIn, ownSignInDir, WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dataPath = path.join(scratch('delete-own'), 'data')
  const target = ownSignInDir(dataPath)
  const signIn = {
    region: 'cn', accessToken: 'at-gone', refreshToken: 'rt-gone',
    expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    uid: 'u-gone', uin: '90000000010', enterpriseId: '', nickname: 'To Delete',
  }
  await writeOwnSignIn(target, signIn)
  // A second account that must survive the delete.
  await writeOwnSignIn(target, { ...signIn, uin: '90000000011', uid: 'u-stays', nickname: 'Stays' })
  const pool = new WorkBuddyAccountPool({ authDirs: [target], dataPath: () => dataPath, cooldownMs: 60000 })
  const accounts = await pool.scan()
  assert.equal(accounts.length, 2)
  const doomed = accounts.find((item) => item.credential.uin === '90000000010')
  assert.ok(doomed !== undefined)
  assert.equal(pool.ownsSignIn(doomed.id), true, 'a sign-in the plugin wrote is deletable')

  assert.equal(await pool.removeOwnSignIn(doomed.id), true)
  assert.equal(fs.readdirSync(target).length, 1, 'the sign-in file must be gone')
  const left = await pool.scan()
  assert.equal(left.length, 1, 'the account must not come back from the archive on the next scan')
  assert.equal(left[0].credential.nickname, 'Stays', 'and the other account is untouched')
  // Once the pool has been rescanned the account is no longer in it, so a
  // second delete has nothing left to remove and says so rather than throwing.
  assert.equal(await pool.removeOwnSignIn(doomed.id), false)
})

/**
 * A delete has to survive a scan that was already reading the directories.
 *
 * The archive is written at the end of every scan, from the list the walk read.
 * A scan that read this sign-in file just before the delete queues that write
 * after the delete's drop, which put the entry back - the file was gone, and the
 * account came back on the next scan through the archive's "file gone, token
 * still valid" path. Ten rounds, because the point is the ordering and one round
 * of a race proves nothing.
 */
test('a scan already in flight cannot archive a deleted sign-in back', async () => {
  const { writeOwnSignIn, ownSignInDir, WorkBuddyAccountPool } = require('../src/accounts.ts')
  for (let round = 0; round < 10; round += 1) {
    const dataPath = path.join(scratch('delete-race-'), 'data')
    const target = ownSignInDir(dataPath)
    await writeOwnSignIn(target, {
      region: 'cn', accessToken: 'at-race-' + round, refreshToken: 'rt-race',
      expiresAtMs: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
      uid: 'u-race', uin: '90000000020', enterpriseId: '', nickname: 'Race',
    })
    const pool = new WorkBuddyAccountPool({ authDirs: [target], dataPath: () => dataPath, cooldownMs: 60000 })
    const scanned = await pool.scan()
    assert.equal(scanned.length, 1)
    // Started, not awaited: this scan is mid-walk when the delete runs.
    const racing = pool.scan()
    assert.equal(await pool.removeOwnSignIn(scanned[0].id), true)
    await racing
    const after = await pool.scan()
    assert.equal(after.length, 0, 'round ' + round + ': the deleted sign-in must not come back')
    assert.ok(!fs.readFileSync(path.join(dataPath, 'credentials-archive.json'), 'utf8').includes('90000000020'),
      'round ' + round + ': and must not be left in the archive')
  }
})

test('a desktop sign-in is never deletable', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('delete-desktop')
  const dataPath = path.join(dir, 'data')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: {
      accessToken: 'desktop-token', refreshToken: 'rt-desktop',
      expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn',
    },
    account: { uin: '90000000012', nickname: 'Desktop' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], dataPath: () => dataPath, cooldownMs: 60000 })
  const accounts = await pool.scan()
  assert.equal(accounts.length, 1)
  assert.equal(pool.ownsSignIn(accounts[0].id), false,
    'the desktop app owns that file, so the panel must not offer to delete it')
  assert.equal(await pool.removeOwnSignIn(accounts[0].id), false, 'and the delete must be refused')
  assert.ok(fs.existsSync(path.join(dir, 'workbuddy-desktop.info')),
    'a refused delete must leave the file alone, or the user is signed out of their app')
  assert.equal((await pool.scan()).length, 1, 'and the account keeps serving')
})

test('a path outside the plugin directory is refused however it is spelled', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const dir = scratch('delete-escape')
  const dataPath = path.join(dir, 'data')
  const outside = path.join(dir, 'elsewhere')
  fs.mkdirSync(outside, { recursive: true })
  const file = path.join(outside, 'workbuddy-desktop.info')
  fs.writeFileSync(file, JSON.stringify({
    auth: { accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uin: '90000000013', nickname: 'Outside' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [outside], dataPath: () => dataPath, cooldownMs: 60000 })
  const accounts = await pool.scan()
  assert.equal(accounts.length, 1)
  // A sibling directory that merely shares a prefix with the plugin's own is
  // not inside it: `startsWith` on the raw string would say it was.
  const sibling = dataPath + '-not-mine'
  const pool2 = new WorkBuddyAccountPool({ authDirs: [outside], dataPath: () => sibling, cooldownMs: 60000 })
  await pool2.scan()
  assert.equal(pool2.ownsSignIn(accounts[0].id), false,
    'a directory whose name merely starts with the plugin path is not inside it')
  assert.equal(await pool2.removeOwnSignIn(accounts[0].id), false)
  assert.ok(fs.existsSync(file), 'and the file survives')
})

/**
 * A finished login answers with the document the panel adopts.
 *
 * The panel paints whatever a channel hands back and holds no idle poll, so a
 * login that answered with a name and nothing else left the list showing the
 * pool as it was before the account landed. The toast said "added" beside an
 * unchanged list, which reads as a failed add, and the account had been written
 * and scanned all along.
 */
test('a finished login answers with the document the panel adopts', async (t) => {
  const vm = require('node:vm')
  const { createRequire } = require('node:module')
  const { createServer } = require('node:http')
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-login-doc-'))
  // The repointed auth file sits in the plugin's own sign-in directory, which
  // is the directory a panel login writes into: one walk reads both, and the
  // machine's real auth directory is never opened.
  const own = path.join(directory, 'signins')
  fs.mkdirSync(own, { recursive: true })
  const authFile = path.join(own, 'workbuddy-desktop.info')
  fs.writeFileSync(authFile, JSON.stringify({
    auth: {
      accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn',
    },
    account: { uin: '90000000020', nickname: 'Fixture' },
  }))

  // Every upstream read is stubbed: a load that reaches the vendor with a
  // fixture token answers nothing useful and costs a real request.
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  // The device flow's three endpoints, in the envelope every one of them uses.
  const loginStub = {
    startDeviceLogin: async (realm) => ({
      state: 'st-doc', authUrl: `https://example.invalid/${realm}/login?state=st-doc`,
    }),
    pollDeviceLogin: async () => ({
      status: 'ok',
      signIn: {
        region: 'cn', accessToken: 'at-added', refreshToken: 'rt-added',
        expiresAtMs: Date.now() + 3600000, domain: 'www.codebuddy.cn',
        uid: 'u-added', uin: '90000000021', enterpriseId: '', nickname: 'Added From Panel',
      },
    }),
  }

  // A port of this run's own, so the load binds an address nothing else holds.
  const free = createServer()
  await new Promise((resolve, reject) => { free.once('error', reject); free.listen(0, '127.0.0.1', resolve) })
  const port = free.address().port
  await new Promise((resolve) => free.close(resolve))

  const { installPi } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({
      enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
      disabledRegions: ['workbuddy:global'], authFile, autoCheckin: { enabled: false },
    }),
    getDataPath: () => directory,
    declareProviders: () => ({ ok: true, changed: true }),
  })
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: (specifier) => {
      const load = createRequire(path.join(root, 'src/host.ts'))
      if (specifier === './ids.ts') return { ...load(specifier), PORT_BASE: port }
      // The login client is replaced rather than answered over the wire: the
      // device flow is a browser hand-off, and a stubbed upstream would still
      // have to be driven through a real authorization.
      if (specifier === './login') return loginStub
      return load(specifier)
    },
    console: { log() {} },
    AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    await plugin.onPanelInvoke('xd.startLogin', { realm: 'cn' })
    const replied = await plugin.onPanelInvoke('xd.pollLogin', { realm: 'cn' })
    assert.equal(replied.status, 'ok')
    assert.equal(replied.nickname, 'Added From Panel')
    assert.ok(replied.state !== undefined && typeof replied.state === 'object'
      && Array.isArray(replied.state.accounts),
      'the answer must carry the document the panel adopts, or the list keeps painting the pool it already had')
    assert.ok(fs.existsSync(path.join(own, 'workbuddy-panel-90000000021.info')),
      'the sign-in landed in the plugin directory, not the app\'s')
    const state = await plugin.onPanelInvoke('xd.state')
    assert.equal(state.accounts.length, replied.state.accounts.length,
      'the answer and the next read agree, which is what makes the adoption visible')
  } finally {
    await plugin.onUnload()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * Deleting a panel sign-in has to forget what was recorded against its id.
 *
 * The id is a hash of the account's own identity, so signing the same account in
 * again produces the same id. A `disabledAccountIds` entry left behind came back
 * with the new sign-in: the account the user had just added was listed as switched
 * off, was never handed a request, and the panel gave no reason. Same for a credit
 * floor, which parks an account behind a reserve nobody re-entered.
 */
test('a deleted account is not remembered as switched off when it is added again', async (t) => {
  const vm = require('node:vm')
  const { createRequire } = require('node:module')
  const { createServer } = require('node:http')
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-delete-forgets-'))
  const own = path.join(directory, 'signins')
  fs.mkdirSync(own, { recursive: true })

  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 100, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))

  // A port of this run's own, so the load binds an address nothing else holds.
  const free = createServer()
  await new Promise((resolve, reject) => { free.once('error', reject); free.listen(0, '127.0.0.1', resolve) })
  const port = free.address().port
  await new Promise((resolve) => free.close(resolve))

  // A writable settings document: the delete path saves the cleanup, and a bridge
  // without `setSettings` refuses every write.
  const saved = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    // The region under test has to be live: a parked region is never scanned, so
    // its pool stays empty and there would be no account to delete.
    disabledRegions: ['workbuddy:global'],
    autoCheckin: { enabled: false },
  }
  const { installPi } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({ ...saved }),
    setSettings: (patch) => { Object.assign(saved, patch) },
    getDataPath: () => directory,
    declareProviders: () => ({ ok: true, changed: true }),
  })
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: (specifier) => {
      const load = createRequire(path.join(root, 'src/host.ts'))
      if (specifier === './ids.ts') return { ...load(specifier), PORT_BASE: port }
      return load(specifier)
    },
    console: { log() {} },
    AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  try {
    await plugin.onLoad()
    const { writeOwnSignIn, ownSignInDir, workbuddyAccountId } = require('../src/accounts.ts')
    const signIn = {
      region: 'cn', accessToken: 'at-again', refreshToken: 'rt-again',
      expiresAtMs: Date.now() + 3600000, domain: 'www.codebuddy.cn',
      uid: 'u-again', uin: '90000000031', enterpriseId: '', nickname: 'Comes Back',
    }
    await writeOwnSignIn(ownSignInDir(directory), signIn)
    const id = workbuddyAccountId({ uin: signIn.uin, uid: signIn.uid, domain: signIn.domain })
    // The service scans on start; the file is written after it, so ask once for the
    // re-read the panel's own refresh button performs.
    await plugin.onPanelInvoke('xd.rescan')
    const listed = await plugin.onPanelInvoke('xd.state')
    assert.ok(listed.accounts.some((account) => account.id === id),
      'the sign-in has to be in the pool before it can be deleted')

    // The user switches it off and pins a credit floor to it, then deletes it.
    await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: id, state: 'disabled' })
    await plugin.onPanelInvoke('xd.setCreditReserve', { region: 'cn', accountId: id, reserve: 500 })
    const deleted = await plugin.onPanelInvoke('xd.setAccountState', { region: 'cn', accountId: id, state: 'deleted' })
    assert.ok(!deleted.accounts.some((account) => account.id === id), 'the account must be gone from the document')

    // Signing the same account in again hands back the same id.
    await writeOwnSignIn(ownSignInDir(directory), { ...signIn, accessToken: 'at-again-2' })
    const back = await plugin.onPanelInvoke('xd.rescan')
    const row = back.accounts.find((account) => account.id === id)
    assert.ok(row !== undefined, 'the new sign-in has to be listed')
    assert.equal(row.disabled, false,
      'a re-added account must not come back switched off by a flag left from the deleted one')
    // Absent is how "no floor" is published: a stale one would come back as a figure.
    assert.equal(row.creditReserve, undefined,
      'and must not inherit a credit floor nobody re-entered')
  } finally {
    await plugin.onUnload()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

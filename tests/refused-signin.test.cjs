/**
 * What happens to an account whose sign-in the upstream refuses.
 *
 * The chat gateway has refreshed-and-retried a refused sign-in since it was
 * written; the panel's reads and the scheduled passes had no such path, so an
 * account the user switched away from in the desktop app answered the raw
 * gateway page on every poll and every pass, with a credential whose own expiry
 * still read as weeks away. The upstream revokes the session without rewriting
 * that expiry, so nothing downstream could see it coming.
 *
 * These cases pin the shared path both hosts now use: one forced refresh, one
 * retry, a hold when the refresh token is spent too, and silence while the hold
 * stands. Every upstream is a stub and every auth directory a scratch one.
 */
const assert = require('node:assert/strict')
const { test, mock } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerHooks, createRequire } = require('node:module')
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

const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { upstreamErrorKind } = require('../src/upstream.ts')

const scratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-refused-${label}-`))

function writeSignIn(dir, uid, nickname = 'Fixture') {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `workbuddy-desktop-${uid}.info`), JSON.stringify({
    auth: {
      accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`,
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn',
    },
    account: { uin: uid, nickname },
  }))
}

/** The refusal the gateway answers a revoked sign-in with, as the client throws it. */
const refused = (status = 401) => Object.assign(
  new Error(`the WorkBuddy gateway rejected this credential (http ${status}). This usually means the ` +
    'account is using a stale sign-in the upstream no longer accepts'),
  { kind: 'session_dead' },
)

/** A pool over one sign-in whose refresh the stub answers however the case wants. */
function poolWith(dir, refreshAnswer) {
  const client = { refreshToken: async () => refreshAnswer() }
  return new WorkBuddyAccountPool({ authDirs: [dir], client })
}

test('a read the upstream refuses is retried once after a forced refresh', async () => {
  const dir = scratch('retry')
  writeSignIn(dir, '90000001001')
  const pool = poolWith(dir, () => ({ accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresInSec: 3600 }))
  const [account] = await pool.scan()

  let calls = 0
  const value = await pool.readAfterRefresh(account.id, async (credential) => {
    calls += 1
    // The first read rides the token the file holds; the retry rides the one
    // the refresh minted, which is the whole point of the second attempt.
    if (calls === 1) {
      assert.equal(credential.accessToken, 'token-90000001001')
      throw refused()
    }
    assert.equal(credential.accessToken, 'fresh-token')
    return { total: 4242 }
  })

  assert.deepEqual(value, { total: 4242 }, 'the retry\'s answer is the caller\'s answer')
  assert.equal(calls, 2, 'one retry, not a loop: the second refusal is the end of it')
  assert.equal(pool.activeHold(account.id), null, 'an account the refresh saved is not held')
})

test('a read the refresh cannot save leaves the account held', async () => {
  const dir = scratch('dead')
  writeSignIn(dir, '90000001002')
  // What the upstream answers a spent refresh token with: the same refusal, on
  // the refresh endpoint, so `ensureFresh` keeps the token it had.
  const pool = poolWith(dir, () => { throw refused() })
  const [account] = await pool.scan()

  let calls = 0
  await assert.rejects(
    () => pool.readAfterRefresh(account.id, async () => {
      calls += 1
      throw refused()
    }),
    /rejected this credential/,
    'the caller still sees the upstream\'s own sentence',
  )
  assert.equal(calls, 1,
    'a refresh the upstream refuses buys no retry: the read would ride the token that was just turned down')

  const hold = pool.activeHold(account.id)
  assert.ok(hold !== null, 'a sign-in the refresh cannot save must not be retried forever')
  assert.equal(hold.reason, 'session', 'the hold names the reason, so a balance read cannot release it')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0,
    'the held account leaves rotation instead of answering 401 on the next turn')
})

test('a held account is not read again while the hold stands', async () => {
  const dir = scratch('silent')
  writeSignIn(dir, '90000001003')
  const pool = poolWith(dir, () => ({ accessToken: 'fresh-token', expiresInSec: 3600 }))
  const [account] = await pool.scan()

  let reads = 0
  const read = async () => { reads += 1; throw refused() }
  await assert.rejects(() => pool.readAfterRefresh(account.id, read))
  assert.equal(reads, 2, 'first pass: read, refresh, retry')

  // The panel polls every couple of minutes and the scheduled passes walk the
  // pool: without the short circuit each of those spends the same two calls on
  // a sign-in that cannot answer.
  await assert.rejects(() => pool.readAfterRefresh(account.id, read), /sign-in was refused/)
  assert.equal(reads, 2, 'the second pass spends nothing upstream')
})

test('a refused read with no refresh token is still held', async () => {
  const dir = scratch('norefresh')
  writeSignIn(dir, '90000001007')
  const pool = poolWith(dir, () => ({ accessToken: 'fresh-token', expiresInSec: 3600 }))
  const [account] = await pool.scan()
  // The parsed document kept the access token but lost the refresh token: the
  // read is refused, so the session is dead and there is nothing to renew with.
  account.credential.refreshToken = ''

  await assert.rejects(
    () => pool.readAfterRefresh(account.id, async () => { throw refused() }),
    /rejected this credential/,
  )
  assert.equal(pool.activeHold(account.id)?.reason, 'session',
    'a dead sign-in with nothing to refresh is the refusal it looks like')
})

test('a refresh that fails for a reason other than a refusal does not hold the account', async () => {
  const dir = scratch('transient')
  writeSignIn(dir, '90000001006')
  // A timeout, a 429 or an unreachable host on the refresh endpoint says
  // nothing about the sign-in. Holding here took a healthy account out of
  // rotation for six hours and told the user to sign in again.
  const transient = Object.assign(new Error('workbuddy upstream transport: fetch failed'), { kind: 'transport' })
  const pool = poolWith(dir, () => { throw transient })
  const [account] = await pool.scan()

  let calls = 0
  await assert.rejects(
    () => pool.readAfterRefresh(account.id, async () => {
      calls += 1
      throw refused()
    }),
    /rejected this credential/,
  )
  assert.equal(calls, 1, 'the read is not retried on a token the refresh never replaced')
  assert.equal(pool.activeHold(account.id), null,
    'a failed refresh is not the upstream refusing the sign-in')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 1,
    'the account stays in rotation for the next read')
})

test('a failure the sign-in did not cause is rethrown untouched', async () => {
  const dir = scratch('other')
  writeSignIn(dir, '90000001004')
  let refreshes = 0
  const pool = poolWith(dir, () => { refreshes += 1; return { accessToken: 'fresh-token', expiresInSec: 3600 } })
  const [account] = await pool.scan()

  const rateLimited = Object.assign(new Error('workbuddy upstream soft_rate (http 429): 频率限制'), { kind: 'soft_rate' })
  await assert.rejects(() => pool.readAfterRefresh(account.id, async () => { throw rateLimited }), /soft_rate/)
  assert.equal(refreshes, 0, 'a rate limit is not the token\'s fault; refreshing cannot help')
  assert.equal(pool.activeHold(account.id), null, 'and it must not park the account')

  const upstreamFault = new Error('workbuddy upstream server (http 503): upstream unavailable')
  await assert.rejects(() => pool.readAfterRefresh(account.id, async () => { throw upstreamFault }), /server/)
  assert.equal(refreshes, 0)
  assert.equal(pool.activeHold(account.id), null)
})

test('the kind a thrown envelope error carries is readable by the caller', async () => {
  // The chat path answers with its kind in a result object; every JSON endpoint
  // throws. A caller that cannot read the kind off the error cannot tell a
  // refused sign-in from a rate limit without matching the sentence.
  assert.equal(upstreamErrorKind(refused()), 'session_dead')
  assert.equal(upstreamErrorKind(Object.assign(new Error('x'), { kind: 'hard_credit' })), 'hard_credit')
  assert.equal(upstreamErrorKind(new Error('a local fault with no kind')), undefined)
  assert.equal(upstreamErrorKind(undefined), undefined)
})

test('a new sign-in for a held account releases the hold', async () => {
  const dir = scratch('release')
  writeSignIn(dir, '90000001005')
  const pool = poolWith(dir, () => ({ accessToken: 'fresh-token', expiresInSec: 3600 }))
  const [account] = await pool.scan()
  await assert.rejects(() => pool.readAfterRefresh(account.id, async () => { throw refused() }))
  assert.ok(pool.activeHold(account.id) !== null, 'held before the re-login')

  // The user signs in again in the desktop app: the file now holds a token the
  // plugin has not seen, which is the signal that releases a session hold.
  const file = path.join(dir, `workbuddy-desktop-90000001005.info`)
  const document = JSON.parse(fs.readFileSync(file, 'utf8'))
  document.auth.accessToken = 'token-after-relogin'
  document.auth.refreshToken = 'refresh-after-relogin'
  fs.writeFileSync(file, JSON.stringify(document))
  await pool.scan()

  assert.equal(pool.activeHold(account.id), null, 'the re-login releases the hold')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 1, 'and the account serves again')
})

test('a refresh that works again releases the hold', async () => {
  const dir = scratch('recovered')
  writeSignIn(dir, '90000001006')
  let spent = true
  const pool = poolWith(dir, () => {
    if (spent) throw refused()
    return { accessToken: 'recovered-token', refreshToken: 'recovered-refresh', expiresInSec: 3600 }
  })
  const [account] = await pool.scan()
  await assert.rejects(() => pool.readAfterRefresh(account.id, async () => { throw refused() }))
  assert.ok(pool.activeHold(account.id) !== null, 'held while the refresh token is spent')

  // The upstream's session comes back, or the user signs in again and the new
  // sign-in's refresh token answers: a token the upstream just minted is proof
  // the credential works, and the hold that said otherwise must not outlive it.
  spent = false
  assert.equal(await pool.refreshAccount(account.id), true, 'the forced refresh succeeds this time')
  assert.equal(pool.activeHold(account.id), null,
    'a credential the upstream just minted releases the hold it earned')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 1, 'and the account serves again')
})

/**
 * The same contract, driven through the host the way the panel drives it.
 *
 * The pool-level cases above pin the mechanism; these pin what a user sees: the
 * panel's read of one account's credits is the call that used to answer the raw
 * gateway page on every poll, and the row that now carries the hold is what the
 * panel renders instead.
 */
const vm = require('node:vm')

async function loadHost(t, temporary, options = {}) {
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth, { recursive: true })
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  // A token with weeks on it: the refresh under test is the forced one a refused
  // sign-in triggers, not the near-expiry one the request path would run anyway.
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: {
      accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 21 * 24 * 3600 * 1000, domain: 'www.codebuddy.cn',
    },
    account: { uin: 'fixture-uin', nickname: 'Fixture' },
  }))

  const { installPi } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })

  const calls = { credits: 0, checkin: 0, refresh: 0 }
  const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => {
    calls.credits += 1
    if (typeof options.credits === 'function') return options.credits(calls.credits)
    return { total: 100, packages: [] }
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => {
    calls.checkin += 1
    return { active: false }
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'refreshToken', async () => {
    calls.refresh += 1
    if (typeof options.refresh === 'function') return options.refresh()
    return { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresInSec: 3600 }
  })

  const timers = new Set()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')),
    module: { exports: {} }, exports: {}, __dirname: temporary,
    console: { log() {}, warn() {}, error() {} }, AbortController, AbortSignal, fetch,
    Date, setTimeout, clearTimeout,
    setInterval: (callback, ms) => {
      const timer = { callback, ms, at: Date.now() + ms }
      timers.add(timer)
      return timer
    },
    clearInterval: (timer) => { timers.delete(timer) },
    process,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  await plugin.onLoad()
  return { plugin, calls }
}

test('the panel\'s read of a refused sign-in is retried once after a forced refresh', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-refused-host-'))
  // The upstream revokes the session without rewriting the token's expiry, so
  // the read is refused while the credential still reads as weeks from expiry.
  const { plugin, calls } = await loadHost(t, temporary, {
    credits: (attempt) => {
      if (attempt === 1) throw refused()
      return { total: 4242, packages: [] }
    },
  })
  try {
    const state = await plugin.onPanelInvoke('xd.state', { wait: true })
    const row = state.accounts.find((entry) => entry.region === 'cn')
    assert.ok(row !== undefined, 'the fixture account is in the document')
    assert.equal(row.credits?.total, 4242, 'the retry\'s balance is what the row shows')
    assert.equal(row.creditsError, undefined, 'and no error is left over from the refused read')
    assert.equal(calls.refresh, 1, 'one forced refresh bought the retry')
    assert.equal(calls.credits, 2, 'the read ran twice, not in a loop')
    assert.equal(row.hold, undefined, 'an account the refresh saved carries no hold')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a sign-in the refresh cannot save is held and stops being read', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-refused-host-'))
  // What the upstream answers a spent refresh token with.
  const { plugin, calls } = await loadHost(t, temporary, {
    credits: () => { throw refused() },
    refresh: () => { throw refused() },
  })
  try {
    // The first document is the one whose probe met the refusal: the row was
    // built before the batch ran, so it still carries the upstream's own
    // sentence, and the refresh-and-retry behind it is what placed the hold.
    const first = await plugin.onPanelInvoke('xd.state', { wait: true })
    const row = first.accounts.find((entry) => entry.region === 'cn')
    assert.match(row.creditsError ?? '', /rejected this credential/,
      'the first read reports the upstream\'s own sentence')
    assert.equal(calls.credits, 1, 'one read, one refresh attempt, and no retry: the refresh was refused too')
    assert.equal(calls.refresh, 1)

    // The next document is the steady state: the row carries the hold, and the
    // panel paints the hold's remedy instead of the sentence. Without the hold
    // every poll repeats the same read on an account that cannot answer it.
    const second = await plugin.onPanelInvoke('xd.state', { wait: true })
    const again = second.accounts.find((entry) => entry.region === 'cn')
    assert.equal(again.hold, 'session', 'the row carries the hold the refused sign-in earned')
    assert.equal(calls.credits, 1, 'and no further read was spent on the account')
    assert.equal(calls.refresh, 1, 'nor a further refresh attempt')
    assert.equal(calls.checkin, 0, 'the check-in read is skipped for the same reason')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

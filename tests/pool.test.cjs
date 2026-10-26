/**
 * The pool's recovery contract and the gateway's answer when nothing is left.
 *
 * Three behaviours that are expensive to get wrong and cheap to pin:
 *
 * - A cooldown that lapses puts the account back in rotation. Without that, one
 *   upstream 429 removes an account for the life of the process.
 * - A hold the pool decided (spent credits, a dead session) is released by the
 *   signal that matches it and by nothing else.
 * - A pool with no account left answers the caller with the cause, not a 500.
 *
 * Every auth directory is a scratch one and every upstream is a stub, so nothing
 * here reaches the network or a real install. It loads the sources through
 * the same TypeScript transform the host builds with.
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

const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { createWorkBuddyShim } = require('../src/shim.ts')

const scratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-pool-${label}-`))

/** One readable sign-in file, the shape the desktop app writes. */
function writeSignIn(dir, name, uid) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.info`)
  fs.writeFileSync(file, JSON.stringify({
    auth: {
      accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`,
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn',
    },
    account: { uin: uid, nickname: name },
  }))
  return file
}

function poolOf(dirs, options = {}) {
  return new WorkBuddyAccountPool({ authDirs: dirs, ...options })
}

test('a cooldown that lapses puts the account back in rotation', async () => {
  const dir = scratch('cooldown')
  writeSignIn(dir, 'workbuddy-desktop', '90000000101')
  const pool = poolOf([dir], { cooldownMs: 200 })
  const [account] = await pool.scan()
  assert.ok(account !== undefined, 'the fixture must be the whole pool')

  pool.penalize(account.id)
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0,
    'a penalised account must not be handed out')

  // Past the window rather than a sleep: the check asks the pool what it thinks
  // now, which is the same question the next request asks.
  const again = pool.available(Date.now() + 400, undefined, 'cn')
  assert.deepEqual(again.map((entry) => entry.id), [account.id],
    'once the window has lapsed the account is usable again, or one 429 retires it for the life of the process')
})

test('a per-model cooldown leaves the account\'s other models usable', async () => {
  const dir = scratch('per-model')
  writeSignIn(dir, 'workbuddy-desktop', '90000000102')
  const pool = poolOf([dir])
  const [account] = await pool.scan()
  pool.penalize(account.id, Date.now() + 60_000, 'hy3')
  const now = Date.now()
  assert.equal(pool.available(now, 'hy3', 'cn').length, 0, 'the limited model is out')
  assert.equal(pool.available(now, 'hy4-preview', 'cn').length, 1,
    'the upstream allows switching models on one account, so the rest stays in')
})

test('a balance read releases a spent hold and leaves a dead session held', async () => {
  const dir = scratch('holds')
  writeSignIn(dir, 'workbuddy-desktop', '90000000103')
  writeSignIn(dir, 'workbuddy-second', '90000000104')
  const pool = poolOf([dir])
  const accounts = await pool.scan()
  assert.equal(accounts.length, 2)
  const spent = accounts[0]
  const dead = accounts[1]

  pool.penalize(spent.id, Date.now() + 60_000, undefined, 'spent')
  pool.penalize(dead.id, Date.now() + 60_000, undefined, 'session')
  const now = Date.now()
  assert.equal(pool.available(now, undefined, 'cn').length, 0, 'both are out')

  // A credits probe that finds a balance again is the signal a spent account was
  // topped up, and it says nothing about a sign-in the upstream refuses.
  pool.setCreditBalance(spent.id, 500)
  pool.setCreditBalance(dead.id, 500)
  const after = pool.available(now + 10, undefined, 'cn').map((entry) => entry.id)
  assert.deepEqual(after, [spent.id],
    'the spent account comes back; releasing the dead session on a balance read put a 401 back at the head of the queue every probe cycle')

  // The panel's "clear all cooldowns" is the manual way out of both holds, and
  // it is the only thing that releases a session hold without a new sign-in.
  pool.resetCooldowns()
  assert.equal(pool.activeHold(dead.id), null, 'a manual reset drops the session hold itself, not just its window')
  assert.deepEqual(pool.available(now + 20, undefined, 'cn').map((entry) => entry.id).sort(), [spent.id, dead.id].sort(),
    'a manual reset releases the session hold too')
})

test('a session hold is released by a sign-in minted after the refusal', async () => {
  const dir = scratch('session-release')
  const file = writeSignIn(dir, 'workbuddy-desktop', '90000000110')
  // The pool mints its own tokens when it renews a sign-in. A refusal recorded
  // before that renewal names the token the files held then, so the minted token
  // is a sign-in the refusal never named and the account gets to serve with it.
  // That is the difference between "sign in again" and an account the pool can
  // already serve.
  const pool = poolOf([dir], {
    // The host always provides one, and the archive it enables is where a refresh
    // of this sign-in lands (the desktop's own file is not written to).
    dataPath: () => path.join(dir, 'data'),
    client: {
      refreshToken: async () => ({ accessToken: 'token-minted-by-the-pool', expiresInSec: 3600 }),
      fetchModels: async () => [],
    },
  })
  const [account] = await pool.scan()
  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0, 'the account is out')
  assert.equal(await pool.refreshAccount(account.id), true, 'the pool mints a token for it anyway')
  await pool.scan()
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 1,
    'a sign-in the refusal did not name puts the account back')

  // That chance is not free. Once the upstream refuses the copy now in force, the
  // hold names it, and a rescan of the same files does not release it again: the
  // retry loop the old rule was guarding against is still guarded.
  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  await pool.scan()
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 0,
    'the sign-in that was refused is not tried again on every scan')

  // What a re-login does leave behind: the file now holds a different sign-in.
  fs.writeFileSync(file, JSON.stringify({
    auth: {
      accessToken: 'token-after-relogin', refreshToken: 'refresh-after-relogin',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn',
    },
    account: { uin: '90000000110', nickname: 'workbuddy-desktop' },
  }))
  const after = await pool.scan()
  assert.deepEqual(after.map((entry) => entry.credential.accessToken), ['token-after-relogin'],
    'and the account serves with that new sign-in, not the token that was refused')
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 1,
    'signing in again releases the hold, which is the remedy the docs promise')
})

test('a session hold on an account the archive serves survives a scan', async () => {
  const dir = scratch('archive-hold')
  const file = writeSignIn(dir, 'workbuddy-desktop', '90000000121')
  const pool = poolOf([dir], { dataPath: () => path.join(dir, 'data') })
  const [account] = await pool.scan()
  // The client switches accounts: its one live file is overwritten, and this
  // account now lives in the archive alone. Nothing on disk can prove a re-login
  // for it, so a scan must not read "no file changed" as "the sign-in is fine".
  fs.unlinkSync(file)
  await pool.scan()
  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0, 'the refused account is out')
  await pool.scan()
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 0,
    'a hold no file can clear must survive a scan, or every scan retries a dead sign-in')
})

test('a re-login is served, not the live sign-in it replaced', async () => {
  // The shape the desktop app leaves behind: its own live file, plus a panel
  // sign-in for the same account. Releasing the hold is not enough on its own: the
  // refused live token is still on disk, and a ranking that forgot the refusal
  // would serve it again one scan later.
  const live = scratch('live-refused')
  const own = scratch('panel-relogin')
  writeSignIn(live, 'workbuddy-desktop', '90000000111')
  const pool = poolOf([live, own])
  const [account] = await pool.scan()
  assert.equal(account.credential.accessToken, 'token-90000000111', 'the live file serves first')

  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0, 'the account is out')

  // The user signs in again from the panel, which writes its own file.
  fs.writeFileSync(path.join(own, 'workbuddy-panel-90000000111.info'), JSON.stringify({
    auth: {
      accessToken: 'token-from-panel-relogin', refreshToken: 'refresh-from-panel-relogin',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: '90000000111', nickname: 'workbuddy-desktop' },
  }))
  const after = await pool.scan()
  const served = after.find((entry) => entry.id === account.id)
  assert.equal(served.credential.accessToken, 'token-from-panel-relogin',
    'the sign-in that released the hold is the one served; the refused live token must not come back')
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 1, 'and the account is back in rotation')

  // The release has to survive the next walks too. The refused file is still on
  // disk, so a ranking that forgot the refusal would hand that token back one scan
  // later and the account would keep failing with the hold looking released.
  await pool.scan()
  await pool.scan()
  const later = pool.list().find((entry) => entry.id === account.id)
  assert.equal(later.credential.accessToken, 'token-from-panel-relogin',
    'and every later scan keeps serving it, however many times the pool rescans')
})

test('an account whose sign-in file is gone still releases its hold on a new one', async () => {
  // The desktop client overwrites its live file when the user switches accounts,
  // so an account can outlive its only file and serve from the archive. Those are
  // the accounts most likely to be refused, and their hold has to be releasable
  // too - remembering "no sign-in" as a missing value rather than an empty set
  // made the documented remedy unreachable for exactly them.
  const dir = scratch('archive-only')
  const file = writeSignIn(dir, 'workbuddy-desktop', '90000000112')
  const pool = poolOf([dir], { dataPath: () => path.join(dir, 'data') })
  const [account] = await pool.scan()

  fs.unlinkSync(file)
  const afterDelete = await pool.scan()
  assert.equal(afterDelete.length, 1, 'the archive keeps the account after its file is gone')

  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0, 'the account is out')

  // Signing in again brings a file back with a token that was never seen before.
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: {
      accessToken: 'token-after-relogin', refreshToken: 'refresh-after-relogin',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn',
    },
    account: { uin: '90000000112', nickname: 'workbuddy-desktop' },
  }))
  await pool.scan()
  assert.equal(pool.available(Date.now() + 10, undefined, 'cn').length, 1,
    'a file that reappears with a new sign-in releases the hold')
})

test('a refused sign-in is not taken back from the archive once its files are gone', async () => {
  // The archive keeps every sign-in the pool has seen, and it outlives the client's
  // own file. A refused token that only the archive still holds would otherwise win
  // the ranking again the moment the account had no file left, and the account would
  // go back to failing with the hold looking released.
  const dir = scratch('archive-refused')
  const own = scratch('archive-refused-own')
  const liveFile = writeSignIn(dir, 'workbuddy-desktop', '90000000114')
  const pool = poolOf([dir, own], { dataPath: () => path.join(dir, 'data') })
  const [account] = await pool.scan()
  assert.equal(account.credential.accessToken, 'token-90000000114', 'the live file serves first')

  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  fs.writeFileSync(path.join(own, 'workbuddy-panel-90000000114.info'), JSON.stringify({
    auth: {
      accessToken: 'token-from-panel-relogin', refreshToken: 'refresh-from-panel-relogin',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: '90000000114', nickname: 'workbuddy-desktop' },
  }))
  await pool.scan()
  assert.equal(pool.list().find((entry) => entry.id === account.id).credential.accessToken,
    'token-from-panel-relogin', 'the re-login releases the hold')

  // The client switches accounts and the panel sign-in is removed: the account now
  // exists only in the archive, which still holds the token that was refused.
  fs.unlinkSync(liveFile)
  fs.unlinkSync(path.join(own, 'workbuddy-panel-90000000114.info'))
  const after = await pool.scan()
  const served = after.find((entry) => entry.id === account.id)
  assert.ok(served !== undefined, 'the account survives on the archive alone')
  assert.notEqual(served.credential.accessToken, 'token-90000000114',
    'the refused token must not come back from the archive')
  assert.equal(served.credential.accessToken, 'token-from-panel-relogin',
    'and the sign-in that replaced it is the one that survives')
})

test('a refused sign-in is remembered while the account still has no files', async () => {
  // The record is what keeps a refused token out of the ranking, so it has to
  // outlive the files that named it. Dropping it as soon as no file holds the token
  // let the archive hand that very token back on the same scan.
  const dir = scratch('refused-survives')
  const own = scratch('refused-survives-own')
  writeSignIn(dir, 'workbuddy-desktop', '90000000115')
  const pool = poolOf([dir, own], { dataPath: () => path.join(dir, 'data') })
  const [account] = await pool.scan()
  pool.penalize(account.id, Date.now() + 60_000, undefined, 'session')
  fs.writeFileSync(path.join(own, 'workbuddy-panel-90000000115.info'), JSON.stringify({
    auth: {
      accessToken: 'token-from-panel-relogin', refreshToken: 'refresh-from-panel-relogin',
      expiresAt: Date.now() + 3600000, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: '90000000115', nickname: 'workbuddy-desktop' },
  }))
  await pool.scan()
  assert.equal(pool.refusedSignIns.size, 1, 'the refusal is on record after the release')

  // Every file for this account is gone, but the account is still in the pool from
  // the archive. The record has to stay: it is the only thing keeping the refused
  // token out of the next ranking.
  for (const entry of pool.signInTokens.get(account.id) ?? []) {
    if (fs.existsSync(entry.sourcePath)) fs.unlinkSync(entry.sourcePath)
  }
  await pool.scan()
  assert.equal(pool.list().some((entry) => entry.id === account.id), true,
    'the account is still served from the archive')
  assert.equal(pool.refusedSignIns.size, 1,
    'so its refusal record has to survive: dropping it lets the archive hand the token back')
})

test('a hold that has lapsed does not clear a later rate-limit cooldown', async () => {
  const dir = scratch('stale-hold')
  writeSignIn(dir, 'workbuddy-desktop', '90000000105')
  const pool = poolOf([dir], { cooldownMs: 60_000 })
  const [account] = await pool.scan()

  // A hold whose window is already in the past: the record outlived what it was
  // holding, which is exactly the state the account is in after one lapses.
  pool.penalize(account.id, Date.now() + 10, undefined, 'spent')
  await new Promise((resolve) => setTimeout(resolve, 30))
  // A fresh, unrelated penalty: this one is the upstream's own window.
  pool.penalize(account.id, Date.now() + 60_000)
  pool.setCreditBalance(account.id, 900)

  assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0,
    'a stale hold record must not release a cooldown that came from a rate limit')
})

test('a run of limits stretches the pool\'s own window, and a stated reset does not', async () => {
  const dir = scratch('streak')
  writeSignIn(dir, 'workbuddy-desktop', '90000000107')
  const pool = poolOf([dir], { cooldownMs: 1000 })
  const [account] = await pool.scan()
  const outFor = (ms) => pool.available(Date.now() + ms, undefined, 'cn').length === 0

  // The bare "frequency limit" body names no deadline, so the pool picks one. One
  // limit uses the configured window; a run of them doubles it, so an account
  // sitting inside a longer upstream window stops coming back every minute to
  // fail again.
  pool.penalize(account.id)
  assert.equal(outFor(500), true, 'the configured window applies at first')
  assert.equal(outFor(1500), false, 'and it is the user\'s own number, not ours')

  pool.penalize(account.id)
  assert.equal(outFor(1500), true, 'a second limit in a row doubles it')
  assert.equal(outFor(2500), false)
  pool.penalize(account.id)
  assert.equal(outFor(3500), true, 'a third doubles again')
  assert.equal(outFor(4500), false)

  // A window the upstream stated is its own, and is taken as given whatever the
  // streak is: it is not this pool's estimate to stretch.
  account.cooldownUntilMs = 0
  pool.penalize(account.id, Date.now() + 2000)
  assert.equal(outFor(1500), true, 'the stated window is cooling')
  assert.equal(outFor(2500), false, 'exactly as stated, not doubled')
})

test('the streak decays, so one limit tomorrow is not one limit in a row', async () => {
  const dir = scratch('streak-decay')
  writeSignIn(dir, 'workbuddy-desktop', '90000000108')
  const pool = poolOf([dir], { cooldownMs: 1000 })
  const [account] = await pool.scan()

  // Enough limits to reach the ceiling of the ladder.
  for (let index = 0; index < 6; index += 1) pool.penalize(account.id)
  const stretched = account.cooldownUntilMs - Date.now()
  assert.ok(stretched > 4000, `a run has to stretch the window (got ${stretched}ms)`)

  // The same account much later: the run has to start over, or every account lives
  // at the longest window for good - which is what made a working credential look
  // broken in the reference proxy. An hour is well past any window the ladder can
  // impose, so this does not depend on the constant's exact value.
  account.cooldownUntilMs = 0
  account.rateLimitStreakAtMs = Date.now() - 60 * 60 * 1000
  pool.penalize(account.id)
  const fresh = account.cooldownUntilMs - Date.now()
  assert.ok(fresh < stretched / 2, `a limit after the gap opens at the configured window (got ${fresh}ms)`)
})

test('the ladder stops at its cap rather than growing with the run', async () => {
  const dir = scratch('streak-cap')
  writeSignIn(dir, 'workbuddy-desktop', '90000000109')
  const pool = poolOf([dir], { cooldownMs: 60_000 })
  const [account] = await pool.scan()

  // The cap exists so a permanently limited account is not cooled for a day by one
  // more 429. Reach it, then check the next few limits add nothing.
  for (let index = 0; index < 8; index += 1) pool.penalize(account.id)
  const capped = account.cooldownUntilMs - Date.now()
  // A window, not a stopwatch: `Date.now()` has moved on since `penalize` read it,
  // and under a loaded full-suite run that is a millisecond or two - enough to
  // make an exact comparison flake. It has to sit just under the cap, not past it.
  assert.ok(capped > 15 * 60 * 1000 - 1000 && capped <= 15 * 60 * 1000,
    `the window stops at 15 minutes (got ${capped}ms)`)

  // And the escalation is still alive at the cap: a fresh run reaches it again
  // rather than the count having collapsed to one.
  account.cooldownUntilMs = 0
  account.rateLimitStreakAtMs = Date.now() - 60 * 60 * 1000
  pool.penalize(account.id)
  const reopened = account.cooldownUntilMs - Date.now()
  assert.ok(reopened > 60_000 - 1000 && reopened <= 60_000,
    `a lone limit a long time later opens at the configured window (got ${reopened}ms)`)
})

test('a run survives the cooldown it just imposed', async () => {
  // The ladder's longest window is 15 minutes, and the account cannot be tried
  // again until it has passed. If the window that decides "in a row" were shorter
  // than that, the run would always restart and the cap would apply once instead of
  // holding a persistently limited account back - which is the shape a 10-minute
  // window had.
  const dir = scratch('streak-survives')
  writeSignIn(dir, 'workbuddy-desktop', '90000000113')
  const pool = poolOf([dir], { cooldownMs: 60_000 })
  const [account] = await pool.scan()

  for (let index = 0; index < 8; index += 1) pool.penalize(account.id)
  const reached = account.cooldownUntilMs - Date.now()
  assert.ok(reached > 15 * 60 * 1000 - 1000 && reached <= 15 * 60 * 1000,
    `the run reached the cap (got ${reached}ms)`)

  // The account comes back as soon as that window lapses, 16 minutes later, and is
  // limited again: the run is still the same run.
  const lapsed = 16 * 60 * 1000
  account.cooldownUntilMs = 0
  account.rateLimitStreakAtMs = Date.now() - lapsed
  pool.penalize(account.id)
  const held = account.cooldownUntilMs - Date.now()
  assert.ok(held > 15 * 60 * 1000 - 1000 && held <= 15 * 60 * 1000,
    `a limit 16 minutes after the last one is still part of the run, so the window stays at the cap (got ${held}ms)`)
})

test('a pool with every account cooling answers the cause, not a 500', async () => {
  const dir = scratch('exhausted')
  writeSignIn(dir, 'workbuddy-desktop', '90000000106')
  const pool = poolOf([dir], { cooldownMs: 60_000 })
  await pool.scan()

  const shim = createWorkBuddyShim({
    pool,
    region: 'cn',
    catalog: { visible: () => [{ id: 'hy3' }], current: () => [{ id: 'hy3' }] },
    client: {
      // Never reached: the pool has nothing to hand out.
      chatStream: async () => { throw new Error('the gateway spent an upstream call on an empty pool') },
      prepareChatBody: (raw) => raw,
      refreshToken: async () => false,
      fetchModels: async () => [],
      fetchCredits: async () => ({ total: 0, packages: [] }),
      fetchCheckinStatus: async () => ({ active: false }),
    },
    logger: { info: () => {}, warn: () => {} },
  })
  await shim.ready
  try {
    const [account] = pool.list('cn')
    pool.penalize(account.id, Date.now() + 60_000, 'hy3')
    const response = await fetch(`${shim.baseUrl().replace(/\/v1$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const text = await response.text()
    // Exactly the retryable answer: the only account is rate-limited, and the
    // status, the code and the deadline all come from that one reason.
    assert.equal(response.status, 429,
      `a rate-limited pool must answer 429, not hand the caller a turn failure (got ${response.status} ${text.slice(0, 160)})`)
    assert.equal(response.headers.get('retry-after'), '60', 'and say how long the wait is')
    const parsed = JSON.parse(text)
    assert.equal(parsed.error.code, 'soft_rate')
    assert.equal(typeof parsed.error.message, 'string')
    assert.ok(parsed.error.message.length > 0, 'and the message has to name the reason')
  } finally {
    await shim.close()
  }
})

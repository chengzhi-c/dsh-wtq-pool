/**
 * What the plugin does with a sign-in the desktop client left behind.
 *
 * The client keeps one live sign-in and a stack of superseded snapshots beside
 * it. A snapshot's token is a session the client stopped using, so nothing
 * renews it: it serves until its access token expires and then the account is
 * gone, holding a refresh token the client's own rotation already spent. That
 * is the whole reason an account that worked an hour ago answers 401 minutes
 * after the user switched to another one.
 *
 * These cases pin the takeover: the snapshot is copied into the directory the
 * plugin writes, the copy is what serves from then on, and it is renewed like
 * any other sign-in the plugin owns. They also pin the boundary — the live
 * sign-in stays the client's, because two holders of one session refreshing on
 * their own schedules is how both end up with a spent refresh token.
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

const { WorkBuddyAccountPool, ownSignInDir, writeOwnSignIn } = require('../src/accounts.ts')

const DAY = 24 * 60 * 60 * 1000
const LIVE_NAME = 'workbuddy-desktop.info'

/**
 * A machine with the desktop client's own directory beside the plugin's.
 *
 * `snapshots` are the superseded files the client left behind and `live` is the
 * one it is signed in with. `dataDir` is where the plugin keeps what it writes,
 * which is where a taken-over sign-in has to land.
 */
function machine(label, { snapshots = [], live = null, issuedAgo = 19 * DAY } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-adopt-${label}-`))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const files = []
  const write = (name, uid, nickname) => {
    const file = path.join(desktop, name)
    fs.writeFileSync(file, JSON.stringify({
      auth: {
        accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`,
        expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
        // `null` models a document from a build that writes no issue time.
        ...issuedAgo === null ? {} : { lastRefreshTime: Date.now() - issuedAgo },
      },
      account: { uin: uid, nickname },
    }, null, 2))
    files.push(file)
    return file
  }
  for (const [uid, nickname] of snapshots) write(`workbuddy-desktop-2026-10-06T10-07-06-${uid}.info`, uid, nickname)
  if (live !== null) write(LIVE_NAME, live[0], live[1])
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop, path.join(dataDir, 'signins')],
    dataPath: () => dataDir,
    client: { refreshToken: async () => ({ accessToken: 'renewed-token', refreshToken: 'renewed-refresh', expiresInSec: 28 * DAY }) },
  })
  return { pool, dataDir, desktop, signins: path.join(dataDir, 'signins') }
}

const cleanup = async (dataDir) => { await fs.promises.rm(dataDir, { recursive: true, force: true }) }

test('an identity-less snapshot is not copied again on every scan', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-noid-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-2026-10-06T10-07-06-noid.info'), JSON.stringify({
    auth: {
      accessToken: 'token-noid', refreshToken: 'refresh-noid',
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    },
    account: {},
  }))
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop, path.join(dataDir, 'signins')],
    dataPath: () => dataDir,
    client: { refreshToken: async () => ({ accessToken: 'renewed-token', refreshToken: 'renewed-refresh', expiresInSec: 28 * DAY }) },
  })
  try {
    await pool.scan()
    await pool.scan()
    // The pool key falls back to the source path, so a copy would be a new
    // account on every scan and the pool would grow without bound.
    assert.equal(fs.existsSync(path.join(dataDir, 'signins')) ? fs.readdirSync(path.join(dataDir, 'signins')).length : 0, 0,
      'a snapshot with no identity is left where it lies')
    assert.equal(pool.list().length, 1, 'and it is still served as one account')
  } finally {
    await cleanup(dataDir)
  }
})

test('a snapshot the client left behind is taken over as the plugin own sign-in', async () => {
  const { pool, dataDir, signins } = machine('takeover', { snapshots: [['90000002001', 'Left Behind']] })
  const [account] = await pool.scan()
  try {
    const own = fs.readdirSync(signins)
    assert.equal(own.length, 1, 'the snapshot was copied into the directory the plugin writes')
    assert.match(own[0], /^workbuddy-panel-/, 'under the plugin own sign-in name')
    assert.equal(account.credential.sourcePath, path.join(signins, own[0]),
      'the copy is what serves, not the snapshot it was copied from')
    assert.equal(account.label, 'Left Behind', 'and it keeps the account it came from')
  } finally {
    await cleanup(dataDir)
  }
})

test('the taken-over sign-in carries the issue time of the token it copied', async () => {
  const { pool, dataDir, signins } = machine('issued', { snapshots: [['90000002002', 'Aged']] })
  await pool.scan()
  try {
    const onDisk = JSON.parse(fs.readFileSync(path.join(signins, fs.readdirSync(signins)[0]), 'utf8'))
    // Stamping the copy as new would hide how old the sign-in is and delay its
    // first renewal by a whole window.
    assert.ok(onDisk.auth.lastRefreshTime < Date.now() - 18 * DAY,
      'the issue time travels with the token rather than being reset to now')
  } finally {
    await cleanup(dataDir)
  }
})

test('the taken-over sign-in is renewed on age like any other the plugin owns', async () => {
  const { pool, dataDir, signins } = machine('renew', { snapshots: [['90000002003', 'Renewable']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account), 'refreshed',
      'an adopted sign-in with weeks of life left is still renewed once it is old enough')
    const onDisk = JSON.parse(fs.readFileSync(path.join(signins, fs.readdirSync(signins)[0]), 'utf8'))
    assert.equal(onDisk.auth.accessToken, 'renewed-token', 'and the renewal reaches the file')
  } finally {
    await cleanup(dataDir)
  }
})

test('the live sign-in stays the client own and is not taken over', async () => {
  const { pool, dataDir, signins } = machine('live', {
    snapshots: [['90000002004', 'Superseded']],
    live: ['90000002005', 'Signed In'],
  })
  await pool.scan()
  try {
    const own = fs.readdirSync(signins)
    assert.equal(own.length, 1, 'only the superseded snapshot is taken over')
    const onDisk = JSON.parse(fs.readFileSync(path.join(signins, own[0]), 'utf8'))
    assert.equal(onDisk.account.uin, '90000002004', 'the live sign-in is left where the client keeps it')
  } finally {
    await cleanup(dataDir)
  }
})

test('an account the client is signed into is not taken over from its own snapshot', async () => {
  const { pool, dataDir, signins } = machine('same-account', {
    snapshots: [['90000002006', 'Both']],
    live: ['90000002006', 'Both'],
  })
  await pool.scan()
  try {
    assert.equal(fs.existsSync(signins), false,
      'the client is using this account, so a second holder of the session would fight its refreshes')
  } finally {
    await cleanup(dataDir)
  }
})

test('a snapshot is taken over once, not again on every scan', async () => {
  const { pool, dataDir, signins } = machine('once', { snapshots: [['90000002007', 'Once']] })
  await pool.scan()
  try {
    const first = fs.readdirSync(signins)
    assert.equal(first.length, 1)
    await pool.scan()
    assert.deepEqual(fs.readdirSync(signins), first, 'the second scan finds the copy already there')
  } finally {
    await cleanup(dataDir)
  }
})

test('a sign-in the plugin already holds is not taken over again', async () => {
  const { pool, dataDir, signins } = machine('already', { snapshots: [['90000002008', 'Mine']] })
  await pool.scan()
  try {
    // A second snapshot of the same account arrives beside the first.
    const stale = path.join(dataDir, 'desktop', 'workbuddy-desktop-2026-10-07T10-07-06-90000002008.info')
    fs.writeFileSync(stale, JSON.stringify({
      auth: {
        accessToken: 'older-token', refreshToken: 'older-refresh',
        expiresAt: Date.now() + 2 * DAY, domain: 'www.codebuddy.cn',
        lastRefreshTime: Date.now() - 25 * DAY,
      },
      account: { uin: '90000002008', nickname: 'Mine' },
    }, null, 2))
    await pool.scan()
    assert.equal(fs.readdirSync(signins).length, 1, 'still one copy, not one per snapshot')
  } finally {
    await cleanup(dataDir)
  }
})

test('a deleted sign-in is not taken back from the snapshot the client still keeps', async () => {
  const { pool, dataDir, signins } = machine('deleted', { snapshots: [['90000002010', 'Deleted']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // The client's snapshot of that account is still lying beside it, which is
    // what made the delete look like it did nothing: the next scan copied it
    // straight back into the plugin's own directory.
    const after = await pool.scan()
    assert.deepEqual(after, [], 'the account is gone, not adopted again')
    assert.equal(fs.existsSync(signins) && fs.readdirSync(signins).length > 0, false,
      'and no sign-in was written back')
  } finally {
    await cleanup(dataDir)
  }
})

test('a delete holds across a restart', async () => {
  const { pool, dataDir } = machine('deleted-restart', { snapshots: [['90000002011', 'Deleted']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // A new pool reads the same data directory, the way the next start of the
    // app does. A tombstone that only lived in memory would forget the delete.
    const restarted = new WorkBuddyAccountPool({
      authDirs: [path.join(dataDir, 'desktop'), path.join(dataDir, 'signins')],
      dataPath: () => dataDir,
    })
    assert.deepEqual(await restarted.scan(), [], 'the account stays deleted')
  } finally {
    await cleanup(dataDir)
  }
})

test('signing in again after a delete brings the account back', async () => {
  const { pool, dataDir } = machine('deleted-return', { snapshots: [['90000002012', 'Returned']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // The client mints a new sign-in for the same account, which is the one
    // event a delete waits for.
    fs.writeFileSync(path.join(dataDir, 'desktop', 'workbuddy-desktop-2026-10-26T05-00-00-90000002012.info'), JSON.stringify({
      auth: {
        accessToken: 'token-again', refreshToken: 'refresh-again',
        expiresAt: Date.now() + 28 * DAY, domain: 'www.codebuddy.cn',
        lastRefreshTime: Date.now(),
      },
      account: { uin: '90000002012', nickname: 'Returned' },
    }, null, 2))
    const after = await pool.scan()
    assert.equal(after.length, 1, 'a newer sign-in ends the delete')
    assert.equal(after[0].id, account.id, 'and it is the same account')
  } finally {
    await cleanup(dataDir)
  }
})

test('a renewal of the desktop sign-in stays in force after the desktop switches away', async () => {
  const { pool, dataDir, desktop, signins } = machine('claim', {
    snapshots: [['90000002030', 'Claimed']],
    live: ['90000002030', 'Claimed'],
  })
  // The plugin's own copy of that account was made from an older snapshot, which
  // is where the stale token it would fall back to comes from.
  fs.mkdirSync(signins, { recursive: true })
  fs.writeFileSync(path.join(signins, 'workbuddy-panel-90000002030.info'), JSON.stringify({
    auth: {
      accessToken: 'own-old-token', refreshToken: 'own-old-refresh',
      expiresAt: Date.now() + 3 * DAY, domain: 'www.codebuddy.cn',
      lastRefreshTime: Date.now() - 30 * DAY,
    },
    account: { uin: '90000002030', nickname: 'Claimed' },
  }, null, 2))
  const [account] = await pool.scan()
  try {
    assert.equal(account.credential.accessToken, 'token-90000002030', 'the desktop sign-in is the newer copy')
    // A refused read is what forces this refresh in the field.
    assert.equal(await pool.ensureFresh(account, true), 'refreshed')
    const claimed = JSON.parse(fs.readFileSync(path.join(signins, 'workbuddy-panel-90000002030.info'), 'utf8'))
    assert.equal(claimed.auth.accessToken, 'renewed-token',
      'the renewal is written into the copy the pool maintains, not just the archive')
    // The desktop logs out of the account: its live file goes away.
    fs.rmSync(path.join(desktop, LIVE_NAME))
    const [afterSwitch] = await pool.scan()
    assert.equal(afterSwitch.credential.accessToken, 'renewed-token',
      'the account keeps serving the token that was minted for it, not the stale copy')
  } finally {
    await cleanup(dataDir)
  }
})

test('a renewal the archive holds outranks the plugin older copy, and ends its hold', async () => {
  const { pool, dataDir } = machine('archive-wins', { snapshots: [['90000002031', 'Archived']] })
  const [account] = await pool.scan()
  try {
    // The plugin's own copy is one rotation behind: its refresh token has been
    // replaced by a renewal the archive kept.
    pool.holdRefusedSignIn(account.id)
    fs.writeFileSync(path.join(dataDir, 'credentials-archive.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: account.id,
        accessToken: 'archived-fresh-token',
        refreshToken: 'archived-fresh-refresh',
        expiresAtMs: Date.now() + 28 * DAY,
        lastRefreshAtMs: Date.now(),
        nickname: 'Archived',
        uin: '90000002031',
        sourcePath: path.join(dataDir, 'desktop', 'workbuddy-desktop-2026-10-06T10-07-06-90000002031.info'),
      }],
    }))
    const [after] = await pool.scan()
    assert.equal(after.credential.accessToken, 'archived-fresh-token',
      'the copy the upstream issued last is the one to serve')
    const picked = await pool.acquire()
    assert.equal(picked?.credential.accessToken, 'archived-fresh-token',
      'and the hold is released, so the account can serve again without a re-login')
  } finally {
    await cleanup(dataDir)
  }
})

test('a delete holds off the copy the archive kept, not only the file the client kept', async () => {
  const { pool, dataDir, desktop, signins } = machine('deleted-archive', { snapshots: [['90000002013', 'Deleted']] })
  const [account] = await pool.scan()
  try {
    const snapshot = path.join(desktop, fs.readdirSync(desktop)[0])
    const archived = fs.readFileSync(path.join(signins, fs.readdirSync(signins)[0]), 'utf8')
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // The delete purges the archive, but that write can lose a race with a scan
    // already queued. Put the entry back the way a lost purge leaves it, with no
    // file anywhere holding the account: the client cleared its snapshot too, so
    // the archive is the only copy left to bring the row back.
    const survivor = JSON.parse(archived)
    fs.rmSync(snapshot)
    fs.writeFileSync(path.join(dataDir, 'credentials-archive.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: account.id,
        accessToken: survivor.auth.accessToken,
        refreshToken: survivor.auth.refreshToken,
        expiresAtMs: survivor.auth.expiresAt,
        lastRefreshAtMs: survivor.auth.lastRefreshTime,
        nickname: 'Deleted',
        uin: '90000002013',
        sourcePath: snapshot,
      }],
    }))
    assert.deepEqual(await pool.scan(), [], 'the archive copy does not bring the account back')
  } finally {
    await cleanup(dataDir)
  }
})

test('a refreshed desktop sign-in is not offered for deletion', async () => {
  const { pool, dataDir, desktop } = machine('claimed-live', {
    snapshots: [],
    live: ['90000002041', 'Claimed'],
  })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account, true), 'refreshed', 'the pool renewed the desktop sign-in')
    // The renewal leaves a copy in the pool's own directory, and that copy is what
    // serves from now on. It does not make the account the pool's to delete: the
    // app is still signed into it, and nothing on that row says the plugin added
    // it, so the button must stay away.
    assert.equal(pool.ownsSignIn(account.id), false,
      'the app still holds that session: the panel must not offer to delete the account')
    assert.equal(await pool.removeOwnSignIn(account.id), false, 'and the delete is refused')
    assert.equal(fs.readdirSync(desktop).length, 1, "the app's own file survives")
  } finally {
    await cleanup(dataDir)
  }
})

test('the copy the plugin wrote is the one that serves after it renews a live sign-in', async () => {
  const { pool, dataDir, signins } = machine('claimed-serves', {
    snapshots: [],
    live: ['90000002042', 'Claimed'],
  })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account, true), 'refreshed', 'the pool renewed the desktop sign-in')
    const [again] = await pool.scan()
    // The archive holds the same token with the path it was renewed from. Serving
    // that copy put the app's file back in front, and the age rule that keeps a
    // session alive only applies to the pool's own copies.
    assert.equal(again.credential.sourcePath.startsWith(signins), true,
      'the renewed token serves from the directory the pool maintains')
  } finally {
    await cleanup(dataDir)
  }
})

test('a sign-in the plugin holds itself is not reported as a lost desktop sign-in', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-own-'))
  const signins = path.join(dataDir, 'signins')
  fs.mkdirSync(signins, { recursive: true })
  fs.writeFileSync(path.join(signins, 'workbuddy-panel-90000002050.info'), JSON.stringify({
    auth: {
      accessToken: 'token-90000002050', refreshToken: 'refresh-90000002050',
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: '90000002050', nickname: 'From Panel' },
  }, null, 2))
  const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir })
  try {
    const [account] = await pool.scan()
    // Added from the panel: no desktop file ever held it, and the pool renews it on
    // age, so the row must not tell the user to sign in again in WorkBuddy.
    assert.equal(account.archived, undefined,
      'the pool holds and renews this copy: the note about a lost desktop sign-in does not apply')
  } finally {
    await cleanup(dataDir)
  }
})

test('a rescan after the pool renews the app sign-in still refuses the delete', async () => {
  const { pool, dataDir, desktop } = machine('claimed-live-rescan', {
    snapshots: [],
    live: ['90000002043', 'Claimed'],
  })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account, true), 'refreshed', 'the pool renewed the desktop sign-in')
    // The scan that follows serves the pool's copy, so a set keyed on the serving
    // copy would lose track of the account and offer a delete one scan later.
    const [again] = await pool.scan()
    assert.equal(pool.ownsSignIn(again.id), false,
      'the app still holds that session, wherever the served copy lives')
    assert.equal(await pool.removeOwnSignIn(again.id), false, 'and the delete stays refused')
    assert.equal(fs.readdirSync(desktop).length, 1, "the app's own file survives")
  } finally {
    await cleanup(dataDir)
  }
})

test('the international live sign-in is left where the client keeps it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-global-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = path.join(dataDir, 'signins')
  fs.mkdirSync(desktop, { recursive: true })
  // The international client keeps exactly one file and overwrites it on an
  // account switch. Reading it as an abandoned snapshot had the pool take over a
  // session the app was still signed into and renew it, spending the rotation the
  // app needed on its own next refresh.
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-ai.info'), JSON.stringify({
    auth: {
      accessToken: 'token-global', refreshToken: 'refresh-global',
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.ai',
      lastRefreshTime: Date.now() - 19 * DAY,
    },
    account: { uin: '90000002060', nickname: 'Global' },
  }, null, 2))
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop, signins],
    dataPath: () => dataDir,
    client: { refreshToken: async () => ({ accessToken: 'renewed-token', refreshToken: 'renewed-refresh', expiresInSec: 28 * DAY }) },
  })
  try {
    const [account] = await pool.scan()
    assert.equal(fs.existsSync(signins), false, 'nothing is taken over from the live file')
    assert.equal(pool.ownsSignIn(account.id), false, 'and the account is the app one to keep')
    assert.equal(await pool.ensureFresh(account), 'fresh',
      'an age-based renewal never touches a session the app is using')
  } finally {
    await cleanup(dataDir)
  }
})

test('a re-login without an issue time ends the tombstone', async () => {
  const { pool, dataDir, signins } = machine('tombstone-undated', { snapshots: [['90000002061', 'Undated']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // A sign-in from a build that writes no issue time. It is a different token,
    // i.e. a sign-in the user made, and refusing it left the account away for the
    // whole retention window with no way back and no hint why.
    fs.writeFileSync(path.join(dataDir, 'desktop', 'workbuddy-desktop.info'), JSON.stringify({
      auth: {
        accessToken: 'token-undated', refreshToken: 'refresh-undated',
        expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      },
      account: { uin: '90000002061', nickname: 'Undated' },
    }, null, 2))
    const after = await pool.scan()
    assert.equal(after.length, 1, 'a different token in the live file is a re-login, dated or not')
    assert.equal(after[0].credential.accessToken, 'token-undated', 'and it is the one served')
  } finally {
    await cleanup(dataDir)
  }
})

test('a renewal outranks the undated live file it replaced', async () => {
  const { pool, dataDir } = machine('undated-live', { live: ['90000002100', 'Undated'], issuedAgo: null })
  const [account] = await pool.scan()
  try {
    // An older build's live document carries no auth.lastRefreshTime. The pool can
    // still renew it, and the token it mints is the only live one; treating the
    // pair as unordered served the rotated-away token again on the next scan.
    assert.equal(await pool.ensureFresh(account, true), 'refreshed', 'the pool renewed the undated sign-in')
    const [after] = await pool.scan()
    assert.equal(after.credential.accessToken, 'renewed-token',
      'the newest sign-in keeps serving: an undated live file is not evidence of a newer one')
  } finally {
    await cleanup(dataDir)
  }
})

test('a failed read of the deleted sign-ins does not undo the delete', async () => {
  const { pool, dataDir } = machine('tombstone-busy', { snapshots: [['90000002400', 'Deleted']] })
  const [account] = await pool.scan()
  const fsp = require('node:fs/promises')
  const original = fsp.readFile
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    // A scanner or a backup holds the file on Windows: the read fails with EBUSY,
    // not ENOENT. Treating that as "no deleted sign-ins" threw away the set the
    // pool already knew, and the next write persisted the empty one. The stamp is
    // moved so the pool really goes back to the file instead of the cached copy.
    const file = path.join(dataDir, 'deleted-signins.json')
    const later = new Date(Date.now() + 2_000)
    fs.utimesSync(file, later, later)
    fsp.readFile = async (file, ...rest) => {
      if (String(file).includes('deleted-signins')) {
        const busy = new Error('resource busy')
        busy.code = 'EBUSY'
        throw busy
      }
      return original(file, ...rest)
    }
    assert.deepEqual(await pool.scan(), [], 'a read that failed leaves the delete in force')
  } finally {
    fsp.readFile = original
    await cleanup(dataDir)
  }
})

test('a delete is not undone by a write a month later', async () => {
  const { pool, dataDir } = machine('tombstone-prune', {
    snapshots: [['90000002410', 'Gone'], ['90000002411', 'Other']],
  })
  const accounts = await pool.scan()
  const gone = accounts.find(entry => entry.credential.uin === '90000002410')
  const other = accounts.find(entry => entry.credential.uin === '90000002411')
  try {
    assert.equal(await pool.removeOwnSignIn(gone.id), true)
    // The client still keeps its snapshot of the deleted account, so a tombstone
    // that expires brings the account back, refresh token included. Model a month
    // passing, then trigger any write of the file.
    const file = path.join(dataDir, 'deleted-signins.json')
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    document.entries[gone.id].deletedAtMs = Date.now() - 31 * DAY
    fs.writeFileSync(file, JSON.stringify(document))
    // The edit above is the test's fiction; without moving the stamp the pool would
    // keep serving the copy it read a moment ago and never see it.
    const touched = new Date(Date.now() + 2_000)
    fs.utimesSync(file, touched, touched)
    assert.equal(await pool.removeOwnSignIn(other.id), true)
    const after = await pool.scan()
    assert.equal(after.some(entry => entry.id === gone.id), false,
      'the delete holds as long as the copy it suppresses is still on disk')
  } finally {
    await cleanup(dataDir)
  }
})

test('two pools over one data directory keep each other deletes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-two-pools-'))
  const signins = ownSignInDir(dataDir)
  const [first, second] = await Promise.all([
    writeOwnSignIn(signins, {
      accessToken: 'token-a', refreshToken: 'refresh-a', expiresAtMs: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', uin: '90000002420', uid: '', nickname: 'A', enterpriseId: '',
      lastRefreshAtMs: Date.now(),
    }),
    writeOwnSignIn(signins, {
      accessToken: 'token-b', refreshToken: 'refresh-b', expiresAtMs: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', uin: '90000002421', uid: '', nickname: 'B', enterpriseId: '',
      lastRefreshAtMs: Date.now(),
    }),
  ])
  const make = () => new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir })
  const a = make()
  const b = make()
  try {
    await Promise.all([a.scan(), b.scan()])
    const [left] = await a.scan()
    const right = (await b.scan()).find(entry => entry.id !== left.id)
    // Both pools cached "no tombstones" before either wrote one. Writing each
    // map verbatim left only the later file, so the other pool's delete was gone.
    await Promise.all([a.removeOwnSignIn(left.id), b.removeOwnSignIn(right.id)])
    const document = JSON.parse(fs.readFileSync(path.join(dataDir, 'deleted-signins.json'), 'utf8'))
    assert.deepEqual(Object.keys(document.entries).sort(), [left.id, right.id].sort(),
      'a write keeps what the other pool already recorded')
    assert.equal(fs.existsSync(first), false, 'the first sign-in file is gone')
    assert.equal(fs.existsSync(second), false, 'the second sign-in file is gone')
  } finally {
    await cleanup(dataDir)
  }
})


test('the session the app is signed into serves over a copy taken from an undated snapshot', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-undated-snap-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const card = (accessToken, domain = 'www.codebuddy.cn') => ({
    auth: { accessToken, refreshToken: `refresh-${accessToken}`, expiresAt: Date.now() + 9 * DAY, domain },
    account: { uin: '90000003001', nickname: 'Undated' },
  })
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop, ownSignInDir(dataDir)], dataPath: () => dataDir })
  try {
    // An older build's snapshot with no issue time: the pool takes it over. The
    // copy it writes must stay undated too; stamping it "issued now" made that
    // superseded token outrank the session the app came back to.
    fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-2026-10-06T10-07-06-90000003001.info'), JSON.stringify(card('token-old'), null, 2))
    await pool.scan()
    fs.writeFileSync(path.join(desktop, LIVE_NAME), JSON.stringify(card('token-live'), null, 2))
    const [again] = await pool.scan()
    assert.equal(again.credential.accessToken, 'token-live', 'the session the app is in is the one served')
    assert.equal(again.credential.sourcePath, path.join(desktop, LIVE_NAME), 'and it serves from the live file')
  } finally {
    await cleanup(dataDir)
  }
})

test('the live sign-in serves over the pool copy when both carry the same issue time', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-same-stamp-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = ownSignInDir(dataDir)
  fs.mkdirSync(desktop, { recursive: true })
  const stamp = Date.now() - DAY
  const card = (accessToken) => ({
    auth: {
      accessToken, refreshToken: `refresh-${accessToken}`, expiresAt: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', lastRefreshTime: stamp,
    },
    account: { uin: '90000002070', nickname: 'Same Stamp' },
  })
  fs.writeFileSync(path.join(desktop, LIVE_NAME), JSON.stringify(card('token-live'), null, 2))
  fs.mkdirSync(signins, { recursive: true })
  fs.writeFileSync(path.join(signins, 'workbuddy-panel-90000002070.info'), JSON.stringify(card('token-own'), null, 2))
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop, signins], dataPath: () => dataDir })
  try {
    const [account] = await pool.scan()
    // Equal stamps and equal rank tier: the source order decides, not the order
    // the directories happened to be walked in.
    assert.equal(account.credential.accessToken, 'token-live', 'the live file leads its own copy')
  } finally {
    await cleanup(dataDir)
  }
})

test('a re-login also clears the tombstone on disk', async () => {
  const { pool, dataDir } = machine('tombstone-release', { snapshots: [['90000002440', 'Released']] })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    fs.writeFileSync(path.join(dataDir, 'desktop', LIVE_NAME), JSON.stringify({
      auth: {
        accessToken: 'token-after-relogin', refreshToken: 'refresh-after-relogin',
        expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
      },
      account: { uin: '90000002440', nickname: 'Released' },
    }, null, 2))
    assert.equal((await pool.scan()).length, 1, 'the re-login brings the account back')
    // The release has to reach the file, not only memory: the writer merges what is
    // on disk, and a pure union put the tombstone it just released back - the
    // account vanished again as soon as the app switched away.
    const document = JSON.parse(fs.readFileSync(path.join(dataDir, 'deleted-signins.json'), 'utf8'))
    assert.deepEqual(Object.keys(document.entries), [], 'and the record of the delete is gone')
  } finally {
    await cleanup(dataDir)
  }
})

test('a failed unlink leaves no tombstone behind', { skip: process.platform === 'win32' }, async () => {
  const { pool, dataDir, signins } = machine('unlink-fail-state', { snapshots: [['90000002500', 'Stuck']] })
  const [account] = await pool.scan()
  try {
    fs.chmodSync(signins, 0o500)
    await assert.rejects(pool.removeOwnSignIn(account.id))
    fs.chmodSync(signins, 0o700)
    const document = JSON.parse(fs.readFileSync(path.join(dataDir, 'deleted-signins.json'), 'utf8'))
    assert.deepEqual(Object.keys(document.entries), [], 'a delete that failed must not suppress the account')
    assert.equal((await pool.scan()).length, 1, 'the account is still listed')
    assert.equal(await pool.removeOwnSignIn(account.id), true, 'and the retry goes through')
  } finally {
    fs.chmodSync(signins, 0o700)
    await cleanup(dataDir)
  }
})

test('a delete whose tombstone cannot be written is reported as failed', async () => {
  const { pool, dataDir } = machine('tombstone-write-fail', { snapshots: [['90000002510', 'Kept']] })
  const [account] = await pool.scan()
  const fsp = require('node:fs/promises')
  const original = fsp.rename
  try {
    fsp.rename = async (from, to) => {
      if (String(to).includes('deleted-signins')) {
        const busy = new Error('resource busy')
        busy.code = 'EBUSY'
        throw busy
      }
      return original(from, to)
    }
    // Without the record the client's snapshot takes the account straight back, so
    // the delete did not happen: reporting success would hide a row that returns
    // after the next restart.
    await assert.rejects(pool.removeOwnSignIn(account.id), 'a delete that could not be recorded must fail')
    assert.equal(fs.existsSync(account.credential.sourcePath), true, 'and the sign-in file is still there')
  } finally {
    fsp.rename = original
    await cleanup(dataDir)
  }
})

test('adding the account again from the panel ends the delete of an undated sign-in', async () => {
  const { pool, dataDir, signins } = machine('tombstone-readd-undated', {
    snapshots: [['90000004001', 'Undated']],
    issuedAgo: null,
  })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true, 'the pool copy of an undated sign-in is deletable')
    // The remedy the release notes give for a dead account. The deleted sign-in had
    // no issue time, so the tombstone cannot be compared with a date the way it is
    // for a dated one; the panel writes into the pool's directory, which is not the
    // app's live file either, and the account stayed away for good.
    await writeOwnSignIn(signins, {
      accessToken: 'token-readd', refreshToken: 'refresh-readd', expiresAtMs: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', uin: '90000004001', uid: '', nickname: 'Undated',
      enterpriseId: '', lastRefreshAtMs: Date.now(),
    })
    const after = await pool.scan()
    assert.equal(after.length, 1, 'a sign-in added after the delete ends it, dated or not')
    assert.equal(after[0].credential.accessToken, 'token-readd', 'and it is the one served')
  } finally {
    await cleanup(dataDir)
  }
})

test('without a data directory nothing is taken over', async () => {
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-nodir-'))
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-2026-10-06T10-07-06-90000002009.info'), JSON.stringify({
    auth: {
      accessToken: 'token-90000002009', refreshToken: 'refresh-90000002009',
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      lastRefreshTime: Date.now() - 19 * DAY,
    },
    account: { uin: '90000002009', nickname: 'No Dir' },
  }, null, 2))
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop], client: { refreshToken: async () => ({}) } })
  const [account] = await pool.scan()
  try {
    assert.equal(account.credential.sourcePath.startsWith(desktop), true,
      'the snapshot keeps serving from where it lies')
    assert.equal(fs.readdirSync(desktop).length, 1, 'and nothing was written')
  } finally {
    await fs.promises.rm(desktop, { recursive: true, force: true })
  }
})

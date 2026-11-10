/**
 * The renewal the keep-alive performs, and where it lands.
 *
 * A refresh used to end in memory: the new token was stamped onto the account
 * and written to the archive, but the sign-in file it was read from kept the old
 * one, and the next scan read that back. The stored expiry therefore never
 * moved, a long-lived token was never renewed at all because the expiry margin
 * is five minutes, and a refresh token the upstream had already revoked stayed
 * undiscovered until the access token aged out on its own.
 *
 * These cases pin both halves: the age rule that makes a renewal happen, and the
 * write-back that makes it stick. They also pin the boundary - a credential read
 * out of the desktop app's directory is the app's to renew, never the plugin's.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { root, transpile } = require('./ts-loader.cjs')

const { WorkBuddyAccountPool, workbuddyAccountId, renewOwnSignInFile } = require('../src/accounts.ts')

const DAY = 24 * 60 * 60 * 1000
const scratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-renewal-${label}-`))

/** The upstream's answer to a refresh: a new token with a month of life. */
const renewed = () => ({
  accessToken: 'renewed-token', refreshToken: 'renewed-refresh', expiresInSec: 28 * 24 * 3600,
})

/**
 * A pool over one sign-in file the case wrote.
 *
 * `issuedAgo` is how long ago the sign-in was last refreshed, which is the age
 * the rule reads; `lifetimeMs` is how much life the stored token has left, which
 * the expiry margin reads. The two are independent so a case can put an account
 * on either side of either rule.
 *
 * `own` decides where the file lands: the plugin's own `signins/` directory,
 * which the renewal may write, or a plain directory standing in for the desktop
 * app's, which it may not.
 */
function poolOver(label, { issuedAgo = 0, lifetimeMs = 28 * DAY, own = true, live = false } = {}) {
  const dataDir = scratch(label)
  const dir = path.join(dataDir, own ? 'signins' : 'desktop')
  const file = path.join(dir, own ? 'workbuddy-panel-renewal-uin.info' : live ? LIVE_FILENAME : 'workbuddy-desktop-renewal-uin.info')
  const document = {
    auth: {
      accessToken: 'old-token', refreshToken: 'old-refresh',
      expiresAt: Date.now() + lifetimeMs, domain: 'www.codebuddy.cn',
      lastRefreshTime: Date.now() - issuedAgo,
    },
    account: { uin: 'renewal-uin', nickname: 'Renewal' },
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(document, null, 2))
  const pool = new WorkBuddyAccountPool({
    authDirs: [dir],
    dataPath: () => dataDir,
    client: { refreshToken: async () => renewed() },
  })
  return { pool, file, dataDir, signins: path.join(dataDir, 'signins') }
}

const readSignIn = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

const cleanup = async (dataDir) => { await fs.promises.rm(dataDir, { recursive: true, force: true }) }

test('a sign-in the plugin wrote is renewed once it is old enough', async () => {
  const { pool, dataDir } = poolOver('age', { issuedAgo: 7 * 60 * 60 * 1000, lifetimeMs: 28 * DAY })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account), 'refreshed',
      'weeks of lifetime left does not keep an old sign-in from being renewed')
  } finally {
    await cleanup(dataDir)
  }
})

test('the renewal is written back into the sign-in file it came from', async () => {
  const { pool, file, dataDir } = poolOver('writeback', { issuedAgo: 7 * 60 * 60 * 1000 })
  const [account] = await pool.scan()
  try {
    await pool.ensureFresh(account)
    const onDisk = readSignIn(file).auth
    assert.equal(onDisk.accessToken, 'renewed-token', 'the new access token reaches the file')
    assert.equal(onDisk.refreshToken, 'renewed-refresh', 'and so does the rotated refresh token')
    assert.ok(onDisk.expiresAt > Date.now() + 27 * DAY, 'and the stored expiry moves forward with it')
    assert.ok(onDisk.lastRefreshTime > Date.now() - 60_000, 'stamped with the moment of the renewal')

    // What the write-back is for: a scan after the renewal must not put the old
    // token back in charge.
    const [after] = await pool.scan()
    assert.equal(after.credential.accessToken, 'renewed-token',
      'a later scan keeps the renewed token rather than reading the superseded one back')
  } finally {
    await cleanup(dataDir)
  }
})

test('a sign-in the plugin wrote that is still young is left alone', async () => {
  const { pool, file, dataDir } = poolOver('young', { issuedAgo: 2 * 60 * 60 * 1000, lifetimeMs: 28 * DAY })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account), 'fresh', 'a recently issued sign-in is not renewed on age')
    assert.equal(readSignIn(file).auth.accessToken, 'old-token', 'and its file is untouched')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * The live file the desktop client is signed in with.
 *
 * A snapshot the client left behind is taken over and renewed like any other
 * sign-in the plugin owns (see adopt-signin.test.cjs), so the boundary the age
 * rule stops at is this one file: the session the client itself is using.
 */
const LIVE_FILENAME = 'workbuddy-desktop.info'

test('the live sign-in the client is using is never renewed on age', async () => {
  const { pool, file, dataDir } = poolOver('live', { issuedAgo: 30 * DAY, lifetimeMs: 28 * DAY, own: false, live: true })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account), 'fresh',
      'the desktop app owns that sign-in: it refreshes it, and a second holder of the session refreshing on its own schedule is how both end up with a spent refresh token')
    assert.equal(readSignIn(file).auth.accessToken, 'old-token', 'and the app file is never written to')
  } finally {
    await cleanup(dataDir)
  }
})

test('a superseded snapshot the client left behind is taken over and renewed', async () => {
  const { pool, file, dataDir, signins } = poolOver('snapshot', { issuedAgo: 30 * DAY, lifetimeMs: 28 * DAY, own: false })
  const [account] = await pool.scan()
  try {
    assert.notEqual(account.credential.sourcePath, file,
      'the plugin holds its own copy of the snapshot, which is the one that serves')
    assert.equal(await pool.ensureFresh(account), 'refreshed',
      'and that copy is renewed on age, so the account outlives the snapshot it came from')
    assert.equal(readSignIn(file).auth.accessToken, 'old-token',
      'while the client own file is left exactly as it was')
    assert.ok(fs.readdirSync(signins).length === 1, 'and the copy lives in the directory the plugin writes')
  } finally {
    await cleanup(dataDir)
  }
})

test('an expired sign-in the plugin wrote is still renewed on the expiry margin', async () => {
  const { pool, dataDir } = poolOver('margin', { issuedAgo: 60 * 1000, lifetimeMs: 60 * 1000 })
  const [account] = await pool.scan()
  try {
    assert.equal(await pool.ensureFresh(account), 'refreshed', 'the expiry margin still renews on its own')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A delete that commits while the upstream is minting a rotation.
 *
 * The tombstone is older than the minted token, so ordering the two by issue
 * time reads this rotation as the user signing in again - exactly the record
 * `endsTombstone` would then clear. What the record names is this account, and
 * no scan has released it, so the rotation must not land in either copy.
 */
test('a delete that lands during a refresh is not undone by the rotated token', async () => {
  const issuedAt = Date.now() - 7 * 60 * 60 * 1000
  const { pool, file, dataDir } = poolOver('delete-race', { issuedAgo: 7 * 60 * 60 * 1000 })
  const [account] = await pool.scan()
  assert.ok(account !== undefined)
  try {
    const id = workbuddyAccountId(account.credential)
    fs.writeFileSync(path.join(dataDir, 'deleted-signins.json'), JSON.stringify({
      version: 1,
      entries: {
        [id]: {
          tokenDigest: createHash('sha256').update('workbuddy\0deleted\0old-token').digest('hex').slice(0, 32),
          lastRefreshAtMs: issuedAt,
          deletedAtMs: Date.now() - 1_000,
        },
      },
    }, null, 2))
    assert.equal(await pool.ensureFresh(account, true), 'fresh',
      'a delete that committed first outranks the rotation')
    assert.equal(readSignIn(file).auth.accessToken, 'old-token',
      'the rotated token must not be written back into a deleted sign-in')
    const archiveFile = path.join(dataDir, 'credentials-archive.json')
    const archive = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, 'utf8') : ''
    assert.equal(archive.includes('renewed-token'), false,
      'and must not reach the archive the next scan reads from')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A tombstone that cannot be read is not a tombstone that is absent.
 *
 * The cache may be from before another pool recorded the delete. Returning it
 * as the answer let a rotation write the account back, and the next scan then
 * read the newer token as a re-login and cleared the record.
 */
test('an unreadable delete record blocks the rotation instead of allowing it', async () => {
  const issuedAt = Date.now() - 7 * 60 * 60 * 1000
  const { pool, file, dataDir } = poolOver('delete-unreadable', { issuedAgo: 7 * 60 * 60 * 1000 })
  const [account] = await pool.scan()
  assert.ok(account !== undefined)
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  try {
    const id = workbuddyAccountId(account.credential)
    fs.writeFileSync(tombstoneFile, JSON.stringify({
      version: 1,
      entries: {
        [id]: {
          tokenDigest: createHash('sha256').update('workbuddy\0deleted\0old-token').digest('hex').slice(0, 32),
          lastRefreshAtMs: issuedAt,
          deletedAtMs: Date.now() - 1_000,
        },
      },
    }, null, 2))
    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    fsp.readFile = async (candidate, ...rest) => {
      if (path.resolve(String(candidate)) === path.resolve(tombstoneFile)) {
        const busy = new Error('fixture tombstone is held without sharing reads')
        busy.code = 'EBUSY'
        throw busy
      }
      return realReadFile(candidate, ...rest)
    }
    try {
      assert.equal(await pool.ensureFresh(account, true), 'fresh',
        'a delete that cannot be ruled out must block the rotation')
      assert.equal(readSignIn(file).auth.accessToken, 'old-token',
        'the rotated token must not be written back')
      const archiveFile = path.join(dataDir, 'credentials-archive.json')
      const archive = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, 'utf8') : ''
      assert.equal(archive.includes('renewed-token'), false,
        'and must not reach the archive the next scan reads from')
    } finally {
      fsp.readFile = realReadFile
    }
    assert.equal((await pool.scan()).length, 0, 'once readable, the delete record still holds the account out')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A write's temporary file is not another writer's to remove while it is young.
 * The rename would fail after the upstream already retired the previous token,
 * and the caller would keep that token only in memory or the archive.
 */
test('a young sign-in temp is left for the write that created it', async () => {
  const directory = scratch('temp-age')
  const file = path.join(directory, 'workbuddy-panel-temp-uin.info')
  const document = {
    auth: {
      accessToken: 'temp-old-token', refreshToken: 'temp-old-refresh',
      expiresAt: Date.now() + DAY, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now() - DAY,
    },
    account: { uin: 'temp-uin', nickname: 'Temp' },
  }
  fs.writeFileSync(file, JSON.stringify(document, null, 2))
  const temporary = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, '{"auth":{"accessToken":"in-flight"}}')
  const previous = {
    accessToken: 'temp-old-token', refreshToken: 'temp-old-refresh',
    expiresAtMs: document.auth.expiresAt, domain: document.auth.domain,
    sourcePath: file, uin: 'temp-uin', nickname: 'Temp',
  }
  const next = {
    ...previous, accessToken: 'temp-new-token', refreshToken: 'temp-new-refresh',
    lastRefreshAtMs: Date.now(),
  }
  try {
    assert.equal(await renewOwnSignInFile(file, next, previous), true)
    assert.equal(fs.existsSync(temporary), true, 'a young temp belongs to the write still preparing it')

    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(temporary, old, old)
    const newer = {
      ...next, accessToken: 'temp-newer-token', refreshToken: 'temp-newer-refresh',
      lastRefreshAtMs: Date.now() + 1,
    }
    assert.equal(await renewOwnSignInFile(file, newer, next), true)
    assert.equal(fs.existsSync(temporary), false, 'an old temp with no writer left is cleaned')
  } finally {
    await cleanup(directory)
  }
})

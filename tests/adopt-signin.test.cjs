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
const { createHash } = require('node:crypto')
require('./ts-loader.cjs')

const {
  WorkBuddyAccountPool, legacyWorkBuddyAccountId, ownSignInDir, parseWorkBuddyAuth, renewOwnSignInFile,
  workbuddyAccountId, writeOwnSignIn,
} = require('../src/accounts.ts')

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

const cleanup = async (dataDir) => {
  await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

test('a serialized encrypted sign-in is opened or kept sealed', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-serialized-'))
  const wrap = (value) => JSON.stringify({ $wbEncrypted: 1, envelope: value })
  const document = JSON.stringify({
    auth: { accessToken: wrap('access'), refreshToken: wrap('refresh'), expiresAt: Date.now() + DAY },
    account: { uin: 'fixture', nickname: wrap('name') },
  })
  try {
    assert.equal(parseWorkBuddyAuth(document, 'fixture'), undefined, 'a sealed value is not a plaintext token')
    assert.equal(parseWorkBuddyAuth(JSON.stringify({ accessToken: '{"plain":true}' }), 'fixture').accessToken, '{"plain":true}')
    atRest.encryptedFieldOpener = async () => (field) => `opened-${field.envelope}`
    fs.writeFileSync(path.join(dataDir, LIVE_NAME), document)
    const pool = new WorkBuddyAccountPool({ authDirs: [dataDir] })
    const [account] = await pool.scan()
    assert.equal(account.credential.accessToken, 'opened-access')
    assert.equal(account.credential.refreshToken, 'opened-refresh')
    assert.equal(account.credential.nickname, 'opened-name')
    atRest.encryptedFieldOpener = async () => undefined
    assert.equal((await pool.scan())[0].credential.accessToken, 'opened-access', 'an unreadable sealed value retains the incumbent')
  } finally {
    atRest.encryptedFieldOpener = originalOpener
    await cleanup(dataDir)
  }
})

test('damaged serialized encrypted tokens cannot replace or enter the archive', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-damaged-sealed-'))
  const desktop = path.join(dataDir, 'desktop')
  const live = path.join(desktop, LIVE_NAME)
  const now = Date.now()
  const document = (accessToken, issued) => JSON.stringify({
    auth: { accessToken, refreshToken: 'fixture-refresh', expiresAt: now + DAY, lastRefreshTime: issued },
    account: { uin: 'fixture' },
  })
  fs.mkdirSync(desktop)
  fs.writeFileSync(live, document('fixture-token', now - 60000))
  atRest.encryptedFieldOpener = async () => undefined
  try {
    const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
    assert.equal((await pool.scan())[0].credential.accessToken, 'fixture-token')
    for (const damaged of [
      '{"$wbEncrypted":1,"envelope":',
      '{"$wbEncrypted":1}',
      '{"$wbEncrypted":1,"envelope":7}',
      '{"$wbEncrypted":1,"envelope":"fixture","extra":true}',
    ]) {
      fs.writeFileSync(live, document(damaged, now))
      assert.equal((await pool.scan())[0].credential.accessToken, 'fixture-token')
      const archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
      assert.equal(archive.entries[0].accessToken, 'fixture-token')
    }
    const plain = '{"plain":"ordinary"}'
    assert.equal(parseWorkBuddyAuth(document(plain, now), 'fixture').accessToken, plain)
  } finally {
    atRest.encryptedFieldOpener = originalOpener
    await cleanup(dataDir)
  }
})

test('an unreadable live sign-in stays protected from deletion across scans', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-sealed-owner-'))
  const desktop = path.join(dataDir, 'desktop')
  const live = path.join(desktop, LIVE_NAME)
  const now = Date.now()
  const document = (accessToken) => JSON.stringify({
    auth: { accessToken, refreshToken: 'fixture-refresh', expiresAt: now + DAY, lastRefreshTime: now - 60000 },
    account: { uin: 'fixture' },
  })
  fs.mkdirSync(desktop)
  fs.writeFileSync(live, document('fixture-desktop'))
  atRest.encryptedFieldOpener = async () => undefined
  try {
    await writeOwnSignIn(ownSignInDir(dataDir), {
      region: 'cn', accessToken: 'fixture-owned', refreshToken: 'fixture-refresh',
      expiresAtMs: now + DAY, lastRefreshAtMs: now, domain: 'codebuddy.cn',
      uin: 'fixture', uid: '', enterpriseId: '', nickname: '',
    })
    const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
    const [account] = await pool.scan()
    assert.equal(account.credential.accessToken, 'fixture-owned')
    assert.equal(pool.ownsSignIn(account.id), false)
    const wrapper = { $wbEncrypted: 1, envelope: 'fixture-envelope' }
    for (const value of [JSON.stringify(wrapper), wrapper]) {
      fs.writeFileSync(live, document(value))
      for (let scan = 0; scan < 2; scan += 1) {
        await pool.scan()
        assert.equal(pool.ownsSignIn(account.id), false)
        assert.equal(await pool.removeOwnSignIn(account.id), false)
      }
    }
    fs.unlinkSync(live)
    fs.writeFileSync(path.join(desktop, 'snapshot.info'), document(JSON.stringify(wrapper)))
    await pool.scan()
    assert.equal(pool.ownsSignIn(account.id), true, 'another sealed file does not keep a removed live file active')
  } finally {
    atRest.encryptedFieldOpener = originalOpener
    await cleanup(dataDir)
  }
})

test('a sealed live sign-in is protected on a cold scan, including when its identity is unavailable', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const now = Date.now()
  const wrapper = { $wbEncrypted: 1, envelope: 'fixture-envelope' }
  for (const value of [JSON.stringify(wrapper), wrapper]) {
    const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-cold-sealed-owner-'))
    const desktop = path.join(dataDir, 'desktop')
    const live = path.join(desktop, LIVE_NAME)
    fs.mkdirSync(desktop)
    fs.writeFileSync(live, JSON.stringify({
      auth: { accessToken: value, refreshToken: 'fixture-refresh', expiresAt: now + DAY },
      account: { uin: 'fixture' },
    }))
    try {
      await writeOwnSignIn(ownSignInDir(dataDir), {
        region: 'cn', accessToken: 'fixture-owned', refreshToken: 'fixture-refresh',
        expiresAtMs: now + DAY, domain: 'codebuddy.cn',
        uin: 'fixture', uid: '', enterpriseId: '', nickname: '',
      })
      await writeOwnSignIn(ownSignInDir(dataDir), {
        region: 'cn', accessToken: 'other-owned', refreshToken: 'other-refresh',
        expiresAtMs: now + DAY, domain: 'codebuddy.cn',
        uin: 'other', uid: '', enterpriseId: '', nickname: '',
      })
      atRest.encryptedFieldOpener = async () => undefined
      const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
      await pool.scan()
      const protectedAccount = pool.list().find(account => account.credential.accessToken === 'fixture-owned')
      const unrelatedAccount = pool.list().find(account => account.credential.accessToken === 'other-owned')
      assert.ok(protectedAccount)
      assert.ok(unrelatedAccount)
      assert.equal(pool.ownsSignIn(protectedAccount.id), false)
      assert.equal(await pool.removeOwnSignIn(protectedAccount.id), false)
      assert.equal(pool.ownsSignIn(unrelatedAccount.id), true, 'an unrelated own account stays removable')

      fs.writeFileSync(live, JSON.stringify({
        auth: { accessToken: value, refreshToken: 'fixture-refresh', expiresAt: now + DAY },
        account: {},
      }))
      await pool.scan()
      assert.equal(pool.ownsSignIn(protectedAccount.id), false)
      assert.equal(pool.ownsSignIn(unrelatedAccount.id), false,
        'an unidentified live account must make deletion conservative')

      const fileSystem = require('node:fs/promises')
      const realReaddir = fileSystem.readdir
      fileSystem.readdir = async (directory, ...args) => {
        if (path.resolve(directory) === path.resolve(desktop)) {
          const error = new Error('fixture directory is unavailable')
          error.code = 'EACCES'
          throw error
        }
        return realReaddir(directory, ...args)
      }
      try {
        await pool.scan()
        assert.equal(pool.ownsSignIn(unrelatedAccount.id), false,
          'an inaccessible live directory must not release deletion protection')
      } finally {
        fileSystem.readdir = realReaddir
      }

      const realReadFile = fileSystem.readFile
      fileSystem.readFile = async (file, ...args) => {
        if (path.resolve(file) === path.resolve(live)) {
          const error = new Error('fixture live file is unavailable')
          error.code = 'EPERM'
          throw error
        }
        return realReadFile(file, ...args)
      }
      try {
        await pool.scan()
        assert.equal(pool.ownsSignIn(unrelatedAccount.id), false,
          'an inaccessible live file must not release deletion protection')
        assert.ok(pool.list().some(account => account.id === unrelatedAccount.id),
          'an inaccessible live file must not clear the accounts in its directory')
      } finally {
        fileSystem.readFile = realReadFile
      }

      fs.writeFileSync(live, '{')
      await pool.scan()
      assert.equal(pool.ownsSignIn(unrelatedAccount.id), false,
        'a live file being rewritten must not release deletion protection')

      fs.writeFileSync(live, JSON.stringify({ auth: { accessToken: '' }, account: {} }))
      await pool.scan()
      assert.equal(pool.ownsSignIn(protectedAccount.id), true,
        'an explicit sign-out must release deletion protection')
      assert.equal(pool.ownsSignIn(unrelatedAccount.id), true)

      fs.unlinkSync(live)
      await pool.scan()
      assert.equal(pool.ownsSignIn(protectedAccount.id), true, 'removing the live file releases deletion')
      assert.equal(pool.ownsSignIn(unrelatedAccount.id), true)
    } finally {
      atRest.encryptedFieldOpener = originalOpener
      await cleanup(dataDir)
    }
  }
})

test('refresh cache preserves unreadable encrypted values and merges recovered values', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const now = Date.now()
  try {
    for (const value of [
      JSON.stringify({ $wbEncrypted: 1, envelope: 'fixture-refresh' }),
      { $wbEncrypted: 1, envelope: 'fixture-refresh' },
    ]) {
      const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-refresh-cache-'))
      const live = path.join(dataDir, LIVE_NAME)
      fs.writeFileSync(live, JSON.stringify({
        auth: {
          accessToken: 'fixture-access', refreshToken: value,
          expiresAt: now + DAY, refreshExpiresAt: now + DAY, lastRefreshTime: now - 60_000,
        },
        account: { uin: 'fixture' },
      }))
      try {
        const pool = new WorkBuddyAccountPool({ authDirs: [dataDir], dataPath: () => dataDir })
        atRest.encryptedFieldOpener = async () => undefined
        assert.equal((await pool.scan())[0].credential.refreshToken, '')

        atRest.encryptedFieldOpener = async () => field => `opened-${field.envelope}`
        assert.equal((await pool.scan())[0].credential.refreshToken, 'opened-fixture-refresh')
        let archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
        assert.equal(archive.entries[0].refreshToken, 'opened-fixture-refresh')

        atRest.encryptedFieldOpener = async () => undefined
        assert.equal((await pool.scan())[0].credential.refreshToken, 'opened-fixture-refresh')
        archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
        assert.equal(archive.entries[0].refreshToken, 'opened-fixture-refresh')
      } finally {
        await cleanup(dataDir)
      }
    }
  } finally {
    atRest.encryptedFieldOpener = originalOpener
  }
})

test('explicitly empty or expired refresh tokens clear a cached refresh token', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-refresh-clear-'))
  const live = path.join(dataDir, LIVE_NAME)
  const now = Date.now()
  const write = (refreshToken, refreshExpiresAt) => fs.writeFileSync(live, JSON.stringify({
    auth: {
      accessToken: 'fixture-access', refreshToken,
      expiresAt: now + DAY, refreshExpiresAt, lastRefreshTime: now - 60_000,
    },
    account: { uin: 'fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [dataDir], dataPath: () => dataDir })
  try {
    write('fixture-refresh', now + DAY)
    assert.equal((await pool.scan())[0].credential.refreshToken, 'fixture-refresh')

    write('', now + DAY)
    assert.equal((await pool.scan())[0].credential.refreshToken, '')

    write('fixture-refresh', now + DAY)
    assert.equal((await pool.scan())[0].credential.refreshToken, 'fixture-refresh')
    write('fixture-refresh', now - DAY)
    const [account] = await pool.scan()
    assert.equal(account.credential.refreshToken, '')
    assert.equal(account.credential.refreshExpiresAtMs, undefined)
    const archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
    assert.equal(archive.entries[0].refreshToken, '')
  } finally {
    await cleanup(dataDir)
  }
})

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

test('a 1.2.3 tombstone also holds off its archive copy', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-legacy-archive-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const sourcePath = path.join(desktop, 'workbuddy-desktop-old.info')
  const previous = legacyWorkBuddyAccountId({ nickname: 'Archive delete', sourcePath })
  fs.writeFileSync(path.join(dataDir, 'credentials-archive.json'), JSON.stringify({
    version: 1,
    entries: [{
      id: previous,
      accessToken: 'legacy-archive-token',
      refreshToken: 'legacy-archive-refresh',
      expiresAtMs: Date.now() + 28 * DAY,
      nickname: 'Archive delete',
      domain: 'www.codebuddy.cn',
      sourcePath,
    }],
  }))
  fs.writeFileSync(path.join(dataDir, 'deleted-signins.json'), JSON.stringify({
    entries: {
      [previous]: {
        tokenDigest: createHash('sha256')
          .update('workbuddy\0deleted\0legacy-archive-token')
          .digest('hex').slice(0, 32),
        lastRefreshAtMs: 0,
        deletedAtMs: Date.now() - 1000,
      },
    },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
  try {
    assert.equal((await pool.scan()).length, 0,
      'the archive copy of the deleted sign-in must not be served')
  } finally {
    await cleanup(dataDir)
  }
})

test('deleting one legacy-key claimant keeps the archive copy of the other', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-legacy-shared-'))
  const signins = path.join(dataDir, 'signins')
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(signins, { recursive: true })
  fs.mkdirSync(desktop, { recursive: true })
  const otherPath = path.join(desktop, 'workbuddy-desktop-old.info')
  try {
    const mine = await writeOwnSignIn(signins, {
      region: 'cn', accessToken: 'own-token', refreshToken: 'own-refresh',
      expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      uid: '', uin: '', enterpriseId: '', nickname: 'Twin',
    })
    const legacy = legacyWorkBuddyAccountId({ nickname: 'Twin', sourcePath: mine })
    fs.writeFileSync(path.join(dataDir, 'credentials-archive.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: legacy,
        accessToken: 'other-token',
        refreshToken: 'other-refresh',
        expiresAtMs: Date.now() + 9 * DAY,
        nickname: 'Twin',
        domain: 'www.workbuddy.ai',
        sourcePath: otherPath,
      }],
    }))
    const pool = new WorkBuddyAccountPool({
      authDirs: [signins, desktop],
      dataPath: () => dataDir,
    })
    const before = await pool.scan()
    assert.equal(before.length, 2, 'the shared key names both identity-less rows')
    const own = before.find(account => account.credential.sourcePath === mine)
    assert.ok(own, 'the plugin-owned sign-in is listed')
    assert.equal(await pool.removeOwnSignIn(own.id), true)
    const after = await pool.scan()
    assert.equal(after.length, 1, 'the other row survives the delete')
    assert.equal(after[0].credential.sourcePath, otherPath)
    const archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
    assert.equal(archive.entries.length, 1, 'a shared 1.2.3 archive entry is not purged')
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

test('an unreadable live sign-in keeps its renewed account out of keep-alive', async () => {
  const { pool, dataDir, desktop } = machine('unreadable-live-refresh', {
    snapshots: [],
    live: ['90000002044', 'Unreadable'],
  })
  const [account] = await pool.scan()
  const live = path.join(desktop, LIVE_NAME)
  const fsp = require('node:fs/promises')
  const originalRead = fsp.readFile
  let refreshes = 0
  pool.client.refreshToken = async () => {
    refreshes += 1
    return { accessToken: `renewed-${refreshes}`, refreshToken: `refresh-${refreshes}`, expiresInSec: 28 * DAY }
  }
  try {
    assert.equal(await pool.ensureFresh(account, true), 'refreshed')
    fsp.readFile = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(live)) {
        const denied = new Error('access denied')
        denied.code = 'EPERM'
        throw denied
      }
      return originalRead(file, ...rest)
    }
    const [after] = await pool.scan()
    assert.equal(await pool.ensureFresh(after, true), 'fresh')
    assert.equal(refreshes, 1, 'a live file the app still holds but cannot be read must block another renewal')
  } finally {
    fsp.readFile = originalRead
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
  const { pool, dataDir } = machine('tombstone-undated', { snapshots: [['90000002061', 'Undated']] })
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

test('a cold pool does not restore a deleted account when its tombstone is unreadable', async () => {
  const { pool, dataDir, desktop } = machine('tombstone-cold-busy', {
    snapshots: [['90000002401', 'Deleted']],
  })
  const [account] = await pool.scan()
  const fsp = require('node:fs/promises')
  const original = fsp.readFile
  try {
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    fsp.readFile = async (file, ...rest) => {
      if (String(file).includes('deleted-signins')) {
        const busy = new Error('resource busy')
        busy.code = 'EBUSY'
        throw busy
      }
      return original(file, ...rest)
    }
    const restarted = new WorkBuddyAccountPool({
      authDirs: [desktop, path.join(dataDir, 'signins')],
      dataPath: () => dataDir,
    })
    assert.deepEqual(await restarted.scan(), [],
      'an unknown tombstone set must keep a cold pool empty')
  } finally {
    fsp.readFile = original
    await cleanup(dataDir)
  }
})

test('an unconfirmed tombstone state cannot reuse an old empty cache', async (t) => {
  for (const failure of ['stat', 'read']) {
    await t.test(failure, async () => {
      const { pool, dataDir, desktop, signins } = machine(`tombstone-stale-cache-${failure}`, {
        snapshots: [['90000002403', 'Deleted']],
      })
      const [account] = await pool.scan()
      const other = new WorkBuddyAccountPool({
        authDirs: [desktop, signins],
        dataPath: () => dataDir,
      })
      await other.scan()
      assert.equal(await other.removeOwnSignIn(account.id), true)
      pool.clear()

      const fsp = require('node:fs/promises')
      const fileName = path.join(dataDir, 'deleted-signins.json')
      const original = fsp[failure]
      fsp[failure] = async (file, ...rest) => {
        if (path.resolve(String(file)) === path.resolve(fileName)) {
          const error = new Error(`fixture ${failure} failed`)
          error.code = failure === 'stat' ? 'EACCES' : 'EBUSY'
          throw error
        }
        return original(file, ...rest)
      }
      try {
        assert.deepEqual(await pool.scan(), [],
          `a failed ${failure} must not make an older empty cache authoritative`)
      } finally {
        fsp[failure] = original
        await cleanup(dataDir)
      }
    })
  }
})

test('a scan that exceeds the delete wait cannot restore the deleted account', async () => {
  const { pool, dataDir } = machine('delete-scan-timeout', {
    snapshots: [['90000002402', 'Deleted']],
  })
  const [account] = await pool.scan()
  let releaseArchive
  let archiveStarted
  const archiveGate = new Promise((resolve) => { releaseArchive = resolve })
  const started = new Promise((resolve) => { archiveStarted = resolve })
  const originalArchive = pool.archiveCredentials
  pool.archiveCredentials = async (...args) => {
    archiveStarted()
    await archiveGate
    return originalArchive.apply(pool, args)
  }
  const realSetTimeout = global.setTimeout
  let racing
  try {
    global.setTimeout = (callback, delay, ...args) =>
      realSetTimeout(callback, delay === 5_000 ? 10 : delay, ...args)
    racing = pool.scan()
    await started
    assert.equal(await pool.removeOwnSignIn(account.id), true)
    releaseArchive()
    await racing
    await new Promise((resolve) => setImmediate(resolve))
    await pool.archiveQueue.catch(() => {})
    assert.deepEqual(pool.list(), [],
      'a scan that passed the tombstone read before the delete must not assign afterwards')
  } finally {
    releaseArchive()
    global.setTimeout = realSetTimeout
    await racing?.catch(() => {})
    await pool.archiveQueue.catch(() => {})
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

test('a sealed live sign-in blocks same-account snapshot takeover', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-sealed-snapshot-'))
  const desktop = path.join(dataDir, 'desktop')
  const uid = '90000006001'
  fs.mkdirSync(desktop)
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-2026-10-06T10-07-06-90000006001.info'), JSON.stringify({
    auth: {
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', lastRefreshTime: Date.now() - 9 * DAY,
    },
    account: { uin: uid },
  }))
  fs.writeFileSync(path.join(desktop, LIVE_NAME), JSON.stringify({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'sealed-access' },
      refreshToken: { $wbEncrypted: 1, envelope: 'sealed-refresh' },
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: uid },
  }))
  atRest.encryptedFieldOpener = async () => undefined
  let refreshes = 0
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop],
    dataPath: () => dataDir,
    client: { refreshToken: async () => { refreshes += 1; return { accessToken: 'renewed' } } },
  })
  try {
    assert.deepEqual(await pool.scan(), [])
    assert.equal(fs.existsSync(ownSignInDir(dataDir)), false, 'the historical snapshot is not claimed')
    assert.equal(refreshes, 0, 'an unreadable live session is not refreshed')
  } finally {
    atRest.encryptedFieldOpener = originalOpener
    await cleanup(dataDir)
  }
})

test('a historical sealed snapshot does not block a readable sign-in refresh', async () => {
  const atRest = require('../src/at-rest.ts')
  const originalOpener = atRest.encryptedFieldOpener
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-sealed-history-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = ownSignInDir(dataDir)
  const uid = '90000006010'
  fs.mkdirSync(desktop)
  fs.writeFileSync(path.join(desktop, `workbuddy-desktop-2026-10-06T10-07-06-${uid}.info`), JSON.stringify({
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'sealed-history' },
      refreshToken: 'sealed-refresh', expiresAt: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', lastRefreshTime: Date.now() - DAY,
    },
    account: { uin: uid },
  }))
  await writeOwnSignIn(signins, {
    accessToken: 'readable-token', refreshToken: 'readable-refresh',
    expiresAtMs: Date.now() + 1000, domain: 'www.codebuddy.cn',
    uin: uid, uid: '', nickname: 'Readable', enterpriseId: '',
    lastRefreshAtMs: Date.now() - DAY,
  })
  atRest.encryptedFieldOpener = async () => undefined
  let refreshes = 0
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop, signins],
    dataPath: () => dataDir,
    client: {
      refreshToken: async () => {
        refreshes += 1
        return { accessToken: 'refreshed-token', refreshToken: 'refreshed-refresh', expiresInSec: 3600 }
      },
    },
  })
  try {
    const [account] = await pool.scan()
    assert.equal(account.credential.accessToken, 'readable-token')
    assert.equal(await pool.ensureFresh(account, true), 'refreshed')
    assert.equal(refreshes, 1,
      'a sealed snapshot that is not the current source must not block a readable account')
  } finally {
    atRest.encryptedFieldOpener = originalOpener
    await cleanup(dataDir)
  }
})

test('an older refresh result cannot overwrite a newer sign-in', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-refresh-login-'))
  const signins = ownSignInDir(dataDir)
  const signIn = (accessToken, lastRefreshAtMs) => ({
    accessToken, refreshToken: `refresh-${accessToken}`, expiresAtMs: Date.now() + 9 * DAY,
    domain: 'www.codebuddy.cn', uin: '90000006002', uid: '', nickname: 'Fixture',
    enterpriseId: '', lastRefreshAtMs,
  })
  let releaseRefresh
  let refreshStarted
  const started = new Promise(resolve => { refreshStarted = resolve })
  const pool = new WorkBuddyAccountPool({
    authDirs: [signins],
    dataPath: () => dataDir,
    client: {
      refreshToken: async () => {
        refreshStarted()
        await new Promise(resolve => { releaseRefresh = resolve })
        return { accessToken: 'old-refresh-result', refreshToken: 'rotated-refresh', expiresInSec: 3600 }
      },
    },
  })
  try {
    const file = await writeOwnSignIn(signins, signIn('old-access', Date.now() - DAY))
    const [account] = await pool.scan()
    const refreshing = pool.refreshAccount(account.id)
    await started
    await writeOwnSignIn(signins, signIn('new-login', Date.now()))
    releaseRefresh()
    assert.equal(await refreshing, true)
    const stored = parseWorkBuddyAuth(fs.readFileSync(file, 'utf8'), file)
    assert.equal(stored.accessToken, 'new-login')
    assert.equal(pool.list()[0].credential.accessToken, 'new-login')
  } finally {
    releaseRefresh?.()
    await cleanup(dataDir)
  }
})

test('a Windows sharing violation does not lose a renewed token', { skip: process.platform !== 'win32' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-refresh-retry-'))
  const signins = ownSignInDir(dataDir)
  const pool = new WorkBuddyAccountPool({
    authDirs: [signins],
    dataPath: () => dataDir,
    client: {
      refreshToken: async () => ({
        accessToken: 'retried-token',
        refreshToken: 'retried-refresh',
        expiresInSec: 3600,
      }),
    },
  })
  let originalRename
  try {
    const file = await writeOwnSignIn(signins, {
      accessToken: 'expiring-access',
      refreshToken: 'expiring-refresh',
      expiresAtMs: Date.now() + 1_000,
      domain: 'www.codebuddy.cn',
      uin: '90000006003',
      uid: '',
      nickname: 'Retry',
      enterpriseId: '',
      lastRefreshAtMs: Date.now() - DAY,
    })
    const [account] = await pool.scan()
    const fsp = require('node:fs/promises')
    originalRename = fsp.rename
    let failures = 2
    fsp.rename = async (from, to, ...rest) => {
      if (failures > 0 && path.resolve(String(to)) === path.resolve(file)) {
        failures -= 1
        const busy = new Error('target is temporarily open')
        busy.code = 'EPERM'
        throw busy
      }
      return originalRename(from, to, ...rest)
    }

    assert.equal(await pool.ensureFresh(account, true), 'refreshed')
    assert.equal(failures, 0, 'the replacement used its bounded retries')
    assert.equal(parseWorkBuddyAuth(fs.readFileSync(file, 'utf8'), file).accessToken, 'retried-token')
    assert.equal(fs.readdirSync(signins).some(name => name.endsWith('.tmp')), false)
  } finally {
    if (originalRename !== undefined) require('node:fs/promises').rename = originalRename
    await cleanup(dataDir)
  }
})

test('two pools merge archive writes instead of losing one', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-archive-lock-'))
  const left = path.join(dataDir, 'left')
  const right = path.join(dataDir, 'right')
  fs.mkdirSync(left)
  fs.mkdirSync(right)
  const card = (uid, token) => JSON.stringify({
    auth: {
      accessToken: token, refreshToken: `refresh-${uid}`, expiresAt: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
    },
    account: { uin: uid },
  })
  fs.writeFileSync(path.join(left, LIVE_NAME), card('90000006003', 'left-token'))
  fs.writeFileSync(path.join(right, LIVE_NAME), card('90000006004', 'right-token'))
  const make = (authDir) => new WorkBuddyAccountPool({ authDirs: [authDir], dataPath: () => dataDir })
  const fsp = require('node:fs/promises')
  const realRename = fsp.rename
  let releaseRename
  let renameStarted
  const started = new Promise(resolve => { renameStarted = resolve })
  let blocked = false
  fsp.rename = async (from, to, ...rest) => {
    if (!blocked && path.basename(String(to)) === 'credentials-archive.json') {
      blocked = true
      renameStarted()
      await new Promise(resolve => { releaseRename = resolve })
    }
    return realRename(from, to, ...rest)
  }
  try {
    const first = make(left).scan()
    await started
    const second = make(right).scan()
    releaseRename()
    await Promise.all([first, second])
    const archive = JSON.parse(fs.readFileSync(path.join(dataDir, 'credentials-archive.json'), 'utf8'))
    assert.equal(archive.entries.length, 2)
  } finally {
    fsp.rename = realRename
    releaseRename?.()
    await cleanup(dataDir)
  }
})

test('a delete does not run without its file lock', async () => {
  const { pool, dataDir } = machine('delete-lock-failure', { snapshots: [['90000006005', 'Locked']] })
  const [account] = await pool.scan()
  const lock = path.join(dataDir, 'deleted-signins.json.lock')
  fs.mkdirSync(lock)
  try {
    await assert.rejects(pool.removeOwnSignIn(account.id))
    assert.equal(fs.existsSync(account.credential.sourcePath), true)
    assert.equal((await pool.scan()).some((entry) => entry.id === account.id), true,
      'a failed lock must not hide the account from the next scan')
  } finally {
    await cleanup(dataDir)
  }
})

test('an unreadable desktop directory blocks deletion on a cold scan', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-cold-unreadable-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = ownSignInDir(dataDir)
  fs.mkdirSync(desktop)
  await writeOwnSignIn(signins, {
    accessToken: 'own-token', refreshToken: 'own-refresh', expiresAtMs: Date.now() + 9 * DAY,
    domain: 'www.codebuddy.cn', uin: '90000006007', uid: '', nickname: 'Fixture',
    enterpriseId: '', lastRefreshAtMs: Date.now(),
  })
  const fsp = require('node:fs/promises')
  const realReaddir = fsp.readdir
  fsp.readdir = async (directory, ...rest) => {
    if (path.resolve(String(directory)) === path.resolve(desktop)) {
      const error = new Error('fixture directory is unavailable')
      error.code = 'EACCES'
      throw error
    }
    return realReaddir(directory, ...rest)
  }
  try {
    const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
    const [account] = await pool.scan()
    assert.equal(pool.ownsSignIn(account.id), false)
    assert.equal(await pool.removeOwnSignIn(account.id), false)
    assert.equal(fs.existsSync(account.credential.sourcePath), true)
  } finally {
    fsp.readdir = realReaddir
    await cleanup(dataDir)
  }
})

test('a delete keeps a live sign-in that replaced the pool copy during a scan', async () => {
  const { pool, dataDir, desktop } = machine('delete-live-race', {
    snapshots: [['90000006006', 'Racing']],
  })
  const [account] = await pool.scan()
  const ownFile = account.credential.sourcePath
  const liveFile = path.join(desktop, LIVE_NAME)
  fs.writeFileSync(liveFile, JSON.stringify({
    auth: {
      accessToken: 'new-live-token', refreshToken: 'new-live-refresh', expiresAt: Date.now() + 9 * DAY,
      domain: 'www.codebuddy.cn', lastRefreshTime: Date.now() + DAY,
    },
    account: { uin: '90000006006' },
  }))
  const fsp = require('node:fs/promises')
  const realReadFile = fsp.readFile
  let releaseRead
  let readStarted
  const started = new Promise(resolve => { readStarted = resolve })
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(liveFile)) {
      readStarted()
      await new Promise(resolve => { releaseRead = resolve })
    }
    return realReadFile(file, ...rest)
  }
  try {
    const scanning = pool.scan()
    await started
    const removing = pool.removeOwnSignIn(account.id)
    const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(tombstoneFile)
        && Object.hasOwn(JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries, account.id)) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    releaseRead()
    await scanning
    assert.equal(await removing, false)
    assert.equal(fs.existsSync(liveFile), true, 'the desktop live sign-in must survive')
    assert.equal(fs.existsSync(ownFile), true, 'the superseded pool copy is not deleted either')
    const tombstones = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries
    assert.equal(Object.hasOwn(tombstones, account.id), false)
  } finally {
    fsp.readFile = realReadFile
    releaseRead?.()
    await cleanup(dataDir)
  }
})

test('a delete keeps a re-login rewritten to the same pool path during a scan', async () => {
  const { pool, dataDir, signins } = machine('delete-same-path-race', {
    snapshots: [['90000006008', 'Racing']],
  })
  const [account] = await pool.scan()
  const ownFile = account.credential.sourcePath
  const fsp = require('node:fs/promises')
  const realReadFile = fsp.readFile
  let releaseRead
  let readStarted
  let held = false
  const started = new Promise((resolve) => { readStarted = resolve })
  fsp.readFile = async (file, ...rest) => {
    if (!held && path.resolve(String(file)) === path.resolve(ownFile)) {
      held = true
      readStarted()
      await new Promise((resolve) => { releaseRead = resolve })
    }
    return realReadFile(file, ...rest)
  }
  try {
    const scanning = pool.scan()
    await started
    const removing = pool.removeOwnSignIn(account.id)
    const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fs.existsSync(tombstoneFile)
        && Object.hasOwn(JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries, account.id)) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await writeOwnSignIn(signins, {
      accessToken: 'new-same-path-token', refreshToken: 'new-same-path-refresh',
      expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      uin: '90000006008', uid: '', nickname: 'Racing', enterpriseId: '',
      lastRefreshAtMs: Date.now(),
    })
    releaseRead()
    await scanning

    assert.equal(await removing, false)
    assert.equal(fs.existsSync(ownFile), true, 'the newly written sign-in must survive')
    assert.equal(parseWorkBuddyAuth(fs.readFileSync(ownFile, 'utf8'), ownFile).accessToken,
      'new-same-path-token')
    const tombstones = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries
    assert.equal(Object.hasOwn(tombstones, account.id), false)
  } finally {
    fsp.readFile = realReadFile
    releaseRead?.()
    await cleanup(dataDir)
  }
})

test('a failed unlink restores the roster after a concurrent scan', async () => {
  const { pool, dataDir } = machine('delete-failure-roster', {
    snapshots: [['90000006009', 'Kept']],
  })
  const [account] = await pool.scan()
  const ownFile = account.credential.sourcePath
  const fsp = require('node:fs/promises')
  const realUnlink = fsp.unlink
  let releaseUnlink
  let unlinkStarted
  const started = new Promise((resolve) => { unlinkStarted = resolve })
  fsp.unlink = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(ownFile)) {
      unlinkStarted()
      await new Promise((resolve) => { releaseUnlink = resolve })
      const denied = new Error('fixture delete denied')
      denied.code = 'EACCES'
      throw denied
    }
    return realUnlink(file, ...rest)
  }
  try {
    const removing = pool.removeOwnSignIn(account.id)
    await started
    const scanning = pool.scan()
    await scanning
    releaseUnlink()
    await assert.rejects(removing, { code: 'EACCES' })

    assert.equal(fs.existsSync(ownFile), true)
    assert.equal(pool.list().some((entry) => entry.id === account.id), true,
      'a failed delete must leave the live account in the roster')
    const document = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'deleted-signins.json'), 'utf8'),
    )
    assert.deepEqual(Object.keys(document.entries), [])
  } finally {
    fsp.unlink = realUnlink
    releaseUnlink?.()
    await cleanup(dataDir)
  }
})

/**
 * A sign-in with no vendor id is keyed by its file, and an earlier build adopted
 * the desktop's snapshot under a second path. Both files carry one session, so
 * renewing either spends the other's refresh token.
 */
test('an identity-less snapshot and the plugin copy of one session are one account', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-same-session-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = ownSignInDir(dataDir)
  fs.mkdirSync(desktop, { recursive: true })
  fs.mkdirSync(signins, { recursive: true })
  const auth = {
    accessToken: 'token-same-session',
    refreshToken: 'refresh-same-session',
    expiresAt: Date.now() + DAY,
    domain: 'www.codebuddy.cn',
  }
  fs.writeFileSync(path.join(desktop, 'workbuddy-desktop-old.info'), JSON.stringify({
    auth,
    account: { nickname: 'Same name' },
  }))
  const ownFile = await writeOwnSignIn(signins, {
    region: 'cn',
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAtMs: auth.expiresAt,
    domain: auth.domain,
    nickname: 'Same name',
    uid: '',
    uin: '',
    enterpriseId: '',
  })
  const pool = new WorkBuddyAccountPool({
    authDirs: [desktop],
    dataPath: () => dataDir,
    client: {
      refreshToken: async () => ({
        accessToken: 'token-same-session-renewed',
        refreshToken: 'refresh-same-session-renewed',
        expiresInSec: 28 * DAY,
      }),
    },
  })
  try {
    const accounts = await pool.scan()
    assert.equal(accounts.length, 1, 'one session is one account, whatever file it was read from')
    assert.equal(accounts[0].credential.sourcePath, ownFile,
      'the plugin-owned copy wins because it is the one the pool renews')

    const outcome = await pool.ensureFresh(accounts[0], true)
    assert.equal(outcome, 'refreshed', 'the own copy is renewed in place')
    const after = await pool.scan()
    assert.equal(after.length, 1,
      'the rotated token must not let the old desktop snapshot back in as a second account')
    assert.equal(after[0].credential.sourcePath, ownFile)
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A tombstone written before the identity change still hides its sign-in.
 *
 * 1.2.3 keyed an identity-less sign-in by its nickname alone; this build adds
 * the source path so two sign-ins sharing a name stay apart. The tombstone file
 * was not migrated, and looking only at the new key let the client's snapshot
 * bring the deleted account back after an upgrade.
 */
test('a 1.2.3 tombstone still hides the sign-in it was written for', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-legacy-tombstone-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const auth = {
    accessToken: 'token-legacy-delete',
    refreshToken: 'refresh-legacy-delete',
    expiresAt: Date.now() + DAY,
    domain: 'www.codebuddy.cn',
  }
  const file = path.join(desktop, 'workbuddy-desktop-old.info')
  fs.writeFileSync(file, JSON.stringify({ auth, account: { nickname: 'Legacy delete' } }))
  const previous = legacyWorkBuddyAccountId({
    nickname: 'Legacy delete', sourcePath: file,
  })
  assert.notEqual(previous, workbuddyAccountId({ nickname: 'Legacy delete', sourcePath: file }),
    'the fixture must exercise the key the upgrade changed')
  fs.writeFileSync(path.join(dataDir, 'deleted-signins.json'), JSON.stringify({
    entries: {
      [previous]: {
        tokenDigest: createHash('sha256')
          .update(`workbuddy\0deleted\0${auth.accessToken}`)
          .digest('hex').slice(0, 32),
        lastRefreshAtMs: 0,
        deletedAtMs: Date.now() - 1000,
      },
    },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
  try {
    const accounts = await pool.scan()
    assert.equal(accounts.length, 0,
      'the row the user deleted must not come back under the new key')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * Settings saved under a 1.2.3 key still name the upgraded account.
 *
 * A deleted account that was switched off, reserved or chosen as preferred kept
 * those decisions in the settings file under the old key. Reading only the new
 * key made the account serve again, ignore its floor, or silently stay behind a
 * preference the panel still showed.
 */
test('settings stored under a 1.2.3 key still apply to the upgraded account', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-legacy-settings-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const file = path.join(desktop, 'workbuddy-desktop-old.info')
  fs.writeFileSync(file, JSON.stringify({
    auth: {
      accessToken: 'token-legacy-settings',
      refreshToken: 'refresh-legacy-settings',
      expiresAt: Date.now() + DAY,
      domain: 'www.codebuddy.cn',
    },
    account: { nickname: 'Legacy settings' },
  }))
  const previous = legacyWorkBuddyAccountId({
    nickname: 'Legacy settings', sourcePath: file,
  })
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
  try {
    pool.applyConfig({ disabledAccountIds: [previous], creditReserves: { [previous]: 100 } })
    const accounts = await pool.scan()
    assert.equal(accounts.length, 1)
    const id = accounts[0].id
    assert.notEqual(id, previous, 'the fixture must exercise the key the upgrade changed')
    assert.equal(pool.isDisabled(id), true, 'a switch saved under the old key still holds')
    assert.equal(pool.creditReserve(id), 100, 'a floor saved under the old key is still in force')

    pool.applyConfig({ disabledAccountIds: [] })
    pool.setCreditBalance(id, 50)
    assert.equal(pool.available(Date.now(), undefined, 'cn').length, 0,
      'the old floor still keeps the account out of rotation')

    pool.setCreditBalance(id, 500)
    assert.equal(pool.available(Date.now(), undefined, 'cn').length, 1)
    pool.applyRemoved([previous])
    assert.equal(pool.list('cn').length, 0, 'a removal saved under the old key still hides the row')
    pool.applyRemoved([])
    pool.prefer(previous, 'cn')
    assert.equal((await pool.acquire(undefined, 'cn'))?.id, id,
      'a preference saved under the old key still picks this account')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A 1.2.3 tombstone blocks its own sign-in without being released.
 *
 * The old key hashed a nickname alone, so two identity-less sign-ins can share
 * it. Releasing the record on a newer token would resurrect the deleted row on
 * the next scan; hiding every same-nickname sign-in would take an unrelated
 * account out of the pool.
 */
test('a 1.2.3 tombstone blocks only the token it was written for', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-legacy-token-'))
  const desktop = path.join(dataDir, 'desktop')
  fs.mkdirSync(desktop, { recursive: true })
  const write = (name, token) => fs.writeFileSync(path.join(desktop, name), JSON.stringify({
    auth: {
      accessToken: token,
      refreshToken: `refresh-${token}`,
      expiresAt: Date.now() + DAY,
      domain: 'www.codebuddy.cn',
    },
    account: { nickname: 'Same nickname' },
  }))
  write('workbuddy-desktop-old.info', 'token-deleted')
  write('workbuddy-desktop-live.info', 'token-live')
  const previous = legacyWorkBuddyAccountId({
    nickname: 'Same nickname', sourcePath: path.join(desktop, 'workbuddy-desktop-old.info'),
  })
  const file = path.join(dataDir, 'deleted-signins.json')
  fs.writeFileSync(file, JSON.stringify({
    entries: {
      [previous]: {
        tokenDigest: createHash('sha256')
          .update('workbuddy\0deleted\0token-deleted')
          .digest('hex').slice(0, 32),
        lastRefreshAtMs: 0,
        deletedAtMs: Date.now() - 1000,
      },
    },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir })
  try {
    for (const pass of [1, 2]) {
      const accounts = await pool.scan()
      assert.equal(accounts.length, 1, `pass ${pass}: only the live sign-in remains`)
      assert.equal(accounts[0].credential.accessToken, 'token-live')
      const tombstones = JSON.parse(fs.readFileSync(file, 'utf8')).entries
      assert.ok(tombstones[previous], `pass ${pass}: the 1.2.3 record must stay for its own token`)
    }
  } finally {
    await cleanup(dataDir)
  }
})

test('a write clears the credential copy an interrupted write left behind', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-temp-'))
  const signins = path.join(dataDir, 'signins')
  const signIn = {
    region: 'cn', accessToken: 'first-token', refreshToken: 'first-refresh',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin: '90000009999', enterpriseId: '', nickname: 'Temp',
  }
  try {
    const file = await writeOwnSignIn(signins, signIn)
    const abandoned = `${file}.00000000-0000-4000-8000-000000000000.tmp`
    fs.writeFileSync(abandoned, JSON.stringify({ auth: { accessToken: 'stale-token' } }))
    // Young enough to belong to a write another process is still preparing.
    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(abandoned, old, old)
    await writeOwnSignIn(signins, { ...signIn, accessToken: 'second-token' })
    assert.equal(fs.existsSync(abandoned), false,
      'a temp file between write and rename holds a full token and must not survive')
    const previous = parseWorkBuddyAuth(fs.readFileSync(file, 'utf8'), file)
    assert.ok(previous, 'the rewritten sign-in parses')
    const abandonedRenewal = `${file}.11111111-1111-4111-8111-111111111111.tmp`
    fs.writeFileSync(abandonedRenewal, JSON.stringify({ auth: { accessToken: 'stale-renewal-token' } }))
    fs.utimesSync(abandonedRenewal, old, old)
    await renewOwnSignInFile(file, {
      ...previous, accessToken: 'third-token', refreshToken: 'third-refresh',
    }, previous)
    assert.equal(fs.existsSync(abandonedRenewal), false,
      'a renewal that was interrupted must not leave its token copy behind')
  } finally {
    await cleanup(dataDir)
  }
})
test('a scan clears an old interrupted sign-in temp and keeps one in flight', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-scan-temp-'))
  const signins = path.join(dataDir, 'signins')
  try {
    const file = await writeOwnSignIn(signins, {
      region: 'cn', accessToken: 'scan-token', refreshToken: 'scan-refresh',
      expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      uid: '', uin: '90000009998', enterpriseId: '', nickname: 'ScanTemp',
    })
    const old = `${file}.00000000-0000-4000-8000-000000000001.tmp`
    const young = `${file}.00000000-0000-4000-8000-000000000002.tmp`
    fs.writeFileSync(old, JSON.stringify({ auth: { accessToken: 'stale-scan-token' } }))
    fs.writeFileSync(young, JSON.stringify({ auth: { accessToken: 'in-flight-token' } }))
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    fs.utimesSync(old, hourAgo, hourAgo)
    const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir })
    await pool.scan()
    assert.equal(fs.existsSync(old), false, 'a crashed write leaves a full token and must be swept')
    assert.equal(fs.existsSync(young), true, 'a temp another writer is preparing is left alone')
  } finally {
    await cleanup(dataDir)
  }
})
/**
 * A stale roster can hold a delete for a sign-in older than one another pool
 * already deleted. When neither record's issue time can order them, dropping
 * one let the other stand in for it and the newer snapshot came back.
 */
test('a stale delete cannot replace an undated newer tombstone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-undated-delete-'))
  const signins = path.join(dataDir, 'signins')
  const copies = path.join(dataDir, 'copies')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  fs.mkdirSync(copies)
  const uin = '90000009985'
  const olderIssued = Date.now() - 60 * 60 * 1000
  const newerIssued = Date.now() - 10 * 60 * 1000
  const digest = (token) => createHash('sha256')
    .update('workbuddy\0deleted\0' + token).digest('hex').slice(0, 32)
  const signIn = (token, issued) => ({
    region: 'cn', accessToken: token, refreshToken: `rt-${token}`,
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'UndatedDelete', lastRefreshAtMs: issued,
  })
  try {
    await writeOwnSignIn(signins, signIn('at-undated-old', olderIssued))
    const stalePool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const staleRoster = await stalePool.scan()
    assert.equal(staleRoster.length, 1)

    // The newer sign-in's file carries no issue time, so its delete cannot be
    // ordered against the stale pool's older dated record. The archive would
    // still offer the older copy, so it is not part of this fixture.
    fs.rmSync(path.join(dataDir, 'credentials-archive.json'), { force: true })
    await writeOwnSignIn(signins, signIn('at-undated-new', 0))
    const currentPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const currentRoster = await currentPool.scan()
    const current = currentRoster.find(account => account.credential.uin === uin)
    assert.ok(current !== undefined)
    assert.equal(current.credential.lastRefreshAtMs, 0, 'the newer sign-in is undated')
    assert.equal(await currentPool.removeOwnSignIn(current.id), true)

    // The stale pool still holds the previous sign-in and deletes it now.
    assert.equal(await stalePool.removeOwnSignIn(staleRoster[0].id), true)
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    const kept = entries[current.id]
    assert.ok(kept !== undefined)
    const digests = [kept.tokenDigest, ...(kept.alternates ?? []).map(record => record.tokenDigest)]
    assert.ok(digests.includes(digest('at-undated-new')),
      'the newer delete must survive beside the stale one')

    // A dated copy of the newer sign-in, issued before the delete, shows up.
    fs.writeFileSync(path.join(copies, 'workbuddy-desktop-old.info'), JSON.stringify({
      auth: {
        accessToken: 'at-undated-new', refreshToken: 'rt-at-undated-new',
        expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn', lastRefreshTime: newerIssued,
      },
      account: { uin, nickname: 'UndatedDelete' },
    }), 'utf8')
    const scanningPool = new WorkBuddyAccountPool({ authDirs: [copies, signins], dataPath: () => dataDir, cooldownMs: 60000 })
    assert.equal((await scanningPool.scan()).length, 0,
      'neither delete may be dropped just because the other one is older')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A failed delete writes its rollback from the set it last saw. If another
 * pool released a tombstone in the meantime, that rollback must not put the
 * release back in force.
 */
test('a failed delete does not resurrect a tombstone released meanwhile', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-release-rollback-'))
  const signins = path.join(dataDir, 'signins')
  const failingDir = path.join(dataDir, 'failing')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  fs.mkdirSync(failingDir)
  const releasedUin = '90000009986'
  const failingUin = '90000009987'
  const digest = (token) => createHash('sha256')
    .update('workbuddy\0deleted\0' + token).digest('hex').slice(0, 32)
  const id = (uin) => workbuddyAccountId({ uin, nickname: 'ReleaseRollback', sourcePath: '' })
  const signIn = (uin, token) => ({
    region: 'cn', accessToken: token, refreshToken: `rt-${token}`,
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'ReleaseRollback', lastRefreshAtMs: Date.now(),
  })
  const released = {
    tokenDigest: digest('at-released'),
    lastRefreshAtMs: Date.now() - DAY,
    deletedAtMs: Date.now() - DAY,
    nonce: 'released-nonce',
  }
  try {
    fs.writeFileSync(tombstoneFile, JSON.stringify({
      version: 1, entries: { [id(releasedUin)]: released },
    }, null, 2))
    await writeOwnSignIn(failingDir, signIn(failingUin, 'at-failing'))
    const failingPool = new WorkBuddyAccountPool({ authDirs: [failingDir], dataPath: () => dataDir, cooldownMs: 60000 })
    const roster = await failingPool.scan()
    const failing = roster.find(account => account.credential.uin === failingUin)
    assert.ok(failing !== undefined)

    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    const realUnlink = fsp.unlink
    let releaseRead
    let readStarted
    let readHeld = false
    const started = new Promise((resolve) => { readStarted = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (!readHeld && path.resolve(String(file)) === path.resolve(failing.credential.sourcePath)) {
        readHeld = true
        readStarted()
        await new Promise((resolve) => { releaseRead = resolve })
      }
      return realReadFile(file, ...rest)
    }
    fsp.unlink = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(failing.credential.sourcePath)) {
        const denied = new Error('fixture unlink denied')
        denied.code = 'EACCES'
        throw denied
      }
      return realUnlink(file, ...rest)
    }
    try {
      const removing = failingPool.removeOwnSignIn(failing.id)
      removing.catch(() => {})
      // The delete has written its tombstone and is now reading the file it
      // would remove; the tombstone lock is free.
      await started
      // Another pool signs the released account back in and scans it.
      const reLoginFile = await writeOwnSignIn(signins, signIn(releasedUin, 'at-released-again'))
      const releasingPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
      const releasedRoster = await releasingPool.scan()
      assert.equal(releasedRoster.some(account => account.credential.uin === releasedUin), true,
        `roster: ${releasedRoster.map(account => `${account.credential.uin}:${account.credential.accessToken}`).join(',')} files: ${fs.readdirSync(signins).join(',')} tombstones: ${fs.readFileSync(tombstoneFile, 'utf8')}`)
      assert.equal(
        Object.hasOwn(JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}, id(releasedUin)),
        false,
        'the re-login releases the tombstone',
      )
      // The sign-in file is gone again by the time the failed delete rolls
      // back; its own rescan must not release the tombstone the rollback
      // restores.
      fs.rmSync(reLoginFile, { force: true })
      releaseRead()
      await assert.rejects(removing, { code: 'EACCES' })
    } finally {
      releaseRead?.()
      fsp.readFile = realReadFile
      fsp.unlink = realUnlink
    }
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(Object.hasOwn(entries, id(releasedUin)), false,
      `the failed delete must not put the released tombstone back: ${JSON.stringify(entries)}`)
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * The archive and adoption phases can take long enough for another pool to
 * delete the account. If the final re-read cannot see the document, the scan
 * cannot tell whether that delete landed, so it must not commit its roster.
 */
test('an unreadable final tombstone check does not commit the roster', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-final-unreadable-'))
  const signins = path.join(dataDir, 'signins')
  const archive = path.join(dataDir, 'credentials-archive.json')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const uin = '90000009988'
  const signIn = {
    region: 'cn', accessToken: 'at-final-unreadable', refreshToken: 'rt-final-unreadable',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'FinalUnreadable', lastRefreshAtMs: Date.now() - DAY,
  }
  try {
    await writeOwnSignIn(signins, signIn)
    const deletingPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const roster = await deletingPool.scan()
    const doomed = roster.find(account => account.credential.uin === uin)
    assert.ok(doomed !== undefined)
    assert.equal(fs.existsSync(archive), true)

    const scanningPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    let parkRead = true
    let denyTombstones = false
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (denyTombstones && path.resolve(String(file)) === path.resolve(tombstoneFile)) {
        const denied = new Error('fixture tombstone read denied')
        denied.code = 'EACCES'
        throw denied
      }
      if (parkRead && path.resolve(String(file)) === path.resolve(archive)) {
        parkRead = false
        const text = await realReadFile(file, ...rest)
        readParked()
        await readGate
        return text
      }
      return realReadFile(file, ...rest)
    }
    try {
      const scanning = scanningPool.scan()
      await parked
      const deleting = deletingPool.removeOwnSignIn(doomed.id)
      const signInFile = doomed.credential.sourcePath
      const deadline = Date.now() + 10_000
      while (fs.existsSync(signInFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(fs.existsSync(signInFile), false)
      denyTombstones = true
      releaseRead()
      await scanning
      await deleting
      assert.equal(scanningPool.list().length, 0,
        'a scan that could not check the delete document must not commit')
    } finally {
      releaseRead()
      fsp.readFile = realReadFile
    }
  } finally {
    await cleanup(dataDir)
  }
})

test('a scan that read the pool before a delete cannot write the account back to the archive', async () => {
  const fsp = require('node:fs/promises')
  const { pool, dataDir, desktop } = machine('archive-race', { live: ['90000001234', 'Race'] })
  const live = path.join(desktop, LIVE_NAME)
  const credential = parseWorkBuddyAuth(fs.readFileSync(live, 'utf8'), live)
  assert.ok(credential, 'the fixture sign-in parses')
  const id = workbuddyAccountId(credential)
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  fs.writeFileSync(tombstoneFile, JSON.stringify({
    version: 1,
    entries: {
      [id]: {
        tokenDigest: createHash('sha256')
          .update('workbuddy\0deleted\0' + credential.accessToken)
          .digest('hex').slice(0, 32),
        lastRefreshAtMs: 0,
        deletedAtMs: Date.now(),
      },
    },
  }))
  const realReadFile = fsp.readFile
  let tombstoneReads = 0
  // The scan's first read predates the delete; the archive write runs after it.
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(tombstoneFile) && tombstoneReads++ === 0) {
      // Make the next stamp differ, as the delete's write would.
      const future = new Date(Date.now() + 5_000)
      fs.utimesSync(tombstoneFile, future, future)
      return JSON.stringify({ version: 1, entries: {} })
    }
    return realReadFile(file, ...rest)
  }
  try {
    await pool.scan()
    const archiveFile = path.join(dataDir, 'credentials-archive.json')
    const archive = fs.existsSync(archiveFile)
      ? JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
      : { entries: [] }
    assert.equal(archive.entries.some((entry) => entry.id === id), false,
      'a deleted sign-in must not return to the archive from a scan that started before the delete')
  } finally {
    fsp.readFile = realReadFile
    await cleanup(dataDir)
  }
})

/**
 * A failed delete has to restore the tombstone document exactly as it found it.
 *
 * The rollback used a map snapshot taken before the delete, while the write
 * persisted whatever map the last read had installed. A concurrent delete in
 * between made the two differ, and the failed delete's own tombstone survived -
 * the account stayed hidden after the panel had reported the failure.
 */
/**
 * A refresh that started before the user deleted the sign-in can finish after
 * the re-login's scan released the tombstone. Its rotated token belongs to the
 * session that was deleted, not to the sign-in now on disk.
 */
test('a refresh finishing after a re-login does not archive the deleted session', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-refresh-relogin-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = path.join(dataDir, 'signins')
  const archive = path.join(dataDir, 'credentials-archive.json')
  fs.mkdirSync(desktop)
  const uin = '90000009989'
  const signIn = (token, refreshToken, issued) => ({
    region: 'cn', accessToken: token, refreshToken,
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'RefreshRelogin', lastRefreshAtMs: issued,
  })
  let releaseRefresh
  let refreshStarted
  const gate = new Promise((resolve) => { releaseRefresh = resolve })
  const started = new Promise((resolve) => { refreshStarted = resolve })
  try {
    await writeOwnSignIn(signins, signIn('at-refresh-before', 'rt-refresh-before', Date.now() - DAY))
    const pool = new WorkBuddyAccountPool({
      authDirs: [desktop, signins],
      dataPath: () => dataDir,
      cooldownMs: 60000,
      client: {
        refreshToken: async () => {
          refreshStarted()
          await gate
          return { accessToken: 'at-refresh-rotated', refreshToken: 'rt-refresh-rotated', expiresInSec: 28 * DAY }
        },
      },
    })
    const [account] = await pool.scan()
    assert.ok(account !== undefined)
    // The pool that deletes is not the one holding the refresh open; its
    // roster cannot tell the refresher that the sign-in is gone.
    const deletingPool = new WorkBuddyAccountPool({ authDirs: [desktop, signins], dataPath: () => dataDir, cooldownMs: 60000 })
    await deletingPool.scan()
    const refreshing = pool.ensureFresh(account, true)
    refreshing.catch(() => {})
    await started

    assert.equal(await deletingPool.removeOwnSignIn(account.id), true)
    // The user signs in again; the client writes its live file.
    fs.writeFileSync(path.join(desktop, LIVE_NAME), JSON.stringify({
      auth: {
        accessToken: 'at-recovered', refreshToken: 'rt-recovered',
        expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn', lastRefreshTime: Date.now(),
      },
      account: { uin, nickname: 'RefreshRelogin' },
    }), 'utf8')
    const recovered = await deletingPool.scan()
    assert.equal(recovered.some(entry => entry.credential.accessToken === 'at-recovered'), true)

    releaseRefresh()
    assert.equal(await refreshing, 'failed')
    const archived = fs.existsSync(archive)
      ? JSON.parse(fs.readFileSync(archive, 'utf8')).entries ?? []
      : []
    assert.equal(archived.some(entry => entry.accessToken === 'at-refresh-rotated'), false,
      'the deleted session must not be archived after the re-login')
    const next = await pool.scan()
    assert.equal(next.some(entry => entry.credential.accessToken === 'at-refresh-rotated'), false,
      'the deleted session must not outrank the re-login')
    assert.equal(next.some(entry => entry.credential.accessToken === 'at-recovered'), true)
  } finally {
    releaseRefresh()
    await cleanup(dataDir)
  }
})

/**
 * A failed unlink rolls the tombstone back. If that rollback write hits a
 * transient sharing violation, the tombstone must not be left behind where a
 * fresh process would hide a sign-in the panel said was not deleted.
 */
test('a failed delete retries a failed tombstone rollback', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-rollback-retry-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const signIn = {
    region: 'cn', accessToken: 'at-rollback-retry', refreshToken: 'rt-rollback-retry',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin: '90000009990', enterpriseId: '', nickname: 'RollbackRetry', lastRefreshAtMs: Date.now(),
  }
  const fsp = require('node:fs/promises')
  const realUnlink = fsp.unlink
  const realRename = fsp.rename
  let tombstoneRenames = 0
  try {
    await writeOwnSignIn(signins, signIn)
    const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const [account] = await pool.scan()
    assert.ok(account !== undefined)
    fsp.unlink = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(account.credential.sourcePath)) {
        const denied = new Error('fixture unlink denied')
        denied.code = 'EPERM'
        throw denied
      }
      return realUnlink(file, ...rest)
    }
    fsp.rename = async (from, to, ...rest) => {
      if (path.resolve(String(to)) === path.resolve(tombstoneFile)) {
        tombstoneRenames += 1
        if (tombstoneRenames === 2) {
          const denied = new Error('fixture rollback write denied')
          denied.code = 'EACCES'
          throw denied
        }
      }
      return realRename(from, to, ...rest)
    }
    await assert.rejects(pool.removeOwnSignIn(account.id), { code: 'EPERM' })
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(Object.hasOwn(entries, account.id), false,
      'the failed delete must not leave its tombstone behind')
    assert.equal(fs.existsSync(account.credential.sourcePath), true)
  } finally {
    fsp.unlink = realUnlink
    fsp.rename = realRename
    await cleanup(dataDir)
  }
})

/**
 * The success path has its own window: the rotation is already on disk when
 * another pool deletes it, so the archive check skips the write. The pool that
 * ran the refresh must not keep serving the rotated token either.
 */
test('a delete after the rotated write reverts the in-memory token', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-refresh-window-'))
  const signins = path.join(dataDir, 'signins')
  const archive = path.join(dataDir, 'credentials-archive.json')
  const uin = '90000009991'
  const signIn = {
    region: 'cn', accessToken: 'at-window-old', refreshToken: 'rt-window-old',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'RefreshWindow',
    lastRefreshAtMs: Date.now() - 7 * 60 * 60 * 1000,
  }
  const client = {
    refreshToken: async () => ({
      accessToken: 'at-window-rotated', refreshToken: 'rt-window-rotated', expiresInSec: 28 * DAY,
    }),
  }
  let archiveReached
  let releaseArchiveCheck
  const reached = new Promise((resolve) => { archiveReached = resolve })
  const gate = new Promise((resolve) => { releaseArchiveCheck = resolve })
  try {
    const file = await writeOwnSignIn(signins, signIn)
    const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000, client })
    const [account] = await pool.scan()
    assert.ok(account !== undefined)
    const realArchiveCheck = pool.archiveRefreshedCredential.bind(pool)
    pool.archiveRefreshedCredential = async (previous, refreshed) => {
      archiveReached()
      await gate
      return await realArchiveCheck(previous, refreshed)
    }
    const refreshing = pool.ensureFresh(account, true)
    await reached
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auth.accessToken, 'at-window-rotated')

    const deletingPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const doomed = (await deletingPool.scan()).find(entry => entry.credential.uin === uin)
    assert.ok(doomed !== undefined)
    assert.equal(doomed.credential.accessToken, 'at-window-rotated')
    assert.equal(await deletingPool.removeOwnSignIn(doomed.id), true)
    assert.equal(fs.existsSync(file), false)

    releaseArchiveCheck()
    assert.equal(await refreshing, 'failed')
    assert.equal(account.credential.accessToken, 'at-window-old',
      'the in-memory credential must revert when the sign-in is gone')
    assert.equal(pool.available(Date.now()).some(entry => entry.credential.accessToken === 'at-window-rotated'), false)
    const archived = fs.existsSync(archive)
      ? JSON.parse(fs.readFileSync(archive, 'utf8')).entries ?? []
      : []
    assert.equal(archived.some(entry => entry.accessToken === 'at-window-rotated'), false)
    assert.equal((await pool.scan()).length, 0)
  } finally {
    releaseArchiveCheck()
    await cleanup(dataDir)
  }
})

test('a failed delete does not leave its own tombstone behind', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-rollback-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const signIn = (uin, nickname) => ({
    region: 'cn', accessToken: `at-${uin}`, refreshToken: `rt-${uin}`,
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname,
  })
  try {
    await writeOwnSignIn(signins, signIn('90000009970', 'Keep'))
    await writeOwnSignIn(signins, signIn('90000009971', 'Other'))
    await writeOwnSignIn(signins, signIn('90000009972', 'Later'))
    const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const other = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const mine = await pool.scan()
    await other.scan()
    const target = mine.find(account => account.credential.uin === '90000009970')
    const first = mine.find(account => account.credential.uin === '90000009971')
    const second = mine.find(account => account.credential.uin === '90000009972')
    assert.ok(target !== undefined && first !== undefined && second !== undefined)
    assert.equal(await other.removeOwnSignIn(first.id), true)

    const fsp = require('node:fs/promises')
    const realUnlink = fsp.unlink
    const realReadFile = fsp.readFile
    const targetFile = target.credential.sourcePath
    fsp.unlink = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(targetFile)) {
        const denied = new Error('fixture sign-in cannot be removed')
        denied.code = 'EPERM'
        throw denied
      }
      return realUnlink(file, ...rest)
    }
    let parkRead = true
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (parkRead && path.resolve(String(file)) === path.resolve(targetFile)) {
        parkRead = false
        readParked()
        await readGate
      }
      return realReadFile(file, ...rest)
    }
    try {
      const deleting = pool.removeOwnSignIn(target.id)
      deleting.catch(() => {})
      // The delete has recorded its tombstone and is about to check the file.
      // This delete changes the tombstone document while the first one is in
      // flight.
      await parked
      assert.equal(await other.removeOwnSignIn(second.id), true)
      releaseRead()
      await assert.rejects(deleting, (error) => error.code === 'EPERM')
    } finally {
      releaseRead()
      fsp.unlink = realUnlink
      fsp.readFile = realReadFile
    }
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(Object.hasOwn(entries, target.id), false,
      'the failed delete must not leave its own tombstone behind')
    assert.equal(Object.hasOwn(entries, workbuddyAccountId(first.credential)), true,
      'the delete it merged from the other pool stays')
    assert.equal(Object.hasOwn(entries, workbuddyAccountId(second.credential)), true,
      'the concurrent delete stays')
    const after = await pool.scan()
    assert.equal(after.some(account => account.id === target.id), true,
      'the account whose delete failed is still served')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A scan releasing an old delete must not erase a newer delete for the same
 * account, written by another pool while the scan was reading the record.
 */
test('a scan releasing an old delete keeps a newer one written meanwhile', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-release-race-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const oldToken = 'at-release-old'
  const newToken = 'at-release-new'
  const uin = '90000009980'
  const id = workbuddyAccountId({ uin, nickname: 'ReleaseRace', sourcePath: '' })
  const digest = (token) => createHash('sha256')
    .update('workbuddy\0deleted\0' + token).digest('hex').slice(0, 32)
  const earlier = { tokenDigest: digest(oldToken), lastRefreshAtMs: Date.now() - DAY, deletedAtMs: Date.now() - 30 * 60 * 1000 }
  const later = { tokenDigest: digest(newToken), lastRefreshAtMs: Date.now(), deletedAtMs: Date.now() + 1_000 }
  try {
    await writeOwnSignIn(signins, {
      region: 'cn', accessToken: newToken, refreshToken: 'rt-release-new',
      expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      uid: '', uin, enterpriseId: '', nickname: 'ReleaseRace', lastRefreshAtMs: Date.now(),
    })
    fs.writeFileSync(tombstoneFile, JSON.stringify({ version: 1, entries: { [id]: earlier } }, null, 2))
    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    let parkRead = true
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (parkRead && path.resolve(String(file)) === path.resolve(tombstoneFile)) {
        parkRead = false
        const text = await realReadFile(file, ...rest)
        readParked()
        await readGate
        return text
      }
      return realReadFile(file, ...rest)
    }
    try {
      const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
      const scanning = pool.scan()
      await parked
      fs.writeFileSync(tombstoneFile, JSON.stringify({ version: 1, entries: { [id]: later } }, null, 2))
      releaseRead()
      await scanning
    } finally {
      releaseRead()
      fsp.readFile = realReadFile
    }
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(entries[id]?.deletedAtMs, later.deletedAtMs,
      'the newer delete must survive the older record being released')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A delete made from a stale roster must not replace the tombstone a newer
 * delete left for the same account. The record naming the newer sign-in is the
 * one that still has to hold, or the newer snapshot comes back as a re-login.
 */
test('a stale delete cannot overwrite a newer sign-in tombstone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-stale-delete-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const uin = '90000009981'
  const olderIssued = Date.now() - 60 * 60 * 1000
  const newerIssued = Date.now() - 10 * 60 * 1000
  const digest = (token) => createHash('sha256')
    .update('workbuddy\0deleted\0' + token).digest('hex').slice(0, 32)
  const signIn = (token, issued) => ({
    region: 'cn', accessToken: token, refreshToken: `rt-${token}`,
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'StaleDelete', lastRefreshAtMs: issued,
  })
  try {
    await writeOwnSignIn(signins, signIn('at-stale-old', olderIssued))
    const stalePool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const staleRoster = await stalePool.scan()
    assert.equal(staleRoster.length, 1)

    await writeOwnSignIn(signins, signIn('at-current', newerIssued))
    const currentPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const currentRoster = await currentPool.scan()
    const current = currentRoster.find(account => account.credential.uin === uin)
    assert.ok(current !== undefined)
    assert.equal(await currentPool.removeOwnSignIn(current.id), true)

    // The older pool still holds the previous sign-in and deletes it now.
    assert.equal(await stalePool.removeOwnSignIn(staleRoster[0].id), true)
    const afterDelete = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(afterDelete[current.id]?.tokenDigest, digest('at-current'),
      'the newer delete must not be replaced by the stale one')

    // The snapshot of the newer sign-in is written again; the newer delete holds.
    await writeOwnSignIn(signins, signIn('at-current', newerIssued))
    assert.equal((await stalePool.scan()).length, 0,
      'the newer sign-in must not return as a re-login')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A delete from another pool can land after this walk read the tombstones.
 * The roster and adoption step must re-check the latest set before committing,
 * or the scan serves a sign-in the other pool already removed.
 */
test('a delete committed during a scan is not served by that scan', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-inflight-delete-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const uin = '90000009982'
  const olderIssued = Date.now() - 60 * 60 * 1000
  const currentIssued = Date.now() - 10 * 60 * 1000
  const digest = (token) => createHash('sha256')
    .update('workbuddy\0deleted\0' + token).digest('hex').slice(0, 32)
  const signIn = {
    region: 'cn', accessToken: 'at-inflight', refreshToken: 'rt-inflight',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'Inflight', lastRefreshAtMs: currentIssued,
  }
  try {
    await writeOwnSignIn(signins, signIn)
    const deletingPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const deletingRoster = await deletingPool.scan()
    const doomed = deletingRoster.find(account => account.credential.uin === uin)
    assert.ok(doomed !== undefined)

    const id = workbuddyAccountId(doomed.credential)
    fs.writeFileSync(tombstoneFile, JSON.stringify({
      version: 1,
      entries: {
        [id]: {
          tokenDigest: digest('at-inflight-older'),
          lastRefreshAtMs: olderIssued,
          deletedAtMs: Date.now() - 30 * 60 * 1000,
        },
      },
    }, null, 2))

    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    let parkRead = true
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (parkRead && path.resolve(String(file)) === path.resolve(tombstoneFile)) {
        parkRead = false
        const text = await realReadFile(file, ...rest)
        readParked()
        await readGate
        return text
      }
      return realReadFile(file, ...rest)
    }
    try {
      const scanningPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
      const scanning = scanningPool.scan()
      await parked
      assert.equal(await deletingPool.removeOwnSignIn(doomed.id), true)
      releaseRead()
      await scanning
      assert.equal(scanningPool.list().length, 0,
        'the in-flight scan must not commit the sign-in deleted while it was reading')
    } finally {
      releaseRead()
      fsp.readFile = realReadFile
    }
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * Two deletes of one account can commit in the same millisecond. A rollback is
 * allowed to drop only its own record; field equality cannot tell the two
 * writes apart, so the record carries an identity of its own.
 */
test('concurrent deletes in one millisecond keep the successful tombstone', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-equal-ms-'))
  const signins = path.join(dataDir, 'signins')
  const tombstoneFile = path.join(dataDir, 'deleted-signins.json')
  const uin = '90000009983'
  const signIn = {
    region: 'cn', accessToken: 'at-equal-ms', refreshToken: 'rt-equal-ms',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'EqualMs', lastRefreshAtMs: Date.now() - DAY,
  }
  try {
    await writeOwnSignIn(signins, signIn)
    const pool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const [account] = await pool.scan()
    assert.ok(account !== undefined)
    const signInFile = account.credential.sourcePath
    const fsp = require('node:fs/promises')
    const realUnlink = fsp.unlink
    const realNow = Date.now
    const fixed = realNow()
    let denyNext = true
    Date.now = () => fixed
    fsp.unlink = async (file, ...rest) => {
      if (denyNext && path.resolve(String(file)) === path.resolve(signInFile)) {
        denyNext = false
        const denied = new Error('fixture first unlink denied')
        denied.code = 'EACCES'
        throw denied
      }
      return realUnlink(file, ...rest)
    }
    let results
    try {
      results = await Promise.allSettled([
        pool.removeOwnSignIn(account.id),
        pool.removeOwnSignIn(account.id),
      ])
    } finally {
      Date.now = realNow
      fsp.unlink = realUnlink
    }
    const fulfilled = results.filter((result) => result.status === 'fulfilled' && result.value === true)
    const rejected = results.filter((result) => result.status === 'rejected')
    assert.equal(rejected.length, 1, 'one delete fails on the unlink')
    assert.equal(fulfilled.length, 1, 'the other delete succeeds')
    const entries = JSON.parse(fs.readFileSync(tombstoneFile, 'utf8')).entries ?? {}
    assert.equal(Object.hasOwn(entries, account.id), true,
      'the successful delete must keep its tombstone')
    await writeOwnSignIn(signins, signIn)
    assert.equal((await pool.scan()).length, 0, 'the deleted sign-in must not come back')
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * The archive phase runs after the scan's tombstone re-read and can take long
 * enough for another pool to delete the account. The final check before the
 * roster commit is what keeps this scan from serving it.
 */
test('a delete during the archive phase is not served by that scan', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-late-delete-'))
  const signins = path.join(dataDir, 'signins')
  const archive = path.join(dataDir, 'credentials-archive.json')
  const uin = '90000009984'
  const signIn = {
    region: 'cn', accessToken: 'at-late', refreshToken: 'rt-late',
    expiresAtMs: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
    uid: '', uin, enterpriseId: '', nickname: 'Late', lastRefreshAtMs: Date.now() - DAY,
  }
  try {
    await writeOwnSignIn(signins, signIn)
    const deletingPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const deletingRoster = await deletingPool.scan()
    const doomed = deletingRoster.find(account => account.credential.uin === uin)
    assert.ok(doomed !== undefined)
    assert.equal(fs.existsSync(archive), true, 'the first scan writes the archive')

    const scanningPool = new WorkBuddyAccountPool({ authDirs: [signins], dataPath: () => dataDir, cooldownMs: 60000 })
    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    let parkRead = true
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (parkRead && path.resolve(String(file)) === path.resolve(archive)) {
        parkRead = false
        const text = await realReadFile(file, ...rest)
        readParked()
        await readGate
        return text
      }
      return realReadFile(file, ...rest)
    }
    try {
      const scanning = scanningPool.scan()
      await parked
      const deleting = deletingPool.removeOwnSignIn(doomed.id)
      // The delete's tombstone and unlink run before its archive purge, which
      // waits for the lock this scan holds. Wait for the file to go, then let
      // the scan continue into the final check.
      const signInFile = doomed.credential.sourcePath
      const deadline = Date.now() + 10_000
      while (fs.existsSync(signInFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(fs.existsSync(signInFile), false, 'the delete commits while the scan is in its archive phase')
      releaseRead()
      await scanning
      await deleting
      assert.equal(scanningPool.list().length, 0,
        'a delete committed during the archive phase must not be served')
    } finally {
      releaseRead()
      fsp.readFile = realReadFile
    }
  } finally {
    await cleanup(dataDir)
  }
})

/**
 * A snapshot deleted while the scan is in its archive phase must not be copied
 * into the plugin's directory afterwards. The delete's unlink reaches its own
 * copy, never the one this scan is about to write.
 */
test('a snapshot deleted during the archive phase is not adopted', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-adopt-adopt-late-'))
  const desktop = path.join(dataDir, 'desktop')
  const signins = path.join(dataDir, 'signins')
  const archive = path.join(dataDir, 'credentials-archive.json')
  const uin = '90000009985'
  fs.mkdirSync(desktop, { recursive: true })
  const snapshot = path.join(desktop, 'workbuddy-desktop-other.info')
  fs.writeFileSync(snapshot, JSON.stringify({
    auth: {
      accessToken: 'at-adopt-late', refreshToken: 'rt-adopt-late',
      expiresAt: Date.now() + 9 * DAY, domain: 'www.codebuddy.cn',
      lastRefreshTime: Date.now() - DAY,
    },
    account: { uin, nickname: 'AdoptLate' },
  }, null, 2))
  try {
    const deletingPool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir, cooldownMs: 60000 })
    const deletingRoster = await deletingPool.scan()
    const doomed = deletingRoster.find(account => account.credential.uin === uin)
    assert.ok(doomed !== undefined)
    assert.equal(fs.readdirSync(signins).length, 1, 'the first scan took the snapshot over')
    assert.equal(fs.existsSync(archive), true)

    const scanningPool = new WorkBuddyAccountPool({ authDirs: [desktop], dataPath: () => dataDir, cooldownMs: 60000 })
    const fsp = require('node:fs/promises')
    const realReadFile = fsp.readFile
    let parkRead = true
    let releaseRead
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    let readParked
    const parked = new Promise((resolve) => { readParked = resolve })
    fsp.readFile = async (file, ...rest) => {
      if (parkRead && path.resolve(String(file)) === path.resolve(archive)) {
        parkRead = false
        const text = await realReadFile(file, ...rest)
        readParked()
        await readGate
        return text
      }
      return realReadFile(file, ...rest)
    }
    try {
      const scanning = scanningPool.scan()
      await parked
      const deleting = deletingPool.removeOwnSignIn(doomed.id)
      const ownCopy = doomed.credential.sourcePath
      const deadline = Date.now() + 10_000
      while (fs.existsSync(ownCopy) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(fs.existsSync(ownCopy), false, 'the delete commits while the scan is in its archive phase')
      releaseRead()
      await scanning
      await deleting
      assert.equal(scanningPool.list().length, 0,
        'a snapshot deleted during the archive phase must not be served')
      assert.equal(fs.existsSync(signins) ? fs.readdirSync(signins).length : 0, 0,
        'and must not be copied into the plugin directory')
    } finally {
      releaseRead()
      fsp.readFile = realReadFile
    }
  } finally {
    await cleanup(dataDir)
  }
})

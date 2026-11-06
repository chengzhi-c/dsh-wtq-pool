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
const { root, transpile } = require('./ts-loader.cjs')

const { WorkBuddyAccountPool, ownSignInDir, parseWorkBuddyAuth, writeOwnSignIn } = require('../src/accounts.ts')

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

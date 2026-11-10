const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

require('./ts-loader.cjs')

const { withFileLock } = require('../src/file-lock.ts')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('two contenders cannot both replace the same stale lock', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-recovery-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)

  const originalRead = fsp.readFile
  const originalUnlink = fsp.unlink
  const originalRename = fsp.rename
  let staleReads = 0
  let releaseReads
  const readsReady = new Promise((resolve) => { releaseReads = resolve })
  let recoveryUnlinks = 0
  let firstWorkStarted
  const workStarted = new Promise((resolve) => { firstWorkStarted = resolve })
  let releaseWork
  const workGate = new Promise((resolve) => { releaseWork = resolve })
  let active = 0
  let maxActive = 0
  let reclaimRenameFailures = process.platform === 'win32' ? 2 : 0

  fsp.readFile = async (file, ...rest) => {
    const text = await originalRead(file, ...rest)
    if (path.resolve(String(file)) === path.resolve(lock) && staleReads < 2) {
      staleReads += 1
      if (staleReads === 2) releaseReads()
      await readsReady
    }
    return text
  }
  fsp.unlink = async (file) => {
    if (path.resolve(String(file)) === path.resolve(lock) && recoveryUnlinks < 2) {
      const call = recoveryUnlinks
      recoveryUnlinks += 1
      if (call === 1) await workStarted
    }
    return originalUnlink(file)
  }
  fsp.rename = async (from, to, ...rest) => {
    if (reclaimRenameFailures > 0 && String(to).includes('.reclaim.')) {
      reclaimRenameFailures -= 1
      const busy = new Error('fixture target is temporarily open')
      busy.code = 'EPERM'
      throw busy
    }
    return originalRename(from, to, ...rest)
  }

  const work = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    firstWorkStarted()
    await workGate
    active -= 1
  }

  try {
    const first = withFileLock(lock, work)
    const second = withFileLock(lock, work)
    await workStarted
    await delay(100)
    releaseWork()
    await Promise.all([first, second])
    assert.equal(maxActive, 1, 'a contender must not remove the live lock created by its peer')
    assert.equal(reclaimRenameFailures, 0, 'the recovery marker used its bounded rename retries')
  } finally {
    releaseWork()
    fsp.readFile = originalRead
    fsp.unlink = originalUnlink
    fsp.rename = originalRename
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a recycled owner PID is recovered across past or future lock mtimes', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-pid-reuse-'))
  const lock = path.join(directory, 'document.lock')
  try {
    for (const offsetMs of [-120_000, 120_000]) {
      fs.writeFileSync(lock, JSON.stringify({
        pid: process.pid,
        token: 'old-owner',
        createdAtMs: Date.now(),
        processStartedAtMs: Date.now() - 120_000,
      }))
      const stamp = new Date(Date.now() + offsetMs)
      fs.utimesSync(lock, stamp, stamp)
      let ran = false
      await withFileLock(lock, async () => { ran = true })
      assert.equal(ran, true, `a lock dated ${offsetMs}ms must be reclaimable when its PID was reused`)
    }
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.reclaim.')), false,
      'a completed recovery must not leave its claim behind')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a recycled PID in another process does not keep an old lock alive', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-external-pid-reuse-'))
  const lock = path.join(directory, 'document.lock')
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  assert.equal(typeof owner.pid, 'number')
  fs.writeFileSync(lock, JSON.stringify({
    pid: owner.pid,
    token: 'old-external-owner',
    createdAtMs: Date.now() - 120_000,
    processStartedAtMs: Date.now() - 120_000,
  }))
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  try {
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'an old lock must be reclaimable when another live process inherited its PID')
  } finally {
    owner.kill()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a contender honors a live unique reclaim claim', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-reclaim-fence-'))
  const lock = path.join(directory, 'document.lock')
  const claim = `${lock}.reclaim.000000000001`
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  fs.writeFileSync(claim, JSON.stringify({
    pid: process.pid,
    token: 'live-claim',
    createdAtMs: Date.now(),
  }))
  let started = false
  try {
    const acquiring = withFileLock(lock, async () => { started = true })
    await delay(100)
    assert.equal(started, false, 'the lock must stay fenced while another claimant owns recovery')
    fs.unlinkSync(claim)
    await acquiring
    assert.equal(started, true)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a live owner is not aged out and its timeout does not expose the path', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-live-age-'))
  const lock = path.join(directory, 'document.lock')
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid,
    token: 'live-owner',
    createdAtMs: clock - 120_000,
    processStartedAtMs: Date.now() - process.uptime() * 1_000,
  }))
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  try {
    let ran = false
    let timeout
    await assert.rejects(withFileLock(lock, async () => { ran = true }), (error) => {
      timeout = error
      return true
    })
    assert.equal(ran, false, 'a live owner must keep its lock')
    assert.equal(fs.existsSync(lock), true)
    assert.equal(timeout.message, 'timed out waiting for the credential document lock')
    assert.equal(timeout.message.includes(directory), false)
  } finally {
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a stale damaged reclaim claim does not block the next generation', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-damaged-claim-'))
  const lock = path.join(directory, 'document.lock')
  const claim = `${lock}.reclaim.000000000001`
  fs.writeFileSync(lock, '')
  fs.writeFileSync(claim, '{damaged')
  const staleTemp = `${claim}.00000000-0000-4000-8000-000000000000.tmp`
  fs.writeFileSync(staleTemp, '{"auth":{"accessToken":"stale"}}')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  fs.utimesSync(claim, old, old)
  try {
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true)
    assert.equal(fs.existsSync(staleTemp), false, 'a dead generation takes its temporary file with it')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a completion failure releases its own reclaim claim', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-completion-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  const realRename = fsp.rename
  const realUnlink = fsp.unlink
  let completionFailed = false
  let claimUnlinkFailed = false
  fsp.rename = async (from, to) => {
    if (!completionFailed && String(to).includes('.reclaim.')) {
      completionFailed = true
      const busy = new Error('fixture completion failed')
      busy.code = 'EACCES'
      throw busy
    }
    return realRename(from, to)
  }
  fsp.unlink = async (file, ...rest) => {
    if (!claimUnlinkFailed && /\.reclaim\.\d{12}$/.test(String(file))) {
      claimUnlinkFailed = true
      const busy = new Error('fixture claim cleanup failed once')
      busy.code = 'EBUSY'
      throw busy
    }
    return realUnlink(file, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => {}), { code: 'EACCES' })
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.reclaim.')), false,
      'the failed claimant must leave no live recovery file')
    fs.writeFileSync(lock, '')
    fs.utimesSync(lock, old, old)
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'the next stale recovery must still run')
  } finally {
    fsp.rename = realRename
    fsp.unlink = realUnlink
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an abandoned reclaim is recovered once its claim can be removed', async () => {
  const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-abandoned-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  const realRename = fsp.rename
  const realUnlink = fsp.unlink
  const realWriteFile = fsp.writeFile
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  const modulePath = require.resolve('../src/file-lock.ts')
  let clock = realNow()
  let completionFailed = false
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.rename = async (from, to) => {
    if (!completionFailed && String(to).includes('.reclaim.')) {
      completionFailed = true
      const busy = new Error('fixture completion failed')
      busy.code = 'EACCES'
      throw busy
    }
    return realRename(from, to)
  }
  fsp.writeFile = async (file, data, ...rest) => {
    if (completionFailed && /\.reclaim\.000000000001$/.test(String(file))) {
      const busy = new Error('fixture claim mark failed')
      busy.code = 'EBUSY'
      throw busy
    }
    return realWriteFile(file, data, ...rest)
  }
  fsp.unlink = async (file, ...rest) => {
    if (String(file).includes('.reclaim.')) {
      const busy = new Error('fixture claim cleanup failed')
      busy.code = 'EBUSY'
      throw busy
    }
    return realUnlink(file, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => {}), { code: 'EACCES' })
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.abandoned.')), true,
      'a sidecar must carry the abandoned state across module instances')

    fsp.rename = realRename
    fsp.writeFile = realWriteFile
    fsp.unlink = realUnlink
    fs.writeFileSync(lock, '')
    fs.utimesSync(lock, old, old)
    delete require.cache[modulePath]
    const secondInstance = require(modulePath)
    let ran = false
    await secondInstance.withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'an abandoned generation must not block the next recovery')
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.reclaim.')), false,
      'the recovery must remove the abandoned terminal files')
  } finally {
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fsp.rename = realRename
    fsp.unlink = realUnlink
    fsp.writeFile = realWriteFile
    delete require.cache[modulePath]
    require(modulePath)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * An abandoned record is keyed by path, not by the lock that was there when it
 * was written. Another process may have reclaimed the path since and created a
 * live lock; with the file unreadable there is no token to prove otherwise, so
 * deleting it would let both processes into the critical section.
 */
test('an abandoned record does not claim an unreadable lock under another owner', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-abandoned-other-'))
  const lock = path.join(directory, 'document.lock')
  const realReadFile = fsp.readFile
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const busy = new Error('fixture scanner holds the lock without sharing reads')
      busy.code = 'EBUSY'
      throw busy
    }
    return realReadFile(file, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => {}), /lock was not released/)
    // The path now holds someone else's live lock. The in-process record still
    // names the path, but cannot name this owner.
    fs.writeFileSync(lock, JSON.stringify({
      pid: process.pid,
      token: 'someone-else',
      createdAtMs: clock,
      processStartedAtMs: clock - 1_000,
    }))
    await assert.rejects(withFileLock(lock, async () => {}), /timed out waiting/)
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'))
    assert.equal(owner.token, 'someone-else', 'an unreadable lock must survive a path-only abandonment record')
  } finally {
    fsp.readFile = realReadFile
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * An unreadable claim is still someone's claim. Treating two missing tokens as
 * a match made a live claim deletable whenever a scanner blocked the read.
 */
test('an unreadable live claim is not treated as abandoned', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-claim-unreadable-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, '')
  const old = new Date(Date.now() - 120_000)
  fs.utimesSync(lock, old, old)
  const claim = `${lock}.reclaim.000000000001`
  fs.writeFileSync(claim, JSON.stringify({
    pid: process.pid,
    token: 'live-claim',
    createdAtMs: Date.now(),
    processStartedAtMs: Date.now() - process.uptime() * 1_000,
  }))
  const realReadFile = fsp.readFile
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(claim)) {
      const busy = new Error('fixture claim cannot be read')
      busy.code = 'EBUSY'
      throw busy
    }
    return realReadFile(file, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => {}), /timed out waiting/)
    assert.equal(fs.existsSync(claim), true, 'a live claim must survive an unreadable scan')
  } finally {
    fsp.readFile = realReadFile
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A terminal claim whose file cannot be deleted used to leave room for the
 * next generation on every retry: a temporary denial turned into a directory
 * growing by one claim per 25 ms for the whole wait.
 */
test('a terminal claim that cannot be removed stops new generations', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-claim-denied-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid, token: 'fixture-abandoned', createdAtMs: Date.now(), state: 'abandoned',
  }))
  const realUnlink = fsp.unlink
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  let clock = realNow()
  let deleteDenied = true
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.unlink = async (file, ...rest) => {
    const name = String(file)
    if (deleteDenied && (path.resolve(name) === path.resolve(lock) || name.includes('.reclaim.'))) {
      const held = new Error('fixture delete denied')
      held.code = 'EPERM'
      throw held
    }
    return realUnlink(file, ...rest)
  }
  const claims = () => fs.readdirSync(directory).filter((name) => name.includes('.reclaim.')).length
  try {
    await assert.rejects(withFileLock(lock, async () => {}), /timed out waiting/)
    const afterFirst = claims()
    assert.ok(afterFirst <= 1, `one failed reclaim must leave at most one generation, found ${afterFirst}`)
    await assert.rejects(withFileLock(lock, async () => {}), /timed out waiting/)
    assert.equal(claims(), afterFirst, 'a generation that cannot be removed must not be joined by another')

    deleteDenied = false
    const old = new Date(Date.now() - 120_000)
    fs.utimesSync(lock, old, old)
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'the path must recover once the deletion is allowed again')
    assert.equal(claims(), 0, 'the recovery must remove the terminal generation')
  } finally {
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fsp.unlink = realUnlink
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('main lock release retries a transient failure and reports an exhausted release', async (t) => {
  await t.test('retry', async () => {
    const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-release-retry-'))
    const lock = path.join(directory, 'document.lock')
    const realUnlink = fsp.unlink
    let failed = false
    fsp.unlink = async (file, ...rest) => {
      if (!failed && path.resolve(String(file)) === path.resolve(lock)) {
        failed = true
        const busy = new Error('fixture unlink busy')
        busy.code = 'EBUSY'
        throw busy
      }
      return realUnlink(file, ...rest)
    }
    try {
      await withFileLock(lock, async () => {})
      assert.equal(fs.existsSync(lock), false)
    } finally {
      fsp.unlink = realUnlink
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  await t.test('exhausted', async () => {
    const directory = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'wtq-lock-release-failed-'))
    const lock = path.join(directory, 'document.lock')
    const realUnlink = fsp.unlink
    const realSetTimeout = global.setTimeout
    const realNow = Date.now
    let clock = realNow()
    Date.now = () => clock
    global.setTimeout = (callback, _delay, ...args) => {
      clock += 6_000
      return realSetTimeout(callback, 0, ...args)
    }
    fsp.unlink = async (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(lock)) {
        const busy = new Error('fixture unlink busy')
        busy.code = 'EBUSY'
        throw busy
      }
      return realUnlink(file, ...rest)
    }
    try {
      await assert.rejects(withFileLock(lock, async () => {}), /lock was not released/)
      assert.equal(fs.existsSync(lock), true)
    } finally {
      global.setTimeout = realSetTimeout
      Date.now = realNow
      fsp.unlink = realUnlink
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})

/**
 * A release that cannot delete its file must not lock this process out of it.
 *
 * The record left behind names this live pid and its own start time, so every
 * later acquire read it as a held lock and timed out for the rest of the
 * process's life - no credential archive or tombstone write could land again.
 * Marking the record abandoned is what lets the stale path reclaim it.
 */
test('a release that cannot delete the lock leaves it recoverable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-selfrelease-'))
  const lock = path.join(directory, 'document.lock')
  const realUnlink = fsp.unlink
  let failedOnce = false
  fsp.unlink = async (file, ...rest) => {
    if (!failedOnce && path.resolve(String(file)) === path.resolve(lock)) {
      failedOnce = true
      const busy = new Error('fixture keeps the lock open')
      busy.code = 'EBUSY'
      throw busy
    }
    return realUnlink(file, ...rest)
  }
  try {
    // Whether the first call reports the failed release or recovers within its
    // own retry budget is not the point; being locked out afterwards is.
    await withFileLock(lock, async () => {}).catch(() => {})
    const started = Date.now()
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'a lock this process could not release must be reclaimable by it')
    assert.equal(Date.now() - started < 3000, true, 'and without waiting for the full lock budget')
  } finally {
    fsp.unlink = realUnlink
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * A failed release must not hide what the work itself reported.
 *
 * The two failures have different owners - one is the disk, the other is the
 * document - and the caller logs whichever message it is given. Naming the lock
 * sent the reader after the wrong cause.
 */
test('a work failure survives a failed release', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-cause-'))
  const lock = path.join(directory, 'document.lock')
  const realUnlink = fsp.unlink
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  const workError = new Error('THE REAL WORK ERROR')
  fsp.unlink = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const busy = new Error('fixture unlink busy')
      busy.code = 'EBUSY'
      throw busy
    }
    return realUnlink(file, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => { throw workError }), (error) => {
      assert.equal(error.cause, workError, 'the real cause must ride along')
      assert.match(error.message, /lock was not released/)
      return true
    })
  } finally {
    fsp.unlink = realUnlink
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * The work's error code survives a failed release. An already-gone file must
 * still read as gone: the delete path treats a missing sign-in as success, and
 * a wrapper without the code made it roll the tombstone back instead.
 */
test('a work error keeps its code when the release also fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-cause-code-'))
  const lock = path.join(directory, 'document.lock')
  const realUnlink = fsp.unlink
  const realSetTimeout = global.setTimeout
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.unlink = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const busy = new Error('fixture unlink busy')
      busy.code = 'EBUSY'
      throw busy
    }
    return realUnlink(file, ...rest)
  }
  const missing = new Error('fixture sign-in is already gone')
  missing.code = 'ENOENT'
  try {
    await assert.rejects(withFileLock(lock, async () => { throw missing }), (error) => {
      assert.equal(error.code, 'ENOENT')
      assert.equal(error.cause, missing)
      assert.match(error.message, /lock was not released/)
      return true
    })
  } finally {
    fsp.unlink = realUnlink
    global.setTimeout = realSetTimeout
    Date.now = realNow
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a transient Windows lock denial is retried', { skip: process.platform !== 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-eperm-once-'))
  const lock = path.join(directory, 'document.lock')
  const realWriteFile = fsp.writeFile
  let denials = 1
  fsp.writeFile = async (file, data, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock) && denials > 0) {
      denials -= 1
      const pending = new Error('fixture lock file is delete-pending')
      pending.code = 'EPERM'
      throw pending
    }
    return realWriteFile(file, data, ...rest)
  }
  try {
    let ran = false
    await withFileLock(lock, async () => { ran = true })
    assert.equal(ran, true, 'the retry after the delete finished must acquire the lock')
    assert.equal(denials, 0)
  } finally {
    fsp.writeFile = realWriteFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a permanent Windows lock denial times out instead of spinning', { skip: process.platform !== 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-eperm-always-'))
  const lock = path.join(directory, 'document.lock')
  const realWriteFile = fsp.writeFile
  const realNow = Date.now
  const realSetTimeout = global.setTimeout
  let clock = realNow()
  let attempts = 0
  Date.now = () => clock
  global.setTimeout = (callback, _delay, ...args) => {
    clock += 6_000
    return realSetTimeout(callback, 0, ...args)
  }
  fsp.writeFile = async (file, data, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      attempts += 1
      if (attempts > 20) {
        const guard = new Error('fixture acquisition loop did not yield')
        guard.code = 'EIO'
        throw guard
      }
      const denied = new Error('fixture lock directory is not writable')
      denied.code = 'EPERM'
      throw denied
    }
    return realWriteFile(file, data, ...rest)
  }
  try {
    await assert.rejects(withFileLock(lock, async () => {}),
      /timed out waiting for the credential document lock/)
    assert.ok(attempts > 0 && attempts < 10,
      'the acquisition loop must yield to the timer, not spin on the missing lock file')
  } finally {
    Date.now = realNow
    global.setTimeout = realSetTimeout
    fsp.writeFile = realWriteFile
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an abandoned lock that cannot be unlinked times out instead of spinning', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-abandoned-unlink-'))
  const lock = path.join(directory, 'document.lock')
  fs.writeFileSync(lock, JSON.stringify({
    pid: process.pid, token: 'fixture-abandoned', createdAtMs: Date.now(), state: 'abandoned',
  }))
  const realUnlink = fsp.unlink
  fsp.unlink = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const held = new Error('fixture lock cannot be removed')
      held.code = 'EPERM'
      throw held
    }
    return realUnlink(file, ...rest)
  }
  try {
    const startedAt = Date.now()
    await assert.rejects(withFileLock(lock, async () => {}),
      /timed out waiting for the credential document lock/)
    assert.ok(Date.now() - startedAt < 8_000, 'the acquisition must end at the deadline')
    const claims = fs.readdirSync(directory).filter((name) => name.includes('.reclaim.')).length
    assert.ok(claims <= 5, `a failed stale reclaim must not accumulate files, found ${claims}`)
  } finally {
    fsp.unlink = realUnlink
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
test('a release blocked by the lock leaves a marker the next acquisition can recover', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-lock-release-read-'))
  const lock = path.join(directory, 'document.lock')
  const realReadFile = fsp.readFile
  fsp.readFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === path.resolve(lock)) {
      const busy = new Error('fixture reader cannot open the lock')
      busy.code = 'EBUSY'
      throw busy
    }
    return realReadFile(file, ...rest)
  }
  try {
    let firstRan = false
    await assert.rejects(withFileLock(lock, async () => { firstRan = true }),
      /lock was not released/)
    assert.equal(firstRan, true, 'the work ran before the release failed')
    assert.ok(fs.readdirSync(directory).some((name) => name.startsWith('document.lock.abandoned.')),
      'a release that cannot rewrite the lock must leave a marker')
  } finally {
    fsp.readFile = realReadFile
  }
  try {
    let secondRan = false
    await withFileLock(lock, async () => { secondRan = true })
    assert.equal(secondRan, true, 'the marker must let the next acquisition recover')
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('document.lock.abandoned.')), false,
      'a successful acquisition removes the marker')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { trustedSystemRootOf, trustedWindowsChildEnv, trustedWindowsPowerShell } from './trusted-process'

const FILE_LOCK_WAIT_MS = 5_000
const UNOWNED_FILE_LOCK_STALE_MS = 60_000
const RETRY_MS = 25
const PROCESS_STARTED_AT_MS = Date.now() - Math.floor(process.uptime() * 1000)
const PROCESS_START_TOLERANCE_MS = 2_000
const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

interface LockRecord {
  pid?: unknown
  token?: unknown
  createdAtMs?: unknown
  processStartedAtMs?: unknown
  state?: unknown
}

interface ReclaimClaim {
  file: string
  token: string
  generation: number
}

type FileRelease = 'released' | 'missing' | 'replaced' | 'failed'

/**
 * The work committed, but the lock file could not be removed.
 *
 * Callers that treat an acquisition failure as a reason to roll their own
 * change back must not do that here: the change is already on disk, and only
 * the bookkeeping file is left behind.
 */
export class FileLockReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileLockReleaseError'
  }
}
const ABANDONED_RECLAIMS = new Map<string, string>()
/**
 * Locks this process failed to release, by resolved path.
 *
 * A holder that shares only reads blocks the write that would mark the lock
 * abandoned as well as the unlink. A sidecar records the same fact for other
 * processes; this map is the fallback when even creating a new file is denied.
 */
const ABANDONED_LOCKS = new Map<string, string>()

function abandonedMarker(file: string, token: string): string {
  return `${file}.abandoned.${token}`
}

async function markAbandoned(file: string, token: string): Promise<void> {
  ABANDONED_LOCKS.set(resolve(file), token)
  try {
    await writeFile(abandonedMarker(file, token), JSON.stringify({
      token,
      createdAtMs: Date.now(),
    }), { flag: 'wx', mode: 0o600 })
  } catch { /* the in-process record still keeps this process out of its own lock */ }
}

async function hasAbandonedMarker(file: string, token: string): Promise<boolean> {
  try {
    await stat(abandonedMarker(file, token))
    return true
  } catch {
    return false
  }
}

async function cleanupAbandonedMarkers(file: string): Promise<void> {
  const directory = dirname(file)
  const prefix = `${basename(file)}.abandoned.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    await unlink(join(directory, name)).catch(() => {})
  }
  ABANDONED_LOCKS.delete(resolve(file))
}

/**
 * Commit a complete temporary file over its target.
 *
 * Windows can report EPERM or EBUSY while another reader is between opening
 * and closing the target. Retrying preserves the atomic rename and avoids
 * falling back to a partial in-place write.
 */
export async function replaceFile(temporary: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, file)
      return
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32'
        || (code !== 'EPERM' && code !== 'EBUSY')
        || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]))
    }
  }
}

function processIsAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return undefined
  }
}

function processOutput(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 1_024, windowsHide: true, env, cwd }, (error, stdout) => {
      if (error !== null) resolve(undefined)
      else resolve(stdout.trim())
    })
  })
}

async function processStartedAt(pid: number, timeoutMs = 2_000): Promise<number | undefined> {
  if (pid === process.pid) return PROCESS_STARTED_AT_MS
  if (process.platform === 'win32') {
    const systemRoot = trustedSystemRootOf(process.env)
    const powershell = trustedWindowsPowerShell(process.env)
    if (systemRoot === undefined || powershell === undefined) return undefined
    const output = await processOutput(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules'); $d=(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime(); ([DateTimeOffset]$d).ToUnixTimeMilliseconds()`,
    ], trustedWindowsChildEnv(process.env, { inheritTemp: true, includeSystemDrive: true }), join(systemRoot, 'System32'), timeoutMs)
    const match = output?.match(/\d{10,}/)
    return match === undefined || match === null ? undefined : Number(match[0])
  }
  const ps = ['/usr/bin/ps', '/bin/ps'].find(existsSync)
  if (ps === undefined) return undefined
  const output = await processOutput(ps, ['-p', String(pid), '-o', 'lstart='], {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    TZ: 'UTC',
  }, '/', timeoutMs)
  const started = output === undefined ? Number.NaN : Date.parse(`${output.trim()} UTC`)
  return Number.isFinite(started) ? started : undefined
}

type LockState = 'missing' | 'current' | 'stale'
type ProbeStartedAt = (pid: number, timeoutMs: number) => Promise<number | undefined>

async function lockState(file: string, probeTimeoutMs = 2_000, probe: ProbeStartedAt = processStartedAt): Promise<LockState> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    // A scanner or backup tool holding the file with no sharing is not an
    // answer about the lock. Throwing here failed the whole acquisition in 2 ms
    // while the caller's own wait loop was still running; "current" lets that
    // loop retry, which is the same treatment `releaseOwnedFile` gives it.
    // An abandoned record is keyed by path, and another process may have
    // reclaimed the path and created its own live lock since. Without a read
    // there is no token to compare, so the record cannot justify deleting it;
    // the record still recovers the lock once the read succeeds.
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'current'
    throw error
  }
  let owner: LockRecord | undefined
  try { owner = JSON.parse(text) as LockRecord } catch { /* legacy empty lock */ }
  // A release that could not unlink its own file rewrites the record as
  // abandoned. Without this, the pid inside it is this live process and the
  // lock read as held for the rest of the process's life.
  if (owner?.state === 'abandoned') return 'stale'
  if (typeof owner?.token === 'string') {
    if (ABANDONED_LOCKS.get(resolve(file)) === owner.token) return 'stale'
    if (await hasAbandonedMarker(file, owner.token)) return 'stale'
  }
  const fileAge = await stat(file).then(entry => Date.now() - entry.mtimeMs, (): number => 0)
  const ownerAlive = typeof owner?.pid === 'number' ? processIsAlive(owner.pid) : undefined
  if (ownerAlive === false) return 'stale'
  // PID liveness alone cannot distinguish a paused owner from a reused PID.
  // Compare the live process start with the start evidence in the lock.
  if (ownerAlive === true && typeof owner?.pid === 'number') {
    const recordedStart = typeof owner.processStartedAtMs === 'number'
      ? owner.processStartedAtMs
      : typeof owner.createdAtMs === 'number' ? owner.createdAtMs : undefined
    // A backward clock step leaves the lock mtime in the future. Such a lock
    // must still get the PID-reuse check rather than staying current until the
    // wall clock catches up.
    if (recordedStart !== undefined && Math.abs(fileAge) > PROCESS_START_TOLERANCE_MS) {
      const actualStart = await probe(owner.pid, probeTimeoutMs)
      if (actualStart !== undefined && actualStart - recordedStart > PROCESS_START_TOLERANCE_MS) return 'stale'
    }
    // A record with no start evidence cannot ever be told apart from a reused
    // PID, and a live-but-unrelated pid (a kernel pid, a recycled one) then
    // claimed the lock for good. Age is the only signal left, and it is the
    // same one the unowned branch below already trusts.
    if (recordedStart === undefined) return fileAge > UNOWNED_FILE_LOCK_STALE_MS ? 'stale' : 'current'
    return 'current'
  }
  return fileAge > UNOWNED_FILE_LOCK_STALE_MS ? 'stale' : 'current'
}

async function createOwnedFile(file: string): Promise<string | undefined> {
  const token = randomUUID()
  try {
    await writeFile(file, JSON.stringify({
      pid: process.pid,
      token,
      createdAtMs: Date.now(),
      processStartedAtMs: PROCESS_STARTED_AT_MS,
    }), { flag: 'wx', mode: 0o600 })
    return token
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return undefined
    // Windows reports a lock file that another writer is deleting as EPERM or
    // EACCES, not EEXIST. That is contention, not a failed write: wait for the
    // delete to finish instead of dropping the archive update for this pass.
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return undefined
    throw error
  }
}

async function releaseOwnedFile(file: string, token: string): Promise<FileRelease> {
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  while (true) {
    let owner: LockRecord | undefined
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      owner = typeof parsed === 'object' && parsed !== null ? parsed as LockRecord : {}
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
      // The holder blocks the read that would let this process mark its own
      // record abandoned. A sidecar needs only a new file in the directory, so
      // the next acquisition can still treat this lock as recoverable.
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        await markAbandoned(file, token)
        return 'failed'
      }
    }
    if (owner !== undefined) {
      if (owner.token !== token) return 'replaced'
      try {
        await unlink(file)
        return 'released'
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
        // A file that will not delete (a scanner holding it) leaves this
        // process's own pid and start time on disk. Every later acquire then
        // read that as a live owner and timed out for the rest of the process's
        // life. Marking the record abandoned is what the stale-recovery path
        // already treats as reclaimable, and it costs one rewrite of the file
        // this process still owns - a rename over it is not blocked by a reader
        // the way an unlink is.
        try {
          await writeFile(file, JSON.stringify({ ...owner, state: 'abandoned' }), { mode: 0o600 })
        } catch { /* the next attempt still sees the same owner and retries */ }
      }
    }
    if (Date.now() >= deadline) {
      await markAbandoned(file, token)
      return 'failed'
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_MS))
  }
}

async function newestReclaimGeneration(lock: string): Promise<number> {
  const directory = dirname(lock)
  const base = basename(lock)
  const prefix = `${base}.reclaim.`
  const names = await readdir(directory)
  let generation = 0
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    if (!/^\d+$/.test(suffix)) continue
    generation = Math.max(generation, Number(suffix))
  }
  return generation
}

/**
 * Drop reclaim generations that are no longer fencing anything.
 *
 * Answers false when a terminal generation could not be removed. Creating the
 * next generation then would leave both files behind, and a filesystem that
 * keeps refusing the delete would grow one more on every retry. The caller
 * waits instead; the cleanup above succeeds once the deletion does.
 */
async function cleanupTerminalReclaims(lock: string): Promise<boolean> {
  const directory = dirname(lock)
  const prefix = `${basename(lock)}.reclaim.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return true
  }
  const claimNames = names.filter(name => {
    if (!name.startsWith(prefix)) return false
    return /^\d+$/.test(name.slice(prefix.length))
  })
  const claimNameSet = new Set(claimNames)
  let blocked = false
  for (const claimName of claimNames) {
    const claim = join(directory, claimName)
    const sidecars = names.filter(name => name.startsWith(`${claimName}.abandoned.`))
    const temporaryFiles = names.filter(name => name.startsWith(`${claimName}.`) && name.endsWith('.tmp'))
    let owner: LockRecord | undefined
    try {
      const parsed = JSON.parse(await readFile(claim, 'utf8')) as unknown
      owner = typeof parsed === 'object' && parsed !== null ? parsed as LockRecord : {}
    } catch { /* A sidecar still marks the generation as abandoned. */ }
    const terminalState = owner?.state === 'complete' || owner?.state === 'abandoned'
    // Only a token this process remembers can make an unreadable claim
    // abandoned. Two undefined tokens compared equal before, and a scanner that
    // blocked the read made another process's live claim deletable.
    const rememberedAbandonment = owner?.token !== undefined
      && ABANDONED_RECLAIMS.get(claim) === owner.token
    if (sidecars.length === 0 && !terminalState && !rememberedAbandonment) continue
    let claimRemoved = false
    try {
      await unlink(claim)
      claimRemoved = true
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      claimRemoved = code === 'ENOENT' || code === 'ENOTDIR'
    }
    if (!claimRemoved) {
      blocked = true
      continue
    }
    for (const sidecar of sidecars) await unlink(join(directory, sidecar)).catch(() => {})
    for (const temporary of temporaryFiles) await unlink(join(directory, temporary)).catch(() => {})
    ABANDONED_RECLAIMS.delete(claim)
  }
  for (const name of names) {
    const marker = name.indexOf(prefix)
    const abandoned = name.indexOf('.abandoned.', marker + prefix.length)
    if (marker !== 0 || abandoned === -1) continue
    if (claimNameSet.has(name.slice(0, abandoned))) continue
    await unlink(join(directory, name)).catch(() => {})
  }
  return !blocked
}

async function claimStaleReclaim(
  lock: string,
  probeTimeoutMs = 2_000,
  probe: ProbeStartedAt = processStartedAt,
): Promise<ReclaimClaim | undefined> {
  const directory = dirname(lock)
  const base = basename(lock)
  const prefix = `${base}.reclaim.`
  const names = await readdir(directory)
  const generation = names.reduce((highest, name) => {
    if (!name.startsWith(prefix)) return highest
    const suffix = name.slice(prefix.length)
    const match = suffix.match(/^(\d+)(?:\.abandoned\..+)?$/)
    return match === null ? highest : Math.max(highest, Number(match[1]))
  }, 0)
  const claims = names
    .filter((name) => {
      if (!name.startsWith(prefix)) return false
      return /^\d+$/.test(name.slice(prefix.length))
    })
    .map(name => join(directory, name))
  for (const claim of claims) {
    const claimName = basename(claim)
    if (names.some(name => name.startsWith(`${claimName}.abandoned.`))) return undefined
    let owner: LockRecord = {}
    try {
      const parsed = JSON.parse(await readFile(claim, 'utf8')) as unknown
      owner = typeof parsed === 'object' && parsed !== null ? parsed as LockRecord : {}
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ABANDONED_RECLAIMS.delete(claim)
        continue
      }
    }
    // A terminal claim the cleanup could not unlink still fences this path.
    // Adding a generation beside it would grow the directory on every retry.
    if (owner.state === 'complete' || owner.state === 'abandoned') return undefined
    if (owner.token !== undefined && ABANDONED_RECLAIMS.get(claim) === owner.token) return undefined
    if (await lockState(claim, probeTimeoutMs, probe) === 'current') return undefined
    // A claimant that died mid-recovery leaves a claim that fences nothing.
    // Removing it keeps generations bounded; if it cannot go, no new one can
    // be told apart from it.
    try {
      await unlink(claim)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
    }
    // A claimant killed between its temporary write and the rename leaves that
    // file under the claim's own name; the next generation knows nothing about
    // it, so it goes with the claim.
    for (const name of names) {
      if (!name.startsWith(`${claimName}.`) || !name.endsWith('.tmp')) continue
      await unlink(join(directory, name)).catch(() => {})
    }
    ABANDONED_RECLAIMS.delete(claim)
  }
  const file = `${lock}.reclaim.${String(generation + 1).padStart(12, '0')}`
  const token = await createOwnedFile(file)
  return token === undefined ? undefined : { file, token, generation: generation + 1 }
}

async function completeReclaim(reclaim: ReclaimClaim): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(reclaim.file, 'utf8')) as LockRecord
    if (owner.token !== reclaim.token) return
    const temporary = `${reclaim.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({
        pid: process.pid,
        token: reclaim.token,
        createdAtMs: Date.now(),
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        state: 'complete',
      }), { mode: 0o600 })
      await replaceFile(temporary, reclaim.file)
    } catch (error: unknown) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function abandonReclaim(reclaim: ReclaimClaim, cause: unknown): Promise<never> {
  let marked = false
  try {
    await writeFile(reclaim.file, JSON.stringify({
      pid: process.pid,
      token: reclaim.token,
      createdAtMs: Date.now(),
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      state: 'abandoned',
    }), { mode: 0o600 })
    marked = true
  } catch { /* deletion below is enough when it succeeds */ }
  const released = await releaseOwnedFile(reclaim.file, reclaim.token)
  if (released === 'released' || released === 'missing') throw cause
  if (!marked) {
    const marker = `${reclaim.file}.abandoned.${reclaim.token}`
    try {
      await writeFile(marker, JSON.stringify({
        token: reclaim.token,
        createdAtMs: Date.now(),
        processStartedAtMs: PROCESS_STARTED_AT_MS,
      }), { flag: 'wx', mode: 0o600 })
      marked = true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') marked = true
    }
  }
  if (marked) {
    ABANDONED_RECLAIMS.delete(reclaim.file)
    throw cause
  }
  ABANDONED_RECLAIMS.set(reclaim.file, reclaim.token)
  throw new Error('could not complete or release the lock recovery claim', { cause })
}

/** Run `work` while holding a lock file shared by every writer to the same document. */
export async function withFileLock(lock: string, work: () => Promise<void>): Promise<void> {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  // One start-time probe per pid per acquisition. The reclaim path checks the
  // same lock twice; probing again after the first probe used the budget left
  // the second call too short to confirm a stale owner, so the lock was never
  // removed and every later acquisition repeated the same timeout.
  const probes = new Map<number, Promise<number | undefined>>()
  const probe: ProbeStartedAt = (pid, timeoutMs) => {
    let pending = probes.get(pid)
    if (pending === undefined) {
      pending = processStartedAt(pid, timeoutMs)
      probes.set(pid, pending)
    }
    return pending
  }
  let token: string | undefined
  while (token === undefined) {
    token = await createOwnedFile(lock)
    if (token !== undefined) break
    const remaining = Math.max(250, deadline - Date.now())
    const current = await lockState(lock, remaining, probe)
    if (current === 'stale') {
      // A terminal claim whose unlink failed would otherwise stay beside the
      // lock, and the next attempt would add another generation every 25 ms for
      // the whole wait. Keep only the generation this attempt is about to use.
      const cleaned = await cleanupTerminalReclaims(lock)
      const reclaim = cleaned ? await claimStaleReclaim(lock, Math.max(250, deadline - Date.now()), probe) : undefined
      if (reclaim !== undefined) {
        try {
          if (await newestReclaimGeneration(lock) === reclaim.generation
            && await lockState(lock, Math.max(250, deadline - Date.now()), probe) === 'stale'
            && await newestReclaimGeneration(lock) === reclaim.generation) {
            await unlink(lock).catch(() => {})
          }
        } finally {
          try {
            await completeReclaim(reclaim)
          } catch (error: unknown) {
            await abandonReclaim(reclaim, error)
          }
        }
      }
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for the credential document lock')
    await new Promise(resolve => setTimeout(resolve, RETRY_MS))
  }
  await cleanupAbandonedMarkers(lock)
  await cleanupTerminalReclaims(lock)
  try {
    await work()
  } catch (error: unknown) {
    // A failed release must not hide what the work itself reported: pointing at
    // the lock sends the reader looking in the wrong place, and the real cause
    // (a write that failed) is what the caller can act on.
    const released = await releaseOwnedFile(lock, token)
    if (released !== 'released' && released !== 'missing') {
      // The work's own code decides what the caller sees. Wrapping it without
      // one made an already-gone file look like a failed unlink, and a delete
      // rolled its tombstone back on a sign-in that was already removed.
      const wrapped = new Error('work failed and the credential document lock was not released', { cause: error })
      const code = (error as NodeJS.ErrnoException).code
      if (code !== undefined) (wrapped as NodeJS.ErrnoException).code = code
      throw wrapped
    }
    throw error
  }
  const released = await releaseOwnedFile(lock, token)
  if (released !== 'released' && released !== 'missing') {
    throw new FileLockReleaseError('work completed but the credential document lock was not released')
  }
}

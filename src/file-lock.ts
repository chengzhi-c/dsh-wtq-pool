import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
const ABANDONED_RECLAIMS = new Map<string, string>()

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
): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(command, [...args], { timeout: 2_000, maxBuffer: 1_024, windowsHide: true, env, cwd }, (error, stdout) => {
      if (error !== null) resolve(undefined)
      else resolve(stdout.trim())
    })
  })
}

async function processStartedAt(pid: number): Promise<number | undefined> {
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
    ], trustedWindowsChildEnv(process.env, { inheritTemp: true, includeSystemDrive: true }), join(systemRoot, 'System32'))
    const match = output?.match(/\d{10,}/)
    return match === undefined || match === null ? undefined : Number(match[0])
  }
  const ps = ['/usr/bin/ps', '/bin/ps'].find(existsSync)
  if (ps === undefined) return undefined
  const output = await processOutput(ps, ['-p', String(pid), '-o', 'lstart='], {
    PATH: '/usr/bin:/bin',
    LC_ALL: 'C',
    TZ: 'UTC',
  }, '/')
  const started = output === undefined ? Number.NaN : Date.parse(`${output.trim()} UTC`)
  return Number.isFinite(started) ? started : undefined
}

type LockState = 'missing' | 'current' | 'stale'

async function lockState(file: string): Promise<LockState> {
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
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'current'
    throw error
  }
  let owner: LockRecord | undefined
  try { owner = JSON.parse(text) as LockRecord } catch { /* legacy empty lock */ }
  // A release that could not unlink its own file rewrites the record as
  // abandoned. Without this, the pid inside it is this live process and the
  // lock read as held for the rest of the process's life.
  if (owner?.state === 'abandoned') return 'stale'
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
      const actualStart = await processStartedAt(owner.pid)
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
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
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
    if (Date.now() >= deadline) return 'failed'
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

async function cleanupTerminalReclaims(lock: string): Promise<void> {
  const directory = dirname(lock)
  const prefix = `${basename(lock)}.reclaim.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return
  }
  const claimNames = names.filter(name => {
    if (!name.startsWith(prefix)) return false
    return /^\d+$/.test(name.slice(prefix.length))
  })
  const claimNameSet = new Set(claimNames)
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
    const rememberedAbandonment = ABANDONED_RECLAIMS.get(claim) === owner?.token
    if (sidecars.length === 0 && !terminalState && !rememberedAbandonment) continue
    let claimRemoved = false
    try {
      await unlink(claim)
      claimRemoved = true
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      claimRemoved = code === 'ENOENT' || code === 'ENOTDIR'
    }
    if (!claimRemoved) continue
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
}

async function claimStaleReclaim(lock: string): Promise<ReclaimClaim | undefined> {
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
    if (names.some(name => name.startsWith(`${claimName}.abandoned.`))) continue
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
    if (owner.state === 'complete' || owner.state === 'abandoned') continue
    if (ABANDONED_RECLAIMS.get(claim) === owner.token) continue
    if (await lockState(claim) === 'current') return undefined
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
  await mkdir(dirname(lock), { recursive: true })
  const deadline = Date.now() + FILE_LOCK_WAIT_MS
  let token: string | undefined
  while (token === undefined) {
    token = await createOwnedFile(lock)
    if (token !== undefined) break
    const current = await lockState(lock)
    if (current === 'missing') continue
    if (current === 'stale') {
      const reclaim = await claimStaleReclaim(lock)
      if (reclaim !== undefined) {
        try {
          if (await newestReclaimGeneration(lock) === reclaim.generation
            && await lockState(lock) === 'stale'
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
        continue
      }
    }
    if (Date.now() >= deadline) throw new Error('timed out waiting for the credential document lock')
    await new Promise(resolve => setTimeout(resolve, RETRY_MS))
  }
  await cleanupTerminalReclaims(lock)
  try {
    await work()
  } catch (error: unknown) {
    // A failed release must not hide what the work itself reported: pointing at
    // the lock sends the reader looking in the wrong place, and the real cause
    // (a write that failed) is what the caller can act on.
    const released = await releaseOwnedFile(lock, token)
    if (released !== 'released' && released !== 'missing') {
      throw new Error('work failed and the credential document lock was not released', { cause: error })
    }
    throw error
  }
  const released = await releaseOwnedFile(lock, token)
  if (released !== 'released' && released !== 'missing') {
    throw new Error('work completed but the credential document lock was not released')
  }
}

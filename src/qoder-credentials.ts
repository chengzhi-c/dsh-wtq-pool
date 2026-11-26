/**
 * Qoder credential reading.
 *
 * `qoder-discovery.ts` can say a Qoder app is installed; this module says
 * whether it is signed in, and hands the token to the caller in memory only.
 * Nothing writes to the Qoder apps' files.
 */
import { execFile, spawn } from 'node:child_process'
import { pbkdf2Sync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { QoderRegion, QoderStorageCandidate } from './qoder-discovery'
import { decryptQoderOscrypt, decryptQoderOscryptMac, qoderStorageCandidates } from './qoder-discovery'
import { trustedSystemRootOf, trustedWindowsChildEnv, trustedWindowsPowerShell } from './trusted-process'

/** One Qoder sign-in, token kept in memory only. */
export interface QoderCredential {
  region: QoderRegion
  userID: string
  name: string
  email: string
  token: string
  expiresAtMs: number
  /** Only present when the app persists one; never fabricated. */
  machineID?: string
}

/** Why one app directory did not yield a credential (token-free). */
export interface QoderCredentialFailure {
  region: QoderRegion
  reason: 'no-auth' | 'no-key' | 'undecryptable' | 'invalid' | 'unsupported-platform'
  message?: string
}

/** Machine-id file names, newest first (0.3.x renamed `machineid`). */
const MACHINE_ID_NAMES: readonly string[] = ['auth.machine-id', 'machineid', 'machineId']

/**
 * Unwrapped OSCrypt keys, keyed on the `Local State` path they came from.
 *
 * Unwrapping costs a PowerShell spawn, so the result is kept for the life of
 * the process and invalidated by the wrapped key: a desktop re-login that
 * rotates the key changes the file, an ordinary chat request changes nothing.
 */
const oscryptKeyCache = new Map<string, { encoded: string; key: Buffer }>()

/** The OSCrypt blob length prefix Chromium writes before the DPAPI payload. */
const DPAPI_PREFIX = 'DPAPI'

/**
 * PowerShell that unwraps one DPAPI blob and prints the result as base64.
 * The blob arrives on stdin and the key leaves on stdout, so neither is ever
 * passed as a command-line argument (visible in the process table) or written
 * to a file.
 */
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XdpoolDpapi {
  [StructLayout(LayoutKind.Sequential)] public struct B { public int cbData; public IntPtr pbData; }
  [DllImport("Crypt32.dll", SetLastError=true)]
  static extern bool CryptUnprotectData(ref B i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref B o);
  [DllImport("Kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static byte[] U(byte[] data) {
    B i = new B(); i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length);
    Marshal.Copy(data, 0, i.pbData, data.Length);
    B o = new B();
    try {
      if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o))
        throw new Exception("DPAPI error " + Marshal.GetLastWin32Error());
      byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
    } finally { Marshal.FreeHGlobal(i.pbData); if (o.pbData != IntPtr.Zero) LocalFree(o.pbData); }
  }
}
'@
$inputText = [Console]::In.ReadToEnd().Trim()
$blob = [Convert]::FromBase64String($inputText)
$key = [XdpoolDpapi]::U($blob)
[Console]::Out.Write([Convert]::ToBase64String($key))
`

/** Why an unwrap failed, without naming the blob. */
export class QoderKeyError extends Error {
  constructor(readonly reason: 'unsupported-platform' | 'invalid' | 'unavailable', message?: string) {
    super(message ?? `Qoder OSCrypt key ${reason}`)
    this.name = 'QoderKeyError'
  }
}

/**
 * Unwrap the AES key an app's `Local State` keeps under `os_crypt`.
 *
 * @throws QoderKeyError with a reason, never with key or blob material.
 */
export async function unwrapQoderOscryptKey(
  localStatePath: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Buffer> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform !== 'win32') throw new QoderKeyError('unsupported-platform', 'Qoder OSCrypt unwrap needs Windows DPAPI')
  const stateText = await readFile(localStatePath, 'utf8')
  let encoded: unknown
  try {
    const parsed = JSON.parse(stateText) as unknown
    const osCrypt = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['os_crypt']
      : undefined
    encoded = typeof osCrypt === 'object' && osCrypt !== null && !Array.isArray(osCrypt)
      ? (osCrypt as Record<string, unknown>)['encrypted_key']
      : undefined
  } catch {
    throw new QoderKeyError('invalid', 'Qoder Local State is not JSON')
  }
  if (typeof encoded !== 'string' || encoded === '') {
    throw new QoderKeyError('invalid', 'Qoder Local State has no os_crypt.encrypted_key')
  }
  const blob = Buffer.from(encoded, 'base64')
  try {
    if (blob.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
      throw new QoderKeyError('invalid', 'Qoder encrypted_key is not a DPAPI blob')
    }
    const payload = blob.subarray(DPAPI_PREFIX.length)
    if (payload.length === 0) throw new QoderKeyError('invalid', 'Qoder encrypted_key is empty')
    // Compare the wrapper already read: a file rotation can preserve mtime or
    // race the read. Return a copy because the caller zeroes its buffer.
    const cached = oscryptKeyCache.get(localStatePath)
    if (cached !== undefined && cached.encoded === encoded) return Buffer.from(cached.key)
    const exe = trustedWindowsPowerShell()
    if (exe === undefined) throw new QoderKeyError('unavailable', 'SystemRoot is not set, cannot locate PowerShell')
    // `spawn` rather than `execFile`, because the blob has to go in on stdin and
    // only the key comes back on stdout.
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
        env: trustedWindowsChildEnv(env),
        // A writable current directory on the DLL search path is how a planted
        // library reaches an elevated PowerShell. The trusted root is the one
        // that located the executable, not the inherited variable the caller
        // can point anywhere.
        cwd: (() => {
          const root = trustedSystemRootOf()
          return root === undefined ? undefined : join(root, 'System32')
        })(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      const timer = setTimeout(() => { child.kill() }, options.timeoutMs ?? 30_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { err += chunk })
      child.on('error', error => { clearTimeout(timer); reject(new QoderKeyError('unavailable', String(error.message).slice(0, 200))) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new QoderKeyError('unavailable', `PowerShell exited ${code}: ${err.trim().slice(0, 160)}`))
      })
      // A child that exits before reading stdin writes EPIPE here. The stream
      // error is not the ChildProcess `error` event, and leaving it unhandled
      // took down the whole plugin host; close/error above already settle.
      child.stdin.on('error', () => {})
      child.stdin.end(payload.toString('base64'))
    })
    const key = Buffer.from(stdout.trim(), 'base64')
    if (key.length !== 32) throw new QoderKeyError('invalid', 'DPAPI unwrap did not yield a 32-byte key')
    oscryptKeyCache.set(localStatePath, { encoded, key: Buffer.from(key) })
    return key
  } finally {
    blob.fill(0)
  }
}

/**
 * Normalise the session JSON inside `auth.v1.dat`.
 *
 * @returns the credential fields, or `undefined` when the session carries no
 * token or no user id — either way the caller reports `invalid` rather than
 * routing a half-known account.
 */
export function parseQoderAuthSession(plaintext: string): {
  userID: string
  name: string
  email: string
  token: string
  expiresAtMs: number
} | undefined {
  let session: unknown
  try { session = JSON.parse(plaintext) as unknown } catch { return undefined }
  if (typeof session !== 'object' || session === null) return undefined
  const record = session as Record<string, unknown>
  const token = typeof record['token'] === 'string' ? record['token'] : ''
  if (token === '') return undefined
  const rawUser = record['user']
  const user = typeof rawUser === 'object' && rawUser !== null && !Array.isArray(rawUser)
    ? rawUser as Record<string, unknown>
    : {}
  const userID = typeof user['id'] === 'string' ? user['id'] : ''
  if (userID === '') return undefined
  // Seconds and milliseconds are both in the wild, and a numeric expiry that
  // fails to parse used to read as 0, which every caller treats as "never
  // expires": a dead token then stayed in rotation until the upstream 401'd.
  const parsedExpiry = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value > 1e12 ? value : value * 1000
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const numeric = Number(value)
      // A numeric spelling that is not positive is "no expiry recorded", not a
      // date: `Date.parse("0")` reads as the year 2000, which dropped a live
      // sign-in out of rotation for looking long dead.
      if (Number.isFinite(numeric)) return numeric > 0 ? (numeric > 1e12 ? numeric : numeric * 1000) : 0
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    return 0
  }
  return {
    userID,
    name: typeof user['name'] === 'string' ? user['name'] : '',
    email: typeof user['email'] === 'string' ? user['email'] : '',
    token,
    expiresAtMs: parsedExpiry(record['expiresAt']),
  }
}

async function machineIdOf(appDir: string): Promise<string | undefined> {
  for (const name of MACHINE_ID_NAMES) {
    try {
      const text = (await readFile(join(appDir, name), 'utf8')).trim()
      if (text !== '') return text
    } catch {
      // Absent is the normal case; the next spelling may still be there.
    }
  }
  return undefined
}

/** First readable `auth.v1.dat` among the spellings, with its bytes kept. */
async function firstAuthBlob(paths: readonly string[]): Promise<Buffer | undefined> {
  for (const path of paths) {
    try {
      return await readFile(path)
    } catch {
      // keep looking; a machine with only the newer layout still resolves
    }
  }
  return undefined
}

/** Keychain service names for the current and older Qoder builds. */
const QODER_KEYCHAIN_SERVICES: Record<QoderRegion, readonly string[]> = {
  cn: ['Qoder CN App Safe Storage', 'Qoder CN Safe Storage', 'QoderWork CN Safe Storage'],
  global: ['Qoder App Safe Storage', 'Qoder Safe Storage', 'QoderWork Safe Storage'],
}

/**
 * PBKDF2 parameters Chromium's macOS OSCrypt uses to turn the Keychain
 * password into the 16-byte AES-128 key. Fixed by Chromium, not secret.
 */
const MAC_OSCRYPT_SALT = 'saltysalt'
const MAC_OSCRYPT_ITERATIONS = 1003

/** Derived macOS keys, keyed on the Keychain service they came from. */
const darwinKeyCache = new Map<string, Buffer>()

/** Pin the system helper and bound the wait for a Keychain prompt. */
function darwinKeychainPassword(service: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 8_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

/** One app directory's credential on macOS, or the reason there is none. */
async function readQoderCredentialMac(
  authBlob: Buffer,
  region: QoderRegion,
  appDir: string,
): Promise<{ credential?: QoderCredential; failure?: QoderCredentialFailure }> {
  const base = { region }
  let decrypted = false
  for (const service of QODER_KEYCHAIN_SERVICES[region]) {
    let key = darwinKeyCache.get(service)
    if (key === undefined) {
      const password = await darwinKeychainPassword(service)
      if (password === undefined) continue
      key = pbkdf2Sync(password, MAC_OSCRYPT_SALT, MAC_OSCRYPT_ITERATIONS, 16, 'sha1')
      darwinKeyCache.set(service, key)
    }
    const plain = decryptQoderOscryptMac(authBlob, key)
    if (plain === undefined) continue
    decrypted = true
    const session = parseQoderAuthSession(plain)
    if (session === undefined) continue
    const machineID = await machineIdOf(appDir)
    return {
      credential: {
        ...base,
        ...session,
        ...machineID === undefined ? {} : { machineID },
      },
    }
  }
  return {
    failure: {
      ...base,
      reason: decrypted ? 'invalid' : 'no-key',
      ...decrypted ? {} : {
        message:
          'no macOS Keychain key opened the sign-in (sign in to the Qoder app, then allow the Keychain prompt and rescan)',
      },
    },
  }
}

/** Read one app directory's credential, or the reason there is none. */
export async function readQoderCredential(
  candidates: readonly QoderStorageCandidate[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): Promise<{ credential?: QoderCredential; failure?: QoderCredentialFailure }> {
  const byKind = (kind: QoderStorageCandidate['kind']): string[] =>
    candidates.filter(candidate => candidate.kind === kind).map(candidate => candidate.path)
  const appDir = candidates[0]?.appDir ?? ''
  const region = candidates[0]?.region ?? 'cn'
  const base = { region }

  const authBlob = await firstAuthBlob(byKind('auth-v1'))
  if (authBlob === undefined) return { failure: { ...base, reason: 'no-auth' } }

  // macOS keeps no key wrapper in `Local State`; the key lives in the login
  // Keychain and the blob is AES-128-CBC, so the whole reader takes another
  // path rather than reusing the DPAPI unwrap that only Windows implements.
  if ((options.platform ?? process.platform) === 'darwin') {
    return readQoderCredentialMac(authBlob, region, appDir)
  }
  let key: Buffer
  try {
    const localState = byKind('local-state')[0]
    if (localState === undefined) throw new QoderKeyError('invalid', 'no Local State candidate')
    key = await unwrapQoderOscryptKey(localState, options)
  } catch (error) {
    const reason = error instanceof QoderKeyError && error.reason === 'unsupported-platform'
      ? 'unsupported-platform'
      : 'no-key'
    return { failure: { ...base, reason, ...error instanceof Error ? { message: error.message } : {} } }
  }
  try {
    const plain = decryptQoderOscrypt(authBlob, key)
    if (plain === undefined) return { failure: { ...base, reason: 'undecryptable' } }
    const session = parseQoderAuthSession(plain)
    if (session === undefined) return { failure: { ...base, reason: 'invalid' } }
    const machineID = await machineIdOf(appDir)
    return {
      credential: {
        ...base,
        ...session,
        ...machineID === undefined ? {} : { machineID },
      },
    }
  } finally {
    key.fill(0)
  }
}

/**
 * How long a discovery answer is reused.
 *
 * The gateways read credentials per request so a desktop re-login is picked up
 * without a rescan, but the read itself walks the app directories and, per
 * directory, used to spawn PowerShell to unwrap the OSCrypt key. The key is
 * now cached on the wrapped key; this TTL keeps the file walk itself off the
 * chat path. `resetQoderCredentialCache()` clears it for a rescan.
 */
const DISCOVERY_TTL_MS = 30_000
let discoveryCache: { at: number; value: { credentials: QoderCredential[]; failures: QoderCredentialFailure[] } } | undefined
let discoveryReadSequence = 0

/**
 * Drop the cached discovery answer, e.g. when the user asks for a rescan.
 *
 * The macOS Keychain keys go with it: a desktop re-login can rotate the stored
 * password, and a rescan is exactly when a rotated key has to be re-read
 * instead of failing every decrypt with the stale copy.
 */
export function resetQoderCredentialCache(): void {
  discoveryCache = undefined
  discoveryReadSequence += 1
  darwinKeyCache.clear()
}

/**
 * Every Qoder sign-in on this machine. One app directory that is missing or
 * unreadable never hides the others; failures carry reasons, never tokens.
 */
export async function discoverQoderCredentials(
  candidates?: readonly QoderStorageCandidate[],
): Promise<{ credentials: QoderCredential[]; failures: QoderCredentialFailure[] }> {
  // Only the default candidate set is cached: a caller that names its own
  // files is asking about those files, not about the machine.
  const cacheable = candidates === undefined
  if (cacheable && discoveryCache !== undefined && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    const cached = discoveryCache.value
    return { credentials: [...cached.credentials], failures: [...cached.failures] }
  }
  const sequence = cacheable ? ++discoveryReadSequence : discoveryReadSequence
  const value = await readQoderCredentials(candidates ?? qoderStorageCandidates())
  // An empty answer is not cached: the expensive half of this read only runs
  // when the app's own files are there, so a machine with no sign-in retries
  // for free, while a read that failed under load retries on the next request
  // instead of sticking for the whole TTL.
  if (cacheable && sequence === discoveryReadSequence && value.credentials.length > 0) discoveryCache = { at: Date.now(), value }
  return { credentials: [...value.credentials], failures: [...value.failures] }
}

async function readQoderCredentials(
  candidates: readonly QoderStorageCandidate[],
): Promise<{ credentials: QoderCredential[]; failures: QoderCredentialFailure[] }> {
  const byAppDir = new Map<string, QoderStorageCandidate[]>()
  for (const candidate of candidates) {
    const list = byAppDir.get(candidate.appDir)
    if (list === undefined) byAppDir.set(candidate.appDir, [candidate])
    else list.push(candidate)
  }
  const credentials: QoderCredential[] = []
  const failures: QoderCredentialFailure[] = []
  for (const group of byAppDir.values()) {
    const result = await readQoderCredential(group)
    if (result.credential !== undefined) {
      const fresh = result.credential
      const at = credentials.findIndex(existing =>
        existing.region === fresh.region && existing.userID === fresh.userID)
      const incumbent = at === -1 ? undefined : credentials[at]
      if (incumbent === undefined) {
        credentials.push(fresh)
      } else {
        const now = Date.now()
        const freshExpired = fresh.expiresAtMs > 0 && fresh.expiresAtMs <= now
        const incumbentExpired = incumbent.expiresAtMs > 0 && incumbent.expiresAtMs <= now
        // Zero means no recorded expiry; an expired copy must not displace it.
        if (freshExpired !== incumbentExpired ? incumbentExpired : fresh.expiresAtMs > incumbent.expiresAtMs) {
          credentials[at] = fresh
        }
      }
    } else if (result.failure !== undefined && result.failure.reason !== 'no-auth') {
      failures.push(result.failure)
    }
  }
  return { credentials, failures }
}

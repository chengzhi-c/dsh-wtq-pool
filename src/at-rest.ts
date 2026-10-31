/**
 * Open WorkBuddy 5.6+ `$wbEncrypted` credential fields.
 *
 * The desktop app seals accessToken / refreshToken / nickname. The key is not
 * on disk: ask the installed WorkBuddy binary (run as plain Node) for its
 * at-rest payload, derive the field key, and keep it in memory only.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')
const KEY_FETCH_TIMEOUT_MS = 30_000
const KEY_FAILURE_BACKOFF_MS = 60_000
const APP_EXECUTABLE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe'] as const
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

interface EncryptedField {
  $wbEncrypted: 1
  envelope: string
}

function encodeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function encodeLengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

function fieldAad(keyId: string, suite: number): Buffer {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed('WBEV1'),
    encodeLengthPrefixed('sym-v1'),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

export function isEncryptedFieldWrapper(value: unknown): value is EncryptedField {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapper = value as Record<string, unknown>
  const keys = Object.keys(wrapper).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && wrapper['$wbEncrypted'] === 1
    && typeof wrapper['envelope'] === 'string'
}

function deriveAtRestKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function deriveAtRestKey(payloadJson: string): Buffer {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object')
  }
  const secret = (payload as Record<string, unknown>)['atRestSecretKey']
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

function encryptedFieldKeyId(field: EncryptedField): string | undefined {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')) as Record<string, unknown>
    return typeof record['keyId'] === 'string' ? record['keyId'] : undefined
  } catch {
    return undefined
  }
}

export function openEncryptedField(field: EncryptedField, key: Buffer): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: encrypted field envelope is not valid JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object')
  }
  const record = envelope as Record<string, unknown>
  const suite = record['suite']
  const keyId = record['keyId']
  const nonce = record['nonce']
  const authTag = record['authTag']
  const ciphertext = record['ciphertext']
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`)
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

function cleanIconPath(raw: string): string {
  return raw.replace(/^"/u, '').replace(/",-?\d+$/u, '').replace(/,-?\d+$/u, '').trim()
}

/**
 * Whether a Windows path names a local file rather than a network share.
 *
 * The registry scan reads values any process running as the user can write. A
 * `DisplayIcon` naming `\\host\share\x.exe` would make PowerShell's own path
 * check authenticate to that host before any signature was read, leaking the
 * user's NTLM response. Only absolute drive paths are considered, and every
 * stat and spawn goes through the same filter.
 */
function localWindowsPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(candidate)
}

function windowsRegistryAppPaths(): string[] {
  if (process.platform !== 'win32') return []
  // The scan is a blocking PowerShell call, and the installs it lists do not
  // move under a running process. Reading it per acquire blocked the whole
  // plugin process - every gateway and the panel with it - for up to the
  // scan's timeout, once per minute, on a machine whose app sits outside the
  // standard roots. So the answer is cached, but only while it is still good:
  // a path the scan once listed and the machine has since removed stats to
  // nothing, and serving it for the life of the process left an app installed
  // later invisible until a restart. An answer with nothing usable behind it
  // - empty, or every path gone - takes the same backoff as a failed scan.
  const cached = registryAppPaths
  if (cached !== undefined) {
    if (cached.length > 0 && statExecutables(cached).length > 0) return cached
    if (Date.now() - registryScannedAtMs < KEY_FAILURE_BACKOFF_MS) return []
  }
  registryAppPaths = readRegistryAppPaths()
  registryScannedAtMs = Date.now()
  return registryAppPaths
}

/**
 * The Windows directory, whichever of the two variables holds it.
 *
 * Both are read here rather than only in `scanInterpreter`, because the module
 * path and the interpreter have to come from the same place: pinning the
 * absolute path from `windir` while the 5.1 module directory was skipped for a
 * missing `SystemRoot` left `Get-AuthenticodeSignature` unable to load for every
 * candidate, which is the failure this pair exists to avoid.
 */
function systemRootOf(env: NodeJS.ProcessEnv): string | undefined {
  const value = env['SystemRoot']?.trim() || env['windir']?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * The environment the signature scan runs in.
 *
 * `powershell` is Windows PowerShell 5.1, and it resolves
 * `Microsoft.PowerShell.Security` by walking `PSModulePath` in order. Any machine
 * with a Store-installed PowerShell 7 carries that build's Modules directory
 * ahead of the system one, because the Store install prepends it to the variable
 * the desktop host inherited. 5.1 then binds the 7 build's copy of the module
 * first and the import dies on a type-data conflict, so
 * `Get-AuthenticodeSignature` throws for every candidate. The scan's own catch
 * swallows that, the policy function is handed an empty status, and the at-rest
 * key reads as "no WorkBuddy executable found" on a machine holding two signed
 * installs. Putting the 5.1 directory first makes the right copy win.
 *
 * The directory is derived from `SystemRoot` rather than written out, and the
 * rest of the ambient path is left alone so a user's own modules still resolve.
 * Applying it twice is a no-op, so the answer stays one directory long however
 * often it is built.
 */
export function signatureScanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = systemRootOf(env)
  const ambient = env['PSModulePath']
  const modules = systemRoot === undefined
    ? undefined
    : join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules')
  if (modules === undefined) return { ...env }
  if (ambient === modules || ambient?.startsWith(`${modules};`) === true) return { ...env }
  return { ...env, PSModulePath: ambient === undefined || ambient === '' ? modules : `${modules};${ambient}` }
}

/**
 * The interpreter to run the scan with, by absolute path.
 *
 * Resolved from `SystemRoot` rather than through `PATH`, for the same reason the
 * scan exists at all: a user-level directory is on the default `PATH`
 * (`%LOCALAPPDATA%\Microsoft\WindowsApps`), so a bare `powershell` would let
 * whatever sits there be spawned inside a process holding every WorkBuddy token.
 * Neither variable set answers `undefined`, and the caller treats that as "no
 * scan" rather than guessing a path.
 */
export function scanInterpreter(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = systemRootOf(env)
  if (systemRoot === undefined) return undefined
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Every path an uninstall key names for a WorkBuddy-family install.
 *
 * The scan reads `DisplayName`, `DisplayIcon` and `InstallLocation` out of the
 * user's own uninstall keys, which means any process running as the user can add
 * one. It only enumerates here: a path is filtered to a local drive, stat'ed,
 * and signature-checked in Node before anything is spawned. Doing the stat or
 * signature read in PowerShell would touch a planted UNC path first and leak an
 * NTLM response to the host it names.
 *
 * PowerShell does the part only it can do: enumerate the keys and clean the
 * resource index and quotes off `DisplayIcon`. The decision is
 * {@link signatureAccepts}'s, in Node, because that is where it can be tested
 * without a registry to plant a key in, and it is handed a module path 5.1 can
 * actually load, because the host's is not always one.
 */
function readRegistryAppPaths(): string[] {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    'function Clean([string]$v) {',
    '  $v = $v.Trim()',
    '  if ($v.Length -ge 2 -and $v.StartsWith("\'") -and $v.EndsWith("\'")) { $v = $v.Substring(1, $v.Length - 2) }',
    '  $v = $v.Trim()',
    '  $i = $v.LastIndexOf(",")',
    '  if ($i -gt 0 -and $v.Substring($i + 1) -match "^[0-9]+$") { $v = $v.Substring(0, $i) }',
    '  return $v',
    '}',
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    '$out = foreach($r in $roots){',
    '  Get-ItemProperty -Path $r | ForEach-Object {',
    '    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation',
    "    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
    '      foreach($raw in @($di,$il)){',
    '        $p = Clean $raw',
    "        if($p -eq ''){ continue }",
    '        Write-Output $p',
    '      }',
    '    }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress',
  ].join('\n')
  let stdout: string
  const interpreter = scanInterpreter(process.env)
  if (interpreter === undefined) return []
  try {
    stdout = execFileSync(interpreter, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8_388_608, env: signatureScanEnv() })
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const cleaned = cleanIconPath(entry)
    if (cleaned === '' || !localWindowsPath(cleaned)) continue
    out.push(cleaned)
  }
  return out
}

/**
 * Whether a scanned file's signature makes it safe to run.
 *
 * Exported so the policy can be tested without a registry to plant a key in: the
 * PowerShell half is not unit-testable, and this half is where the decision
 * actually lives.
 *
 * `Valid` means the chain resolved to a trusted root. A user process cannot
 * forge the vendor's signature, but it can trust a certificate of its own in the
 * current user's root store without elevation, so this check raises the bar
 * rather than proving the file is the vendor's. It still rejects an unsigned
 * planted executable, and every cached registry path is checked again before it
 * is run.
 *
 * The publisher is deliberately not pinned. The plugin is a third-party build and
 * the vendor can change its signing certificate; a pinned name would turn that
 * into a silent loss of the at-rest key on every machine at once, which is a
 * worse failure than the one being prevented.
 *
 * An unknown status is refused, not assumed: `HashMismatch`, `NotSigned` and a
 * signature PowerShell could not read at all all mean the file is not the
 * vendor's, and the caller answers "no key" rather than running something.
 */
export function signatureAccepts(status: string | undefined, signer: string | undefined): boolean {
  return status === 'Valid' && signer !== undefined && signer.trim() !== ''
}

/** Why the last signature scan could not produce an answer, if it could not. */
let signatureScanFailure = ''

/**
 * The candidates whose Authenticode signature is valid.
 *
 * The standard install roots and the environment override were trusted by path
 * alone, while only the registry fallback checked a signature. A process running
 * as the user can write `%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe`; when
 * the host runs elevated, spawning that file would hand it the plugin's whole
 * environment and every WorkBuddy token. Every path is checked here, and the
 * registry result is passed through the same check before it is spawned.
 */
async function signedExecutables(candidates: string[]): Promise<string[]> {
  if (process.platform !== 'win32' || candidates.length === 0) return candidates
  signatureScanFailure = ''
  const interpreter = scanInterpreter(process.env)
  if (interpreter === undefined) {
    signatureScanFailure = 'the signature check could not run: Windows PowerShell was not found'
    return []
  }
  const payload = Buffer.from(JSON.stringify(candidates), 'utf8').toString('base64')
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    `$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    '$out = foreach ($p in @($paths)) {',
    '  if ([string]::IsNullOrWhiteSpace([string]$p)) { continue }',
    '  $s = $null',
    '  try { $s = Get-AuthenticodeSignature -LiteralPath ([string]$p) } catch { $s = $null }',
    '  [pscustomobject]@{',
    '    path = [string]$p',
    '    status = if ($s -ne $null) { [string]$s.Status } else { "" }',
    '    signer = if ($s -ne $null -and $s.SignerCertificate -ne $null) { [string]$s.SignerCertificate.Subject } else { "" }',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress',
  ].join('\n')
  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(interpreter, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8_388_608, env: signatureScanEnv() }, (error, output) => {
        if (error !== null) reject(error)
        else resolve(output)
      })
    })
  } catch {
    signatureScanFailure = 'the signature check could not run'
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    signatureScanFailure = 'the signature check returned no readable answer'
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const accepted: string[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const file = record['path']
    const status = record['status']
    const signer = record['signer']
    if (typeof file !== 'string' || file === '') continue
    if (!signatureAccepts(typeof status === 'string' ? status : undefined,
      typeof signer === 'string' ? signer : undefined)) continue
    accepted.push(file)
  }
  return accepted
}

function statExecutables(candidates: string[]): string[] {
  const files: string[] = []
  for (const candidate of candidates) {
    if (candidate === '') continue
    // A UNC path would make `statSync` open an SMB connection, which is the
    // same leak the registry scan avoids. Only local drive paths are touched.
    if (process.platform === 'win32' && !localWindowsPath(candidate)) continue
    try {
      // A file, not merely something that exists: the registry scan emits
      // InstallLocation, which is a directory, and spawning one spent a doomed
      // execFile per backoff window while the doctor reported the directory's
      // own spawn error as the reason the keys could not be fetched.
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) files.push(candidate)
    } catch { /* unstatable path */ }
  }
  return files
}

async function executableCandidates(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const override = env[WORKBUDDY_APP_EXECUTABLE_ENV]?.trim()
  const known = override === undefined ? [] : [override]
  if (process.platform === 'win32') {
    // LOCALAPPDATA is not in the environment the host hands a plugin, so the
    // per-user install root is rebuilt from the home directory as well.
    const local = env['LOCALAPPDATA']?.trim()
    const roots = [env['ProgramFiles'], env['ProgramFiles(x86)'], local === undefined || local === '' ? join(homedir(), 'AppData', 'Local', 'Programs') : join(local, 'Programs')]
    for (const root of roots) {
      if (!root) continue
      for (const name of APP_EXECUTABLE_NAMES) {
        known.push(join(root, 'WorkBuddy', name))
        known.push(join(root, 'WorkBuddy AI', name))
      }
    }
  } else if (process.platform === 'darwin') {
    const home = homedir()
    for (const bundle of ['WorkBuddy.app', 'WorkBuddy AI.app']) {
      for (const base of ['/Applications', join(home, 'Applications')]) {
        known.push(join(base, bundle, 'Contents', 'MacOS', 'Electron'))
      }
    }
  }
  const standard = await signedExecutables(statExecutables(known))
  // The registry scan is a blocking PowerShell call and the host waits for this
  // plugin to load, so it is only worth its cost for an install none of the
  // standard roots holds: a machine with the app in the usual place never runs
  // it, and one without it pays for the scan instead of guessing wrong roots.
  if (standard.length > 0 || process.platform !== 'win32') return standard
  // The registry answer is cached, but its paths are not trusted: a cached path
  // the user has since replaced, or one a planted key named, still has to be a
  // local file carrying a valid signature before it runs.
  return signedExecutables(statExecutables(windowsRegistryAppPaths()))
}

function fetchAtRestKeyPayload(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ['-e', "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: KEY_FETCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1_048_576,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`))
        return
      }
      const payload = stdout.trim()
      if (payload === '') {
        reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
        return
      }
      resolve(payload)
    })
  })
}

const atRestKeyById = new Map<string, Buffer>()
let registryAppPaths: string[] | undefined
let registryScannedAtMs = 0
let inflightKeys: Promise<void> | undefined
let lastKeyFailureAtMs = 0
let lastKeyFailure = ''
let lastKeyRotationAtMs = 0

/** Why the last at-rest key fetch failed. Empty whenever keys are available. */
export function atRestKeyFailure(): string {
  return atRestKeyById.size > 0 ? '' : lastKeyFailure
}

/**
 * Drop the cached keys so the next read asks the desktop app again.
 *
 * The desktop app re-derives its at-rest key when it is reinstalled or
 * upgraded, and a process holding the old one then read every sealed field as
 * empty: the sign-in stayed in the pool serving a stale token until it 401'd,
 * and the doctor reported the key as healthy the whole time. The field names
 * the key it was sealed with, so an unknown key id is the signal. Rate limited,
 * because a field no installed build can open is unknown every time and one
 * refetch per backoff window is the honest answer to that.
 */
function invalidateAtRestKeys(): void {
  if (Date.now() - lastKeyRotationAtMs < KEY_FAILURE_BACKOFF_MS) return
  lastKeyRotationAtMs = Date.now()
  atRestKeyById.clear()
  lastKeyFailureAtMs = 0
  lastKeyFailure = ''
}

function ensureAtRestKeys(): Promise<void> {
  if (atRestKeyById.size > 0) return Promise.resolve()
  if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve()
  inflightKeys ??= (async () => {
    const candidates = await executableCandidates()
    if (candidates.length === 0) {
      lastKeyFailureAtMs = Date.now()
      // Named, because the only other signal was a shim reporting "no WorkBuddy
      // credential found" for a sign-in whose sealed fields simply could not be
      // opened. A scan that never ran is reported as its own condition rather
      // than as a verdict that the installed file is unsigned.
      lastKeyFailure = process.platform === 'win32'
        ? signatureScanFailure !== ''
          ? signatureScanFailure
          : 'no WorkBuddy executable with a valid signature was found'
        : 'no WorkBuddy executable found in the standard install roots'
      return
    }
    let anySuccess = false
    let lastReason = ''
    await Promise.all(candidates.map(async executable => {
      try {
        const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable))
        atRestKeyById.set(deriveAtRestKeyId(key), key)
        anySuccess = true
      } catch (error: unknown) {
        // One build failing must not hide another build's key, but the reason
        // is kept: it is what the doctor reports when every sealed field reads
        // as empty and the pool looks empty with it.
        lastReason = String(error instanceof Error ? error.message : error).slice(0, 200)
      }
    }))
    lastKeyFailure = anySuccess ? '' : lastReason
    lastKeyFailureAtMs = anySuccess ? 0 : Date.now()
  })().finally(() => {
    inflightKeys = undefined
  })
  return inflightKeys
}

export async function encryptedFieldOpener(): Promise<((value: unknown) => string) | undefined> {
  await ensureAtRestKeys()
  if (atRestKeyById.size === 0) return undefined
  return value => {
    if (!isEncryptedFieldWrapper(value)) throw new Error('workbuddy: not an encrypted field wrapper')
    const keyId = encryptedFieldKeyId(value)
    if (keyId === undefined) throw new Error('workbuddy: encrypted field has no key id')
    const key = atRestKeyById.get(keyId)
    if (key === undefined) {
      // A key id this process has never seen means the desktop app rotated its
      // at-rest key, not that the field is foreign: dropping the cached keys
      // lets the next read fetch the current one.
      invalidateAtRestKeys()
      throw new Error('workbuddy: no at-rest key available for this encrypted field')
    }
    return openEncryptedField(value, key)
  }
}

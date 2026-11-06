/**
 * Open WorkBuddy 5.6+ `$wbEncrypted` credential fields.
 *
 * The desktop app seals accessToken / refreshToken / nickname. The key is not
 * on disk: ask the installed WorkBuddy binary (run as plain Node) for its
 * at-rest payload, derive the field key, and keep it in memory only.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse, resolve } from 'node:path'

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

/** Reject direct UNC and device paths before checking a candidate. */
function localWindowsPath(candidate: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(candidate)
}

/**
 * Keep only candidates on fixed local volumes.
 *
 * A mapped drive still looks like `Z:\...` to Node, and even `lstatSync` can
 * contact its SMB server. Windows exposes the volume type without opening a
 * file, so every candidate is filtered before any path component is inspected.
 */
function fixedWindowsPaths(candidates: string[]): string[] {
  const local = candidates
    .filter((candidate) => localWindowsPath(candidate))
    .map((candidate) => resolve(candidate))
  if (local.length === 0) return []
  // The install lives on the system volume on virtually every machine, and a
  // volume query is a PowerShell spawn the host waits on. Asking only about the
  // roots that are *not* the system one keeps the common case free while still
  // refusing a mapped or removable drive.
  //
  // With no system root to compare against, the filter is skipped rather than
  // refusing everything: the stat below still refuses what it cannot reach, and
  // the signature check is what decides.
  const anchor = systemRootOf(process.env) ?? process.env['SystemRoot'] ?? process.env['windir']
  if (anchor === undefined) return local
  const systemRoot = parse(resolve(anchor)).root.toUpperCase()
  const elsewhere = [...new Set(local
    .map((candidate) => parse(candidate).root.toUpperCase())
    .filter((candidateRoot) => candidateRoot !== '' && candidateRoot !== systemRoot))]
  const fixed = new Set(elsewhere.length === 0 ? [] : scanFixedRoots(elsewhere))
  return local.filter((candidate) => {
    const candidateRoot = parse(candidate).root.toUpperCase()
    return candidateRoot === systemRoot || (candidateRoot !== '' && fixed.has(candidateRoot))
  })
}

/** Which of `roots` are fixed drives, asked of PowerShell in one spawn. */
function scanFixedRoots(roots: readonly string[]): string[] {
  const interpreter = scanInterpreter(process.env)
  if (interpreter === undefined) return []
  const payload = Buffer.from(JSON.stringify(roots), 'utf8').toString('base64')
  const script = [
    "$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules')",
    "$ErrorActionPreference='SilentlyContinue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    `$roots=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    '$out = foreach ($root in @($roots)) {',
    '  try {',
    '    if ([IO.DriveInfo]::new([string]$root).DriveType -eq [IO.DriveType]::Fixed) { [string]$root }',
    '  } catch {}',
    '}',
    'ConvertTo-Json -InputObject @($out) -Compress',
  ].join('\n')
  let parsed: unknown
  try {
    const stdout = execFileSync(interpreter, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      maxBuffer: 65_536,
      env: signatureScanEnv(),
      cwd: dirname(dirname(dirname(interpreter))),
    })
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.toUpperCase())
}

/** Walk every Windows path component without following a reparse point. */
function windowsPathHasReparsePoint(candidate: string): boolean {
  if (process.platform !== 'win32') return false
  const normalized = resolve(candidate)
  const root = parse(normalized).root
  let current = root
  for (const part of normalized.slice(root.length).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, part)
    try {
      const entry = lstatSync(current, { throwIfNoEntry: false })
      // The OS would not resolve a missing component either. Treat it as unsafe
      // so the path it later opens is the one whose components were inspected.
      if (entry === undefined) return true
      if (entry.isSymbolicLink()) return true
    } catch {
      // A path we cannot inspect without following it is not safe to touch.
      return true
    }
  }
  return false
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

/** Resolve the OS directory without trusting inherited Windows environment variables. */
function systemRootOf(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === 'win32') {
    try {
      return realpathSync.native('\\\\?\\GLOBALROOT\\SystemRoot')
    } catch {
      return undefined
    }
  }
  const value = env['SystemRoot']?.trim() || env['windir']?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** Do not pass user-controlled CLR, module, or executable search paths to PowerShell. */
export function signatureScanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const systemRoot = systemRootOf(env)
  if (systemRoot === undefined) return {}
  return {
    SystemRoot: systemRoot,
    windir: systemRoot,
    PATH: join(systemRoot, 'System32'),
    PSModulePath: join(systemRoot, 'system32', 'WindowsPowerShell', 'v1.0', 'Modules'),
  }
}

/**
 * The interpreter to run the scan with, by absolute path.
 *
 * The OS directory comes from the Windows object manager, not an inherited path.
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
 * one. It only enumerates here: directly specified UNC and device paths are
 * filtered before candidates are stat'ed and signature-checked in Node.
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
    "$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules')",
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
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8_388_608, env: signatureScanEnv(), cwd: dirname(dirname(dirname(interpreter))) })
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

/** Trust the vendor's signing keys, not a subject name or a user-trusted root. */
export function signatureAccepts(status: string | undefined, publicKeyHash: string | undefined, elevated: boolean | undefined): boolean {
  return status === 'Valid' && elevated === false && [
    '2F95C8391B09328BC42D131C50CC7B4E06F9E2A7B1E3624E14C9070A1BE9CC97',
    '307ECCDC80B73FF1662464E2591BF027124F11175039423BA2FEC1CDE64DB212',
  ].includes(publicKeyHash?.toUpperCase() ?? '')
}

/** Why the last signature scan could not produce an answer, if it could not. */
let signatureScanFailure = ''

/**
 * The candidates whose Authenticode signature is valid.
 *
 * A signed file can still be replaced between inspection and execution. Refuse
 * to run any candidate from an elevated process, including user-writable paths.
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
    "$ErrorActionPreference='Stop'",
    "$env:PSModulePath=[IO.Path]::Combine($env:SystemRoot,'System32\\WindowsPowerShell\\v1.0\\Modules')",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    'try {',
    '  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    '  $elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '} catch { ConvertTo-Json -InputObject @{ elevated = $null; entries = @() } -Compress; exit }',
    'if ($elevated) { ConvertTo-Json -InputObject @{ elevated = $true; entries = @() } -Compress; exit }',
    "$ErrorActionPreference='SilentlyContinue'",
    `$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    '$out = foreach ($p in @($paths)) {',
    '  if ([string]::IsNullOrWhiteSpace([string]$p)) { continue }',
    '  $s = $null',
    '  try { $s = Get-AuthenticodeSignature -LiteralPath ([string]$p) } catch { $s = $null }',
    '  $keyHash = ""',
    '  if ($s -ne $null -and $s.SignerCertificate -ne $null) {',
    '    $sha = [System.Security.Cryptography.SHA256]::Create()',
    '    try { $keyHash = [BitConverter]::ToString($sha.ComputeHash($s.SignerCertificate.GetPublicKey())).Replace("-", "") } finally { $sha.Dispose() }',
    '  }',
    '  [pscustomobject]@{',
    '    path = [string]$p',
    '    status = if ($s -ne $null) { [string]$s.Status } else { "" }',
    '    publicKeyHash = $keyHash',
    '  }',
    '}',
    'ConvertTo-Json -InputObject @{ elevated = $false; entries = @($out) } -Compress -Depth 3',
  ].join('\n')
  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(interpreter, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8_388_608, env: signatureScanEnv(), cwd: dirname(dirname(dirname(interpreter))) }, (error, output) => {
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
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    signatureScanFailure = 'the signature check returned no readable answer'
    return []
  }
  const result = parsed as Record<string, unknown>
  if (result['elevated'] !== false) {
    signatureScanFailure = result['elevated'] === true
      ? 'WorkBuddy key retrieval is unavailable when the host runs elevated; restart it as a regular user'
      : 'the host elevation could not be determined; WorkBuddy key retrieval was skipped'
    return []
  }
  const entries = Array.isArray(result['entries']) ? result['entries'] : []
  const accepted: string[] = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const file = record['path']
    const status = record['status']
    const publicKeyHash = record['publicKeyHash']
    if (typeof file !== 'string' || file === '') continue
    if (!signatureAccepts(typeof status === 'string' ? status : undefined,
      typeof publicKeyHash === 'string' ? publicKeyHash : undefined, false)) continue
    accepted.push(file)
  }
  return accepted
}

function statExecutables(candidates: string[]): string[] {
  const localCandidates = process.platform === 'win32' ? fixedWindowsPaths(candidates) : candidates
  const files: string[] = []
  for (const candidate of localCandidates) {
    if (candidate === '') continue
    // A reparse point can turn an apparently local path into an SMB request.
    if (process.platform === 'win32'
      && windowsPathHasReparsePoint(candidate)) continue
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
  signatureScanFailure = ''
  if (process.platform !== 'win32') {
    try {
      if (typeof process.geteuid !== 'function' || process.geteuid() === 0) {
        signatureScanFailure = 'WorkBuddy key retrieval requires a non-root host'
        return []
      }
    } catch {
      signatureScanFailure = 'the host privileges could not be determined; WorkBuddy key retrieval was skipped'
      return []
    }
  }
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
  const root = process.platform === 'win32' ? systemRootOf(process.env) : '/'
  if (root === undefined) return Promise.reject(new Error('workbuddy: the system directory is unavailable'))
  const allowed = process.platform === 'win32'
    ? ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']
    : ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE']
  const names = new Set(allowed.map(name => name.toUpperCase()))
  const trustedWindowsNames = new Set(['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PATH', 'PSMODULEPATH'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const normalized = name.toUpperCase()
    return names.has(normalized) && (process.platform !== 'win32' || !trustedWindowsNames.has(normalized))
  }))
  if (process.platform === 'win32') {
    env['SystemRoot'] = root
    env['windir'] = root
    if (/^[A-Za-z]:\\/.test(root)) env['SystemDrive'] = root.slice(0, 2)
    env['PATH'] = join(root, 'System32')
    env['PSModulePath'] = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  }
  env['ELECTRON_RUN_AS_NODE'] = '1'
  return new Promise((resolve, reject) => {
    execFile(executable, ['-e', "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
      env,
      cwd: process.platform === 'win32' ? join(root, 'System32') : root,
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
      lastKeyFailure = signatureScanFailure !== '' ? signatureScanFailure : process.platform === 'win32'
        ? 'no WorkBuddy executable with a trusted signing key was found'
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

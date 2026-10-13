/**
 * Open WorkBuddy 5.6+ `$wbEncrypted` credential fields.
 *
 * The desktop app seals accessToken / refreshToken / nickname. The key is not
 * on disk: ask the installed WorkBuddy binary (run as plain Node) for its
 * at-rest payload, derive the field key, and keep it in memory only.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

function windowsRegistryAppPaths(): string[] {
  if (process.platform !== 'win32') return []
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    'foreach($r in $roots){',
    '  Get-ItemProperty -Path $r | ForEach-Object {',
    '    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation',
    "    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
    "      if($di -ne ''){ Write-Output $di }",
    "      if($il -ne ''){ Write-Output $il }",
    '    }',
    '  }',
    '}',
  ].join('\n')
  let stdout: string
  try {
    stdout = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8_388_608 })
  } catch {
    return []
  }
  const out: string[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const cleaned = cleanIconPath(line.trim())
    if (cleaned !== '') out.push(cleaned)
  }
  return out
}

function statExecutables(candidates: string[]): string[] {
  const files: string[] = []
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      if (existsSync(candidate)) files.push(candidate)
    } catch { /* unstatable path */ }
  }
  return files
}

function executableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
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
  const standard = statExecutables(known)
  // The registry scan is a blocking PowerShell call and the host waits for this
  // plugin to load, so it is only worth its cost for an install none of the
  // standard roots holds: a machine with the app in the usual place never runs
  // it, and one without it pays for the scan instead of guessing wrong roots.
  if (standard.length > 0 || process.platform !== 'win32') return standard
  return statExecutables(windowsRegistryAppPaths())
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
let inflightKeys: Promise<void> | undefined
let lastKeyFailureAtMs = 0

function ensureAtRestKeys(): Promise<void> {
  if (atRestKeyById.size > 0) return Promise.resolve()
  if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return Promise.resolve()
  inflightKeys ??= (async () => {
    const candidates = executableCandidates()
    if (candidates.length === 0) {
      lastKeyFailureAtMs = Date.now()
      return
    }
    let anySuccess = false
    await Promise.all(candidates.map(async executable => {
      try {
        const key = deriveAtRestKey(await fetchAtRestKeyPayload(executable))
        atRestKeyById.set(deriveAtRestKeyId(key), key)
        anySuccess = true
      } catch { /* one build failing must not hide another build's key */ }
    }))
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
    if (key === undefined) throw new Error('workbuddy: no at-rest key available for this encrypted field')
    return openEncryptedField(value, key)
  }
}

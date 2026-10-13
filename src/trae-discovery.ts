/**
 * Trae read-only credential discovery.
 *
 * Finds every Trae desktop sign-in on this machine. Nothing here writes to the
 * Trae apps' files; failures carry paths and error text, never token material.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Trae desktop edition label. */
export type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg'

/** Where a local sign-in was persisted. */
export type TraeCredentialSource = 'desktop' | 'cli'

/** One file to probe, in probe order. */
export interface TraeStorageCandidate {
  edition: TraeEdition
  path: string
  source: TraeCredentialSource
}

/** One parsed Trae credential, token kept in memory only. */
export interface TraeCredential {
  accessToken: string
  userId: string
  accountName?: string
  /** The account's email, when the app stored one: the only human-readable id
   *  some accounts have (a Trae-generated `username` reads as a stranger). */
  email?: string
  host: string
  userRegion?: string
  expiresAtMs: number
  edition: TraeEdition
  source: 'desktop' | 'cli'
}

/** Why one candidate path did not yield an account (token-free). */
export interface TraeCandidateFailure {
  path: string
  edition: TraeEdition
  source: TraeCredentialSource
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/** Storage bucket: the CN service or the international (ai) service. */
export type TraeRegion = 'cn' | 'ai'

const TRAE_AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide'
const TRAE_CLI_TOKEN_FILENAME = 'trae-jwt-token'
const CLI_DEFAULT_HOST = 'https://api.trae.cn'

const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37])
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125])
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209])
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170])

function xor(a: Uint8Array, b: Uint8Array): Buffer {
  return Buffer.from(a.map((value, index) => value ^ (b[index] ?? 0)))
}

type EncryptionType = 'aes' | 'aes-private'

function encryptionType(header: Buffer): EncryptionType {
  if (header.equals(Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]))) return 'aes'
  if (header.equals(Buffer.from([18, 57, 32, 32, 2, 3]))) return 'aes-private'
  throw new Error('unsupported Trae auth encryption header')
}

/** Open one encrypted desktop auth value (reference: dsh-connect-trae decrypt.ts). */
export function decryptTraeStorageValue(encoded: string): string {
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length <= 102) throw new Error('Trae auth ciphertext is too short')
  const type = encryptionType(buffer.subarray(0, 6))
  const random = buffer.subarray(6, 38)
  const encrypted = buffer.subarray(38)
  const salt = type === 'aes-private' ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B)
  const first = createHash('sha512').update(random).digest()
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest()
  const decipher = createDecipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  if (decrypted.length < 64) throw new Error('Trae auth plaintext is too short')
  const expected = decrypted.subarray(0, 64)
  const plaintext = decrypted.subarray(64)
  const actual = createHash('sha512').update(plaintext).digest()
  if (!expected.equals(actual)) throw new Error('Trae auth integrity check failed')
  return plaintext.toString('utf8')
}

function parseTraeAuthValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('Trae auth value is empty')
  const plaintext = trimmed.startsWith('{') ? trimmed : decryptTraeStorageValue(trimmed)
  return JSON.parse(plaintext) as unknown
}

function parseTraeStorageDocument(text: string): unknown {
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Trae storage document must be an object')
  }
  const value = (parsed as Record<string, unknown>)[TRAE_AUTH_STORAGE_KEY]
  if (typeof value !== 'string') throw new Error(`Trae storage document has no ${TRAE_AUTH_STORAGE_KEY}`)
  return parseTraeAuthValue(value)
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | undefined {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch { return undefined }
}

/** Parse a CLI token file (bare JWT or a JSON envelope holding one). */
export function parseTraeCliToken(text: string): { accessToken: string; userId: string; expiresAtMs?: number } {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('Trae CLI token file is empty')
  let token = trimmed
  if (trimmed.startsWith('{')) {
    const envelope = JSON.parse(trimmed) as Record<string, unknown>
    const candidate = envelope['token'] ?? envelope['accessToken'] ?? envelope['jwt']
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new Error('Trae CLI token document has no token field')
    }
    token = candidate.trim()
  }
  const segments = token.split('.')
  if (segments.length !== 3 || segments.some(segment => segment === '')) {
    throw new Error('Trae CLI token is not a three-part JWT')
  }
  const payload = decodeBase64UrlJson(segments[1]!)
  if (payload === undefined) throw new Error('Trae CLI token payload is not decodable JSON')
  const data = typeof payload['data'] === 'object' && payload['data'] !== null && !Array.isArray(payload['data'])
    ? payload['data'] as Record<string, unknown>
    : undefined
  const userId = typeof data?.['user_id'] === 'string' ? data['user_id'] : undefined
  if (userId === undefined || userId === '') throw new Error('Trae CLI token has no data.user_id claim')
  const exp = payload['exp']
  const expiresAtMs = typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  return { accessToken: token, userId, ...expiresAtMs === undefined ? {} : { expiresAtMs } }
}

/** Region for an edition label: the international installs belong to `ai`. */
export function traeRegionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/** Region from the credential's `userRegion` claim (object or bare string, case-blind). */
export function traeRegionOfUserRegion(value: unknown): TraeRegion | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  if (typeof raw !== 'string') return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'cn') return 'cn'
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/** Region from a credential host (`.trae.ai` → ai, `.trae.cn`/`.trae.com.cn` → cn). */
export function traeRegionOfHost(host: string | undefined): TraeRegion | undefined {
  if (host === undefined) return undefined
  const trimmed = host.trim()
  if (trimmed === '') return undefined
  let hostname: string
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return undefined
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai'
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')) return 'cn'
  return undefined
}

/** Region of a credential: `userRegion` wins, host suffix is the fallback, edition is last. */
export function traeRegionOfCredential(credential: { edition: TraeEdition; host?: string; userRegion?: string }): TraeRegion {
  return traeRegionOfUserRegion(credential.userRegion)
    ?? traeRegionOfHost(credential.host)
    ?? traeRegionOfEdition(credential.edition)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/** Normalize one decrypted desktop document into a credential (undefined = no usable token). */
export function normalizeTraeCredential(raw: unknown, edition: TraeEdition, source: TraeCredential['source']): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined
  return {
    accessToken,
    userId: optionalString(value['userId']) ?? '',
    ...optionalString(account?.['username']) === undefined ? {} : { accountName: optionalString(account?.['username'])! },
    ...optionalString(account?.['email']) === undefined ? {} : { email: optionalString(account?.['email'])! },
    host: optionalString(value['host']) ?? '',
    ...userRegionOf(value['userRegion']) === undefined ? {} : { userRegion: userRegionOf(value['userRegion'])! },
    expiresAtMs: timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0,
    edition,
    source,
  }
}

/**
 * Identity of the account behind a credential, not the app that stored it.
 *
 * Trae CN, TraeWork CN (SOLO) and the CN CLI each keep a copy of the same
 * account's sign-in. Keying on the edition made every copy a separate pool
 * account: one account showed up twice (and was checked in twice).
 *
 * The region is part of the key, because the two regions are separate services
 * with separate user-id sequences: folding a numeral that both happen to use
 * into one entry drops whichever copy expires sooner, and that region's gateway
 * is then left with no credential at all while this dedup reports success.
 */
function traeAccountKey(credential: TraeCredential): string {
  const region = traeRegionOfCredential(credential)
  const userId = credential.userId.trim()
  if (userId !== '') return `id:${region}:${userId}`
  return `name:${region}\u0000${credential.accountName ?? credential.email ?? ''}`
}

/**
 * Of two copies of one account, the one to keep: the copy that can serve a
 * request longest, then a desktop sign-in over a CLI token, then the copy that
 * knows who the account is.
 */
function preferredTraeCredential(left: TraeCredential, right: TraeCredential): TraeCredential {
  if (left.expiresAtMs !== right.expiresAtMs) return left.expiresAtMs > right.expiresAtMs ? left : right
  const rank = (credential: TraeCredential): number =>
    (credential.source === 'desktop' ? 2 : 0) + (credential.accountName ?? credential.email ? 1 : 0)
  return rank(left) >= rank(right) ? left : right
}

const WINDOWS_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['Trae CN', 'trae-cn'],
  sg: ['Trae'],
  solo: ['TRAE SOLO CN', 'trae-solo-cn'],
  'solo-sg': ['TRAE SOLO'],
}

const LINUX_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['trae-cn', 'Trae CN', 'trae', 'Trae'],
  sg: ['trae', 'Trae'],
  solo: ['trae-solo-cn', 'TRAE SOLO CN'],
  'solo-sg': ['trae-solo', 'TRAE SOLO'],
}

const MAC_APP_NAMES: Readonly<Record<TraeEdition, string>> = {
  cn: 'Trae CN',
  sg: 'Trae',
  solo: 'TRAE SOLO CN',
  'solo-sg': 'TRAE SOLO',
}

/** One edition's macOS app-support / bundle spelling. */
export function traeMacAppName(edition: TraeEdition): string {
  return MAC_APP_NAMES[edition]
}

/**
 * One edition's plausible Windows directory spellings, in probe order.
 *
 * Exported so the identity reader and this credential scanner probe the SAME
 * names: they resolve different files in one installation (the install's
 * `product.json` vs the per-user `storage.json`), so a spelling that works for
 * one but not the other is a bug rather than a preference.
 */
export function traeWindowsAppNames(edition: TraeEdition): readonly string[] {
  return WINDOWS_APP_NAMES[edition]
}

const CLI_HOME_NAMES: readonly string[] = ['.trae-cn', '.trae']

function traeCliCandidates(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): TraeStorageCandidate[] {
  const roots: string[] = []
  if (platform === 'win32') {
    for (const value of [env.USERPROFILE, home]) {
      if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value)
    }
  } else {
    roots.push(home)
  }
  const result: TraeStorageCandidate[] = []
  for (const root of roots) {
    for (const name of CLI_HOME_NAMES) {
      result.push({ edition: name === '.trae-cn' ? 'cn' : 'sg', path: join(root, name, TRAE_CLI_TOKEN_FILENAME), source: 'cli' })
    }
  }
  return result
}

/**
 * Every Trae storage file to probe, in probe order. Missing files are normal
 * (an edition that was never installed); the discover step skips them.
 */
export function traeStorageCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeStorageCandidate[] {
  const result: TraeStorageCandidate[] = []
  for (const edition of ['cn', 'sg', 'solo', 'solo-sg'] as const) {
    let roots: string[]
    let appNames: readonly string[]
    if (platform === 'darwin') {
      roots = [join(home, 'Library', 'Application Support')]
      appNames = [MAC_APP_NAMES[edition]]
    } else if (platform === 'win32') {
      roots = [env.APPDATA, join(home, 'AppData', 'Roaming')].filter((value, index, all): value is string =>
        typeof value === 'string' && value !== '' && all.indexOf(value) === index)
      appNames = WINDOWS_APP_NAMES[edition]
    } else if (platform === 'linux') {
      roots = [env.XDG_CONFIG_HOME || join(home, '.config')]
      appNames = LINUX_APP_NAMES[edition]
    } else {
      roots = []
      appNames = [MAC_APP_NAMES[edition]]
    }
    for (const root of roots) {
      for (const appName of appNames) {
        result.push({ edition, path: join(root, appName, 'User', 'globalStorage', 'storage.json'), source: 'desktop' })
      }
    }
  }
  return [...result, ...traeCliCandidates(platform, home, env)]
}

function failureOf(candidate: TraeStorageCandidate, error: unknown): TraeCandidateFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (code === 'ENOENT') return { path: candidate.path, edition: candidate.edition, source: candidate.source, reason: 'missing' }
  if (error instanceof Error && code !== undefined) {
    return { path: candidate.path, edition: candidate.edition, source: candidate.source, reason: 'unreadable', message: error.message }
  }
  return {
    path: candidate.path,
    edition: candidate.edition,
    source: candidate.source,
    reason: code === undefined ? 'invalid' : 'unreadable',
    message: error instanceof Error ? error.message : String(error),
  }
}

function credentialFrom(candidate: TraeStorageCandidate, text: string): TraeCredential {
  let credential: TraeCredential | undefined
  if (candidate.source === 'cli') {
    // Only the CN CLI home is verified: an international CLI token carries no
    // host claim, so routing it to CN would be a silent misroute.
    if (traeRegionOfEdition(candidate.edition) !== 'cn') {
      throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`)
    }
    const claims = parseTraeCliToken(text)
    credential = normalizeTraeCredential({
      token: claims.accessToken,
      userId: claims.userId,
      host: CLI_DEFAULT_HOST,
      expiredAt: claims.expiresAtMs,
    }, candidate.edition, 'cli')
  } else {
    credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, 'desktop')
  }
  if (credential === undefined) throw new Error(`${candidate.source} candidate could not be normalized into a credential`)
  return credential
}

/**
 * Read every candidate file and return deduplicated credentials. One stale,
 * partially written or signed-out install never hides the others; failures are
 * recorded token-free so diagnostics can explain a silent "not signed in".
 */
export async function discoverTraeCredentials(
  candidates: TraeStorageCandidate[] = traeStorageCandidates(),
): Promise<{ credentials: TraeCredential[]; failures: TraeCandidateFailure[] }> {
  const byAccount = new Map<string, TraeCredential>()
  const failures: TraeCandidateFailure[] = []
  for (const candidate of candidates) {
    let text: string
    try {
      text = await readFile(candidate.path, 'utf8')
    } catch (error: unknown) {
      const failure = failureOf(candidate, error)
      if (failure.reason !== 'missing') failures.push(failure)
      continue
    }
    try {
      const credential = credentialFrom(candidate, text)
      const key = traeAccountKey(credential)
      const existing = byAccount.get(key)
      byAccount.set(key, existing === undefined ? credential : preferredTraeCredential(existing, credential))
    } catch (error: unknown) {
      failures.push(failureOf(candidate, error))
    }
  }
  return { credentials: [...byAccount.values()], failures }
}

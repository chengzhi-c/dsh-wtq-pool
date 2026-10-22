/**
 * Qoder gateway request codec.
 *
 * Offline half of the Qoder path: everything needed to turn a credential into
 * the exact bytes and headers one gateway request must carry. No DPAPI,
 * PowerShell or SQLite work happens here — the credential is handed in by
 * the caller.
 */
import { createCipheriv, createHash, publicEncrypt, randomUUID, constants as cryptoConstants } from 'node:crypto'
import type { QoderRegion } from './qoder-discovery'
import type { QoderClientCredential } from './qoder-client'

/** Gateway base per region. */
export const QODER_GATEWAYS: Readonly<Record<QoderRegion, string>> = {
  cn: 'https://gateway.qoder.com.cn/',
  global: 'https://api3.qoder.sh/',
}

/** Public key the gateway expects the per-request AES key to be wrapped with. */
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`

/** COSY protocol revision the gateway is currently serving. */
const COSY_VERSION = '1.1.38'
/** Client type magic the gateway expects from a CLI client. */
const CLIENT_TYPE = '5'
/** Machine type magic the gateway expects. */
const MACHINE_TYPE = '5'
/** Data-policy value a non-consenting client sends. */
const DATA_POLICY = 'disagree'
/** Login protocol revision. */
const LOGIN_VERSION = 'v2'

/** Permuted base64 alphabet used when `Encode=1` is in effect. */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
/** Standard base64 alphabet, positionally mapped onto the custom one. */
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Positional translation table from standard to custom alphabet. Every one of
 * the 256 byte values is present, defaulting to itself, so a lookup can never
 * read out of bounds or need a fallback. `=` becomes `$`, which is why the
 * encoded body is not valid base64 and must not be decoded as such.
 */
const ENCODE_TABLE = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < table.length; i++) table[i] = i
  for (let i = 0; i < STD_ALPHABET.length; i++) {
    table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

/**
 * The translation for one byte.
 *
 * The `?? byte` is a type-level requirement, not a runtime one:
 * `noUncheckedIndexedAccess` types every indexed read as possibly `undefined`,
 * and every one of the 256 values is present - so the fallback is unreachable
 * and exists only to satisfy the compiler.
 */
function encodeByteAt(byte: number): number {
  return ENCODE_TABLE[byte] ?? byte
}

/**
 * Encode a request body the way `Encode=1` requires: base64 the bytes,
 * translate each character through the permuted alphabet, then rotate the
 * string so the last third comes first and the first third goes last.
 */
export function encodeBody(plaintext: Buffer | string): Buffer {
  const bytes = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext)
  const std = bytes.toString('base64')
  const n = std.length
  const third = Math.floor(n / 3)
  const out = Buffer.allocUnsafe(n)
  let dst = 0
  for (let i = n - third; i < n; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  for (let i = third; i < n - third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  for (let i = 0; i < third; i++) out[dst++] = encodeByteAt(std.charCodeAt(i))
  return out
}

/**
 * The path the signature covers: the request path with a leading `/algo`
 * stripped, because the gateway routes that prefix away before verifying.
 */
function signaturePath(url: string): string {
  let path = new URL(url).pathname
  if (path.startsWith('/algo')) path = path.slice('/algo'.length)
  return path
}

/**
 * Machine OS string, spelled the way the gateway expects. Measured safe on
 * both regions (the gateway does not gate on it), so it names the real host
 * instead of announcing every machine as `x86_64_linux`.
 */
function qoderMachineOs(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === 'win32') return arch === 'arm64' ? 'aarch64_windows' : 'x86_64_windows'
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64_darwin' : 'x86_64_darwin'
  return arch === 'arm64' ? 'aarch64_linux' : 'x86_64_linux'
}

export interface CosyHeaderOptions {
  /** Seconds since epoch; injectable so a signature can be reproduced. */
  nowSeconds?: () => number
  /** UUID source; injectable for the same reason. */
  uuid?: () => string
  /** Per-request AES key material; injectable to keep tests deterministic. */
  aesKey?: string
}

/** AES-128-CBC encrypt with the key doubling as the IV, base64-encoded. */
function aesEncryptCBCBase64(plaintext: string, keyString: string): string {
  const key = Buffer.from(keyString)
  const cipher = createCipheriv('aes-128-cbc', key, key)
  return cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64')
}

/**
 * Build the full authenticated header set for one gateway request.
 *
 * @param body - the exact bytes that will be sent (already encoded).
 * @param url - the absolute request URL.
 * @param credential - `{ userID, token, name, email, machineID }`.
 */
export function buildCosyAuthHeaders(
  body: Buffer,
  url: string,
  credential: QoderClientCredential,
  options: CosyHeaderOptions = {},
): Record<string, string> {
  const uuid = options.uuid ?? randomUUID
  // 16 characters = the 16-byte AES-128 key the gateway unwraps from Cosy-Key.
  const aesKey = options.aesKey ?? uuid().replace(/-/g, '').slice(0, 16)
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? '',
      aid: '',
      email: credential.email ?? '',
    }),
    aesKey,
  )
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey),
  ).toString('base64')

  const timestamp = Math.floor((options.nowSeconds ?? (() => Date.now() / 1000))()).toString()
  const payloadB64 = Buffer.from(JSON.stringify({
    version: 'v1',
    requestId: uuid(),
    info: infoB64,
    cosyVersion: COSY_VERSION,
    ideVersion: '',
  })).toString('base64')
  const path = signaturePath(url)
  const bodyBytes = body
  const sig = createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(bodyBytes)
    .update('\n')
    .update(path)
    .digest('hex')

  const machineID = credential.machineID ?? ''
  return {
    'Authorization': `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': credential.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': COSY_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': MACHINE_TYPE,
    'Cosy-Machineos': qoderMachineOs(),
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': createHash('md5').update(bodyBytes).digest('hex'),
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': path,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': uuid(),
  }
}

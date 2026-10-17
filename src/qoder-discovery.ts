 /**
  * Qoder read-only credential discovery.
  *
  * Finds every Qoder desktop sign-in slot on this machine: the app
  * directories, the `Local State` key wrapper and the `auth.v1.dat` session
  * blob. The reader (`qoder-credentials.ts`) unwraps the OSCrypt key with
  * DPAPI and opens the blob; discovery itself only names files. Nothing here
  * writes to the Qoder apps' files. Failures carry paths and error text,
  * never token material.
  *
  * Shapes follow `dsh-connect-qoder` (MIT): the current layout is
  * `<appDir>/auth.v1.dat` (a Chromium OSCrypt blob whose plaintext is the
  * session JSON), with the key wrapper in `<appDir>/Local State` under
  * `os_crypt.encrypted_key`. The legacy `state.vscdb` layout is deliberately
  * not probed: reading it needs a SQLite reader this plugin does not carry,
  * and advertising a slot nothing can open reported legacy installs as signed
  * out with no explanation.
 *
 * @module dsh-wtq-pool/qoder-discovery
 */

import { createDecipheriv } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Storage bucket: the CN service or the international service. */
export type QoderRegion = 'cn' | 'global'

/** One file slot to probe inside an app directory. */
export type QoderCandidateKind =
  | 'local-state'
  | 'auth-v1'

/** One file to probe, in probe order. */
export interface QoderStorageCandidate {
  region: QoderRegion
  appName: string
  appDir: string
  path: string
  kind: QoderCandidateKind
}


/** CN desktop app directory names. The 0.3.x layout is probed first. */
const QODER_CN_APP_NAMES: readonly string[] = ['com.qodercn.app.stable', 'QoderCN', 'Qoder CN', 'QoderWork CN']

/** International desktop app directory names. The 0.3.x layout is probed first. */
const QODER_GLOBAL_APP_NAMES: readonly string[] = ['com.qoder.app.stable', 'Qoder', 'QoderWork']

/**
 * The per-user application-data root Qoder's Electron apps live under.
 *
 * Same documented order as the reference chain: Windows `%APPDATA%`
 * (roaming — Electron's `userData` default) else the roaming path under the
 * home directory, macOS `~/Library/Application Support`, Linux/other
 * `$XDG_CONFIG_HOME` else `~/.config`.
 */
function qoderAppDataRootFor(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    // The host spawns plugins with a whitelisted environment that has no
    // APPDATA, so the roaming path has to be rebuilt from the home directory
    // (same reason `accounts.ts` does it for WorkBuddy). Returning '' here made
    // every Qoder candidate vanish, which read as "no Qoder sign-in" and left
    // the Qoder gateways with nothing to publish.
    const roaming = env['APPDATA']?.trim()
    return roaming === undefined || roaming === '' ? join(home, 'AppData', 'Roaming') : roaming
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support')
  const xdg = env.XDG_CONFIG_HOME
  if (typeof xdg === 'string' && xdg.length > 0) return xdg
  return join(home, '.config')
}


/**
 * Every Qoder storage file to probe, in probe order. Missing files are normal
 * (an edition that was never installed); the discover step skips them silently.
 */
export function qoderStorageCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): QoderStorageCandidate[] {
  const root = qoderAppDataRootFor(platform, env, home)
  // win32 probes APPDATA plus the home-derived roaming fallback (deduped);
  // every other platform has exactly one documented root.
  let roots: string[]
  if (platform === 'win32') {
    const fallback = join(home, 'AppData', 'Roaming')
    roots = [root, fallback].filter((value, index, all) => all.indexOf(value) === index)
  } else {
    roots = [root]
  }
  const apps: Array<{ appName: string; region: QoderRegion }> = [
    ...QODER_CN_APP_NAMES.map((appName): { appName: string; region: QoderRegion } => ({ appName, region: 'cn' })),
    ...QODER_GLOBAL_APP_NAMES.map((appName): { appName: string; region: QoderRegion } => ({ appName, region: 'global' })),
  ]
  const result: QoderStorageCandidate[] = []
  for (const rootDir of roots) {
    for (const { appName, region } of apps) {
      const appDir = join(rootDir, appName)
      result.push({ region, appName, appDir, path: join(appDir, 'Local State'), kind: 'local-state' })
      result.push({ region, appName, appDir, path: join(appDir, 'auth.v1.dat'), kind: 'auth-v1' })
    }
  }
  return result
}

/**
 * Decrypt one Chromium OSCrypt blob.
 *
 * Pure helper (reference: dsh-connect-qoder credentials.ts): `v10` prefix,
 * 12-byte nonce, 16-byte tag, AES-256-GCM. The DPAPI unwrap that produces
 * the 32-byte `key` from `Local State` is NOT here — that stays in the full
 * chain for a later round.
 *
 * @param blob - the raw stored bytes, including the `v10` prefix.
 * @param key - the 32-byte AES key unwrapped from `Local State`.
 * @returns the plaintext, or `undefined` when authentication fails.
 */
export function decryptQoderOscrypt(blob: Buffer, key: Buffer): string | undefined {
  if (blob.length < 3 + 12 + 16) return undefined
  if (blob.subarray(0, 3).toString('latin1') !== 'v10') return undefined
  const body = blob.subarray(3)
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ciphertext = body.subarray(12, body.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}



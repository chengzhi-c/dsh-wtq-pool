/**
 * Account pool: discovers every WorkBuddy credential snapshot the desktop app
 * has left on this machine and hands out one healthy account per request,
 * rotating away from any account the upstream has rate-limited.
 *
 * Discovery is read-only: the desktop app's files are never written. Each
 * account is keyed by its billing identity (`uin`, falling back to `uid`), so
 * re-logging the same account refreshes in place instead of creating a duplicate.
 *
 * @module dsh-wtq-pool/accounts
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tokenExpiryMs, regionOf, upstreamErrorKind, type WorkBuddyRegion } from './upstream'
import { encryptedFieldOpener, isEncryptedFieldWrapper } from './at-rest'
import { LOG_PREFIX } from './log'

/** Minimal upstream surface the pool needs to refresh a token (no circular import). */
export interface TokenRefresher {
  refreshToken(credential: WorkBuddyCredential): Promise<{
    accessToken: string
    refreshToken?: string
    expiresInSec?: number
    domain?: string
  }>
}

/** Live auth file name the WorkBuddy desktop app writes. */
const WORKBUDDY_LIVE_FILENAME = 'workbuddy-desktop.info'
/**
 * Live auth file name the international client writes.
 *
 * One file, no snapshots beside it: the client overwrites this one when the user
 * switches accounts. Treating it as an abandoned snapshot had the pool take over
 * the session the app was still signed into and renew it behind the app's back,
 * which spends the rotation the app needed on its next refresh.
 */
const WORKBUDDY_GLOBAL_LIVE_FILENAME = 'workbuddy-desktop-ai.info'

/** Env override for the auth file or its directory. */
const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/**
 * File the pool keeps beside its own settings: every credential it has seen.
 *
 * The CN client writes a timestamped snapshot beside its live sign-in, so a
 * re-login leaves the previous account's file behind. The global client writes
 * one live file and nothing else, and switching accounts overwrites it — which
 * is why the global pool saw a single account no matter how many had signed in.
 */
const ARCHIVE_FILENAME = 'credentials-archive.json'
/** Subdirectory of the plugin's own data root that holds the sign-ins it wrote. */
const OWN_SIGN_IN_DIRNAME = 'signins'
/**
 * Sign-ins the user deleted, kept as a tombstone so a scan cannot resurrect them.
 *
 * Deleting only the file is not enough: the account's token is still in the
 * archive, and the desktop client still keeps a superseded snapshot of it, so the
 * next scan took the snapshot over and wrote the file straight back. The row never
 * moved, and the delete read as a button that does nothing.
 */
const DELETED_SIGN_INS_FILENAME = 'deleted-signins.json'
/** File-name prefix that marks one of those sign-ins as the plugin's own. */
const OWN_SIGN_IN_PREFIX = 'workbuddy-panel-'
/**
 * How long a delete waits for a scan that is already running.
 *
 * The wait is for ordering, not for the walk itself: a normal scan is a handful
 * of milliseconds, and the host answers a panel call in thirty seconds. A cold
 * scan stuck in the at-rest key fetch would otherwise burn that whole budget and
 * report the delete as failed after it had already happened.
 */
const DELETE_SCAN_WAIT_MS = 5_000
/**
 * One sign-in a panel login produced, before it is written to disk.
 *
 * Flat strings rather than the parsed credential: this is what the upstream's
 * own answers carry, and the empty string means "the upstream did not say" for
 * every field but the tokens.
 */
export interface OwnSignIn {
  region: WorkBuddyRegion
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  /** Domain the credential is served under, which decides its gateway. */
  domain: string
  uid: string
  uin: string
  enterpriseId: string
  nickname: string
  /**
   * When the upstream issued this token, for a sign-in taken over from the
   * desktop client. Stamping an adopted sign-in as new would hide how old it
   * is and delay its first renewal, so the issue time travels with the token.
   */
  lastRefreshAtMs?: number
}
/**
 * How long an archived credential is kept after the last token it can still be
 * renewed with would have expired.
 *
 * Measured against the credential's own dates rather than the file's write time:
 * an account switched away from today is worth keeping for as long as its
 * refresh token lives, and the global access token alone is valid for a year.
 */
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * One parsed WorkBuddy credential.
 * The first four fields are required because every caller reads them; the rest
 * are optional so a credential restored from the archive does not have to
 * invent a value the upstream never sent.
 */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  /**
   * When the upstream says it issued this token (`auth.lastRefreshTime`).
   *
   * This, not `expiresAtMs`, is the reliable freshness signal: the upstream
   * never rewrites a stored expiry when it revokes a token, so a long-dead
   * backup can claim to expire later than the token that actually works.
   * Absent on documents the desktop app did not write (the plugin's own
   * refreshed copy, older builds).
   */
  lastRefreshAtMs?: number
  nickname?: string
  uin?: string
  uid?: string
  enterpriseId?: string
  domain: string
  /** Where this credential came from, for diagnostics. */
  sourcePath: string
}


/**
 * What one keep-alive pass did for one account.
 *
 * `refreshed` spent an upstream call and got a new token. `fresh` needed
 * nothing, which is the answer for a token that still has hours on it and for
 * an international one that lives a year. `failed` could not refresh. `refused`
 * was turned down by the upstream, so the sign-in itself is dead. `noToken` has
 * no refresh token to refresh with, so it is dead for good.
 */
export type KeepAliveOutcome = 'refreshed' | 'fresh' | 'failed' | 'refused' | 'noToken'
/** An account is a credential plus pool bookkeeping. */
export interface WorkBuddyAccount {
  /** Stable pool key: sha256 of the billing identity. */
  id: string
  /**
   * Short human label: the account's own nickname. A uid prefix is appended
   * only when two accounts would otherwise read alike (see
   * {@link disambiguateLabels}).
   */
  label: string
  credential: WorkBuddyCredential
  /**
   * Epoch ms until which this account is skipped for EVERY model. Only set by
   * account-wide cooldowns (callers that penalize without a model id). The
   * upstream rate limit is actually per-model ("可切换其他模型继续使用"), so
   * routine 429s are tracked in {@link modelCooldowns} instead and never ban a
   * whole account.
   */
  cooldownUntilMs: number
  /**
   * Per-model cooldowns, keyed by upstream model id → epoch ms until that model
   * on THIS account is skipped. A 429 on `hy4-preview` cools only that model
   * here; `hy3`/`glm-*` on the same account keep serving.
   *
   * Always a prototype-less object: the key is the client's model id, and a
   * request naming `__proto__` would otherwise write through to the prototype
   * and leave no own key, so the cooldown silently did nothing.
   */
  modelCooldowns: Record<string, number>
  /**
   * Models this account's plan does not include, keyed by model id → epoch ms
   * until the block is retried.
   *
   * Kept apart from {@link modelCooldowns} because the two answer differently:
   * a cooldown is a window the upstream named and clears on its own, so the
   * gateway answers 429 with a retry hint. A plan block has no window, is not a
   * rate limit, and the client must be told about the plan rather than told to
   * wait. Storing it in the cooldown table made the next request say
   * "rate-limited" about a model the account can never use.
   */
  modelBlocks: Record<string, number>
  /** Lifetime count of rate-limit hits; this is what the panel shows. */
  rateLimitHits: number
  /**
   * How many failures in a row are stretching this account's own window, and when
   * the last one landed.
   *
   * Separate from `rateLimitHits`, which is the lifetime total the panel shows:
   * resetting that one to express "in a row" would silently change what the panel
   * is counting.
   */
  rateLimitStreak?: number
  rateLimitStreakAtMs?: number
  /**
   * Kept only in the pool's own archive: the desktop client overwrote or
   * removed this account's sign-in file. The credential still works until it
   * expires, so it keeps serving; the flag tells the panel the sign-in itself
   * is gone, and one re-login in the client makes it file-backed again.
   */
  archived?: boolean
}

function nonEmptyEnv(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Platform-default directories holding the desktop app's auth files.
 * Windows probes Local before Roaming; a redirected profile still resolves
 * through the env location.
 */
function defaultDesktopAuthDirs(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = nonEmptyEnv(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
    const roaming = nonEmptyEnv(env['APPDATA']) ?? join(home, 'AppData', 'Roaming')
    return [
      join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  if (platform === 'linux') {
    const config = nonEmptyEnv(env['XDG_CONFIG_HOME']) ?? join(home, '.config')
    return [join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  return []
}

/**
 * Any expiry past this is unusable input rather than a date: 2100-01-01.
 *
 * A saved sign-in whose `expiresAt` is a hand-edited or upstream-garbled
 * sentinel (1e15, 1e16) otherwise reads as a token that never expires, so the
 * pool skips its refresh forever and serves a dead token as live. Past
 * 8.64e15 `new Date(…).toISOString()` also throws, which failed the whole
 * panel document rather than the one row.
 */
const MAX_EXPIRY_MS = 4_102_444_800_000
/**
 * Normalize an expiry that may arrive in seconds or milliseconds.
 *
 * Anything past {@link MAX_EXPIRY_MS} is unusable input, not a date, so it
 * reads as "no expiry" (0) - the same answer a sign-in without an `expiresAt`
 * gives. The caller must not treat that as "fresh": see {@link tokenExpiryMs}.
 */
function expiryToMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const ms = value > 1e12 ? value : value * 1000
  return ms > MAX_EXPIRY_MS ? 0 : ms
}
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Whether `work` finished inside `budgetMs`.
 *
 * A timeout here is not a cancellation: the caller is told to stop waiting, and
 * whatever it started keeps running. The timer is cleared on the fast path so a
 * short wait does not hold the process open for the whole budget.
 */
async function raceWithTimeout(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs)
  })
  try {
    return await Promise.race([work.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Parse a WorkBuddy auth document. Accepts the nested desktop shape
 * `{"auth":{...},"account":{...}}` and the flat panel shape; returns undefined
 * when there is no usable access token.
 */
export function parseWorkBuddyAuth(
  text: string,
  sourcePath: string,
  decrypt?: (value: unknown) => string,
): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>

  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity =
      typeof document['account'] === 'object' && document['account'] !== null
        ? (document['account'] as Record<string, unknown>)
        : {}
  } else {
    auth = document
    identity = document
  }

  const accessToken = decryptableString(auth['accessToken'], decrypt)
  if (accessToken === '') return undefined

  const refreshExpiresAtMs =
    typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const refreshToken = decryptableString(auth['refreshToken'], decrypt)
  // A refresh token past its own expiry cannot renew anything, but the access
  // token issued beside it may still have hours left. Returning the whole
  // credential as unreadable took the account out of the pool for that window,
  // and the panel reported "no WorkBuddy sign-in found" over a token that was
  // still serving. Without the refresh token the request path lands in the
  // no-refresh branch instead, which warns once and keeps serving.
  const refreshExpired = refreshExpiresAtMs !== undefined
    && refreshExpiresAtMs > 0
    && refreshExpiresAtMs < Date.now()

  const lastRefreshAtMs = typeof auth['lastRefreshTime'] === 'number'
    ? expiryToMs(auth['lastRefreshTime'])
    : undefined
  const nickname = optionalString(decryptableString(identity['nickname'], decrypt))

  return {
    accessToken,
    refreshToken: refreshExpired ? '' : refreshToken,
    expiresAtMs: typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0,
    ...refreshExpiresAtMs === undefined || refreshExpired ? {} : { refreshExpiresAtMs },
    ...lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs },
    ...nickname === undefined ? {} : { nickname },
    ...optionalString(identity['uin']) === undefined ? {} : { uin: optionalString(identity['uin']) },
    ...optionalString(identity['uid']) === undefined ? {} : { uid: optionalString(identity['uid']) },
    ...optionalString(identity['enterpriseId']) === undefined
      ? {}
      : { enterpriseId: optionalString(identity['enterpriseId']) },
    domain: typeof auth['domain'] === 'string' ? auth['domain'] : '',
    sourcePath,
  }
}

/**
 * A credential field is either a plain string (older builds) or the desktop
 * app's `$wbEncrypted` envelope (5.6.0+, both platforms). An encrypted field
 * that cannot be opened is an empty string so the caller skips the file
 * instead of treating a sealed token as "not signed in".
 */
function decryptableString(
  value: unknown,
  decrypt?: (value: unknown) => string,
): string {
  if (typeof value === 'string') return value
  if (isEncryptedFieldWrapper(value) && decrypt !== undefined) {
    try {
      return decrypt(value)
    } catch { /* an unavailable key leaves this field unreadable */ }
  }
  return ''
}

/**
 * Whether `path` is the desktop app's live sign-in (as opposed to a backup
 * snapshot it left behind). A copy of it outranks an abandoned snapshot of the
 * same token, because the app keeps it current.
 */
function isLiveAuthFile(path: string): boolean {
  const name = basename(path)
  return name === WORKBUDDY_LIVE_FILENAME || name === WORKBUDDY_GLOBAL_LIVE_FILENAME
}

/**
 * Which of two credentials for the same account the pool should keep.
 *
 * Ordering, highest first:
 *
 * 1. the credential the upstream issued most recently (`lastRefreshAtMs`);
 * 2. the source the copy came from: the live sign-in file, then a sign-in the
 *    plugin wrote, then a superseded snapshot the client left behind;
 * 3. the longer stored expiry, as a fallback for documents that carry no issue
 *    time at all.
 *
 * Issue time comes first, and source rank only breaks a tie between copies of
 * the same token. Rank used to come first, on the reasoning that a file the
 * plugin writes is the one with a future, and that ordering cost the pool a
 * working token outright: a renewal of an account the desktop was signed into
 * is written to the archive, the plugin's own copy of that account stays one
 * rotation behind, and the next scan served the dead copy while the live one sat
 * next to it. An account was marked "sign in again" with a working token in the
 * same directory.
 *
 * The stored expiry alone is NOT a freshness signal: the upstream does not
 * rewrite it when it revokes a token, so a long-dead backup can claim to expire
 * later than the token that actually works. Selecting on it made every upstream
 * call return 401 while a perfectly good credential sat in the same directory.
 */
function compareFreshness(a: WorkBuddyCredential, b: WorkBuddyCredential, ownDir: string): number {
  const aIssued = a.lastRefreshAtMs ?? 0
  const bIssued = b.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued && aIssued > 0 && bIssued > 0) return bIssued - aIssued

  const aRank = credentialRank(a, ownDir)
  const bRank = credentialRank(b, ownDir)
  // One dated, one not. A copy the plugin wrote or refresh carries a date it set
  // itself, and that date is newer than the undated document it replaced; treating
  // the pair as unordered put the app's file back in front and served a token the
  // rotation beside it had already retired. A dated *snapshot* is the other way
  // round: nobody renews it, so an undated live file is still the better bet.
  if ((aIssued > 0) !== (bIssued > 0)) {
    if (aIssued > 0 && aRank <= 1) return -1
    if (bIssued > 0 && bRank <= 1) return 1
  }

  if (aRank !== bRank) return aRank - bRank
  if (aIssued !== bIssued) return bIssued - aIssued

  return b.expiresAtMs - a.expiresAtMs
}

/**
 * Which kind of source a credential came from, lowest number first.
 *
 * A sign-in the plugin wrote outranks a snapshot the client left behind because
 * the plugin renews it and nothing renews the snapshot: the same token, but one
 * of the two copies has a future.
 */
function credentialRank(credential: WorkBuddyCredential, ownDir: string): number {
  if (isLiveAuthFile(credential.sourcePath)) return 0
  if (ownSignInPath(credential.sourcePath, ownDir)) return 1
  return 2
}

/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential, ownDir: string): boolean {
  return compareFreshness(candidate, incumbent, ownDir) < 0
}

/**
 * Queue order for the account list: the live sign-in first, then the copy the
 * upstream issued last, then the newest expiry.
 *
 * This is a different question from `compareFreshness`, which decides which copy
 * of *one* account serves. That rule falls back to the source only when a copy
 * carries no issue time, which makes it cycle across three copies (a dated
 * snapshot, an undated live file, a dated panel sign-in) and leaves a list sort
 * with the order TimSort happened to produce. A key vector cannot.
 */
function compareQueueOrder(a: WorkBuddyCredential, b: WorkBuddyCredential, ownDir: string): number {
  const aRank = credentialRank(a, ownDir)
  const bRank = credentialRank(b, ownDir)
  if (aRank !== bRank) return aRank - bRank
  const aIssued = a.lastRefreshAtMs ?? 0
  const bIssued = b.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued) return bIssued - aIssued
  return b.expiresAtMs - a.expiresAtMs
}

/**
 * One deleted sign-in: enough to tell it apart from a later re-login.
 *
 * The token is stored as a digest, not as the token itself. This file has to
 * survive restarts, and a deleted sign-in is one the user asked to be rid of;
 * keeping the secret to recognise it is a worse trade than keeping its hash.
 */
interface DeletedSignIn {
  tokenDigest: string
  /** When the upstream issued the deleted token; 0 when its file did not say. */
  lastRefreshAtMs: number
  /** When the user deleted it, which is what the tombstone's own age is. */
  deletedAtMs: number
}

function tokenDigest(accessToken: string): string {
  return createHash('sha256').update(`workbuddy\0deleted\0${accessToken}`).digest('hex').slice(0, 32)
}

/**
 * A stamp for one file that changes when its content is replaced.
 *
 * Millisecond mtime alone repeats on a coarse filesystem, and two pools over one
 * data directory then kept a stale tombstone set; the size is in here so a rewrite
 * that lands in the same reported millisecond still reads as a different file.
 */
async function signInFileStamp(file: string): Promise<string> {
  try {
    const entry = await stat(file)
    return `${entry.mtimeMs}:${entry.size}`
  } catch {
    return ''
  }
}

/**
 * Run `work` while holding a lock file, or without it when the lock stays taken.
 *
 * The tombstone document is the one file two pools over the same data directory
 * both write, and a read-union-write is only as good as its serialisation. The
 * budget is short on purpose: a panel call is answered within seconds, and the
 * work is a few kilobytes of JSON. A lock older than that is a process that died
 * holding it, so it is dropped and retried.
 */
async function withFileLock(lock: string, work: () => Promise<void>): Promise<void> {
  let held = false
  for (let attempt = 0; attempt < 25 && !held; attempt += 1) {
    try {
      await writeFile(lock, '', { flag: 'wx', mode: 0o600 })
      held = true
      break
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break
      const age = await stat(lock).then(entry => Date.now() - entry.mtimeMs, (): number => 0)
      if (age > 5_000) {
        await unlink(lock).catch(() => {})
        continue
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    await work()
  } finally {
    if (held) await unlink(lock).catch(() => {})
  }
}

/**
 * Read the tombstone document.
 *
 * Throws when the file exists but cannot be read or parsed, so the caller can keep
 * what it already knows instead of treating a scanner's EBUSY as "no deleted
 * sign-ins".
 */
async function readDeletedSignInsFile(file: string): Promise<Map<string, DeletedSignIn>> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries?: unknown }
  const tombstones = new Map<string, DeletedSignIn>()
  const entries = parsed?.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return tombstones
  for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
    const entry = value as Partial<DeletedSignIn> | null
    if (entry === null || typeof entry !== 'object') continue
    const digest = entry.tokenDigest
    if (typeof digest !== 'string' || digest === '') continue
    const issued = entry.lastRefreshAtMs
    const deletedAt = entry.deletedAtMs
    tombstones.set(id, {
      tokenDigest: digest,
      lastRefreshAtMs: typeof issued === 'number' && Number.isFinite(issued) ? issued : 0,
      deletedAtMs: typeof deletedAt === 'number' && Number.isFinite(deletedAt) ? deletedAt : 0,
    })
  }
  return tombstones
}

/**
 * Whether `credential` is a sign-in the user made after deleting the account.
 *
 * A re-login is newer than the tombstone, so its issue time is the signal. Files
 * that carry no issue time cannot be ordered, and for those a different token is
 * the only evidence of a new sign-in.
 *
 * The same token never ends it, whatever stamp the copy carries: a superseded
 * snapshot the client still keeps is that same sign-in lying in another file, and
 * a tolerant comparison (same stamp within a few minutes) let one of them bring a
 * deleted account back the moment the build allowed it. An older-issued token is
 * not a re-login either, which is why the comparison stays strict: a genuine
 * re-login is issued after the deleted one, and the alternative — accepting a
 * slightly older stamp as “close enough” — cannot tell it apart from the next
 * snapshot down the stack.
 */
function endsTombstone(tombstone: DeletedSignIn, credential: WorkBuddyCredential): boolean {
  if (tokenDigest(credential.accessToken) === tombstone.tokenDigest) return false
  const issued = credential.lastRefreshAtMs ?? 0
  // Only two dated copies can be ordered. An undated one is decided by its name:
  // the live file is what the app writes on a sign-in, and every other name is a
  // copy it left behind, where an older build's snapshot carries no issue time and
  // would otherwise undo a delete.
  if (tombstone.lastRefreshAtMs > 0 && issued > 0) return issued > tombstone.lastRefreshAtMs
  // The deleted sign-in had no issue time, so its own stamp says nothing. A dated
  // replacement minted after the delete is a re-login whatever file it lands in:
  // "Add account" writes into the pool's directory, which is not a live file, and
  // an account re-added that way stayed out of the pool forever.
  if (tombstone.lastRefreshAtMs === 0 && issued > 0) return issued >= tombstone.deletedAtMs
  return isLiveAuthFile(credential.sourcePath)
}

/**
 * Whether `sourcePath` sits inside the directory the plugin writes into.
 *
 * A walk that escapes the root is not inside it, and `..` is how a path gets
 * there. An empty walk means the path IS the directory.
 */
function ownSignInPath(sourcePath: string, ownDir: string): boolean {
  if (ownDir === '' || sourcePath === '') return false
  const walked = relative(resolve(ownDir), resolve(sourcePath))
  return walked !== '' && !walked.startsWith('..') && !isAbsolute(walked)
}

export function workbuddyAccountId(
  credential: Pick<WorkBuddyCredential, 'uin' | 'uid' | 'nickname' | 'sourcePath'>,
): string {
  // The source path is the last resort so two sign-ins with no identity at all
  // stay two accounts: a shared constant hashed them into one pool entry and
  // silently dropped the second.
  const stable = credential.uin ?? credential.uid ?? credential.nickname ?? `path:${credential.sourcePath}`
  return createHash('sha256').update(`workbuddy\0${stable}`).digest('hex').slice(0, 16)
}

/** Human label; the nickname alone, so the pool reads as names rather than keys. */
function accountLabel(credential: WorkBuddyCredential): string {
  return credential.nickname ?? 'WorkBuddy'
}

/**
 * Whether a credential can no longer serve a request at all.
 *
 * Only a token that has already died AND that carries nothing to renew it with.
 * A credential with no recorded expiry is live (`expiresAtMs <= 0` is the
 * sentinel for "the file did not say"), and one that is merely near its expiry
 * is renewed by `ensureFresh` before the request is spent on it.
 */
function credentialUnusable(credential: WorkBuddyCredential, now: number): boolean {
  if (credential.expiresAtMs <= 0 || credential.expiresAtMs > now) return false
  return credential.refreshToken === ''
}

/**
 * Give the accounts that read alike a uid prefix, and leave the rest clean.
 *
 * The prefix is what tells two accounts apart, so it is worth its width only
 * where there is something to tell apart. Two sign-ins can share a nickname,
 * and a credential with none falls back to `WorkBuddy`, which makes every
 * nickname-less account identical. Every other row keeps the name the user
 * knows it by.
 */
function disambiguateLabels(accounts: readonly WorkBuddyAccount[]): void {
  const counts = new Map<string, number>()
  for (const account of accounts) counts.set(account.label, (counts.get(account.label) ?? 0) + 1)
  for (const account of accounts) {
    if ((counts.get(account.label) ?? 0) < 2) continue
    const discriminator = (account.credential.uid ?? account.credential.uin ?? '').slice(0, 8)
    if (discriminator !== '') account.label = `${account.label}#${discriminator}`
  }
}

/**
 * Credential files in one auth directory, freshest first.
 *
 * Every `*.info` file counts, not just the timestamped `workbuddy-desktop.*`
 * snapshots: the international client signs in as `workbuddy-desktop-ai.info`
 * (a hyphen, not a dot), so a prefix test silently dropped every global
 * credential and the global provider then saw an empty pool.
 *
 * Filenames are plain strings, and the ordering here is only a first pass —
 * `isFresher` makes the real call once each file has been parsed.
 */
async function authFilesIn(dir: string): Promise<string[] | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Unreadable is not "empty": the caller keeps accounts it already has from here.
    return undefined
  }
  const files = entries.filter(name => name.endsWith('.info'))
  // Newest snapshot first so the freshest token wins when uids collide.
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  return files.map(name => join(dir, name))
}

/**
 * One credential file's reading.
 *
 * `sealed` is not `absent`: a 5.6+ sign-in whose `$wbEncrypted` fields cannot be
 * opened because the at-rest key is not available right now. The file is intact
 * and the account was usable a moment ago, so the pool keeps the incumbent
 * instead of reporting an empty pool.
 */
type CredentialRead =
  | { kind: 'credential'; credential: WorkBuddyCredential }
  | { kind: 'sealed' }
  | { kind: 'absent' }

/** True when the document's access token is a `$wbEncrypted` envelope. */
function sealedAccessToken(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const document = parsed as Record<string, unknown>
  const auth = typeof document['auth'] === 'object' && document['auth'] !== null
    ? document['auth'] as Record<string, unknown>
    : document
  return isEncryptedFieldWrapper(auth['accessToken'])
}

async function readCredential(path: string): Promise<CredentialRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { kind: 'absent' }
  }
  const decrypt = text.includes('"$wbEncrypted"') ? await encryptedFieldOpener() : undefined
  const credential = parseWorkBuddyAuth(text, path, decrypt)
  if (credential !== undefined) return { kind: 'credential', credential }
  if (sealedAccessToken(text)) return { kind: 'sealed' }
  return { kind: 'absent' }
}


/** Refresh a credential this long before its expiry, so a request never rides one that dies mid-flight. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000
/**
 * Oldest a sign-in the plugin itself wrote may get before it is renewed, weeks
 * of lifetime left or not.
 *
 * An expiry-based lead cannot do this job. The upstream revokes a session
 * without rewriting the token's `expiresAt`, so an account the user signed out
 * of still claims weeks of life: a lead of any size waits for an expiry that
 * never arrives, and the dead sign-in is only discovered when a request rides
 * it. Renewing on age instead means the renewal is visible in the panel, and a
 * sign-in the upstream no longer honours surfaces within this window rather
 * than at expiry.
 *
 * Only the plugin's own sign-ins qualify. A credential read out of the desktop
 * app's directory belongs to that app: it refreshes it, and a renewal here would
 * be discarded by the next scan while still spending an upstream call. Once a
 * desktop sign-in has been renewed here the copy in force is the plugin's own,
 * which is what keeps an account whose session ran out under this window.
 *
 * Six hours: short enough that a revoked session is noticed the same day, long
 * enough that the cost stays at one lightweight POST per account per window.
 */
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000
/**
 * Longest one penalize may cool an account: same 2h ceiling as the parse
 * layer, so a raw caller-supplied timestamp cannot sleep a pool all day.
 *
 * A hold the pool itself decides is exempt: a spent account or a dead session
 * does not come back on its own, and clamping it to two hours put the account
 * back at the head of the queue while it was still unusable. The exemption is
 * keyed on the caller naming a hold rather than a timestamp, so no untrusted
 * value can reach it.
 */
const PENALIZE_CAP_MS = 2 * 60 * 60 * 1000
/**
 * How long a hold the pool decided itself keeps an account out of rotation.
 *
 * Neither condition behind a hold clears by itself: the credit balance has to
 * change, or the user has to sign in again. The configured cooldown window is
 * sized for a limit that expires, and using it here put a held account back at
 * the head of the queue every minute, where it failed again and burned the
 * attempts of the healthy accounts behind it. A hold is a fallback, not a
 * verdict: a manual cooldown reset, a re-scan and a balance read that finds
 * credits again all release it.
 */
export const POOL_HOLD_MS = 6 * 60 * 60 * 1000
/**
 * What a read on an account whose sign-in the upstream refuses is answered with
 * while the hold stands.
 *
 * The upstream's own sentence names a stale sign-in and sends the reader to the
 * connection check, which is right for the first refusal and noise on every
 * poll after it: the hold is the plugin's own statement that this account needs
 * a new sign-in, and it is the one the panel shows until one arrives.
 */
const REFUSED_SIGN_IN_MESSAGE =
  'this account\'s sign-in was refused by the upstream and its refresh token is spent; ' +
  'sign in again in the WorkBuddy desktop app'
/**
 * Live per-model cooldown keys kept per account.
 *
 * The key is whatever model string the request carried, so a client that
 * sprays distinct ids could otherwise grow one map per account forever.
 */
const MAX_MODEL_COOLDOWN_KEYS = 128
/**
 * How far a repeated limit may stretch the configured window, and how many times
 * it may double first.
 *
 * One `usage exceeds frequency limit` is the commonest answer the upstream
 * sends, and returning the account after the configured minute put it straight
 * back into the same wall for as long as the window lasted: every attempt spent
 * an upstream call to learn nothing. Doubling from the user's own window keeps
 * their setting in charge of the first retry and only stretches the ones that
 * keep failing, which is the escalation the reference proxy settled on after the
 * same incident.
 */
const RATE_LIMIT_STREAK_CAP = 15 * 60 * 1000
const RATE_LIMIT_STREAK_STEPS = 4
/**
 * How close two failures have to be to count as consecutive.
 *
 * Without this the count is a lifetime total: one failure hours ago plus another
 * today would sit at the cap forever, and every future one would open at the
 * longest window. The reference proxy names that exact shape as the bug that made
 * a working credential look broken.
 *
 * It has to outlast `RATE_LIMIT_STREAK_CAP`, or the top of the ladder cancels
 * itself: the account cannot be tried again until that window has passed, so it
 * would always come back to a count of one and the cap would apply once per
 * cycle instead of holding a persistently limited account back.
 */
const RATE_LIMIT_STREAK_WINDOW_MS = RATE_LIMIT_STREAK_CAP * 2

/** Drop expired per-model cooldowns and blocks, then cap what is left, soonest first. */
function pruneModelCooldowns(account: WorkBuddyAccount, now: number): void {
  for (const table of [account.modelCooldowns, account.modelBlocks]) {
    for (const [modelId, until] of Object.entries(table)) {
      if (until <= now) delete table[modelId]
    }
  }
  const keys = Object.keys(account.modelCooldowns)
  if (keys.length <= MAX_MODEL_COOLDOWN_KEYS) return
  keys.sort((a, b) => (account.modelCooldowns[a] ?? 0) - (account.modelCooldowns[b] ?? 0))
  for (const key of keys.slice(0, keys.length - MAX_MODEL_COOLDOWN_KEYS)) {
    delete account.modelCooldowns[key]
  }
}

/**
 * Directory the plugin writes its own sign-ins into.
 *
 * A login the panel starts lands here rather than in the desktop app's auth
 * directory: the app owns that directory and indexes the files it wrote, so a
 * foreign `.info` beside them is a file nothing maintains. This one is scanned
 * on the same terms as the vendor's, so an account added from the panel is an
 * ordinary pool account, and it disappears only when the user removes it.
 */
export function ownSignInDir(dataPath: string): string {
  return dataPath === '' ? '' : join(dataPath, OWN_SIGN_IN_DIRNAME)
}

/**
 * The sign-in document fields one credential spells, in the vocabulary
 * `writeOwnSignIn` takes.
 *
 * `OwnSignIn` spells "the upstream did not say" as the empty string and a parsed
 * credential spells it as an absent field; coalescing here keeps that meeting
 * point in one place rather than in every writer.
 */
function ownSignInOf(credential: WorkBuddyCredential): OwnSignIn {
  return {
    region: regionOf(credential.domain),
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs,
    domain: credential.domain,
    ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
    uid: credential.uid ?? '',
    uin: credential.uin ?? '',
    enterpriseId: credential.enterpriseId ?? '',
    nickname: credential.nickname ?? '',
  }
}

/**
 * Write one panel-added sign-in as a `.info` file the scan reads back.
 *
 * The shape is the desktop app's own, so `parseWorkBuddyAuth` opens it with no
 * special case. The file name carries the billing identity: re-adding the same
 * account rewrites its own file instead of leaving a second copy behind, and
 * two accounts never collide on a name.
 */
export async function writeOwnSignIn(
  directory: string,
  signIn: OwnSignIn,
): Promise<string> {
  const stable = signIn.uin === '' ? signIn.uid : signIn.uin
  const suffix = stable === '' ? randomUUID() : stable.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  const file = join(directory, `${OWN_SIGN_IN_PREFIX}${suffix === '' ? randomUUID() : suffix}.info`)
  await mkdir(directory, { recursive: true })
  await writeFile(file, JSON.stringify({
    auth: {
      accessToken: signIn.accessToken,
      refreshToken: signIn.refreshToken,
      expiresAt: signIn.expiresAtMs,
      domain: signIn.domain,
      lastRefreshTime: signIn.lastRefreshAtMs ?? Date.now(),
    },
    account: {
      ...signIn.uid === '' ? {} : { uid: signIn.uid },
      ...signIn.uin === '' ? {} : { uin: signIn.uin },
      ...signIn.enterpriseId === '' ? {} : { enterpriseId: signIn.enterpriseId },
      ...signIn.nickname === '' ? {} : { nickname: signIn.nickname },
    },
  }, null, 2), { mode: 0o600 })
  return file
}

/**
 * Rewrite one of the plugin's own sign-in files with a renewed token.
 *
 * Read-modify-write of the document that is already there, so the identity
 * fields the vendor's own parser looks for survive untouched and only the three
 * auth values a refresh replaces are written. Atomic for the same reason as the
 * archive: a truncated `.info` is an account the scan cannot open.
 */
export async function renewOwnSignInFile(file: string, credential: WorkBuddyCredential): Promise<void> {
  const document = JSON.parse(await readFile(file, 'utf8')) as { auth?: Record<string, unknown> }
  const auth = document.auth ?? {}
  auth.accessToken = credential.accessToken
  auth.refreshToken = credential.refreshToken
  auth.expiresAt = credential.expiresAtMs
  auth.lastRefreshTime = credential.lastRefreshAtMs ?? Date.now()
  document.auth = auth
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
    await rename(temporary, file)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}
/**
 * Soonest future one-off expiry. Missing or past sorts last. None left -> list head.
 *
 * Strict soonest-first, not a weighted spread: this mode exists so a pack about to
 * lapse is the one that gets spent, and a pool of two or three accounts has
 * nothing to spread. The burst this could cause is bounded by `available`, which
 * drops an account the moment the upstream limits it, so the next request already
 * goes elsewhere. The reference proxy weights the share instead, because it runs
 * enough accounts that one of them would otherwise absorb every request; adopting
 * that here would trade away the guarantee the user picked the mode for.
 */
function pickSoonestExpiry<T extends { id: string }>(
  pool: readonly T[],
  expiryMs: ReadonlyMap<string, number>,
  now: number,
): T | undefined {
  let best: T | undefined
  let bestAt = Infinity
  for (const account of pool) {
    const at = expiryMs.get(account.id)
    if (at === undefined || at <= now) continue
    if (at < bestAt) {
      best = account
      bestAt = at
    }
  }
  return best ?? pool[0]
}

export function candidateAuthDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs: string[] = []
  const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV])
  if (override !== undefined) {
    // The env var may name the file or its directory; accept both.
    dirs.push(override.toLowerCase().endsWith('.info') ? resolve(override, '..') : override)
  }
  dirs.push(...defaultDesktopAuthDirs())
  return dirs
}

/**
 * True when two directory lists name the same places.
 *
 * Order does not matter: discovery walks them in order, so only the SET decides
 * whether the accounts already held can still be valid.
 */
function sameDirs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((dir) => b.includes(dir))
}

/**
 * Read the credential archive: id → credential.
 *
 * A missing file is an empty archive. A read error or a damaged document
 * throws, so the writer leaves the file alone instead of saving an empty one
 * over every sign-in it still holds.
 */
async function readArchivedCredentials(file: string): Promise<Map<string, WorkBuddyCredential>> {
  const stored = new Map<string, WorkBuddyCredential>()
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return stored
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('credential archive is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return stored
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return stored
  const horizon = Date.now() - ARCHIVE_RETENTION_MS
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record['id'] !== 'string' || record['id'] === '') continue
    if (typeof record['accessToken'] !== 'string' || record['accessToken'] === '') continue
    // Retention is measured from when the credential stops being usable at all,
    // not from when this file was last written: every archive write rewrites
    // the whole document, so a write-time stamp would never expire anything.
    const expiresAt = typeof record['expiresAtMs'] === 'number' ? record['expiresAtMs'] : 0
    const refreshExpiresAt = typeof record['refreshExpiresAtMs'] === 'number' ? record['refreshExpiresAtMs'] : 0
    // Zero is the sentinel for "the sign-in document did not say", not a date in
    // 1970. Treating it as one dropped every credential without a stated expiry,
    // which is precisely the kind it is unsafe to drop: nothing else holds a copy.
    const lastUsable = Math.max(expiresAt, refreshExpiresAt)
    if (lastUsable > 0 && lastUsable < horizon) continue
    stored.set(record['id'], {
      accessToken: record['accessToken'],
      refreshToken: typeof record['refreshToken'] === 'string' ? record['refreshToken'] : '',
      expiresAtMs: typeof record['expiresAtMs'] === 'number' ? record['expiresAtMs'] : 0,
      ...typeof record['refreshExpiresAtMs'] !== 'number' ? {} : { refreshExpiresAtMs: record['refreshExpiresAtMs'] },
      ...typeof record['lastRefreshAtMs'] !== 'number' ? {} : { lastRefreshAtMs: record['lastRefreshAtMs'] },
      ...typeof record['nickname'] !== 'string' || record['nickname'] === '' ? {} : { nickname: record['nickname'] },
      ...typeof record['uin'] !== 'string' || record['uin'] === '' ? {} : { uin: record['uin'] },
      ...typeof record['uid'] !== 'string' || record['uid'] === '' ? {} : { uid: record['uid'] },
      ...typeof record['enterpriseId'] !== 'string' || record['enterpriseId'] === '' ? {} : { enterpriseId: record['enterpriseId'] },
      domain: typeof record['domain'] === 'string' ? record['domain'] : '',
      sourcePath: typeof record['sourcePath'] === 'string' ? record['sourcePath'] : '',
    })
  }
  return stored
}

/**
 * Write the archive, replacing the previous file only once the new one is whole.
 *
 * The write is what keeps an overwritten sign-in recoverable, so it must not
 * leave a truncated file behind if it is interrupted: temp file, then rename.
 * Only the archived credential is stored, not the raw sign-in document.
 */
async function writeArchivedCredentials(
  file: string,
  entries: ReadonlyMap<string, WorkBuddyCredential>,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const body = JSON.stringify({
    version: 1,
    entries: [...entries].map(([id, credential]) => ({
      id,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAtMs: credential.expiresAtMs,
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
      ...credential.lastRefreshAtMs === undefined ? {} : { lastRefreshAtMs: credential.lastRefreshAtMs },
      ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
      ...credential.uin === undefined ? {} : { uin: credential.uin },
      ...credential.uid === undefined ? {} : { uid: credential.uid },
      ...credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId },
      domain: credential.domain,
      sourcePath: credential.sourcePath,
    })),
  })
  // Unique per write, not per process: two writers sharing one temp path can
  // interleave into it and both rename the result.
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** How the pool chooses which account serves the next request. */
export type AccountDistribution = 'priority' | 'round-robin' | 'expiry' | 'sticky'

/** The condition behind a pool-decided hold. */
export type PoolHoldReason = 'spent' | 'session' | 'restricted'

/**
 * Why an account is not being served, as `unavailableReason` reports it.
 *
 * A union rather than a string so every reason is spelled in one place, and a
 * new one shows up where the gateway answers them; that answer function is still
 * updated by hand, and an unrecognised reason falls through to the generic 503.
 */
export type IneligibleReason =
  | 'removed'
  | 'switched off'
  | 'under its credit reserve'
  | 'sign-in expired'
  | 'other region'
  | 'sign-in refused'
  | 'restricted by the upstream'
  | 'on hold'
  | 'plan'
  | 'rate-limited'

/**
 * Why the pool itself is holding an account out of rotation, and until when.
 *
 * `spent` clears when a balance read finds credits again; `session` clears when
 * the user signs in again or resets the cooldowns. Keeping the two apart is
 * what stops a credits probe from un-holding an account whose chats are
 * refused. The deadline travels with the reason so a hold that has lapsed
 * cannot be mistaken for a live one when the next balance read arrives.
 */
export interface PoolHold {
  reason: PoolHoldReason
  /** Absolute ms after which the hold is no longer holding anything. */
  until: number
  /**
   * Every sign-in the account's own files held when the hold was put there.
   *
   * Recorded so a new sign-in can be recognised on its own evidence: the pool
   * releases `session` when a sign-in appears that was not there before, which is
   * the one thing a user re-login does and a token refresh does not. Adoption
   * cannot answer this — which copy of an account serves is decided by issue time
   * now, so a refresh that lands in a file looks like one — and a timestamp cannot
   * either, since it would compare this machine's clock with the one that issued
   * the sign-in.
   *
   * Never empty as this build writes it: the credential in force is always named,
   * so an account with no readable file has its archive token in here. The guard
   * that skips an empty set stays for a hold recorded by an older build.
   */
  heldSignIns: readonly string[]
}

export interface AccountPoolOptions {
  /** Logger for discovery and rotation events. */
  logger?: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error?(...args: unknown[]): void }
  /** Override the directories scanned (tests). */
  authDirs?: readonly string[]
  /**
   * Supplies the directory the pool may write its own credential archive into.
   *
   * Read-only discovery stays read-only; this is the plugin's data directory,
   * and without it the pool has nowhere to keep an account whose only sign-in
   * file the client overwrites on the next account switch. A function because
   * the host hands the path out after the pool exists.
   */
  dataPath?: () => string | undefined
  /** How long a rate-limited account stays out of rotation. */
  cooldownMs?: number
  /** Upstream client consulted to refresh near-expiry tokens. */
  client?: TokenRefresher
  /**
   * How requests are spread across the pool.
   *
   * - `priority` (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one
   *   account at a time, and a cooled account resumes at the head of the
   *   queue the moment its window resets.
   * - `round-robin`: consecutive requests rotate through the pool so the
   *   spend spreads evenly.
   * - `expiry`: the account whose one-off credit pack expires soonest.
   *   Monthly packs are ignored. No expiry data falls back to priority.
   * - `sticky`: one conversation stays on one account; the next new
   *   conversation takes the next account. The upstream prompt cache is
   *   per account, so changing accounts mid-conversation discards it.
   */
  distribution?: AccountDistribution
}

/**
 * Read-only pool of every discovered WorkBuddy account, with rate-limit
 * cooldown and round-robin failover.
 */
export class WorkBuddyAccountPool {
  private readonly logger: AccountPoolOptions['logger']
  private authDirs: readonly string[]
  private cooldownMs: number
  private readonly client: TokenRefresher | undefined
  private accounts: WorkBuddyAccount[] = []
  private distribution: AccountDistribution
  /**
   * Account ids the user switched off on the panel.
   *
   * Disabling is a user preference, not a property of the credential: scan()
   * rebuilds every account from the auth files, so the set has to be re-applied
   * from settings and only filters at pick time.
   */
  private disabledIds = new Set<string>()
  /** Cursor for round-robin and the next new sticky conversation. */
  private cursor = 0
  /** Sticky mode: conversation key → account id. Content stays out of memory. */
  private sticky = new Map<string, string>()
  private lastScanAtMs = 0
  private preferredIds = new Map<WorkBuddyRegion | undefined, string>()
  /**
   * Account ids the user removed from the pool for good.
   *
   * Enforced while scan() assembles its result, so a removed account cannot
   * re-enter the pool when the desktop app rewrites its sign-in file. That is
   * the difference from {@link disabledIds}, which leaves the account listed,
   * readable and restorable with one switch.
   */
  private removedIds = new Set<string>()
  /**
   * Per-account credit floor, keyed by account id. 0 (or absent) means "spend it
   * all".
   *
   * A reserve is protection, not a limit the upstream knows about: the pool
   * simply stops picking an account once its last known balance is at or below
   * the floor, so the user keeps a cushion for their own use.
   */
  private creditReserves = new Map<string, number>()
  /**
   * Last known credit balance per account.
   *
   * Fed by the panel's read-only probes. An account with no reading stays
   * usable: refusing to pick an account whose balance has not been checked yet
   * would strand a healthy pool, and the first 402 still cools it as before.
   */
  private creditBalances = new Map<string, number>()
  /** Supplies the archive directory; asked on each scan, not at construction. */
  private readonly dataPath: (() => string | undefined) | undefined
  /** Soonest remaining one-off pack, ms. Cleared when that pack is spent or past. */
  private creditExpiries = new Map<string, number>()
  private refreshInflight = new Map<string, Promise<KeepAliveOutcome>>()
  /** Tail of the archive's write chain; every archive write waits on it. */
  private archiveQueue: Promise<void> = Promise.resolve()
  /** The one scan in progress; concurrent callers await it instead of duplicating it. */
  private scanInflight: Promise<WorkBuddyAccount[]> | undefined
  /** Torn-down sign-ins, read on first use: a scan cannot resurrect what is here. */
  /**
   * Cached tombstones, with the file stamp they were read at.
   *
   * A second pool over the same data directory writes this file too. Serving a
   * cache read before that write and then writing it back verbatim dropped the
   * other pool's deletions, and a deleted account came back the next time the
   * client's snapshot was adopted. The stamp makes a write elsewhere visible.
   */
  private deletedSignIns: Map<string, DeletedSignIn> | undefined
  private deletedSignInsStamp: string | undefined
  /** The directories the in-flight scan is reading, so a repoint supersedes it. */
  private scanDirs: readonly string[] = []
  /**
   * Accounts whose "expired with no refresh token" warning has been logged.
   *
   * A credential with no expiry and no refresh token stays on the expiring path
   * forever, so without this the same warning fired on every request.
   */
  private noRefreshWarned = new Set<string>()
  /**
   * Accounts a hold the pool itself decided is keeping out of rotation, and why.
   *
   * Separate from `cooldownUntilMs` because the two are released by different
   * things: an upstream's rate-limit window expires on its own, while a hold
   * ends when the condition behind it changes. The reason is recorded because
   * the two conditions are not the same signal: a balance read finding credits
   * again says a spent account was topped up, and it says nothing about a
   * sign-in the upstream refuses. Releasing both on a balance meant a 401'ing
   * account went back to the head of the queue on every probe cycle.
   */
  private heldIds = new Map<string, PoolHold>()
  /**
   * Accounts the desktop client is signed into right now.
   *
   * The pool renews one of these into its own directory when the app's session
   * runs out, and serves that copy until the app writes a newer one. Renewing it
   * does not make it the pool's own account: the app still holds the session, and
   * a delete would hide the account from the pool while the user believed they
   * were removing something the plugin had added.
   */
  private appHeldIds: ReadonlySet<string> = new Set()
  /**
   * The sign-ins each account's own files hold, as of the last scan.
   *
   * Only the files the client and the panel write, not the archive: the archive
   * is rewritten whenever this process refreshes a token, so counting it would
   * turn every refresh into a "the user signed in again".
   */
  private signInTokens = new Map<string, WorkBuddyCredential[]>()
  /**
   * Sign-ins the upstream refused, per account.
   *
   * A refused token must not come back through the ranking: the copies are
   * compared by issue time, and a token the upstream rejected can be the newest
   * one (a re-login that did not work, a sign-in copied from another machine).
   * Without this the scan would serve it again, and the hold would look released
   * while the requests kept failing. Kept across scans, and
   * dropped once the sign-in is no longer on disk or the cooldowns are reset.
   */
  private refusedSignIns = new Map<string, readonly string[]>()
  constructor(options: AccountPoolOptions = {}) {
    this.logger = options.logger
    this.authDirs = options.authDirs ?? candidateAuthDirs()
    this.dataPath = options.dataPath
    this.cooldownMs = options.cooldownMs ?? 60_000
    // A zero, negative or non-finite window is not a cooldown, and the escalating
    // path multiplies this value: with one of those the account would read as not
    // cooling at all (or as cooling until an invalid Date that later throws).
    // `applyConfig` already refuses a window below a second from the settings; the
    // constructor is reached directly by tests and by the host's first build.
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs <= 0) this.cooldownMs = 60_000
    this.client = options.client
    // Priority is the default: users pool their own accounts to spend one
    // before touching the next, not to split every request evenly.
    this.distribution = options.distribution ?? 'priority'
  }

  /**
   * Re-apply configuration that only affects discovery and cooldown policy,
   * without rebuilding the pool. A later `scan()` uses the new auth dirs and
   * cooldown window; existing accounts keep their in-memory state.
   *
   * Answers whether the auth directory set changed, which is the one case that
   * empties the pool: the caller has to know, because nothing downstream reads
   * the disk on its own and the pool would otherwise stay empty until a chat
   * request happened to scan it.
   */
  applyConfig(options: {
    authDirs?: readonly string[]
    cooldownMs?: number
    distribution?: AccountDistribution
    /** Account ids switched off on the panel; the set is replaced wholesale. */
    disabledAccountIds?: readonly string[]
    /** Per-account credit floor, keyed by account id. Replaced wholesale. */
    creditReserves?: Readonly<Record<string, number>>
  }): boolean {
    let emptied = false
    if (options.authDirs !== undefined && options.authDirs.length > 0) {
      // Pointed somewhere else entirely, so nothing already in the pool can
      // still be valid: `scan()` seeds from the accounts it holds, which is what
      // keeps cooldowns across a rescan but would otherwise pin the pool to the
      // previous directory forever.
      if (!sameDirs(this.authDirs, options.authDirs)) {
        this.accounts = []
        emptied = true
      }
      this.authDirs = options.authDirs
    }
    if (options.cooldownMs !== undefined && options.cooldownMs >= 1000) {
      this.cooldownMs = options.cooldownMs
    }
    if (options.distribution !== undefined) {
      this.distribution = options.distribution
    }
    if (options.disabledAccountIds !== undefined) {
      this.disabledIds = new Set(options.disabledAccountIds)
    }
    if (options.creditReserves !== undefined) {
      const next = new Map<string, number>()
      for (const [id, value] of Object.entries(options.creditReserves)) {
        const floor = Number(value)
        if (id !== "" && Number.isFinite(floor) && floor > 0) next.set(id, Math.floor(floor))
      }
      this.creditReserves = next
    }
    return emptied
  }

  /** Remember an account's last known balance, from the panel's probe. */
  setCreditBalance(accountId: string, total: number, nearestExpiryMs?: number): void {
    if (!Number.isFinite(total) || total < 0) return
    this.creditBalances.set(accountId, total)
    // Spent or already past: forget it, or expiry mode stays stuck on an empty account.
    if (typeof nearestExpiryMs === 'number' && Number.isFinite(nearestExpiryMs) && nearestExpiryMs > Date.now()) {
      this.creditExpiries.set(accountId, nearestExpiryMs)
    } else {
      this.creditExpiries.delete(accountId)
    }
    // A balance that is there again is the one signal that a spent account has
    // been topped up. The hold the pool put on it for that reason is released
    // here; without this, the account stayed out of rotation for the whole hold
    // after the user had already fixed it, and the only way back was a manual
    // cooldown reset. A rate-limit cooldown is NOT released: it belongs to the
    // upstream's window, which a balance says nothing about.
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    const hold = this.heldIds.get(accountId)
    if (hold === undefined) return
    // A hold whose window has already lapsed is not holding anything: drop the
    // record rather than leaving an id that would clear a later, unrelated
    // cooldown the next time this balance is read.
    if (hold.until <= Date.now()) {
      this.heldIds.delete(accountId)
      return
    }
    if (hold.reason !== 'spent' || total <= 0) return
    this.heldIds.delete(accountId)
    // Only the hold this record describes is released. A rate-limit cooldown
    // that outlasts it belongs to the upstream's window and stays.
    if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0
    this.logger?.info?.(`${LOG_PREFIX}: ${account.label} has credits again; releasing the hold`)
  }

  /** True when a known balance has reached the floor set for this account. */
  private reserveHolds(accountId: string): boolean {
    const floor = this.creditReserves.get(accountId)
    if (floor === undefined || floor <= 0) return false
    const balance = this.creditBalances.get(accountId)
    return balance !== undefined && balance <= floor
  }

  /** Whether this account was switched off on the panel. */
  isDisabled(accountId: string): boolean {
    return this.disabledIds.has(accountId)
  }

  /**
   * Replace the permanent removal list.
   *
   * The list only filters what is handed out, so both directions take effect at
   * once: a removed account disappears without a rescan, and restoring one does
   * not wait for the next scan to bring it back.
   */
  applyRemoved(ids: Iterable<string>): void {
    this.removedIds = new Set(ids)
  }

  /**
   * True when this account's sign-in is one the plugin wrote, so it may be
   * deleted. The panel asks before it offers the button: deleting a desktop
   * app's own sign-in would sign the user out of that app.
   *
   * A refreshed desktop sign-in does not qualify. The pool holds a copy of it
   * after a renewal, but the app is still signed in, so the row stays out of
   * reach: removing it would suppress an account the user only ever added to the
   * app, and nothing on that row says so.
   */
  ownsSignIn(accountId: string): boolean {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined || this.appHeldIds.has(accountId)) return false
    return this.isOwnSignInPath(account.credential.sourcePath)
  }

  /**
   * Delete one account's sign-in, and its archive entry with it.
   *
   * Two things have to go, not one: the archive keeps a copy of every
   * credential a walk has seen and reads it back for every directory the walk
   * can still read, which includes the plugin's own. Deleting only the file
   * would bring the account straight back on the next scan.
   *
   * Only a sign-in this plugin wrote is removable. The desktop app owns its own
   * directory, and a file deleted there takes the user's session in that app
   * down with it, so anything outside the plugin's own directory is refused
   * rather than attempted. Answers false for an unknown account too, so the
   * caller reports a refusal instead of treating it as done.
   */
  async removeOwnSignIn(accountId: string): Promise<boolean> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return false
    if (!this.ownsSignIn(accountId)) return false
    // Let a scan that is already reading the directories finish first. Its copy
    // of this sign-in is queued for the archive, and an archive write queued
    // behind the drop below would put the entry back - the file gone, the
    // account still listed on the next scan.
    //
    // Waiting without a limit is not an option: a cold scan can sit in the at-rest
    // key fetch for half a minute, and the host kills a panel call at 30 s. The
    // delete would then be reported as failed while the unlink had already run,
    // and the row would stay on screen. Past this budget the delete goes ahead and
    // the entry is dropped again once that scan settles, which is the same
    // ordering, just taken on the other side.
    const running = this.scanInflight
    // Torn down before anything else, including that wait. The account's token is
    // still in the archive and its snapshot still in the client's directory, and a
    // walk that got past the tombstone check before this point would put the
    // account straight back on assignment.
    const known = (await this.loadDeletedSignIns()).has(account.id)
    // A delete whose tombstone could not be recorded is not a delete: the file is
    // about to go, and the only thing that keeps the client's copy from taking the
    // account back is that record. Reporting success would leave a row that
    // returns after the next restart.
    if (!await this.rememberDeletedSignIn(account.id, account.credential)) {
      throw new Error('could not record the deleted sign-in')
    }
    if (running !== undefined) {
      const settled = await raceWithTimeout(running.catch(() => {}), DELETE_SCAN_WAIT_MS)
      if (!settled) void running.catch(() => {}).then(() => this.forgetArchived(account.id))
    }
    // Already gone is success: the point is that no sign-in is left, and a
    // second delete must not read as a failure.
    try {
      await unlink(account.credential.sourcePath)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // The file is still there, so the delete failed and the row has to stay.
        // Keeping the tombstone wrote it anyway: the next scan would hide the
        // account while the panel had just reported the delete as failed, and the
        // file left behind would bring it back once the tombstone was gone.
        if (!known) {
          ;(await this.loadDeletedSignIns()).delete(account.id)
          await this.writeDeletedSignIns([account.id])
        }
        throw error
      }
    }
    await this.forgetArchived(account.id)
    // Dropped from the pool here, not on the next walk. The credential in memory
    // is one whose file is gone, and until a walk replaces the list it outranks
    // every copy a walk finds: the row came straight back after a delete, serving
    // a token the user asked to be rid of.
    this.forgetAccount(account.id)
    return true
  }

  /** Drop one account and everything the pool remembers about it. */
  private forgetAccount(accountId: string): void {
    this.accounts = this.accounts.filter(item => item.id !== accountId)
    // The warn-once flag is keyed by id, so a re-sign-in later must be able to
    // warn again. The balances and check-in state are dropped with the account:
    // a balance and an expiry that outlive their account are inherited by the
    // next sign-in under the same id, which then reads as unpickable on a
    // reserve floor nobody set for it.
    this.noRefreshWarned.delete(accountId)
    this.creditBalances.delete(accountId)
    this.creditExpiries.delete(accountId)
    this.heldIds.delete(accountId)
    this.signInTokens.delete(accountId)
    this.refusedSignIns.delete(accountId)
  }

  /**
   * Record one deleted sign-in, so no later scan puts the account back.
   *
   * The file is written before the delete is reported: a tombstone that only
   * lived in memory would be gone after a restart, and the snapshot it has to
   * hold off is still sitting in the client's directory.
   */
  private async rememberDeletedSignIn(id: string, credential: WorkBuddyCredential): Promise<boolean> {
    const tombstones = await this.loadDeletedSignIns()
    const previous = tombstones.get(id)
    tombstones.set(id, {
      tokenDigest: tokenDigest(credential.accessToken),
      lastRefreshAtMs: credential.lastRefreshAtMs ?? 0,
      deletedAtMs: Date.now(),
    })
    if (await this.writeDeletedSignIns()) return true
    // The write failed, so the delete is not going to happen. Leaving the entry in
    // the set would hide the account on the next scan anyway, while the panel had
    // just reported the delete as failed.
    if (previous === undefined) tombstones.delete(id)
    else tombstones.set(id, previous)
    return false
  }

  /**
   * Read the tombstones, re-reading when the file changed underneath us.
   *
   * Nothing is pruned by age. A deleted sign-in's copy is still lying in the
   * client's directory until the client overwrites it, so a tombstone that
   * expired would bring that copy straight back, refresh token included.
   */
  private async loadDeletedSignIns(): Promise<Map<string, DeletedSignIn>> {
    const file = this.deletedSignInsFile()
    const stamp = file === undefined ? '' : await signInFileStamp(file)
    if (this.deletedSignIns !== undefined && this.deletedSignInsStamp === stamp) return this.deletedSignIns
    if (file === undefined) {
      this.deletedSignInsStamp = ''
      this.deletedSignIns = new Map()
      return this.deletedSignIns
    }
    try {
      const tombstones = await readDeletedSignInsFile(file)
      this.deletedSignInsStamp = stamp
      this.deletedSignIns = tombstones
      return tombstones
    } catch (error: unknown) {
      // A file that is there but unreadable is not "no deleted sign-ins": keeping
      // the set we already have is what stops the next scan from adopting every
      // account the user deleted, and stops the next write from persisting an
      // empty set over theirs. The stamp is left unrecorded so the read is retried.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.deletedSignInsStamp = stamp
        this.deletedSignIns = new Map()
        return this.deletedSignIns
      }
      this.logger?.warn?.(`${LOG_PREFIX}: could not read the deleted sign-ins: ${String(error)}`)
      return this.deletedSignIns ?? new Map()
    }
  }

  /**
   * Persist the tombstone set; the caller has already updated the map.
   *
   * What is on disk is merged in first, except for the ids this call is removing:
   * a second pool over the same data directory writes this same file, and writing
   * our map verbatim dropped a delete it had already recorded. The removals are the
   * other half of that: a re-login ends a tombstone and a failed delete rolls one
   * back, and a pure union put both straight back.
   *
   * Answers false when the file could not be written, so a delete can refuse to
   * report success on a state it could not record.
   */
  private async writeDeletedSignIns(removed: readonly string[] = []): Promise<boolean> {
    const tombstones = this.deletedSignIns
    const file = this.deletedSignInsFile()
    if (tombstones === undefined || file === undefined) return true
    let written = false
    await withFileLock(`${file}.lock`, async () => {
      const onDisk = await readDeletedSignInsFile(file).catch(() => new Map<string, DeletedSignIn>())
      for (const [id, entry] of onDisk) {
        if (removed.includes(id)) continue
        const ours = tombstones.get(id)
        if (ours === undefined || entry.deletedAtMs > ours.deletedAtMs) tombstones.set(id, entry)
      }
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(temporary, JSON.stringify({ version: 1, entries: Object.fromEntries(tombstones) }, null, 2), { mode: 0o600 })
        await rename(temporary, file)
        this.deletedSignInsStamp = await signInFileStamp(file)
        written = true
      } catch (error: unknown) {
        await unlink(temporary).catch(() => {})
        this.logger?.warn?.(`${LOG_PREFIX}: could not record the deleted sign-ins: ${String(error)}`)
      }
    })
    return written
  }

  private deletedSignInsFile(): string | undefined {
    const directory = this.dataPath?.()
    return directory === undefined || directory === '' ? undefined : join(directory, DELETED_SIGN_INS_FILENAME)
  }

  /** Whether the pool recorded this sign-in as refused by the upstream. */
  private signInRefused(id: string, token: string): boolean {
    if (this.refusedSignIns.get(id)?.includes(token) ?? false) return true
    // A live session hold names the sign-ins it was put there for; those are
    // exactly the ones a later scan must not prefer over a copy nobody refused.
    const hold = this.heldIds.get(id)
    return hold?.reason === 'session' && hold.heldSignIns.includes(token)
  }

  /**
   * Every sign-in a refusal could have named for this account.
   *
   * The files the last walk read, plus the credential in force when it came from
   * somewhere else (the archive, or a token this process minted before it was
   * written to disk). Naming only the files left an account served from the
   * archive with an empty proof, and a hold with an empty proof is released by
   * the first scan that follows it.
   */
  private refusedSignInsFor(id: string): string[] {
    const tokens = (this.signInTokens.get(id) ?? []).map(entry => entry.accessToken)
    const inForce = this.accounts.find(account => account.id === id)?.credential.accessToken
    if (inForce !== undefined && inForce !== '' && !tokens.includes(inForce)) tokens.push(inForce)
    return tokens
  }

  /** Whether `sourcePath` sits inside the directory the plugin writes into. */
  private isOwnSignInPath(sourcePath: string): boolean {
    return ownSignInPath(sourcePath, ownSignInDir(this.dataPath?.() ?? ''))
  }

  /**
   * Take over the sign-ins the desktop client left behind.
   *
   * The client keeps one live sign-in and a stack of superseded snapshots beside
   * it. A snapshot's token is a session the client itself stopped using, so
   * nothing renews it: it serves until its access token expires and then the
   * account is gone, holding a refresh token the client's own rotation already
   * spent. Copying it into the directory the plugin writes makes it the
   * plugin's account, renewed by the same age rule a panel-added sign-in gets,
   * so the account outlives the snapshot it came from.
   *
   * Only a superseded snapshot is taken over. The live sign-in stays the
   * client's: it refreshes it, and a second holder of the same session
   * refreshing on its own schedule is how both end up with a spent refresh
   * token. An account the client is signed into is skipped for the same reason.
   */
  private async adoptOrphanedSignIns(
    found: readonly WorkBuddyCredential[],
    tornDown: ReadonlySet<string>,
  ): Promise<WorkBuddyCredential[]> {
    const directory = ownSignInDir(this.dataPath?.() ?? '')
    if (directory === '') return []
    const liveIds = new Set<string>()
    const ownedIds = new Set<string>()
    for (const credential of found) {
      const id = workbuddyAccountId(credential)
      if (isLiveAuthFile(credential.sourcePath)) liveIds.add(id)
      else if (ownSignInPath(credential.sourcePath, directory)) ownedIds.add(id)
    }
    const adopted: WorkBuddyCredential[] = []
    for (const credential of found) {
      if (isLiveAuthFile(credential.sourcePath)) continue
      if (ownSignInPath(credential.sourcePath, directory)) continue
      const id = workbuddyAccountId(credential)
      // The client is signed into this account, the plugin already holds a copy of
      // it, or the user deleted it: either way there is nothing to take over.
      if (liveIds.has(id) || ownedIds.has(id) || tornDown.has(id)) continue
      // Without an identity the pool key falls back to the source path, so the
      // copy would be a different account on every scan and the pool would grow
      // without bound. Such a snapshot keeps serving from where it lies.
      if ((credential.uin ?? credential.uid ?? credential.nickname ?? '') === '') continue
      let file: string
      try {
        // The document said nothing about when this token was issued, and this
        // build must not invent a date for it: the ranking trusts a date on a copy
        // the plugin wrote, so an invented one made a superseded snapshot outrank
        // the session the app is signed into once the user went back to it.
        file = await writeOwnSignIn(directory, { ...ownSignInOf(credential), lastRefreshAtMs: credential.lastRefreshAtMs ?? 0 })
      } catch (error: unknown) {
        // A snapshot the plugin could not copy is still a snapshot: it keeps
        // serving from where it lies, exactly as before.
        this.logger?.warn?.(`${LOG_PREFIX}: could not take over ${accountLabel(credential)}: ${String(error)}`)
        continue
      }
      ownedIds.add(id)
      adopted.push({ ...credential, sourcePath: file })
    }
    return adopted
  }

  /**
   * Write a renewed token back into the sign-in file it was read from.
   *
   * Best effort: a failed write costs the renewal its persistence, never the
   * request already in flight. Anything that did not come from the plugin's own
   * directory is left alone - the desktop app owns its files.
   */
  private async renewOwnSignIn(credential: WorkBuddyCredential): Promise<void> {
    if (this.isOwnSignInPath(credential.sourcePath)) {
      try {
        await renewOwnSignInFile(credential.sourcePath, credential)
      } catch (error: unknown) {
        this.logger?.warn?.(
          `${LOG_PREFIX}: could not write the renewed token back for ${credential.nickname ?? credential.uid}: ${String(error)}`,
        )
      }
      return
    }
    // The rotation was just spent on a copy the plugin does not own: a desktop
    // sign-in it read, or one the archive handed back. Keeping the result in the
    // archive alone left the plugin's own copy of that account one rotation
    // behind, and the next scan served that dead copy until the account was
    // marked as needing a sign-in. Writing the token into the directory the pool
    // maintains claims the account with the token that was just minted.
    const directory = ownSignInDir(this.dataPath?.() ?? '')
    if (directory === '') return
    try {
      credential.sourcePath = await writeOwnSignIn(directory, ownSignInOf(credential))
    } catch (error: unknown) {
      this.logger?.warn?.(
        `${LOG_PREFIX}: could not keep the renewed token for ${credential.nickname ?? credential.uid}: ${String(error)}`,
      )
    }
  }

  /**
   * Drop one account from the credential archive.
   *
   * On the same queue as every other archive write: this is a read-modify-write
   * of one document, and a delete that raced a scan's write would otherwise be
   * overwritten by it.
   */
  private async forgetArchived(id: string): Promise<void> {
    const file = this.archiveFile()
    if (file === undefined) return
    const run = this.archiveQueue.then(async () => {
      const stored = await readArchivedCredentials(file)
      if (!stored.delete(id)) return
      await writeArchivedCredentials(file, stored)
    })
    this.archiveQueue = run.catch(() => {})
    try {
      await run
    } catch (error: unknown) {
      // The file is already gone at this point, so a failed archive write means
      // the account comes back on the next scan. Loud rather than silent: the
      // user was told it was deleted.
      this.logger?.warn?.(`${LOG_PREFIX}: could not drop ${id} from the credential archive: ${String(error)}`)
    }
  }

  /** Drop every account, e.g. when the source is switched off. A later `scan()` rebuilds from disk. */
  clear(): void {
    this.accounts = []
    this.appHeldIds = new Set()
  }

  /** Rescan the auth directories and merge newly discovered accounts. */
  async scan(): Promise<WorkBuddyAccount[]> {
    // The chat path calls this whenever the pool is empty, and without the guard
    // every concurrent request started its own walk of the auth directories,
    // each with its own at-rest key fetch. The walk in flight is reused only
    // while it reads the same directories: `applyConfig` empties the pool the
    // moment `authFile` is repointed, and a walk that started before that would
    // otherwise end by writing the previous directory's accounts back over the
    // clear.
    const dirs = this.scanDirsFor(this.authDirs)
    if (this.scanInflight !== undefined && sameDirs(this.scanDirs, dirs)) return this.scanInflight
    const inflight = this.scanOnce(dirs).finally(() => {
      // The identity check keeps a superseded walk's exit from clearing the
      // walk that replaced it.
      if (this.scanInflight === inflight) {
        this.scanInflight = undefined
        this.scanDirs = []
      }
    })
    this.scanDirs = dirs
    this.scanInflight = inflight
    return inflight
  }

  /**
   * The directories a walk reads: the configured ones plus the plugin's own.
   *
   * The pool writes sign-ins into its own directory (a renewal it claims, an
   * account it takes over), so it has to read that directory too, whether or not
   * the host listed it. Read in both places through this one function: a set that
   * disagreed with itself read as "the auth directories were repointed mid-walk"
   * and threw the whole walk away.
   */
  private scanDirsFor(authDirs: readonly string[]): string[] {
    const dirs = [...authDirs]
    const own = ownSignInDir(this.dataPath?.() ?? '')
    if (own !== '' && !dirs.some(dir => resolve(dir) === resolve(own))) dirs.push(own)
    return dirs
  }

  /**
   * Keep the credentials this walk saw, so an account whose only file the client
   * overwrites on the next sign-in still has a copy to be read back from.
   *
   * Best effort by design: a failed write costs the archive, never the scan.
   */
  private async archiveCredentials(credentials: readonly WorkBuddyCredential[]): Promise<void> {
    const file = this.archiveFile()
    if (file === undefined || credentials.length === 0) return
    const ownDir = ownSignInDir(this.dataPath?.() ?? '')
    // Serialized: this is a read-modify-write of one document, and two scans can
    // overlap when the auth directories are repointed mid-walk. Interleaved
    // writers overwrite each other's entries, and a half-written archive reads
    // back as empty, which would cost every archived account at once.
    const run = this.archiveQueue.then(async () => {
      const stored = await readArchivedCredentials(file)
      let changed = false
      for (const credential of credentials) {
        const id = workbuddyAccountId(credential)
        const previous = stored.get(id)
        if (previous !== undefined && !isFresher(credential, previous, ownDir)) continue
        stored.set(id, credential)
        changed = true
      }
      if (changed) await writeArchivedCredentials(file, stored)
    })
    // The queue must survive a failed write, or every later archive write would
    // be skipped as if one were still running.
    this.archiveQueue = run.catch(() => {})
    try {
      await run
    } catch (error: unknown) {
      this.logger?.warn?.(`${LOG_PREFIX}: could not update the credential archive: ${String(error)}`)
    }
  }

  /** Credentials the archive kept for a directory this walk can read. */
  private async archivedCredentials(homes: ReadonlySet<string>): Promise<WorkBuddyCredential[]> {
    const file = this.archiveFile()
    if (file === undefined) return []
    try {
      const stored = await readArchivedCredentials(file)
      return [...stored.values()].filter(credential => homes.has(this.homeOf(credential)))
    } catch (error: unknown) {
      this.logger?.warn?.(`${LOG_PREFIX}: could not read the credential archive: ${String(error)}`)
      return []
    }
  }

  /** The auth directory a credential was read from. */
  private homeOf(credential: WorkBuddyCredential): string {
    return resolve(dirname(credential.sourcePath))
  }
  private archiveFile(): string | undefined {
    const directory = this.dataPath?.()
    return directory === undefined || directory === '' ? undefined : join(directory, ARCHIVE_FILENAME)
  }

  private async scanOnce(dirs: readonly string[]): Promise<WorkBuddyAccount[]> {
    const found: WorkBuddyCredential[] = []
    // Directories that answered. An account is dropped only when its own directory
    // answered and no longer contains it — a directory that could not be read
    // keeps the accounts already held, cooldown included.
    const readableDirs = new Set<string>()
    // Directories holding a sealed token this build cannot open. Treated like an
    // unreadable directory: the account is kept until the key is available again.
    const sealedDirs = new Set<string>()
    for (const dir of dirs) {
      const files = await authFilesIn(dir)
      if (files === undefined) continue
      readableDirs.add(resolve(dir))
      for (const file of files) {
        const read = await readCredential(file)
        if (read.kind === 'credential') found.push(read.credential)
        else if (read.kind === 'sealed') sealedDirs.add(resolve(dir))
      }
    }

    // Nothing below may see a sign-in the user deleted. The desktop client keeps a
    // superseded snapshot of it and the archive keeps its token, so dropping only
    // the file the plugin wrote left both of them to put the account straight
    // back: the row never moved and the delete read as a button that does nothing.
    // A sign-in the client minted after the delete is a re-login and ends it.
    const tombstones = await this.loadDeletedSignIns()
    const tornDown = new Set<string>()
    const releasedIds: string[] = []
    const held: WorkBuddyCredential[] = []
    for (const credential of found) {
      const id = workbuddyAccountId(credential)
      const tombstone = tombstones.get(id)
      if (tombstone === undefined) {
        held.push(credential)
        continue
      }
      if (!endsTombstone(tombstone, credential)) {
        tornDown.add(id)
        continue
      }
      tombstones.delete(id)
      releasedIds.push(id)
      held.push(credential)
    }
    found.length = 0
    found.push(...held)
    // A tombstone whose account has no file left holds off the copies the walk
    // cannot see either: the archive keeps the token the delete purged, and a
    // purge that raced a scan or lost its write would otherwise put the row back
    // on a scan where no file exists to carry the tombstone check.
    for (const id of tombstones.keys()) tornDown.add(id)
    if (releasedIds.length > 0) await this.writeDeletedSignIns(releasedIds)

    // Remember every sign-in this walk saw before anything about it is dropped.
    // The global client keeps no snapshot beside its live file, so a re-login
    // overwrites the previous account's only copy on disk; the archive is what
    // lets that account stay in the pool afterwards.
    await this.archiveCredentials(found)

    // Sign-ins the client left behind become the plugin's own, so something
    // renews them. After the archive write, so the snapshot being copied is
    // already kept, and before anything below reads `found`.
    found.push(...(await this.adoptOrphanedSignIns(found, tornDown)))

    // The sign-in each account's own files hold, taken from the walk before the
    // archive's copies join `found`: those carry whatever this process last
    // minted, and a refresh is not a re-login.
    const signInTokens = new Map<string, WorkBuddyCredential[]>()
    for (const credential of found) {
      const id = workbuddyAccountId(credential)
      const held = signInTokens.get(id)
      if (held === undefined) signInTokens.set(id, [credential])
      else held.push(credential)
    }

    // Accounts the archive still holds, offered as candidates even when the
    // account also has files. The archive is where this process keeps the token it
    // renewed last, and a renewal of a sign-in the plugin does not own (the
    // desktop's own file) lands there and nowhere else. Dropping those entries
    // whenever a file existed left the stale file in force: the account answered
    // 401, its refresh token had already been rotated away by the renewal beside
    // it, and the row asked for a sign-in while a working token sat in the same
    // directory. Which copy serves is the ranking's call, not this loop's.
    // "The pool still has a copy of its own": a file the client wrote or one the
    // plugin wrote. Neither is left, and the archive is the only thing holding the
    // token, is what the panel's note is about. Counting own copies out put the
    // note on every account added from the panel, with advice to re-login for a
    // sign-in the pool renews itself.
    const liveIds = new Set(found.map(credential => workbuddyAccountId(credential)))
    // Held in the app right now. Read from the files this walk saw, not from the
    // copy that won: a renewal is written into the pool's own directory and
    // repoints the serving credential at it, so deriving this from the winner
    // dropped the account out of the set one scan later and offered a delete for
    // an account the user never added to the pool.
    const appHeld = new Set(
      found.filter(credential => isLiveAuthFile(credential.sourcePath)).map(credential => workbuddyAccountId(credential)),
    )
    for (const credential of await this.archivedCredentials(readableDirs)) {
      const id = workbuddyAccountId(credential)
      if (tornDown.has(id)) continue
      // The archive keeps the copy a renewal was written with, and that copy
      // remembers the path it was read from (the app's live file). Offering it
      // beside the file that holds the same token made the ranking pick the app's
      // path back, and the pool stopped renewing an account whose session it had
      // just taken over, because the age rule only applies to its own copies.
      if (found.some(entry => workbuddyAccountId(entry) === id && entry.accessToken === credential.accessToken)) continue
      found.push(credential)
    }

    const byId = new Map<string, WorkBuddyAccount>()
    // Seed with existing accounts so cooldown state survives a rescan.
    for (const account of this.accounts) byId.set(account.id, account)

    for (const credential of found) {
      const id = workbuddyAccountId(credential)
      const existing = byId.get(id)
      if (existing === undefined) {
        byId.set(id, {
          id,
          label: accountLabel(credential),
          credential,
          cooldownUntilMs: 0,
          modelCooldowns: Object.create(null) as Record<string, number>,
          modelBlocks: Object.create(null) as Record<string, number>,
          rateLimitHits: 0,
        })
        continue
      }
      const hold = this.heldIds.get(id)
      // A new sign-in is the one event a `session` hold waits for: the account
      // was taken out because its chats were refused, and a sign-in that was not
      // in these files before is the proof that it no longer is. Without this the
      // documented remedy did not exist, and a 401 kept the account out for the
      // whole hold window even after the user had signed in again.
      //
      // A sign-in is what counts, not a timestamp: comparing this machine's clock
      // with the one that issued it turned a fast clock into "a re-login never
      // releases", and a token this process refreshed in memory counted as one.
      const heldSignIns = hold?.reason === 'session' ? hold.heldSignIns : undefined
      const replaced = heldSignIns === undefined
        ? undefined
        : signInTokens.get(id)?.find(entry => !heldSignIns.includes(entry.accessToken))
      if (replaced !== undefined && hold !== undefined && heldSignIns !== undefined) {
        this.heldIds.delete(id)
        // Only the cooldown this record describes is released. A rate-limit
        // window that outlasts it belongs to the upstream, and a sign-in says
        // nothing about that window.
        if (existing.cooldownUntilMs <= hold.until) existing.cooldownUntilMs = 0
        // The sign-in that proved it is the one to serve with, and the ones it
        // replaced stay out of the ordering below and of every later scan.
        existing.credential = replaced
        this.refusedSignIns.set(id, heldSignIns)
      }
      // Keep whichever credential the app/upstream considers current. The stored
      // expiry alone is not a freshness signal, so this goes through `isFresher`
      // rather than comparing expiry values directly. The label is not carried
      // over here: every label is rebuilt from the credential in force below,
      // which is also what keeps the prefix from stacking up on a rescan.
      // A copy the upstream already refused never outranks one it did not. The
      // account was held out on the strength of the dead copy, so without this
      // the working copy sitting beside it was never picked up and the row kept
      // asking for a sign-in the pool had no use for. Only a candidate that is
      // itself untouched by the refusal may replace a refused incumbent; a
      // second dead copy is no better than the first.
      if (!this.signInRefused(id, credential.accessToken)
        && (this.signInRefused(id, existing.credential.accessToken)
          || isFresher(credential, existing.credential, ownSignInDir(this.dataPath?.() ?? '')))) {
        existing.credential = credential
      }
    }

    // A copy that works ends the hold: the account was taken out because the
    // sign-in it was serving had been refused, and the copy now in force is not
    // one of those. The cooldown this hold wrote is released with it, and only
    // that one: a rate-limit window belongs to the upstream and outlasts it.
    for (const [id, account] of byId) {
      const hold = this.heldIds.get(id)
      if (hold?.reason !== 'session') continue
      // A hold that names no sign-in has nothing a scan can release it with: the
      // account had no file when it was refused, so only a file that appears
      // later can, through the merge above.
      if (hold.heldSignIns.length === 0) continue
      if (this.signInRefused(id, account.credential.accessToken)) continue
      this.heldIds.delete(id)
      if (account.cooldownUntilMs > 0 && account.cooldownUntilMs <= hold.until) account.cooldownUntilMs = 0
      this.logger?.info?.(`${LOG_PREFIX}: ${account.label} has a sign-in the upstream did not refuse; releasing the hold`)
    }

    const foundIds = new Set(found.map(credential => workbuddyAccountId(credential)))
    // A sign-in nobody's files hold any more cannot be chosen again - unless the
    // account has no files left at all, in which case the archive can hand the same
    // token back and the ranking would prefer it. So the record is dropped only for
    // an account that is gone; a live one keeps it until its files change.
    for (const [id, refused] of this.refusedSignIns) {
      if (!foundIds.has(id)) {
        this.refusedSignIns.delete(id)
        continue
      }
      const onDisk = signInTokens.get(id)
      if (onDisk !== undefined && !refused.some(token => onDisk.some(entry => entry.accessToken === token))) {
        this.refusedSignIns.delete(id)
      }
    }

    const scanNow = Date.now()
    for (const account of byId.values()) pruneModelCooldowns(account, scanNow)
    for (const [id, account] of byId) {
      const home = resolve(dirname(account.credential.sourcePath))
      if (sealedDirs.has(home)) continue
      if (readableDirs.has(home) && !foundIds.has(id)) {
        byId.delete(id)
        this.forgetAccount(id)
      }
    }

    // Held in the app right now: the file the client is signed into, as opposed
    // to a snapshot it left behind. The pool may renew such an account into its
    // own directory, but the app is the one holding the session, so the panel
    // must not offer to delete it: those rows are not the pool's to remove.
    this.appHeldIds = appHeld

    // A stable order is what makes "prefer the first account" meaningful, and it
    // is a queue order, not the freshness rule: the live sign-in leads so the next
    // request goes to the account the user is actually in, then the most recently
    // issued credential, then the newest expiry. It is a key vector rather than
    // `compareFreshness`, whose mixed date/source rule is only meaningful pairwise
    // and cycles across three copies, leaving the queue to whatever order the sort
    // happened to make of an inconsistent comparator.
    const ordered = [...byId.values()]
    ordered.sort((a, b) => compareQueueOrder(a.credential, b.credential, ownSignInDir(this.dataPath?.() ?? '')))
    for (const account of ordered) {
      account.label = accountLabel(account.credential)
      // Recomputed every scan: signing the account back in makes it live again,
      // and a flag carried over would keep it out of rotation forever. A
      // directory that could not be read or unsealed this time says nothing about
      // the account, so its previous answer stands: marking it archived told the
      // user the sign-in was gone while the file was still on disk.
      const home = resolve(dirname(account.credential.sourcePath))
      if (!readableDirs.has(home) || sealedDirs.has(home)) continue
      if (liveIds.has(account.id)) delete account.archived
      else account.archived = true
    }
    disambiguateLabels(ordered)
    // A directory set that changed while this walk was reading is not this
    // walk's answer: `applyConfig` already emptied the pool for the new set, and
    // assigning here would put the previous directory's accounts back.
    if (!sameDirs(this.scanDirsFor(this.authDirs), dirs)) return this.accounts
    this.accounts = ordered
    // Kept for `penalize`, which records them so a later scan can tell a new
    // sign-in from the one that was refused.
    this.signInTokens = signInTokens
    this.lastScanAtMs = Date.now()
    return this.accounts
  }

  /** All accounts, cooldown state included. */
  list(region?: WorkBuddyRegion): readonly WorkBuddyAccount[] {
    const kept = this.accounts.filter(account => !this.removedIds.has(account.id))
    if (region === undefined) return kept
    return kept.filter(account => regionOf(account.credential.domain) === region)
  }

  /**
   * Why this account cannot serve a request, or null when it can.
   *
   * One ladder, two readers: `available` filters with it and
   * `unavailableReason` prints its answer. Keeping them separate meant every
   * new disqualifier had to be added in two places, and forgetting one made the
   * panel call an account available that the rotation would never pick.
   */
  private ineligible(
    account: WorkBuddyAccount,
    now: number,
    modelId?: string,
    region?: WorkBuddyRegion,
  ): IneligibleReason | null {
    // Removed for good, or switched off: neither may serve a request. Switched
    // off is still listed, so the panel can switch it back on.
    if (this.removedIds.has(account.id)) return 'removed'
    if (this.disabledIds.has(account.id)) return 'switched off'
    // Reserved credits: stop at the floor the user set for this account.
    if (this.reserveHolds(account.id)) return 'under its credit reserve'
    // An archived account is judged by its credential like any other, below.
    // The switch that overwrote its sign-in file does not revoke its token, and
    // the global token lasts a year, so treating it as unusable threw away the
    // very account the archive exists to keep. A credential whose access token
    // has died and that carries nothing to refresh it with cannot serve a
    // request: leading with one spent the turn on a guaranteed 401, and the
    // refresh-and-retry that follows is spent on a call that cannot change the
    // answer. One that still has a refresh token stays eligible: `ensureFresh`
    // renews it on the way through.
    if (credentialUnusable(account.credential, now)) return 'sign-in expired'
    // A region-scoped caller (one of the two providers) must never pick an
    // account that talks to the other region gateway.
    if (region !== undefined && regionOf(account.credential.domain) !== region) return 'other region'
    if (account.cooldownUntilMs > now) {
      // The three holds need different remedies, and the caller prints this
      // string as the advice: a balance read clears `spent`, only a fresh
      // sign-in clears `session`, and a vendor restriction needs the account
      // appealed. One word for all of them sent users to top up an account
      // whose chats were refused.
      const reason = this.heldIds.get(account.id)?.reason
      return reason === 'session' ? 'sign-in refused' : reason === 'restricted' ? 'restricted by the upstream' : 'on hold'
    }
    if (modelId !== undefined && (account.modelBlocks[modelId] ?? 0) > now) return 'plan'
    if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return 'rate-limited'
    return null
  }

  /**
   * Accounts currently eligible to serve a request.
   *
   * With a `modelId`, an account is eligible when it is not account-wide cooled
   * AND that model is not cooling on it — so a 429 on `hy4-preview` only keeps
   * that model out while `hy3` on the same account stays usable. Without a
   * model id the legacy account-wide check applies (callers that cannot name a
   * model, e.g. CLI diagnostics). The panel asks this same question to mark the
   * account the next request will use: a hand-rolled filter there once marked a
   * switched-off account as next up, which is what this being the only answer is
   * for.
   */
  available(now: number, modelId?: string, region?: WorkBuddyRegion): WorkBuddyAccount[] {
    return this.accounts.filter(account => this.ineligible(account, now, modelId, region) === null)
  }

  /**
   * The pool's own hold on this account, if one is in force right now.
   *
   * A caller that is about to spend upstream calls on an account asks first: a
   * held sign-in cannot answer, so the read is skipped and the hold's reason is
   * reported instead. Null when no hold applies or the hold has run out.
   */
  activeHold(accountId: string): { reason: PoolHoldReason; untilMs: number } | null {
    const hold = this.heldIds.get(accountId)
    if (hold === undefined || hold.until <= Date.now()) return null
    return { reason: hold.reason, untilMs: hold.until }
  }
  /**
   * Why this account is not being served right now, for a caller that has to
   * explain an empty pool. Returns null when the account is eligible.
   *
   * One place for the answer: the gateway used to infer a cause from cooldown
   * timestamps alone, so an expired sign-in was reported as a credit-reserve
   * setting the user never touched.
   */
  unavailableReason(accountId: string, now: number, modelId?: string): IneligibleReason | null {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return null
    return this.ineligible(account, now, modelId)
  }

  /**
   * Pick the account to serve a request.
   *
   * The `distribution` setting chooses how:
   *
   * - **priority** (default): one account serves every request until it is
   *   rate-limited, then the next in order takes over. Credits drain one account
   *   at a time, and a cooling account returns to the head of the queue the moment
   *   its window resets - it was never consumed, so it resumes straight away.
   * - **round-robin**: consecutive requests rotate through the pool so spend
   *   spreads evenly across every account.
   * - **expiry**: the account whose credit pack expires soonest goes first, so
   *   nothing is wasted on the day it lapses.
   * - **sticky**: one account per conversation, for as long as it keeps working.
   *
   * In every mode an explicit user selection (`prefer`) heads the list, a cooling
   * account is skipped for that model only, and an unrecognised setting falls back
   * to priority.
   *
   * Scans on first use, and rescans when every known account is cooling down: a
   * fresh desktop login is the usual way out of an exhausted pool.
   */
  async acquire(modelId?: string, region?: WorkBuddyRegion, conversationKey?: string): Promise<WorkBuddyAccount | undefined> {
    if (this.accounts.length === 0) await this.scan()
    let pool = this.available(Date.now(), modelId, region)
    if (pool.length === 0) {
      await this.scan()
      pool = this.available(Date.now(), modelId, region)
    }
    if (pool.length === 0) return undefined

    // A manual choice overrides automatic distribution, but never cooldowns.
    const preferredId = this.preferredIds.get(region)
    const account = pool.find(item => item.id === preferredId) ?? this.pick(pool, conversationKey)
    if (account === undefined) return undefined
    await this.ensureFresh(account)
    // A cooldown that landed while the refresh was in flight must not be
    // ridden: the pick above happened before it, and the request would spend
    // its turn on an account that is already cooling.
    const eligible = this.available(Date.now(), modelId, region)
    if (eligible.includes(account)) return account
    const next = eligible.find(item => item.id === preferredId) ?? this.pick(eligible, conversationKey)
    if (next === undefined) return undefined
    await this.ensureFresh(next)
    return next
  }

  private pick(pool: WorkBuddyAccount[], conversationKey?: string): WorkBuddyAccount | undefined {
    if (this.distribution === 'expiry') return this.pickByExpiry(pool)
    if (this.distribution === 'sticky' && conversationKey !== undefined) {
      const bound = this.sticky.get(conversationKey)
      const kept = bound === undefined ? undefined : pool.find(account => account.id === bound)
      if (kept !== undefined) return kept
      const account = pool[this.cursor % pool.length]
      if (account === undefined) return undefined
      this.sticky.set(conversationKey, account.id)
      this.cursor = (this.cursor + 1) % pool.length
      while (this.sticky.size > 200) {
        const oldest = this.sticky.keys().next().value
        if (oldest === undefined) break
        this.sticky.delete(oldest)
      }
      return account
    }
    const index = this.distribution === 'round-robin' ? this.cursor % pool.length : 0
    const account = pool[index]
    if (account !== undefined && this.distribution === 'round-robin') {
      this.cursor = (index + 1) % pool.length
    }
    return account
  }

  private pickByExpiry(pool: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    return pickSoonestExpiry(pool, this.creditExpiries, Date.now())
  }

  /** Next account the card may name. Rotating modes have none. Does not move the cursor. */
  preview(eligible: readonly WorkBuddyAccount[]): WorkBuddyAccount | undefined {
    if (eligible.length === 0) return undefined
    if (this.distribution === 'expiry') return this.pickByExpiry(eligible)
    if (this.distribution === 'priority') return eligible[0]
    return undefined
  }


  /** Prefer one billing account per gateway; undefined restores automatic use. */
  prefer(accountId: string | undefined, region?: WorkBuddyRegion): void {
    if (accountId === undefined) this.preferredIds.delete(region)
    else this.preferredIds.set(region, accountId)
  }

  /**
   * Refresh one account after a session-dead upstream answer, ignoring the
   * stored expiry: a revocation does not rewrite it. False when the access
   * token is unchanged, so the caller stops retrying the same dead token.
   */
  async refreshAccount(accountId: string): Promise<boolean> {
    return await this.refreshForRetry(accountId) === 'refreshed'
  }

  /**
   * Refresh after a session-dead answer, keeping a refusal apart from a failure.
   *
   * Only the upstream turning the sign-in down justifies a hold. A timeout, a
   * rate limit or an unreachable host says nothing about the token, and parking
   * the account for six hours over one bad round trip took a healthy account out
   * of rotation until a manual reset.
   */
  private async refreshForRetry(accountId: string): Promise<'refreshed' | 'refused' | 'failed'> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return 'failed'
    const previous = account.credential.accessToken
    // A read the upstream just refused is the proof the session is dead. With
    // nothing to refresh with, waiting on `ensureFresh` would call it `fresh`
    // because the access token has not expired yet, and the hold that the
    // refusal earned would never be placed.
    if (account.credential.refreshToken === '') return 'refused'
    const outcome = await this.ensureFresh(account, true)
    // An in-flight refresh may have replaced the token without this call
    // spending one; the token is what the retry rides, so it decides.
    if (account.credential.accessToken !== previous) return 'refreshed'
    return outcome === 'refused' ? 'refused' : 'failed'
  }

  /**
   * Hold an account whose sign-in the upstream refuses.
   *
   * The chat gateway has answered a refused sign-in with this hold since it was
   * written; the panel's reads and the scheduled passes had no equivalent, so a
   * revoked account kept spending its two upstream calls on every poll and every
   * pass. The hold is what stops that, and it is released the way every other
   * hold is: a new sign-in for the account, a cooldown reset, or its cap.
   */
  holdRefusedSignIn(accountId: string): void {
    this.penalize(accountId, Date.now() + POOL_HOLD_MS, undefined, 'session')
  }

  /**
   * One upstream read that a refused sign-in gets a second chance at.
   *
   * The upstream revokes the session a sign-in belongs to without rewriting the
   * token's own expiry, so an account the user switched away from in the desktop
   * app keeps a credential that reads as valid for weeks and answers 401 on
   * every call. A refresh token that still lives recovers the account on the
   * spot, which is the case the desktop app's own refresh leaves behind; one
   * that does not leaves the account held instead of retried forever.
   *
   * A failure of any other kind is rethrown untouched: a rate limit, a spent
   * balance and an upstream fault each have their own path, and none of them is
   * helped by a token this read did not blame.
   *
   * While the hold stands the read is not attempted at all. The panel polls
   * every couple of minutes and the scheduled passes walk the whole pool, and
   * each of those would otherwise spend the same call on a sign-in that cannot
   * answer it.
   */
  async readAfterRefresh<T>(accountId: string, read: (credential: WorkBuddyCredential) => Promise<T>): Promise<T> {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) throw new Error(`${LOG_PREFIX}: no account ${accountId} to read for`)
    if (this.activeHold(accountId)?.reason === 'session') throw new Error(REFUSED_SIGN_IN_MESSAGE)
    try {
      return await read(account.credential)
    } catch (error) {
      if (upstreamErrorKind(error) !== 'session_dead') throw error
      // No retry when the refresh itself was refused: the token the read would
      // ride is the one the upstream just turned down, so the second attempt
      // spends a call to learn what the first one already said. A refresh that
      // failed for any other reason leaves the account in rotation: the token
      // may still work, and the next read decides.
      const outcome = await this.refreshForRetry(accountId)
      if (outcome === 'refreshed') {
        try {
          return await read(account.credential)
        } catch (retry) {
          if (upstreamErrorKind(retry) !== 'session_dead') throw retry
          this.holdRefusedSignIn(accountId)
          throw retry
        }
      }
      if (outcome === 'refused') this.holdRefusedSignIn(accountId)
      throw error
    }
  }

  /**
   * Refresh the account's access token when it is within the margin (or already
   * expired), in-flight de-duped per account. A failed refresh keeps the
   * existing token when it has not yet expired, so an unreachable refresh
   * endpoint never takes down a working session.
   *
   * Reports what it did, so a caller walking the pool for keep-alive can tell a
   * pass that refreshed something from one that had nothing to do. The answer
   * describes this call, not the account: an in-flight refresh another call
   * started is reported as `fresh` because this one spent no upstream call.
   */
  async ensureFresh(account: WorkBuddyAccount, forced = false): Promise<KeepAliveOutcome> {
    if (this.client === undefined) return 'fresh'
    const credential = account.credential
    const issuedAt = credential.lastRefreshAtMs ?? 0
    // Age, not just the expiry margin: a token with weeks left is still renewed
    // once it is old enough, which is what makes the keepalive renew anything at
    // all on a pool of long-lived tokens.
    const stale = this.isOwnSignInPath(credential.sourcePath) && issuedAt > 0 && Date.now() - issuedAt >= REFRESH_AFTER_MS
    const expiring = forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS || stale
    if (!expiring) return 'fresh'
    const existing = this.refreshInflight.get(account.id)
    if (existing !== undefined) {
      return await existing
    }
    const run = (async () => {
      if (credential.refreshToken === '') {
        // Nothing to refresh with; only worth failing if already expired.
        if (credential.expiresAtMs > Date.now() + 30_000) return 'fresh'
        // Once per account rather than once per request: this branch is reached
        // on every turn for a credential with no expiry, and the repeated
        // warning buried everything else in the log.
        if (!this.noRefreshWarned.has(account.id)) {
          this.noRefreshWarned.add(account.id)
          this.logger?.warn(`${LOG_PREFIX}: ${account.label} token expired with no refresh token; sign in again`)
        }
        return 'noToken'
      }
      try {
        const outcome = await this.client!.refreshToken(credential)
        // A desktop re-login during the refresh supersedes this response.
        if (account.credential !== credential) return 'fresh'
        account.credential = {
          ...credential,
          accessToken: outcome.accessToken,
          ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
          // A refresh that reports no lifetime still produced a fresh token, so
          // the stored expiry is replaced rather than kept: carrying the old
          // value forward leaves a credential that was parsed without any
          // `expiresAt` (0) permanently "expiring", which re-runs this whole
          // round trip on every single request. The assumed lifetime must clear
          // the margin above, or `ensureFresh` would still see it as expiring.
          expiresAtMs: tokenExpiryMs(outcome.expiresInSec),
          ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
          // Stamped with the moment the upstream issued this token. A file on
          // disk keeps the issue time it was written with, so without this
          // stamp the refreshed credential ties with its own on-disk snapshot
          // and then loses the expiry tiebreaker to the very token it replaced:
          // the next scan swapped the working token back out and every request
          // rode the revoked one until it was refreshed again.
          lastRefreshAtMs: Date.now(),
        }
        // Kept in the archive as well. For an account whose sign-in file the
        // client already overwrote, the archive is the only copy that survives a
        // restart: leaving the superseded token there meant the account came back
        // dead and held out until a manual re-login.
        await this.archiveCredentials([account.credential])
        // A sign-in the plugin wrote is renewed in place. Without this the
        // refreshed token lived only in memory and in the archive, the next scan
        // read the old file back, and the renewal was lost: the stored expiry
        // never moved, so the keepalive looked like it did nothing.
        await this.renewOwnSignIn(account.credential)
        this.noRefreshWarned.delete(account.id)
        // A token the upstream minted is proof the sign-in works again, so a hold
        // that said otherwise is dropped here rather than at its cap: without this
        // an account recovered by a refresh still showed as needing a re-login and
        // stayed out of rotation for the rest of the window. Only a session hold is
        // released - a rate-limit or balance cooldown says nothing this refresh
        // contradicts.
        const sessionHold = this.heldIds.get(account.id)
        if (sessionHold !== undefined && sessionHold.reason === 'session') {
          this.heldIds.delete(account.id)
          // Only the cooldown this hold wrote is cleared; one that outlasts it
          // belongs to the upstream's own window and stays.
          if (account.cooldownUntilMs > Date.now() && account.cooldownUntilMs <= sessionHold.until) account.cooldownUntilMs = 0
          this.logger?.info?.(`${LOG_PREFIX}: ${account.label} refreshed again; releasing the refused sign-in hold`)
        }
        this.logger?.info?.(`${LOG_PREFIX}: refreshed token for ${account.label}`)
        return 'refreshed'
      } catch (error: unknown) {
        if (credential.expiresAtMs > Date.now() + 30_000) {
          this.logger?.warn?.(`${LOG_PREFIX}: token refresh failed but token still valid for ${account.label}`, error)
        } else {
          this.logger?.error?.(`${LOG_PREFIX}: token refresh failed and token expired for ${account.label}`, error)
        }
        const kind = upstreamErrorKind(error)
        return kind === 'session_dead' ? 'refused' : 'failed'
      }
    })()
    this.refreshInflight.set(account.id, run)
    try {
      return await run
    } finally {
      this.refreshInflight.delete(account.id)
    }
  }

  /**
   * Mark an account (or one of its models) rate-limited.
   *
   * With `modelId`, only that model on the account is cooled — the account's
   * other models stay in rotation, matching the upstream's per-model rate
   * limit ("可切换其他模型继续使用"). Without a model id the whole account is
   * cooled, which callers should reserve for limits that truly span every model.
   *
   * `hold` names a decision of the pool's own rather than a timestamp read
   * off an upstream answer — a spent account, a dead session. It is bounded by
   * POOL_HOLD_MS instead of PENALIZE_CAP_MS, because the two-hour ceiling
   * exists to stop a mis-parsed reset from parking an account all day, and
   * neither of these conditions clears by itself.
   */
  penalize(
    accountId: string,
    resetAtMs?: number,
    modelId?: string,
    hold: false | PoolHoldReason = false,
  ): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return
    account.rateLimitHits += 1
    // Cap even a caller-supplied reset: the parse layer already caps, but a
    // raw timestamp passed straight in must not sleep an account all day. The
    // configured window is the user's own choice and is not capped.
    const now = Date.now()
    // A reset the upstream named is its own window and is taken as given; it is
    // not this pool's estimate to stretch.
    const stated = resetAtMs !== undefined && resetAtMs > now
    // Only a failure the pool had to size itself counts, and a hold does not:
    // spent credits and a refused sign-in are facts about the credential, not a
    // frequency wall the next attempt would clear. Counting them stretched the
    // window for the limit that came after.
    if (hold === false && !stated) {
      const sinceLast = now - (account.rateLimitStreakAtMs ?? 0)
      account.rateLimitStreak = sinceLast > RATE_LIMIT_STREAK_WINDOW_MS ? 1 : (account.rateLimitStreak ?? 0) + 1
      account.rateLimitStreakAtMs = now
    }
    const holdReason: PoolHoldReason | undefined = hold === false ? undefined : hold
    const cap = holdReason !== undefined ? POOL_HOLD_MS : PENALIZE_CAP_MS
    // A limit with no deadline - the bare "frequency limit" body - is stretched by
    // how often this account has failed in a row, so a persistently limited account
    // stops returning to the queue every configured minute to fail again.
    const streak = Math.min(Math.max((account.rateLimitStreak ?? 1) - 1, 0), RATE_LIMIT_STREAK_STEPS)
    const backoff = Math.min(this.cooldownMs * 2 ** streak, Math.max(this.cooldownMs, RATE_LIMIT_STREAK_CAP))
    const until = stated ? Math.min(resetAtMs, now + cap) : holdReason !== undefined ? now + cap : now + backoff
    if (modelId !== undefined && modelId !== '') {
      pruneModelCooldowns(account, now)
      account.modelCooldowns[modelId] = Math.max(account.modelCooldowns[modelId] ?? 0, until)
      this.logger?.warn(
        `${LOG_PREFIX}: ${account.label} rate-limited on model ${modelId}; ` +
          `cooling that model until ${new Date(until).toISOString()}`,
      )
      return
    }
    account.cooldownUntilMs = Math.max(account.cooldownUntilMs, until)
    // Recorded only for the account-wide hold, which is the only shape a balance
    // read can release: a per-model cooldown belongs to the upstream's window.
    // A live `session` hold keeps both its reason and the sign-in that caused it
    // when another reason lands on top, because only a new sign-in clears that
    // one; relabelling it here handed its release to a balance read.
    if (holdReason !== undefined) {
      const prior = this.heldIds.get(accountId)
      const carried = prior !== undefined && prior.until > now && prior.reason === 'session' ? prior : undefined
      const reason = carried?.reason ?? holdReason
      // The proof is every sign-in this account can be served with: what the files
      // hold now, plus the copy in force when it came from somewhere the walk does
      // not read (the archive). Both are what a later scan compares against.
      //
      // An empty proof is not "nothing to answer to": it means the account had no
      // file at all when it was refused, and then only a file that appears later
      // can end the hold. Recording nothing there let every scan release a dead
      // account and spend an upstream call rediscovering the refusal.
      const heldSignIns = carried !== undefined
        ? carried.heldSignIns
        : this.refusedSignInsFor(accountId)
      this.heldIds.set(accountId, {
        reason,
        until: Math.max(until, carried?.until ?? 0),
        heldSignIns,
      })
    }
    this.logger?.warn(
      holdReason !== undefined
        ? `${LOG_PREFIX}: account ${account.label} held (${holdReason}); held until ${new Date(until).toISOString()}`
        : `${LOG_PREFIX}: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`,
    )
  }

  /**
   * Keep one model out of one account's rotation for a stated window.
   *
   * `penalize` caps what it writes at `PENALIZE_CAP_MS`, which exists so a
   * mis-parsed rate-limit reset cannot park work all day. A plan refusal names
   * no upstream window and clears only when the subscription changes, so it
   * brings its own deadline; routing it through `penalize` silently shortened
   * it to the rate-limit ceiling and bought one wasted upstream call per two
   * hours. The account is left alone: every other model on it still serves.
   */
  blockModel(accountId: string, modelId: string, untilMs: number): void {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined || modelId === '' || untilMs <= Date.now()) return
    pruneModelCooldowns(account, Date.now())
    account.modelBlocks[modelId] = Math.max(account.modelBlocks[modelId] ?? 0, untilMs)
  }

  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns(): void {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0
      account.modelCooldowns = Object.create(null) as Record<string, number>
      account.modelBlocks = Object.create(null) as Record<string, number>
      account.rateLimitHits = 0
      account.rateLimitStreak = 0
      account.rateLimitStreakAtMs = 0
    }
    this.heldIds.clear()
    this.refusedSignIns.clear()
  }

  /** Diagnostics snapshot. Account-wide cooling count (per-model cooling excluded:
   *  the account as a whole stays usable when only one model is limited). */
  status(): { count: number; cooling: number; lastScanAtMs: number } {
    const now = Date.now()
    return {
      count: this.accounts.length,
      cooling: this.accounts.filter(account => account.cooldownUntilMs > now).length,
      lastScanAtMs: this.lastScanAtMs,
    }
  }
}

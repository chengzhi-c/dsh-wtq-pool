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
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tokenExpiryMs, regionOf, type WorkBuddyRegion } from './upstream'
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
 * an international one that lives a year. `failed` could not refresh.
 * `noToken` has no refresh token to refresh with, so it is dead for good.
 */
export type KeepAliveOutcome = 'refreshed' | 'fresh' | 'failed' | 'noToken'
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
   */
  modelCooldowns: Record<string, number>
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
 * True when `path` is the desktop app's live sign-in (as opposed to a backup
 * snapshot it left behind). The live file always wins: it is the session the
 * app itself is using.
 */
function isLiveAuthFile(path: string): boolean {
  return basename(path) === WORKBUDDY_LIVE_FILENAME
}

/**
 * Which of two credentials for the same account the pool should keep.
 *
 * Ordering, highest first:
 *
 * 1. the live file the desktop app is signed in with;
 * 2. the credential the upstream issued most recently (`lastRefreshAtMs`);
 * 3. the longer stored expiry, as a fallback for documents that carry no issue
 *    time (the plugin's own refreshed copy, older builds).
 *
 * The stored expiry alone is NOT a freshness signal: the upstream does not
 * rewrite it when it revokes a token, so a long-dead backup can claim to expire
 * later than the token that actually works. Selecting on it made every upstream
 * call return 401 while a perfectly good credential sat in the same directory.
 */
function compareFreshness(a: WorkBuddyCredential, b: WorkBuddyCredential): number {
  const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0
  const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0
  if (aLive !== bLive) return bLive - aLive

  const aIssued = a.lastRefreshAtMs ?? 0
  const bIssued = b.lastRefreshAtMs ?? 0
  if (aIssued !== bIssued) return bIssued - aIssued

  return b.expiresAtMs - a.expiresAtMs
}

/** True when `candidate` should replace `incumbent` for the same account. */
function isFresher(candidate: WorkBuddyCredential, incumbent: WorkBuddyCredential): boolean {
  return compareFreshness(candidate, incumbent) < 0
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
/** How long a hold the pool itself decided may keep an account out of rotation. */
const POOL_HOLD_CAP_MS = 24 * 60 * 60 * 1000
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

/** Drop expired per-model cooldowns, then cap what is left, soonest first. */
function pruneModelCooldowns(account: WorkBuddyAccount, now: number): void {
  for (const [modelId, until] of Object.entries(account.modelCooldowns)) {
    if (until <= now) delete account.modelCooldowns[modelId]
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
      lastRefreshTime: Date.now(),
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
export type PoolHoldReason = 'spent' | 'session'

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
   * cannot answer this — `compareFreshness` ranks a live desktop file above every
   * panel sign-in regardless of issue time — and a timestamp cannot either, since
   * it would compare this machine's clock with the one that issued the sign-in.
   *
   * Empty rather than absent when the account has no readable file of its own: those
   * live in the archive or behind a sealed token, they are the ones most likely to
   * be refused, and a missing set made the documented remedy unreachable for them.
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
   * `compareFreshness` ranks a live desktop file above every panel sign-in
   * whatever their issue times, so a token that was refused would win that ranking
   * again on the very next scan and the account would go on sending it - the hold
   * would look released while the requests kept failing. Kept across scans, and
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
   */
  ownsSignIn(accountId: string): boolean {
    const account = this.accounts.find(item => item.id === accountId)
    return account !== undefined && this.isOwnSignInPath(account.credential.sourcePath)
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
    if (!this.isOwnSignInPath(account.credential.sourcePath)) return false
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
    if (running !== undefined) {
      const settled = await raceWithTimeout(running.catch(() => {}), DELETE_SCAN_WAIT_MS)
      if (!settled) void running.catch(() => {}).then(() => this.forgetArchived(account.id))
    }
    // Already gone is success: the point is that no sign-in is left, and a
    // second delete must not read as a failure.
    await unlink(account.credential.sourcePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await this.forgetArchived(account.id)
    return true
  }

  /** Whether `sourcePath` sits inside the directory the plugin writes into. */  private isOwnSignInPath(sourcePath: string): boolean {
    const own = ownSignInDir(this.dataPath?.() ?? '')
    if (own === '' || sourcePath === '') return false
    const walked = relative(resolve(own), resolve(sourcePath))
    // A walk that escapes the root is not inside it, and `..` is how a path
    // gets there. An empty walk means the path IS the directory.
    return walked !== '' && !walked.startsWith('..') && !isAbsolute(walked)
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
    const dirs = [...this.authDirs]
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
   * Keep the credentials this walk saw, so an account whose only file the client
   * overwrites on the next sign-in still has a copy to be read back from.
   *
   * Best effort by design: a failed write costs the archive, never the scan.
   */
  private async archiveCredentials(credentials: readonly WorkBuddyCredential[]): Promise<void> {
    const file = this.archiveFile()
    if (file === undefined || credentials.length === 0) return
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
        if (previous !== undefined && !isFresher(credential, previous)) continue
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

    // Signing in again is a new sign-in file, not the one that was deleted, so it
    // ends the tombstone: the account is the user's again and has to be archived
    // like any other.
    // Remember every sign-in this walk saw before anything about it is dropped.
    // The global client keeps no snapshot beside its live file, so a re-login
    // overwrites the previous account's only copy on disk; the archive is what
    // lets that account stay in the pool afterwards.
    await this.archiveCredentials(found)

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

    // Accounts only the archive still holds. The sign-in file is gone, so their
    // token gets no renewal from the client, but the token itself is still
    // valid and keeps serving until it expires.
    const liveIds = new Set(found.map(credential => workbuddyAccountId(credential)))
    for (const credential of await this.archivedCredentials(readableDirs)) {
      if (liveIds.has(workbuddyAccountId(credential))) continue
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
          modelCooldowns: {},
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
      const refused = this.refusedSignIns.get(id)
      if (isFresher(credential, existing.credential) && !(refused?.includes(credential.accessToken) ?? false)) {
        existing.credential = credential
      }
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
        // The warn-once flag is keyed by id, so a re-sign-in later must be able
        // to warn again.
        this.noRefreshWarned.delete(id)
        // Every per-account map the pool keeps, dropped with the account: a
        // balance and an expiry that outlive their account are inherited by the
        // next sign-in under the same id, which then reads as unpickable on a
        // reserve floor nobody set for it.
        this.creditBalances.delete(id)
        this.creditExpiries.delete(id)
        this.heldIds.delete(id)
        this.signInTokens.delete(id)
        this.refusedSignIns.delete(id)
      }
    }

    // A stable, predictable order is what makes "prefer the first account"
    // meaningful: a live sign-in leads, then the most recently issued
    // credential, then the newest expiry. `byId` already preserves the order
    // accounts were first discovered, so re-scans do not shuffle the queue.
    const ordered = [...byId.values()]
    ordered.sort((a, b) => compareFreshness(a.credential, b.credential))
    for (const account of ordered) {
      account.label = accountLabel(account.credential)
      // Recomputed every scan: signing the account back in makes it live again,
      // and a flag carried over would keep it out of rotation forever.
      if (liveIds.has(account.id)) delete account.archived
      else account.archived = true
    }
    disambiguateLabels(ordered)
    // A directory set that changed while this walk was reading is not this
    // walk's answer: `applyConfig` already emptied the pool for the new set, and
    // assigning here would put the previous directory's accounts back.
    if (!sameDirs(this.authDirs, dirs)) return this.accounts
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
    return this.accounts.filter(account => {
      // Removed for good, or switched off: neither may serve a request.
      if (this.removedIds.has(account.id)) return false
      // An archived account is judged by its credential like any other, below.
      // The switch that overwrote its sign-in file does not revoke its token,
      // and the global token lasts a year, so treating it as unusable threw away
      // the very account the archive exists to keep.
      // Switched off on the panel: never picked, but still listed so the panel
      // can switch it back on.
      if (this.disabledIds.has(account.id)) return false
      // Reserved credits: stop at the floor the user set for this account.
      if (this.reserveHolds(account.id)) return false
      // A credential whose access token has died and that carries nothing to
      // refresh it with cannot serve a request. Leading with one spent the turn
      // on a guaranteed 401, and the refresh-and-retry that follows is spent on
      // a call that cannot change the answer. One that still has a refresh
      // token stays eligible: `ensureFresh` renews it on the way through, which
      // is the only thing that ever puts it back.
      if (credentialUnusable(account.credential, now)) return false
      if (account.cooldownUntilMs > now) return false
      if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return false
      // A region-scoped caller (one of the two providers) must never pick
      // an account that talks to the other region gateway.
      if (region !== undefined && regionOf(account.credential.domain) !== region) return false
      return true
    })
  }

  /**
   * Why this account is not being served right now, for a caller that has to
   * explain an empty pool. Returns null when the account is eligible.
   *
   * One place for the answer: the gateway used to infer a cause from cooldown
   * timestamps alone, so an expired sign-in was reported as a credit-reserve
   * setting the user never touched.
   */
  unavailableReason(accountId: string, now: number, modelId?: string): string | null {
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return null
    if (this.removedIds.has(account.id)) return 'removed'
    if (this.disabledIds.has(account.id)) return 'switched off'
    if (this.reserveHolds(account.id)) return 'under its credit reserve'
    if (credentialUnusable(account.credential, now)) return 'sign-in expired'
    if (account.cooldownUntilMs > now) {
      // The two holds need different remedies, and the caller prints this
      // string as the advice: a balance read clears `spent`, while only a fresh
      // sign-in clears `session`. One word for both sent users to top up an
      // account whose chats were refused.
      return this.heldIds.get(account.id)?.reason === 'session' ? 'sign-in refused' : 'on hold'
    }
    if (modelId !== undefined && (account.modelCooldowns[modelId] ?? 0) > now) return 'rate-limited'
    return null
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
    const account = this.accounts.find(item => item.id === accountId)
    if (account === undefined) return false
    const previous = account.credential.accessToken
    await this.ensureFresh(account, true)
    return account.credential.accessToken !== previous
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
    const expiring = forced || credential.expiresAtMs <= 0 || credential.expiresAtMs <= Date.now() + REFRESH_MARGIN_MS
    if (!expiring) return 'fresh'
    const existing = this.refreshInflight.get(account.id)
    if (existing !== undefined) {
      await existing
      return 'fresh'
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
        this.noRefreshWarned.delete(account.id)
        this.logger?.info?.(`${LOG_PREFIX}: refreshed token for ${account.label}`)
        // Kept in the archive as well. For an account whose sign-in file the
        // client already overwrote, the archive is the only copy that survives a
        // restart: leaving the superseded token there meant the account came back
        // dead and held out until a manual re-login.
        await this.archiveCredentials([account.credential])
        return 'refreshed'
      } catch (error: unknown) {
        if (credential.expiresAtMs > Date.now() + 30_000) {
          this.logger?.warn?.(`${LOG_PREFIX}: token refresh failed but token still valid for ${account.label}`, error)
        } else {
          this.logger?.error?.(`${LOG_PREFIX}: token refresh failed and token expired for ${account.label}`, error)
        }
        return 'failed'
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
   * `hold` marks a decision of the pool's own rather than a timestamp read off
   * an upstream answer — a spent account, a dead session. It is bounded by
   * POOL_HOLD_CAP_MS instead of PENALIZE_CAP_MS, because the two-hour ceiling
   * exists to stop a mis-parsed reset from parking an account all day, and
   * neither of these conditions clears by itself.
   */
  penalize(
    accountId: string,
    resetAtMs?: number,
    modelId?: string,
    hold: boolean | PoolHoldReason = false,
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
    // `true` is the spent-account shape, which is what a caller that does not
    // name a reason means.
    const holdReason: PoolHoldReason | undefined = hold === false ? undefined : hold === true ? 'spent' : hold
    const cap = holdReason !== undefined ? POOL_HOLD_CAP_MS : PENALIZE_CAP_MS
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
      // The proof is every sign-in the files hold now, which is what a later scan
      // compares against. `account.credential` may already be a token this process
      // minted: recording that alone made a file that had not changed look like a
      // re-login on the next scan.
      const heldSignIns = carried !== undefined
        ? carried.heldSignIns
        : (this.signInTokens.get(accountId) ?? []).map(entry => entry.accessToken)
      this.heldIds.set(accountId, {
        reason,
        until: Math.max(until, carried?.until ?? 0),
        heldSignIns,
      })
    }
    this.logger?.warn(
      `${LOG_PREFIX}: account ${account.label} rate-limited; cooling until ${new Date(until).toISOString()}`,
    )
  }

  /** Clear all cooldowns (account-wide and per-model), e.g. from a reset command. */
  resetCooldowns(): void {
    for (const account of this.accounts) {
      account.cooldownUntilMs = 0
      account.modelCooldowns = {}
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

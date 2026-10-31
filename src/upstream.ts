/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client.
 *
 * 参考：corrinehu/dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）
 *       dingminhua/dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing）
 *   — 端点与 wire behavior（按 domain 选 CN/global base、/v2 路径、强制
 *     stream:true、tool_choice 压平为字符串、chat 请求绝不携带 refresh
 *     token 的安全红线、developer→system role 转换、刷新走独立
 *     X-Refresh-Token 头、错误分类、积分按套餐聚合）经 dingminhua 实测
 *     验证，此处沿用并适配本插件的凭据接口与多账户池。
 *
 * @module dsh-wtq-pool/upstream
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { WorkBuddyCredential } from './accounts'
import { zonedDay } from './checkin-time'
import { boundedRetryAfterSeconds, redactSecrets, withRelayStream } from './loopback'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'waf_block'
  | 'not_found'
  | 'server'
  | 'client'
  /** The vendor restricted the account itself: 11140, "request illegal". */
  | 'account_restricted'
  /** A model this account's plan does not include: the upstream's 11158 gate. */
  | 'model_tier'
  /** The network path failed before any upstream answer existed. */
  | 'transport'
  /** The caller hung up before the answer arrived; not an upstream failure. */
  | 'aborted'

/** Token-refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** One CLI-usable model, carrying what the plugin card displays. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  creditMultiplier?: number
  /** Upstream image-input flag. Both gateways spell it `supportsImages`; some entries
   * also carry `disabledMultimodal`, the negative spelling. Reading anything else
   * reported every model as text-only, which made a vision shim register a second
   * route under the same display name and split the model picker group.
   */
  supportsImages?: boolean
  reasoning?: { supportedEfforts?: readonly string[]; defaultEffort?: string; canDisableThinking?: boolean }
}

/** One billing package, already normalised. */
export interface WorkBuddyCreditPackage {
  packageName: string
  remain: number
  size: number
  monthly: boolean
  /** Next cycle refresh point, ms; monthly packs only. */
  refreshAtMs?: number
  /** One-off expiry, ms. */
  expiresAtMs?: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  packages: readonly WorkBuddyCreditPackage[]
  expiringSoon: number
  /** Soonest remaining one-off pack. Monthly packs never set this. */
  nearestExpiryMs?: number
}

/** Daily check-in activity state. */
export interface WorkBuddyCheckinStatus {
  active: boolean
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  isStreakDay: boolean
  nextStreakDay: number
  streakBonusCredit: number
}

/** Daily check-in claim result. */
export interface WorkBuddyCheckinClaim {
  credit: number
  streakDays: number
  isStreakDay: boolean
}
/** One buddy (cat) profile; null when the account has none. */
export interface WorkBuddyBuddy {
  id: number
  name: string
}

/** One streak tier and what redeeming it pays. */
export interface WorkBuddyStreakTier {
  /** Tier key, e.g. `7d`. */
  tier: string
  /** Login days the tier needs. */
  days: number
  credit: number
  energy: number
  /** `locked` / `unlocked` / `claimed`. */
  status: string
}

/** The growth streak as a whole: progress and the tiers that can be redeemed. */
export interface WorkBuddyStreakStatus {
  /** Current consecutive active days. */
  days: number
  /** Next tier key, e.g. `7d`. */
  nextTier: string
  /** Days still needed for `nextTier`. */
  nextTierRemaining: number
  /**
   * Make-up cards in hand. The same response carries the balance, so a reader
   * that wants the card count does not pay a second request for it.
   */
  makeupCards: number
  tiers: readonly WorkBuddyStreakTier[]
}

/** Cat-travel state for one account. */
export interface WorkBuddyTravelState {
  /** idle | traveling | arrived; unknown states pass through as-is. */
  state: string
  /** True once today's dispatch quota is used (resets at 00:00 CST). */
  dailyLimitReached: boolean
  /** In-transit/arrived record id; claiming requires it. */
  recordId: number
}

/**
 * True when adopting the first buddy was refused for an unmet conversation
 * threshold. Expected, not an account problem: the caller records the day and
 * retries tomorrow instead of hammering the upstream.
 */
export function isBuddyThresholdIncomplete(message: unknown): boolean {
  return typeof message === 'string'
    && message.toLowerCase().includes('first_buddy task not completed yet')
}

/** Result of one upstream chat attempt. */
export type ChatStreamResult =
  | { ok: true; response: Response }
  | {
      ok: false
      kind: UpstreamErrorKind
      status: number
      message: string
      /** Upstream-stated wait in seconds, when it gave one in `Retry-After`. */
      retryAfter?: number
    }

export interface UpstreamClientOptions {
  /** Injectable fetch, primarily for tests. */
  fetchImpl?: typeof fetch
}

/** CN chat base per dingminhua's on-machine probe (HTTP 200 for chat/models). */
const CN_CHAT_BASE = 'https://copilot.tencent.com'
/** Billing/console base — `www.codebuddy.cn` is the billing origin. */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** Global base for `workbuddy.ai` logins. */
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Client versions the two gateways see, and the headers that carry them.
 *
 * CN desktop 5.9.3 (2026-10-27) sends `X-Agent-Runtime: local-agent` and the
 * same `X-Stainless-*` family as the bundled CLI. The international desktop is
 * still 5.8.4. Keeping one literal for both was one version behind on CN and
 * produced a combination no installed client sends.
 */
const CN_CLIENT_VERSION = '5.9.3'
const CN_CLI_VERSION = '2.165.0'
const GLOBAL_CLIENT_VERSION = '5.8.4'
const GLOBAL_CLI_VERSION = '2.161.0'
/** CN chat UA: the desktop client's three-segment spelling. */
const CN_CHAT_UA = `WorkBuddy/${CN_CLIENT_VERSION} WorkBuddy/${CN_CLIENT_VERSION} CLI/${CN_CLI_VERSION}`
/** CN desktop UA, used by the endpoints the desktop process calls directly. */
const CN_DESKTOP_UA = `WorkBuddy/${CN_CLIENT_VERSION}`

/**
 * The international desktop client's UA. The `workbuddy-ai/` segment only
 * exists on that gateway, and the CN spelling gets the CLI roster there.
 */
const GLOBAL_CHAT_UA = `WorkBuddy/${GLOBAL_CLIENT_VERSION} workbuddy-ai/${GLOBAL_CLIENT_VERSION} CLI/${GLOBAL_CLI_VERSION}`

/**
 * Desktop app UA for the global gateway. It serves its product config only to
 * this client channel: the CLI UA gets a truncated roster (or an HTTP 500),
 * which is why the international catalog must be read with the desktop
 * spelling.
 */
const GLOBAL_DESKTOP_UA = `WorkBuddy/${GLOBAL_CLIENT_VERSION}`

/** CN model catalog. */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = '/v3/config'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096
/** Deadline for a failed response's error body, which no other phase covers. */
export const ERROR_BODY_TIMEOUT_MS = 10_000
/** Deadline for the chat POST to reach its response headers. */
const STREAM_HEADERS_TIMEOUT_MS = 60_000
/** Longest a relayed chat stream may go without a single byte. */
const STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000
/**
 * Lifetime assumed for a token whose answer carries no `expiresIn`.
 *
 * It must exceed the refresh margin, or a refreshed credential would read as
 * already-expiring and every request would refresh again. An hour is
 * comfortably past that margin and far short of any cap, so a token with a
 * real lifetime always replaces it in time.
 */
const ASSUMED_TOKEN_LIFETIME_MS = 60 * 60 * 1000

/** Longest expiry `Date` can represent; anything past it is not a date. */
const MAX_EXPIRY_MS = 4_102_444_800_000

/**
 * Absolute expiry for a token the vendor issued, from its `expiresIn`.
 *
 * The figure comes from the vendor's own answer, so it is bounded here rather
 * than trusted: a garbled one (1e300, Infinity) would otherwise store a
 * timestamp past `Date`'s range, and the panel's `toISOString()` for that row
 * then threw, failing the whole document rather than the one field. A value
 * this function refuses falls back to the assumed lifetime, not to 0: 0 means
 * "never expires", which would leave a token that really was not fresh being
 * served as if it were.
 */
export function tokenExpiryMs(expiresInSec: number | undefined): number {
  const assumed = () => Date.now() + ASSUMED_TOKEN_LIFETIME_MS
  if (typeof expiresInSec !== 'number' || !Number.isFinite(expiresInSec) || expiresInSec <= 0) {
    return assumed()
  }
  const at = Date.now() + expiresInSec * 1000
  if (!Number.isFinite(at) || at > MAX_EXPIRY_MS) return assumed()
  return at
}

/**
 * A response's `Retry-After`, in whole seconds, bounded.
 *
 * The header is the upstream's own answer to "how long", and it is the only
 * place a 429 window can be stated that the body parser does not cover.
 */
export function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (raw === null || raw.trim() === '') return undefined
  return boundedRetryAfterSeconds(Number(raw.trim()))
}

/**
 * Wrap a relayed body so a stream that goes quiet mid-turn fails instead of
 * hanging. The upstream socket is cancelled on the first idle gap, and the
 * failure is surfaced through the stream: `reader.cancel` resolves the pending
 * read as a clean end, which the relay would otherwise report as a finished
 * turn with a truncated reply.
 */
export function withIdleWatchdog(
  body: ReadableStream<Uint8Array>,
  idleMs: number = STREAM_IDLE_TIMEOUT_MS,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let idle: Error | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  /**
   * Give up on the body and make the pending read report this failure.
   *
   * `reader.cancel` resolves the read the watchdog is waiting on as an end
   * rather than rejecting it, so the reason is recorded for `pull` to turn into
   * an error instead of a clean close. Shared by the idle timer and a caller
   * hang-up: a client that stopped waiting must tear the upstream down, and the
   * header deadline deliberately detaches its own listener once the headers
   * land, so this is where that abort has to be caught.
   */
  const stop = (reason: Error): void => {
    if (idle !== undefined) return
    idle = reason
    void reader.cancel(reason).catch(() => {})
    disarm()
    // Detached as well as on the terminal paths: once the read is cancelled
    // this listener has no work left, and a body the consumer never reads or
    // cancels again would keep it on the caller's signal for the whole rotation.
    detach()
  }
  const onAbort = (): void => {
    stop(signal?.reason instanceof Error ? signal.reason : new Error('upstream stream cancelled by the caller'))
  }
  // The listener is added once per attempt and removed on every terminal path:
  // a rotation that exhausts its attempts wraps eight bodies on the same caller
  // signal, and leaving one listener each is how the listener warning fired.
  const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort)
  const finish = (): void => {
    disarm()
    detach()
  }
  const arm = (): void => {
    disarm()
    timer = setTimeout(() => { stop(new Error('upstream stream went idle')) }, idleMs)
    timer.unref?.()
  }
  return new ReadableStream<Uint8Array>({
    start() { arm() },
    async pull(controller) {
      try {
        const next = await reader.read()
        // Checked before `done`: the watchdog cancels the reader, which
        // resolves the read as an end of stream rather than rejecting it.
        // And checked before `arm`: re-arming for a stream the watchdog has
        // already given up on leaves a timer counting down into a reader that
        // has been released, which is the same leak one branch down.
        if (idle !== undefined) {
          finish()
          controller.error(idle)
          return
        }
        arm()
        if (next.done) {
          // The stream is over, and so is the timer: without this every turn
          // left one armed for the full idle window, holding the reader and
          // the upstream response alive with it.
          finish()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (error: unknown) {
        finish()
        controller.error(error)
      }
    },
    cancel(reason) {
      finish()
      return reader.cancel(reason)
    },
  })
}

/**
 * A fetch signal that covers the response headers and nothing else.
 *
 * A signal handed to `fetch` stays attached to the response body afterwards:
 * undici errors the body when it fires, so a deadline meant for the headers
 * phase cuts the stream dead the moment it expires. Measured on this machine,
 * every WorkBuddy turn longer than a minute and every Trae or Qoder turn
 * longer than two was aborted mid-body, the client meeting a reset connection
 * instead of the rest of the reply.
 *
 * The returned signal is aborted by a hang-up straight away, and by the
 * deadline only while the request is still waiting for headers. `arrived()`
 * disarms the deadline and detaches the hang-up listener, because a rotation
 * that exhausts its attempts would otherwise add one listener per account on
 * the same caller signal. The body's own teardown on a hang-up is the idle
 * watchdog's: `withIdleWatchdog` is handed the same signal and cancels the
 * upstream read when it fires.
 */
export function headersDeadline(
  caller: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; arrived: () => void } {
  const controller = new AbortController()
  const onCallerAbort = (): void => controller.abort(caller?.reason)
  // A caller that hung up before this was built has already said everything:
  // forwarding only future aborts sent the request anyway, and the turn it
  // belonged to was being paid for by nobody.
  if (caller?.aborted === true) controller.abort(caller.reason)
  else caller?.addEventListener('abort', onCallerAbort)
  const timer = setTimeout(() => {
    controller.abort(new Error(`upstream did not send response headers within ${ms}ms`))
  }, ms)
  timer.unref?.()
  return {
    signal: controller.signal,
    arrived: () => {
      clearTimeout(timer)
      // Detached as well as disarmed: one listener is added per call, and a
      // rotation that exhausts its attempts adds one per account on the same
      // caller signal, which is how Node's listener warning used to fire on
      // every exhausted turn.
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** Whether a text names an exhausted balance rather than a rate limit. */
export function isHardCreditText(body: string): boolean {
  const lower = body.toLowerCase()
  return HARD_CREDIT_MARKERS.some(marker => lower.includes(marker.toLowerCase()) || body.includes(marker))
}

/**
 * Session-invalidation markers that mean "sign in again in the WorkBuddy app".
 *
 * `12153` is matched as an envelope value, not as a bare substring: a plain
 * `12153` turns up inside ids and timestamps, and on a rate-limited body it
 * would reclassify a cooldown as a dead session - which rotates without ever
 * cooling the account, so the same limited account is hit on every attempt.
 */
const SESSION_DEAD_PATTERN = /Offline user session not found|"code"\s*:\s*"?12153\b/u

/**
 * The plan gate: the account is fine, the model is not included in it.
 *
 * Matched as an envelope value rather than a bare substring, for the same
 * reason as the session marker: `11158` turns up inside ids, and reclassifying
 * a request error as a plan gate would cool a model that is actually fine.
 */
const MODEL_TIER_PATTERN = /"code"\s*:\s*"?11158\b/u

/**
 * The prompt-screen refusal: `11128`.
 *
 * The host returns it for a system or assistant turn whose wording belongs to a
 * client it does not serve. It is a property of the request body, not the
 * account, so the rotation must not spend another sign-in on it; `chatStream`
 * moves the system prompt into the first user turn and retries once instead.
 */
const CHANNEL_CHECK_PATTERN = /"code"\s*:\s*"?11128\b/u

/**
 * The vendor's account-level restriction: `11140`, "request illegal".
 *
 * The body names the account ("your account has been restricted due to unusual
 * activity") rather than the request, and no retry with the same sign-in can
 * clear it. Reading it as a plain client error answered 400 and stopped the
 * rotation, so a second account that could serve the turn was never tried.
 */
const ACCOUNT_RESTRICTED_PATTERN = /"code"\s*:\s*"?11140\b/u

/**
 * The upstream's rate-limit marker.
 *
 * The same envelope is returned with HTTP 200 by JSON endpoints and by the
 * chat screen, so the status alone cannot decide it. The code is matched as an
 * envelope value rather than as a bare number for the reason above; the text
 * forms cover the older deployments that answer with prose only.
 */
const SOFT_RATE_PATTERN = /"code"\s*:\s*"?6004\b|soft_rate|频率限制/u

/** The two gateways WorkBuddy serves: the domestic one and the international one. */
export type WorkBuddyRegion = 'cn' | 'global'

/**
 * Hosts the international product answers on, once each has been stripped of a
 * leading label. The WorkBuddy AI desktop app signs in at `workbuddy.ai` (and
 * the desktop client itself lists `workbuddy.cc` alongside it); the CodeBuddy
 * CLI signs the same international account in at `codebuddy.ai`. All are served
 * by one gateway stack, so all are `global` — missing a spelling sends those
 * tokens to the CN gateway, which rejects them at the openresty layer with an
 * HTML 401 instead of a business JSON error.
 */
const GLOBAL_HOSTS: readonly string[] = ['workbuddy.ai', 'workbuddy.cc', 'codebuddy.ai']

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): 'cn' | 'global' {
  const lowered = domain.trim().toLowerCase()
  for (const host of GLOBAL_HOSTS) {
    if (lowered === host || lowered.endsWith(`.${host}`)) return 'global'
  }
  return 'cn'
}

/** The client version that gateway expects in `X-IDE-Version`. */
function clientVersion(region: 'cn' | 'global'): string {
  return region === 'global' ? GLOBAL_CLIENT_VERSION : CN_CLIENT_VERSION
}

/** The full chat UA for the credential's gateway. */
function chatUa(region: 'cn' | 'global'): string {
  return region === 'global' ? GLOBAL_CHAT_UA : CN_CHAT_UA
}

/** The desktop-process UA for endpoints outside the chat path. */
function desktopUa(region: 'cn' | 'global'): string {
  return region === 'global' ? GLOBAL_DESKTOP_UA : CN_DESKTOP_UA
}

/**
 * The OpenAI Node SDK's fingerprint headers, as the current desktop client sends
 * them. OS, architecture and runtime version follow the host so a macOS or Linux
 * install does not claim to be a Windows client; the rest mirror the bundled CLI.
 */
function stainlessHeaders(): Record<string, string> {
  const os = process.platform === 'win32' ? 'Windows'
    : process.platform === 'darwin' ? 'MacOS' : 'Linux'
  return {
    'x-stainless-lang': 'js',
    'x-stainless-package-version': '6.25.0',
    'x-stainless-os': os,
    'x-stainless-arch': process.arch,
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '1200',
  }
}

/**
 * Gateway for a global credential.
 *
 * International accounts are NOT interchangeable across brand domains: a token
 * issued at `codebuddy.ai` is rejected by the `workbuddy.ai` gateway and vice
 * versa, so the base must follow the credential's own domain rather than one
 * hardcoded host. Anything unrecognised falls back to the desktop app's gateway.
 */
function globalBase(credential: WorkBuddyCredential): string {
  const lowered = credential.domain.trim().toLowerCase()
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BASE
}

function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? globalBase(credential) : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': billingBase(credential),
    'Referer': `${billingBase(credential)}/`,
    'User-Agent': desktopUa(regionOf(credential.domain)),
    // The official client's gate header, on every API request. Missing it
    // marks the caller as something other than the client.
    'X-CodeBuddy-Request': '1',
    // One connection per request. undici's global pool would otherwise hand a
    // socket that just carried another account's Authorization to the next
    // account, and two credentials seen on one connection is a correlation
    // clue the connection itself carries. fetch exposes no per-request agent,
    // so the socket is closed instead; a turn pays one handshake for it.
    'Connection': 'close',
  }
}

/**
 * The conversation header family the desktop client puts on every chat request.
 *
 * The international gateway runs a channel check that refuses a request
 * carrying no conversation id at all: business code 11128,
 * `conversation id missing`, answered as a 400 whose tip says the call failed
 * channel verification. The CN gateway does not ask for it and accepts the
 * family too, so it is sent on both rather than branched on region.
 *
 * The shapes and the pairings follow the 5.8.4 client capture: the conversation
 * id is a dashed UUID, the four request and message ids are 32 hex characters,
 * `X-Root-Request-ID` carries the same value as `X-Conversation-Request-ID`,
 * and `X-Request-ID` the same value as `X-Conversation-Message-ID`. The trace
 * family is the W3C/B3 pair the client sends; `X-B3-ParentSpanId` is left out
 * because a real parent span needs a caller this plugin does not have.
 *
 * Every id is fresh per request. The upstream keeps no history by the
 * conversation id - the same id sent twice answers the second turn as a fresh
 * one - so there is nothing to gain from deriving it, and a stable value would
 * be one more thing for the channel check to notice.
 */
function conversationHeaders(region: 'cn' | 'global'): Record<string, string> {
  const turn = randomUUID().replace(/-/g, '')
  const message = randomUUID().replace(/-/g, '')
  const traceId = randomUUID().replace(/-/g, '')
  const spanId = randomBytes(8).toString('hex')
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': turn,
    'X-Root-Request-ID': turn,
    'X-Conversation-Message-ID': message,
    'X-Request-ID': message,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-IDE-Version': clientVersion(region),
    'X-Private-Data': 'true',
    'X-Trace-ID': traceId,
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const region = regionOf(credential.domain)
  return {
    ...commonHeaders(credential),
    ...conversationHeaders(region),
    ...stainlessHeaders(),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...credential.uid === '' || credential.uid === undefined
      ? { 'X-No-User-Id': '1' }
      : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
    // CN 5.9 names its agent runtime; the international build does not.
    ...region === 'cn' ? { 'X-Agent-Runtime': 'local-agent' } : {},
    'User-Agent': chatUa(region),
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    // Billing does not go through commonHeaders, so the gate header lands here.
    'X-CodeBuddy-Request': '1',
    // A request with no UA at all is its own kind of fingerprint: every client
    // sends one, and leaving it out made the billing family look unlike the
    // desktop app the rest of the calls imitate.
    'User-Agent': desktopUa(regionOf(credential.domain)),
    // Same reason as commonHeaders: one connection, one account.
    'Connection': 'close',
  }
  if (credential.uid !== '' && credential.uid !== undefined) headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

/**
 * Gateway denials that arrive as an HTML page rather than a JSON envelope.
 *
 * openresty / APISIX reject a request before it reaches the product when the
 * credential is one the gateway no longer honours — most often a stale sign-in
 * left in the auth directory. The status alone (401) is not actionable and the
 * HTML body leaks nothing useful, so this turns it into a sentence the user can
 * act on.
 */
function isGatewayHtmlRejection(status: number, text: string): boolean {
  if (status !== 401 && status !== 403) return false
  const head = text.slice(0, 512).toLowerCase()
  return head.includes('<html') || head.includes('openresty') || head.includes('apisix')
}

/**
 * The sentence a gateway-level rejection is answered with.
 *
 * openresty / APISIX reject a request before it reaches the product when the
 * credential is one the gateway no longer honours. The status alone is not
 * actionable and the HTML body leaks nothing useful, so the raw page would
 * otherwise reach the client as the error text.
 */
function gatewayRejectionText(status: number): string {
  return (
    `the WorkBuddy gateway rejected this credential (http ${status}). This usually means the ` +
    'account is using a stale sign-in the upstream no longer accepts: sign in again in ' +
    'the WorkBuddy desktop app, then pick the account on the plugin card. ' +
    "Run the WTQ Pool connection check (the panel's connection tab) to list every credential found."
  )
}

/**
 * Read a failed response's body, bounded in both time and size.
 *
 * An upstream that answers 429 and then trickles its error page would otherwise
 * hold the attempt until undici's own body timeout, and a rotation pays that
 * once per account before it can answer at all. Cancelling the reader is what
 * releases the socket, so the bound is real rather than a race that leaves the
 * connection behind. The caller's own hang-up reaches the body through
 * `signal`: the headers deadline has detached itself by the time a non-2xx
 * answer is read, so a cancelled turn would otherwise wait out the deadline
 * below with the socket still open.
 *
 * Never rejects: a read that fails keeps whatever arrived, which is usually the
 * sentence the client needs. Callers on the error path used to let a body that
 * died mid-read replace the upstream's status with a bare abort error.
 *
 * `timeoutMs` is a seam for the check: the shipped deadline is ten seconds, and
 * the case that proves the reader is cancelled should not sit it out.
 */
export async function readErrorBody(
  response: Response,
  limitBytes: number,
  signal?: AbortSignal,
  timeoutMs: number = ERROR_BODY_TIMEOUT_MS,
): Promise<string> {
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const abandon = (reason: string): void => {
    void reader.cancel(new Error(reason)).catch(() => {})
  }
  const deadline = setTimeout(() => { abandon('upstream error body read timed out') }, timeoutMs)
  deadline.unref?.()
  const onAbort = (): void => { abandon('upstream error body read cancelled by the caller') }
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener('abort', onAbort)
  let done = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        done = true
        break
      }
      text += decoder.decode(next.value, { stream: true })
      // Past the limit the rest is discarded: the caller slices it anyway, and
      // an unbounded error page is the one body size nobody bounds. The slice
      // below is what makes the bound exact when one chunk overshoots it.
      if (text.length >= limitBytes) break
    }
  } catch {
    /* keep what arrived */
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener('abort', onAbort)
    // A read abandoned at the size limit leaves the upstream response
    // unconsumed, and nothing else closes it: the socket is held until undici
    // or the peer gives up. Cancelling is what releases it.
    if (!done) abandon('upstream error body size limit reached')
    reader.releaseLock()
  }
  return text.length > limitBytes ? text.slice(0, limitBytes) : text
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  if (isGatewayHtmlRejection(response.status, text)) {
    // The status is interpolated rather than written: this branch accepts 401
    // and 403, and naming 401 for a 403 sends the reader looking for a
    // credential problem the gateway never reported.
    //
    // The kind rides on the error because the callers that have to act on it
    // (a refresh-and-retry, a hold) catch this throw rather than reading a
    // result object, and matching the sentence would tie them to its wording.
    throw Object.assign(new Error(gatewayRejectionText(response.status)), {
      kind: classifyUpstreamError(response.status, text),
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${redactSecrets(text).slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  // The business code arrives as a number on the chat path and as a numeric
  // string on some JSON endpoints. Reading only the number turned `"12153"`
  // into success, so the refusal was never classified and the sign-in was
  // served again on the next request.
  const rawCode = document['code']
  const code = typeof rawCode === 'number' && Number.isFinite(rawCode)
    ? rawCode
    : typeof rawCode === 'string' && /^-?\d+$/u.test(rawCode.trim())
      ? Number(rawCode.trim())
      : 0
  return {
    code,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  // Classified from the envelope rebuilt as a document, not from `msg` alone:
  // the business codes that decide a class live in the `code` field, so passing
  // only the message hid 11140/11158 from every JSON answer and left a refused
  // roster read looking like a plain client error.
  const document = JSON.stringify({ code: envelope.code, msg: envelope.msg })
  const kind = classifyUpstreamError(status, document)
  return Object.assign(
    new Error(`workbuddy upstream ${kind} (http ${status}): ${redactSecrets(envelope.msg).slice(0, 160)}`),
    { kind },
  )
}

/**
 * The classified kind of an upstream failure, for a caller holding the error.
 *
 * `chatStream` answers with its kind in the result; every JSON endpoint throws,
 * and a caller that must tell a refused sign-in from a rate limit would
 * otherwise match on the message text. Anything without a kind - a local fault,
 * a bug - reads as undefined rather than being guessed at.
 */
export function upstreamErrorKind(error: unknown): UpstreamErrorKind | undefined {
  const kind = (error as { kind?: unknown } | null | undefined)?.kind
  return typeof kind === 'string' ? kind as UpstreamErrorKind : undefined
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * A body marker only refines a status that has not already said something
 * more specific. A 429 has: the throttling answer routinely quotes quota
 * text, and reading that as billing exhaustion answered 402 for a limit that
 * clears on its own. When the status is about the sign-in, the only thing
 * that may reclassify it is a session marker, and a session marker never
 * fires on any other status, or a rate limit whose text happens to carry
 * the code would rotate without cooling the account.
 *
 * The credit markers are read on the statuses the upstream itself uses for
 * "this account cannot pay": 402, 403, and an HTTP 200 business envelope. A
 * 400 or 422 is a verdict on the REQUEST, and its body routinely quotes the
 * quota it measured against, so matching there turned a malformed body into a
 * whole-pool rotation and a 402 that named the wrong problem.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  // JSON endpoints answer a refusal as HTTP 200 with a business code. Reading
  // the status as success left a dead sign-in unheld, a rate limit rotating
  // without a cooldown, and a plan gate looking like a client error.
  if (status === 200) {
    if (ACCOUNT_RESTRICTED_PATTERN.test(body)) return 'account_restricted'
    if (MODEL_TIER_PATTERN.test(body)) return 'model_tier'
    if (SESSION_DEAD_PATTERN.test(body)) return 'session_dead'
    // The business code outranks prose here, matching the chat path: a rate
    // limit that quotes quota text is still a rate limit, not a spent account.
    if (SOFT_RATE_PATTERN.test(body)) return 'soft_rate'
    if (isHardCreditText(body)) return 'hard_credit'
    return 'client'
  }
  // The vendor restricted the account itself. The body names the account, not
  // the request, so no retry with this sign-in can clear it; reading it as
  // `client` answered 400 and left the rotation on the first account.
  if ((status === 400 || status === 403 || status === 422) && ACCOUNT_RESTRICTED_PATTERN.test(body)) {
    return 'account_restricted'
  }
  // A plan refusal is a verdict on the model, not on the account: the sign-in
  // is healthy and every other model on it still works. Reading it as `client`
  // answered a bare 400 and never tried the accounts that can serve the model.
  if ((status === 400 || status === 403 || status === 422) && MODEL_TIER_PATTERN.test(body)) {
    return 'model_tier'
  }
  const aboutSignIn = status === 401 || status === 403
  if (aboutSignIn && SESSION_DEAD_PATTERN.test(body)) return 'session_dead'
  // A 401 carries no other meaning here: the loopback endpoint authenticates
  // nothing, so the upstream is the only party that could have refused the
  // bearer, and it refused this account's. Reading the unrecognised ones as
  // `client` answered 400 and broke the rotation on the first account, which
  // left a stale sign-in serving every turn as a hard failure while the
  // refresh-and-retry path below it — written for exactly this — never ran.
  // The gateway's own HTML page is the other shape a 401 takes, and it means
  // the same thing about the credential.
  if (status === 401) return 'session_dead'
  // A 403 the upstream answers with a credit marker is a spent account, not a
  // sign-in problem: the marker names the reason and the session pattern above
  // has already had its chance. A 400 or 422 never gets here — it is a verdict
  // on the request, and its body routinely quotes the quota it measured
  // against, so matching there turned a malformed body into a whole-pool
  // rotation and a 402 that named the wrong problem.
  if (status === 403) {
    if (isHardCreditText(body)) return 'hard_credit'
  }
  // The three markers refine a status that is itself undecided about rate
  // limiting, and only that. A 400/404/422 is a verdict on the request, and its
  // body routinely quotes the quota it measured against; a 5xx is an upstream
  // fault that stays one. Both matched here once, and either turned a bad
  // request or an outage into a whole-pool rotation answered as 429.
  if (status === 503 && SOFT_RATE_PATTERN.test(body)) return 'soft_rate'
  // A 403 with no business envelope is the gateway's WAF page (HTML, empty or
  // plain text), not an answer about the request: it clears with time and
  // another account, so it must not read as a terminal client error. A 403
  // that carries `"code":` / `"msg":` is the upstream's own verdict and stays
  // with the classes above and below.
  if (status === 403 && !/"code"\s*:|"msg"\s*:/.test(body)) return 'waf_block'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/**
 * Parse the reset time the upstream reports for a rate limit, when present.
 * Recognises an epoch-millisecond field and the Chinese-localised sentence
 * form, so the pool can resume exactly when the window reopens.
 *
 * The localised form is a Beijing wall clock with no zone on it, so it is read
 * as UTC+8 rather than as whatever the host machine is set to. Parsing it as
 * local time puts the reset 13 hours out on a US host — the account stays out
 * of rotation all day — and 3 hours early in Sydney, where it comes back while
 * still limited and the request rotates again. China has had no DST since
 * 1991, so the fixed offset is exact and needs no timezone dependency.
 */
const UPSTREAM_CLOCK_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Longest a parsed reset may push an account out of rotation. The upstream's
 * own soft-cooldown ceiling is 2h; anything beyond that is a stale or
 * mis-parsed timestamp, and sleeping a whole day on it is worse than coming
 * back early to a still-limited account (the next 429 re-cools it anyway).
 */
const RATE_RESET_CAP_MS = 2 * 60 * 60 * 1000

/** Clamp a parsed reset into [now, now + cap]; the past stays past. */
function capRateReset(value: number): number {
  const now = Date.now()
  if (value <= now) return value
  return Math.min(value, now + RATE_RESET_CAP_MS)
}

export function parseRateLimitReset(body: string): number | undefined {
  // The value may be quoted and may count seconds instead of milliseconds; both
  // spellings occur, and a quoted or seconds-level value fell through to the
  // default cooldown while the upstream had named the exact window.
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*["']?(\d{10,13})["']?/.exec(body)
  if (epochMs !== null) {
    const raw = Number(epochMs[1])
    return capRateReset(raw < 1e12 ? raw * 1000 : raw)
  }

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const asUtc = Date.parse(localized[1]!.replace(' ', 'T') + 'Z')
    if (!Number.isNaN(asUtc)) return capRateReset(asUtc - UPSTREAM_CLOCK_OFFSET_MS)
  }
  return undefined
}

/** Parse the upstream's `credits` string into a multiplier. */
function parseCreditMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value)
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * The effort ladder the upstream's plural-form payloads declare across both
 * gateways (the live union of every `supportedEfforts` list seen; `minimal` has
 * never appeared). Both gateways also accept every level of it on
 * singular-form models — medium/xhigh fold into high, low/max answer with their
 * own budgets — so a singular `effort` value is a DEFAULT, never the model's
 * only level.
 */
const SINGULAR_EFFORT_LADDER: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * True when `reasoning` arrives in the singular spelling: an `effort` string,
 * with none of the plural-form fields alongside it. Seen on CN
 * `deepseek-v4.1-flash` / `kimi-k3-1` / `glm-5.2` and global
 * `deepseek-v4.1-flash` / `kimi-k3` / `gemini-3.5-flash`.
 */
function isSingularEffortForm(raw: Record<string, unknown>): boolean {
  return typeof raw['effort'] === 'string'
    && !Array.isArray(raw['supportedEfforts'])
    && typeof raw['defaultEffort'] !== 'string'
    && typeof raw['canDisableThinking'] !== 'boolean'
}

/**
 * Fold a singular-form `effort` into the plural shape the rest of the plugin
 * already understands. Probes on both gateways show these models answer with
 * distinct `reasoning_content` across the whole ladder — and do not think at
 * all when no `reasoning_effort` is sent — so the fold widens
 * `supportedEfforts` and carries the declared value into `defaultEffort`. An
 * unrecognized `effort` passes through as the lone level.
 */
function singularEffortLadder(raw: Record<string, unknown>): string[] | undefined {
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  if (effort === undefined) return undefined
  return SINGULAR_EFFORT_LADDER.includes(effort) ? [...SINGULAR_EFFORT_LADDER] : [effort]
}

/**
 * Parse the upstream's `reasoning` object; unknown shapes degrade to
 * `undefined`. Both spellings normalize here: the plural form passes through as
 * declared, and the singular `effort` form folds via
 * {@link singularEffortLadder}.
 */
function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const singularForm = isSingularEffortForm(raw)
  const effort = typeof raw['effort'] === 'string' ? raw['effort'] : undefined
  const supportedEfforts = Array.isArray(raw['supportedEfforts'])
    ? raw['supportedEfforts'].filter((entry): entry is string => typeof entry === 'string')
    : singularEffortLadder(raw)
  const defaultEffort = typeof raw['defaultEffort'] === 'string'
    ? raw['defaultEffort']
    : effort
  const canDisableThinking = typeof raw['canDisableThinking'] === 'boolean'
    ? raw['canDisableThinking']
    : singularForm ? true : undefined
  if (supportedEfforts === undefined && defaultEffort === undefined && canDisableThinking === undefined) {
    return undefined
  }
  return {
    ...supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...canDisableThinking === undefined ? {} : { canDisableThinking },
  }
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  // Growth rewards sometimes arrive as numeric strings. Treating those as 0
  // made a claim that had already paid look like it collected nothing.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw['id'] === 'string' ? raw['id'] : ''
  if (id === '' || raw['disabled'] === true) return undefined
  const input = typeof raw['maxInputTokens'] === 'number' ? raw['maxInputTokens'] : 0
  const output = typeof raw['maxOutputTokens'] === 'number' ? raw['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const name = typeof raw['name'] === 'string' && raw['name'] !== '' ? raw['name'] : id
  const creditMultiplier = parseCreditMultiplier(raw['credits'])
  const reasoning = parseReasoning(raw['reasoning'])
  const supportsImages = typeof raw['supportsImages'] === 'boolean' ? raw['supportsImages'] : undefined
  return {
    id,
    name,
    contextWindow: input,
    maxTokens: output,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...reasoning === undefined ? {} : { reasoning },
    ...supportsImages === undefined ? {} : { supportsImages },
  }
}

/**
 * Put an empty system prompt in front of the conversation when the host opened
 * with a user turn.
 *
 * The international gateway refuses a request whose first message is not a
 * system prompt (code 11128, "first message is not system prompt"), and a host
 * that starts with the user's turn sends none. The content is empty on purpose:
 * it satisfies the check without adding an instruction the model would follow,
 * so the model still sees exactly what the host sent. The CN gateway asks for
 * neither, so this is the one part of the shape that is region-specific.
 */
function withLeadingSystemPrompt(prepared: string): string {
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    return prepared
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return prepared
  const obj = body as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return prepared
  const first = messages[0]
  if (typeof first === 'object' && first !== null
    && (first as Record<string, unknown>)['role'] === 'system') {
    return prepared
  }
  obj['messages'] = [{ role: 'system', content: '' }, ...messages]
  return JSON.stringify(obj)
}

/**
 * System prompts the host has already refused at its channel check.
 *
 * WorkBuddy's prompt screen reads system and assistant roles, not user turns, and
 * it matches more than one client's wording: the DSH opening line, the DSH GUI
 * pair, and several lines shared with other agent harnesses. A fixed rewrite list
 * is therefore always one upstream change behind. The first turn that is refused
 * pays one 400, its system prompt is folded into the first user message, and the
 * same prompt is folded before sending from then on. Bounded so a process that
 * sees many one-off prompts keeps only recent ones.
 */
const FOLDED_PROMPTS_MAX = 32
const foldedPrompts = new Set<string>()

/** The fingerprint of every system message in a prepared body, if it has one. */
function systemPromptFingerprint(prepared: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    return undefined
  }
  const messages = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) return undefined
  const texts: string[] = []
  for (const value of messages) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const message = value as Record<string, unknown>
    if (message['role'] !== 'system' && message['role'] !== 'developer') continue
    texts.push(contentText(message['content']))
  }
  if (texts.length === 0) return undefined
  return createHash('sha256').update(texts.join('\u0000')).digest('hex')
}

/** The text parts of a message content value, joined for the fingerprint and fold. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>)['text'] === 'string') {
      parts.push((part as Record<string, unknown>)['text'] as string)
    }
  }
  return parts.join('\n')
}

/**
 * Move every system message into the first user message, and take the client
 * name out of assistant turns.
 *
 * The host accepts the same instructions in a user turn; a system turn is what
 * its channel check inspects. Assistant turns are inspected too, so a reply that
 * quoted the client name would fail the next request; that copy is renamed. A
 * neutral system message stays first so a gateway that insists on one still sees
 * it. Returns undefined when there is nothing to move or rename, which is also
 * what keeps an empty system message from looping.
 */
export function foldSystemIntoUser(prepared: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const obj = body as Record<string, unknown>
  const messages = obj['messages']
  if (!Array.isArray(messages)) return undefined

  const prompts: string[] = []
  const rest: unknown[] = []
  let renamed = false
  for (const value of messages) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const message = value as Record<string, unknown>
      if (message['role'] === 'system' || message['role'] === 'developer') {
        const text = contentText(message['content'])
        if (text.trim() !== '') prompts.push(text)
        continue
      }
      if (message['role'] === 'assistant' && 'content' in message) {
        const content = renameInContent(message['content'])
        if (content !== message['content']) {
          renamed = true
          rest.push({ ...message, content })
          continue
        }
      }
    }
    rest.push(value)
  }
  if (prompts.length === 0 && !renamed) return undefined
  if (prompts.length === 0) {
    obj['messages'] = rest
    return JSON.stringify(obj)
  }

  const instructions = prompts.join('\n\n')
  const firstUser = rest.findIndex((value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>)['role'] === 'user')
  if (firstUser === -1) {
    rest.unshift({ role: 'user', content: instructions })
  } else {
    const message = rest[firstUser] as Record<string, unknown>
    const content = message['content']
    rest[firstUser] = {
      ...message,
      content: typeof content === 'string'
        ? `${instructions}\n\n${content}`
        : [{ type: 'text', text: instructions }, ...(Array.isArray(content) ? content : [])],
    }
  }
  obj['messages'] = [{ role: 'system', content: '' }, ...rest]
  return JSON.stringify(obj)
}

/**
 * Rename the client in one message content, preserving every other field.
 *
 * Matched case-insensitively because the host's screen is, and only the product
 * name is replaced: the rest of the sentence still reads naturally, and the
 * model sees the same instructions.
 */
function renameInContent(content: unknown): unknown {
  const rename = (text: string): string => text.replace(/DeepSeek Harness/gi, 'DeepSeek')
  if (typeof content === 'string') return rename(content)
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (typeof part === 'string') return rename(part)
    if (typeof part !== 'object' || part === null || Array.isArray(part)) return part
    const record = part as Record<string, unknown>
    if (typeof record['text'] !== 'string') return part
    const text = rename(record['text'])
    return text === record['text'] ? part : { ...record, text }
  })
}

function rememberFoldedPrompt(fingerprint: string): void {
  if (foldedPrompts.has(fingerprint)) return
  if (foldedPrompts.size >= FOLDED_PROMPTS_MAX) {
    const oldest = foldedPrompts.values().next().value
    if (oldest !== undefined) foldedPrompts.delete(oldest)
  }
  foldedPrompts.add(fingerprint)
}

/** Whether a 400 body is the host's prompt screen rather than a bad request. */
function isChannelCheckText(text: string): boolean {
  return CHANNEL_CHECK_PATTERN.test(text)
}

export class WorkBuddyUpstreamClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: UpstreamClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  /**
   * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
   * force `stream: true` (the upstream rejects non-streaming), convert the
   * DSH `developer` role into `system` (upstream rejects `developer` with
   * business code 11128), and flatten `tool_choice` into its string form.
   */
  prepareChatBody(raw: string): string {
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return raw
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return raw
    const obj = body as Record<string, unknown>
    obj['stream'] = true
    delete obj['stream_options']
    if (Array.isArray(obj['messages'])) {
      for (const value of obj['messages']) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
        const message = value as Record<string, unknown>
        if (message['role'] === 'developer') message['role'] = 'system'
        // The host's prompt screen reads assistant turns as well as system
        // ones, so a reply that quoted the client name would fail every later
        // turn of the same conversation. Renaming the product in history is
        // local to this copy; the conversation the user sees is unchanged.
        if (message['role'] === 'assistant' && 'content' in message) {
          const content = renameInContent(message['content'])
          if (content !== message['content']) message['content'] = content
        }
      }
    }
    const choice = obj['tool_choice']
    if (typeof choice === 'string') {
      if (choice.trim().toLowerCase() === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      }
    } else if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const wrapped = choice as Record<string, unknown>
      const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
      if (type === 'none') {
        delete obj['tool_choice']
        delete obj['tools']
        delete obj['functions']
      } else if (type === 'auto' || type === 'required') {
        obj['tool_choice'] = type
      } else if (type === 'function') {
        const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
          ? (wrapped['function'] as Record<string, unknown>)
          : undefined
        let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
        if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
        obj['tool_choice'] = name.trim() !== '' ? name.trim() : 'auto'
      }
      // An unrecognised form is passed through rather than dropped: the upstream
      // is the one that knows whether it can honour it, and deleting it here
      // silently removed a restriction the client set.
    }
    return JSON.stringify(obj)
  }


/** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(
    credential: WorkBuddyCredential,
    prepared: string,
    signal?: AbortSignal,
    timeouts?: { headersMs?: number; idleMs?: number },
  ): Promise<ChatStreamResult> {
    const fingerprint = systemPromptFingerprint(prepared)
    const region = regionOf(credential.domain)
    // The international gateway also insists the first message be a system
    // prompt. This is the one place the credential is known, so it is the one
    // place the region can be decided; CN pays nothing for it.
    let body = region === 'global' ? withLeadingSystemPrompt(prepared) : prepared
    // A prompt this process has already seen refused is folded before sending,
    // so only the first turn of a conversation pays the channel check. Keyed by
    // region: a CN refusal says nothing about what the international host wants.
    const cacheKey = fingerprint === undefined ? undefined : `${region}:${fingerprint}`
    if (cacheKey !== undefined && foldedPrompts.has(cacheKey)) {
      body = foldSystemIntoUser(body) ?? body
    }
    // Remembered only once the folded request is accepted: a retry that fails
    // again must leave the prompt unfolded for the next turn instead of caching
    // a rewrite that does not work.
    let rememberOnSuccess: string | undefined
    // One retry, and only for the prompt screen: the host answers 11128 on the
    // system role, and the same instructions in the first user message pass.
    for (let attempt = 0; ; attempt++) {
      let response: Response
      // The caller's signal only covers a hang-up; an upstream that accepts the
      // POST and then goes quiet held the turn until the host's own fetch
      // timeout. The headers phase gets a deadline of its own, and the stream an
      // idle watchdog: a healthy stream sends something every few seconds.
      const deadline = headersDeadline(signal, timeouts?.headersMs ?? STREAM_HEADERS_TIMEOUT_MS)
      try {
        response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
          redirect: 'error',
          method: 'POST',
          headers: chatHeaders(credential),
          body,
          signal: deadline.signal,
        })
      } catch (error: unknown) {
        // The caller hanging up is not an upstream failure. Answering it as one
        // made every cancelled turn look like a network fault in the log, and
        // spent a rotation on a request the client had already dropped.
        if (signal?.aborted === true) {
          return { ok: false, kind: 'aborted', status: 0, message: 'cancelled by the caller' }
        }
        // A transport failure (DNS, reset, TLS, a 30x under `redirect: 'error'`)
        // is a property of the network path, not of this account: the next
        // sign-in may well reach the host. Classing it as `server` had the shim
        // break out of the rotation and answer 502 with the healthy accounts
        // behind it still untried.
        return { ok: false, kind: 'transport', status: 0, message: `transport error: ${String(error)}` }
      } finally {
        // Only the headers phase was on the clock: the body is the watchdog's.
        deadline.arrived()
      }
      if (response.ok) {
        // A 200 is not automatically a stream: the prompt screen can answer the
        // refusal as a JSON envelope with HTTP 200. Treating that as success
        // skipped the fold/retry and cached nothing, so every turn paid the same
        // refusal. Read the small JSON body here and run the same one-retry path.
        const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
        // A refusal is not required to arrive as `application/json`: some
        // deployments label the same envelope `text/plain`. A declared small
        // body cannot be a live event stream, so it is safe to read and inspect;
        // a stream with no length stays untouched.
        const declaredLength = Number(response.headers.get('content-length') ?? '')
        const smallDeclaredBody = Number.isFinite(declaredLength) && declaredLength > 0
          && declaredLength <= ERROR_BODY_LIMIT
        if (contentType.includes('application/json')
          || (smallDeclaredBody && !contentType.includes('text/event-stream'))) {
          const text = await readErrorBody(response, ERROR_BODY_LIMIT, signal)
          if (attempt === 0 && isChannelCheckText(text)) {
            const folded = foldSystemIntoUser(body)
            if (folded !== undefined) {
              rememberOnSuccess = cacheKey
              body = folded
              continue
            }
          }
          if (rememberOnSuccess !== undefined && !isChannelCheckText(text)) {
            rememberFoldedPrompt(rememberOnSuccess)
          }
          const envelopeResponse = new Response(text, {
            status: response.status,
            headers: response.headers,
          })
          const envelopeBody = envelopeResponse.body
          if (envelopeBody === null) {
            return { ok: false, kind: 'server', status: 502, message: 'upstream returned 200 without a body' }
          }
          return { ok: true, response: withRelayStream(envelopeResponse, envelopeBody) }
        }
        // The folded request was accepted: from now on this prompt skips the
        // refused round trip.
        if (rememberOnSuccess !== undefined) rememberFoldedPrompt(rememberOnSuccess)
        // A 200 with no body has nothing to relay. Returning it as success made
        // the gateway throw inside the relay and answer 500 `internal`, which
        // reads as a plugin bug instead of an upstream fault.
        if (response.body === null) {
          return { ok: false, kind: 'server', status: 502, message: 'upstream returned 200 without a stream' }
        }
        // The watchdog stream is handed over under the relay key as well: a
        // Response built around a stream this plugin made stops delivering to a
        // `Readable.fromWeb` reader after the first chunks, so the gateway pumps
        // this stream directly instead.
        const relayed = withIdleWatchdog(response.body, timeouts?.idleMs, signal)
        return {
          ok: true,
          response: withRelayStream(new Response(relayed, {
            status: response.status,
            headers: response.headers,
          }), relayed),
        }
      }
      const text = (await readErrorBody(response, ERROR_BODY_LIMIT, signal))
      const retryAfter = retryAfterSeconds(response.headers)
      if (attempt === 0 && response.status === 400 && isChannelCheckText(text)) {
        const folded = foldSystemIntoUser(body)
        if (folded !== undefined) {
          rememberOnSuccess = cacheKey
          body = folded
          continue
        }
      }
      return {
        ok: false,
        kind: classifyUpstreamError(response.status, text),
        status: response.status,
        // A gateway page is answered with the sentence that says what to do
        // about it. The page itself is the other half of the same refusal, and
        // relaying it put a screenful of openresty HTML in front of the user
        // where one instruction belonged.
        message: isGatewayHtmlRejection(response.status, text)
          ? gatewayRejectionText(response.status)
          : text,
        // The upstream states the wait in the standard header as well as in the
        // body, and the body parse only covers the spellings it knows. Handing
        // the header through lets the shim honour the upstream's own window
        // instead of guessing `cooldownSeconds` for every 429.
        ...retryAfter === undefined ? {} : { retryAfter },
      }
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      redirect: 'error',
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome: WorkBuddyRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /**
   * Fetch the model catalog, keeping the `cli` agent's models only.
   *
   * The two gateways are read differently, because they answer differently:
   *
   * - **CN** serves the roster at `/v2/enterprises/personal/models`. Like the
   *   desktop process that calls it directly, it expects the desktop client
   *   spelling; this is not the chat endpoint's three-segment UA.
   * - **Global** serves it as part of the product config at `/v3/config`, and
   *   only to the DESKTOP client channel. Asking the global host with the CLI UA
   *   yields a truncated roster, and the CN path answers HTTP 500 there — which
   *   is what left the international provider on its static fallback.
   *
   * Both documents share the `{ models, agents }` entry shape, so the parsing
   * below is common to the two branches.
   */
  async fetchModels(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyUpstreamModel[]> {
    const global = regionOf(credential.domain) === 'global'
    const url = global
      ? `${globalBase(credential)}${GLOBAL_CONFIG_PATH}`
      : `${chatBase(credential)}${MODELS_CATALOG_PATH}`

    const headers: Record<string, string> = global
      ? {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          ...credential.uid === undefined || credential.uid === '' ? {} : { 'X-User-Id': credential.uid },
          ...credential.domain === '' ? {} : { 'X-Domain': credential.domain },
          'X-Product': 'SaaS',
          'X-Requested-With': 'XMLHttpRequest',
          // The gate header every API request carries, the global roster included.
          'X-CodeBuddy-Request': '1',
          'Connection': 'close',
          'User-Agent': GLOBAL_DESKTOP_UA,
        }
      : {
          // Built from commonHeaders rather than spelled out: the hand-written
          // copy was the one WorkBuddy request that missed the gate header and
          // the per-request connection close, so a roster call could hand a
          // socket with one account's Authorization to the next account.
          ...commonHeaders(credential),
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
        }
    if (!global && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      headers['X-Enterprise-Id'] = credential.enterpriseId
    }

    const response = await this.fetchImpl(url, {
      redirect: 'error',
      headers,
      ...signal === undefined ? {} : { signal },
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    const byId = new Map<string, WorkBuddyUpstreamModel>()
    for (const model of rawModels) {
      const parsed = parseUpstreamModel(model)
      if (parsed !== undefined) byId.set(parsed.id, parsed)
    }
    const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
    const models = ids
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
    return models
  }

  /** Read-only credits query, aggregated by package. Does not consume credits. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const fmt = (date: Date): string => {
      const p = (n: number) => n.toString().padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: fmt(now),
        PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const wrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof wrapper['Response'] === 'object' && wrapper['Response'] !== null
      ? wrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []

    let total = 0
    let expiringSoon = 0
    let nearestExpiryMs: number | undefined
    const SOON_MS = 3 * 24 * 60 * 60 * 1000
    const parseDate = (raw: unknown): number | undefined => {
      // Milliseconds when the number is already one, seconds when it is an epoch
      // a second long: every other date reader in this plugin normalises the two
      // this way, and taking only the millisecond shape silently dropped a
      // pack's expiry, which then left the `expiry` distribution blind to it.
      if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw > 1_000_000_000_000 ? raw : raw > 1_000_000_000 ? raw * 1000 : undefined
      }
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Date.parse(raw)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }
    const packages: WorkBuddyCreditPackage[] = []
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const monthly = numberField(account, 'CapacityType') === 4
      const size = monthly ? numberField(account, 'CycleCapacitySize') : numberField(account, 'CapacitySize')
      const remain = monthly ? numberField(account, 'CycleCapacityRemain') : numberField(account, 'CapacityRemain')
      const capped = remain < 0 ? 0 : remain
      const cycleEndMs = parseDate(account['CycleEndTime'])
      const expiresAtMs = monthly ? undefined : parseDate(account['ExpiredTime']) ?? cycleEndMs
      const refreshAtMs = monthly ? (cycleEndMs === undefined ? undefined : cycleEndMs + 1000) : undefined
      // A pack with nothing left in it is not a pack the user can spend. A
      // monthly one carries no expiry, so only `capped <= 0` drops it; without
      // that a drained month shows as an empty row and counts toward the header.
      if (capped <= 0 || (!monthly && expiresAtMs !== undefined && expiresAtMs <= Date.now())) continue
      total += capped
      if (expiresAtMs !== undefined && expiresAtMs - Date.now() <= SOON_MS) expiringSoon += capped
      if (expiresAtMs !== undefined && (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs)) {
        nearestExpiryMs = expiresAtMs
      }
      packages.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain: capped,
        size,
        monthly,
        ...refreshAtMs === undefined ? {} : { refreshAtMs },
        ...expiresAtMs === undefined ? {} : { expiresAtMs },
      })
    }
    return {
      total,
      packages,
      expiringSoon,
      ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    }
  }

  /** Query today's check-in status without changing account state. */
  async fetchCheckinStatus(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinStatus> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return {
      active: data['active'] === true,
      todayCheckedIn: data['today_checked_in'] === true,
      streakDays: numberField(data, 'streak_days'),
      dailyCredit: numberField(data, 'daily_credit'),
      todayCredit: numberField(data, 'today_credit'),
      isStreakDay: data['is_streak_day'] === true,
      nextStreakDay: numberField(data, 'next_streak_day'),
      streakBonusCredit: numberField(data, 'streak_bonus_credit'),
    }
  }

  /** Claim today's check-in reward. The browser route guards this mutation. */
  async claimDailyCheckin(credential: WorkBuddyCredential): Promise<WorkBuddyCheckinClaim> {
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return {
      credit: numberField(data, 'credit'),
      streakDays: numberField(data, 'streak_days'),
      isStreakDay: data['is_streak_day'] === true,
    }
  }
  /**
   * Query the account's buddy profile; null means no buddy yet.
   *
   * Null, missing and empty-object shapes all read as "no buddy" — the
   * upstream answers whichever it feels like, and the caller adopts in all
   * three cases.
   */
  async fetchBuddyInfo(credential: WorkBuddyCredential): Promise<WorkBuddyBuddy | null> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/info`, {
      redirect: 'error',
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const raw = data['buddy']
    if (raw === null || raw === undefined) return null
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const profile = raw as Record<string, unknown>
    return {
      id: typeof profile['id'] === 'number' ? profile['id'] : 0,
      name: typeof profile['name'] === 'string' ? profile['name'] : '',
    }
  }

  /** Query the cat-travel state for one account. */
  async fetchTravelStatus(credential: WorkBuddyCredential): Promise<WorkBuddyTravelState> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/status`, {
      redirect: 'error',
      headers: billingHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return {
      state: typeof data['state'] === 'string' ? data['state'] : '',
      dailyLimitReached: data['daily_limit_reached'] === true,
      recordId: numberField(data, 'record_id'),
    }
  }

  /**
   * Dispatch the buddy to travel. Location 4 (ancient-town inn): the four
   * locations share the same reward/duration range, so there is no optimum —
   * the number just has to be one the upstream accepts.
   */
  async departTravel(credential: WorkBuddyCredential, locationId = 4): Promise<void> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/depart`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({ location_id: locationId }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Claim the arrival reward. A missing reward field is not a failure — the
   * caller logs 0 and moves on, matching the upstream's own tolerance.
   */
  async claimTravelReward(credential: WorkBuddyCredential, recordId: number): Promise<number> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/travel/claim`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({ record_id: recordId }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    return numberField(data, 'reward_credit')
  }

  /** Accept the buddy agreement. Idempotent: safe to repeat. */
  async agreeBuddy(credential: WorkBuddyCredential): Promise<void> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/agreement`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({ agree: true }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /** Adopt the first buddy. Throws the threshold refusal when unqualified. */
  async adoptBuddy(credential: WorkBuddyCredential): Promise<void> {
    const response = await this.fetchImpl(`${chatBase(credential)}/activity/growth/buddy/first`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Report one chat activity. The full event shape, not a minimal subset: the
   * upstream lights growth streak and unlocks the first-buddy task on this,
   * and a trimmed event risks a future tightening. `userId` is the account
   * uid — without it the upstream answers 200 yet silently drops the report.
   *
   * The uid is not optional and is not substituted: the `uin` is a different
   * identifier, and sending it produced exactly the silent drop the comment
   * above warns about, with a 200 to show for it. An account that carries no
   * uid fails loudly instead.
   */
  async reportChatActivity(credential: WorkBuddyCredential, conversationId: string): Promise<void> {
    const uid = credential.uid ?? ''
    if (uid === '') throw new Error('workbuddy report needs a uid-bearing credential')
    const now = Date.now()
    const event = {
      eventCode: 'chat_request_send',
      timestamp: now,
      reportDelay: 0,
      mode: 'craft',
      conversationId,
      requestId: conversationId,
      inputLength: 12,
      requestModelId: 'deepseek-v4-flash',
      requestModelName: 'DeepSeek V4 Flash',
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 0,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: '',
      mentionContextCount: 0,
      command: '',
      expertId: '',
      recommendId: '',
      skillId: '',
      skillCount: 0,
      totalCount: 0,
      fileUri: '',
      presentAt: now,
      traceId: '',
      rootRequestId: conversationId,
      parentConversationId: conversationId,
      agentName: 'default',
      agentType: 'conversation',
      userId: uid,
    }
    const response = await this.fetchImpl(`${billingBase(credential)}/v2/report`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify([event]),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Call a growth-domain endpoint and return its unwrapped `data`.
   *
   * These endpoints live on the chat host with the billing header set, and
   * carry the same envelope as everything else. Centralised here because every
   * growth call needs the identical envelope check. The path carries NO `/v2`
   * prefix: asking for the `/v2` form does not 404, it answers with a body that
   * has no streak object at all.
   */
  private async growthJson(
    credential: WorkBuddyCredential,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${chatBase(credential)}${path}`, {
      redirect: 'error',
      method,
      headers: billingHeaders(credential),
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    return asRecord(envelope.data)
  }

  /**
   * The full streak picture: days, tier unlock state, and what each tier pays.
   *
   * Read before redeeming, because the tier state is the only honest answer to
   * "is there anything to claim": the redeem endpoint answers 403 for a locked
   * tier, which is indistinguishable from a real failure once the response is
   * just an error. The counter is nested as `data.streak.days`, not `data.days`.
   */
  async growthStreakFull(credential: WorkBuddyCredential): Promise<WorkBuddyStreakStatus> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/streak')
    const streak = asRecord(data['streak'])
    const redemption = asRecord(data['redemption_status'])
    const tiers: WorkBuddyStreakTier[] = []
    if (Array.isArray(redemption['tiers'])) {
      for (const entry of redemption['tiers']) {
        const tier = asRecord(entry)
        const name = typeof tier['tier'] === 'string' ? tier['tier'] : ''
        if (name === '') continue
        tiers.push({
          tier: name,
          days: numberField(tier, 'days'),
          credit: numberField(tier, 'credit'),
          energy: numberField(tier, 'energy'),
          // The flat status fields are the authoritative unlock state; the
          // per-tier entry does not carry one of its own.
          status: String(redemption[`tier_${name}_status`] ?? '').toLowerCase(),
        })
      }
    }
    return {
      days: numberField(streak, 'days'),
      nextTier: typeof streak['next_tier'] === 'string' ? streak['next_tier'] : '',
      nextTierRemaining: numberField(streak, 'next_tier_remaining'),
      makeupCards: numberField(asRecord(data['makeup_cards']), 'balance'),
      tiers,
    }
  }

  /**
   * Redeem one unlocked streak tier.
   *
   * A locked tier answers 403 ("连续登录天数不足"); callers check the status from
   * {@link growthStreakFull} first, so this only throws for genuine failures.
   * The client token is the upstream's idempotency key — a fresh one per attempt
   * keeps a retry from being read as a duplicate of the last one.
   */
  async redeemStreakTier(credential: WorkBuddyCredential, tier: string): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/redeem', {
      tier,
      client_token: randomUUID(),
    })
  }

  /**
   * Call a billing-domain endpoint and return its unwrapped `data`.
   *
   * Counterpart of {@link growthJson}: same envelope, but these paths carry the
   * `/v2/billing/meter` prefix and the billing host. Kept separate because the
   * prefix is part of the path, not something the caller should remember.
   */
  private async billingJson(
    credential: WorkBuddyCredential,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${billingBase(credential)}${path}`, {
      redirect: 'error',
      method: 'POST',
      headers: billingHeaders(credential),
      body: body === undefined ? '{}' : JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    return asRecord(envelope.data)
  }

  /**
   * The one-off starter gift. Once per account; a second claim is a business
   * error, which the caller treats as "nothing to collect".
   *
   * No `/v2` prefix: that form answers a 404 route miss, while the bare path is
   * the one the console itself posts to.
   */
  async claimGift(credential: WorkBuddyCredential): Promise<number> {
    return numberField(await this.billingJson(credential, '/billing/meter/claim-gift'), 'credit')
  }

  /** Campaign compensation, when the account has any waiting. */
  async claimCompensation(credential: WorkBuddyCredential): Promise<number> {
    return numberField(await this.billingJson(credential, '/billing/meter/claim-compensation'), 'credit')
  }

  /**
   * Whether yesterday is still empty on the streak heatmap.
   *
   * A missed day breaks the run, and the run is what unlocks the 7/14/28-day
   * tiers, so this is read before deciding to spend a make-up card on it.
   */
  async missedYesterday(credential: WorkBuddyCredential): Promise<boolean> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/heatmap')
    const cells = Array.isArray(data['cells']) ? data['cells'] : []
    // Yesterday in the check-in zone, not the host zone: the upstream resets at
    // 00:00 CST and a machine in another zone would aim at the wrong day.
    const yesterday = zonedDay(-1)
    for (const entry of cells) {
      const cell = asRecord(entry)
      const date = typeof cell['date'] === 'string' ? cell['date'].slice(0, 10) : ''
      if (date === yesterday) return numberField(cell, 'score') === 0
    }
    return false
  }

  /** Spend one make-up card on a past day (`YYYY-MM-DD`). */
  async useMakeupCard(credential: WorkBuddyCredential, date: string): Promise<void> {
    await this.growthJson(credential, 'POST', '/activity/growth/makeup-cards/use', { target_date: date })
  }

  /** Make-up cards in hand; the streak is only repairable while this is above zero. */
  async makeupCards(credential: WorkBuddyCredential): Promise<number> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/streak')
    return numberField(asRecord(data['makeup_cards']), 'balance')
  }

  /** Draws available from redeemed streak tiers. */
  async lotteryChances(credential: WorkBuddyCredential): Promise<number> {
    const data = await this.growthJson(credential, 'GET', '/activity/growth/lottery/summary')
    return numberField(data, 'chances')
  }

  /** Spend one draw; the prize payload is passed through as-is. */
  async drawLottery(credential: WorkBuddyCredential): Promise<Record<string, unknown>> {
    return await this.growthJson(credential, 'POST', '/activity/growth/lottery/draw', {
      client_token: randomUUID(),
    })
  }
}

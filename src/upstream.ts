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

import { randomUUID } from 'node:crypto'

import type { WorkBuddyCredential } from './accounts'
import { redactSecrets } from './loopback'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'waf_block'
  | 'not_found'
  | 'server'
  | 'client'

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

/** One growth-centre task, flattened from the upstream's loosely-shaped entry. */
export interface WorkBuddyTask {
  /** Upstream task code; the claim path is built from it. */
  taskCode: string
  title: string
  /** Reward in credits, when the task declares one. */
  credit: number
  /** Reward in energy, when the task declares one. */
  energy: number
  /** Progress target; 0 is a valid value (a task with no counter). */
  target: number
  /** Current progress; 0 is a valid value. */
  current: number
  /** Upstream enrolment state: not_accepted / accepted / claimed. */
  acceptStatus: string
  /** Progress reached its target and the reward is still outstanding. */
  claimable: boolean
  /** Reward already collected. */
  claimed: boolean
  /** Upstream marked the task locked (not yet reachable). */
  locked: boolean
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
  | { ok: false; kind: UpstreamErrorKind; status: number; message: string }

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

/** Chat UA: the official desktop client's three-segment spelling. */
const CLIENT_UA = 'WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1'

/**
 * Desktop app UA. The global gateway serves its product config only to this
 * client channel: the CLI UA gets a truncated roster (or an HTTP 500), which
 * is why the international catalog must be read with the desktop spelling.
 */
const DESKTOP_UA = 'WorkBuddy/5.5.2'

/** CN model catalog. */
const MODELS_CATALOG_PATH = '/v2/enterprises/personal/models'
/** Global product config, which carries the international model roster. */
const GLOBAL_CONFIG_PATH = '/v3/config'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Session-invalidation markers that mean "sign in again in the WorkBuddy app".
 *
 * `12153` is matched as an envelope value, not as a bare substring: a plain
 * `12153` turns up inside ids and timestamps, and on a rate-limited body it
 * would reclassify a cooldown as a dead session - which rotates without ever
 * cooling the account, so the same limited account is hit on every attempt.
 */
const SESSION_DEAD_PATTERN = /Offline user session not found|"code"\s*:\s*"?12153\b/u

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
    'User-Agent': CLIENT_UA,
    // The official client's gate header, on every API request. Missing it
    // marks the caller as something other than the client.
    'X-CodeBuddy-Request': '1',
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
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

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  if (isGatewayHtmlRejection(response.status, text)) {
    // The status is interpolated rather than written: this branch accepts 401
    // and 403, and naming 401 for a 403 sends the reader looking for a
    // credential problem the gateway never reported.
    throw new Error(
      `the WorkBuddy gateway rejected this credential (http ${response.status}). This usually means the ` +
      'account is using a stale sign-in the upstream no longer accepts: sign in again in ' +
      'the WorkBuddy desktop app, then pick the account on the plugin card. ' +
      'Run the WTQ Pool connection check (the command palette entry, or the panel\'s connection tab) to list every credential found.',
    )
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
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${redactSecrets(envelope.msg).slice(0, 160)}`)
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * A body marker only refines a status that has not already said something
 * more specific. When the status is about the sign-in, the only thing that may
 * reclassify it is a session marker - otherwise a 401 quoting "quota exceeded"
 * reads as a billing failure, which answers 402 and skips the token refresh.
 * And a session marker never fires on any other status, or a rate limit whose
 * text happens to carry the code would rotate without cooling the account.
 */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const aboutSignIn = status === 401 || status === 403
  if (aboutSignIn && SESSION_DEAD_PATTERN.test(body)) return 'session_dead'
  if (!aboutSignIn) {
    const lower = body.toLowerCase()
    for (const marker of HARD_CREDIT_MARKERS) {
      if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
    }
    if (SESSION_DEAD_PATTERN.test(body)) return 'session_dead'
  }
  // The 429 the user hits ("频率限制 / soft_rate / code 6004") routes here.
  if (status === 429) return 'soft_rate'
  if (body.includes('soft_rate') || body.includes('"code":6004') || body.includes('频率限制')) {
    return 'soft_rate'
  }
  // A 403 with no business envelope is the gateway's WAF page (HTML, empty or
  // plain text), not an answer about the request: it clears with time and
  // another account, so it must not read as a terminal client error. A 403
  // that carries `"code":` / `"msg":` is the upstream's own verdict and stays
  // with the classes above and below.
  if (status === 403 && !body.includes('"code":') && !body.includes('"msg":')) return 'waf_block'
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
  const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body)
  if (epochMs !== null) return capRateReset(Number(epochMs[1]))

  const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body)
  if (localized !== null) {
    const asUtc = Date.parse(localized[1]!.replace(' ', 'T') + 'Z')
    if (!Number.isNaN(asUtc)) return capRateReset(asUtc - UPSTREAM_CLOCK_OFFSET_MS)
  }
  return undefined
}

/** Parse the upstream's `credits` string into a multiplier. */
export function parseCreditMultiplier(value: unknown): number | undefined {
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
export function parseReasoning(value: unknown): WorkBuddyUpstreamModel['reasoning'] {
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

/**
 * Flatten one upstream task entry.
 *
 * Progress is reported two ways depending on the task: flat `current`/`target`
 * fields, or a nested `progress: {current, target}`. The nested form wins when
 * it carries anything, because a task that reports both puts the live counter
 * there. Entries without a usable `task_code` are dropped — without one the
 * claim path cannot be built.
 */
function parseTask(value: unknown): WorkBuddyTask | undefined {
  const raw = asRecord(value)
  const taskCode = typeof raw['task_code'] === 'string' ? raw['task_code'] : ''
  if (taskCode === '') return undefined

  let current = numberField(raw, 'current')
  let target = numberField(raw, 'target')
  const nested = asRecord(raw['progress'])
  const nestedCurrent = numberField(nested, 'current')
  const nestedTarget = numberField(nested, 'target')
  if (nestedTarget > 0 || nestedCurrent > 0) {
    current = nestedCurrent
    target = nestedTarget
  }

  const acceptStatus = typeof raw['accept_status'] === 'string' ? raw['accept_status'] : ''
  const claimed = acceptStatus === 'claimed'
  return {
    taskCode,
    title: typeof raw['title'] === 'string' && raw['title'] !== '' ? raw['title'] : taskCode,
    credit: numberField(raw, 'reward_credit'),
    energy: numberField(raw, 'reward_energy'),
    target,
    current,
    acceptStatus,
    claimable: !claimed && target > 0 && current >= target,
    claimed,
    locked: raw['locked'] === true,
  }
}

/** Parse one catalog entry; entries without usable token limits are dropped. */
export function parseUpstreamModel(value: unknown): WorkBuddyUpstreamModel | undefined {
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
      } else {
        delete obj['tool_choice']
      }
    }
    return JSON.stringify(obj)
  }

  /** Forward one chat completion. Never throws for upstream failures. */
  async chatStream(
    credential: WorkBuddyCredential,
    prepared: string,
    signal?: AbortSignal,
  ): Promise<ChatStreamResult> {
    let response: Response
    try {
      response = await this.fetchImpl(`${chatBase(credential)}/v2/chat/completions`, {
        redirect: 'error',
        method: 'POST',
        headers: chatHeaders(credential),
        body: prepared,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, kind: 'server', status: 0, message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      kind: classifyUpstreamError(response.status, text),
      status: response.status,
      message: text,
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
   * - **CN** serves the roster at `/v2/enterprises/personal/models` and expects
   *   the CLI client spelling.
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
          'Connection': 'close',
          'User-Agent': DESKTOP_UA,
        }
      : {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Origin': billingBase(credential),
          'Referer': `${billingBase(credential)}/`,
          'User-Agent': CLIENT_UA,
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
      if (typeof raw === 'number' && raw > 1_000_000_000_000) return raw
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
   */
  async reportChatActivity(credential: WorkBuddyCredential, conversationId: string): Promise<void> {
    const uid = credential.uid ?? credential.uin ?? ''
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
   * Fetch the growth task list for one account.
   *
   * The upstream answers `data.tasks[]`, and `claimable` is derived locally —
   * the upstream does not mark it. The task list is the one growth endpoint
   * that DOES carry the `/v2` prefix.
   */
  async listTasks(credential: WorkBuddyCredential): Promise<readonly WorkBuddyTask[]> {
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks`, {
      redirect: 'error',
      headers: chatHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const raw = Array.isArray(asRecord(envelope.data)['tasks']) ? asRecord(envelope.data)['tasks'] as unknown[] : []
    const out: WorkBuddyTask[] = []
    for (const entry of raw) {
      const parsed = parseTask(entry)
      if (parsed !== undefined) out.push(parsed)
    }
    return out
  }

  /**
   * Accept (enrol in) tasks by code.
   *
   * Accepting is the "sign up" half: it produces no progress by itself, and the
   * upstream answers success for an already-accepted task, so replaying this is
   * safe. Progress is lit by real activity (a chat, an activity report).
   */
  async acceptTasks(credential: WorkBuddyCredential, taskCodes: readonly string[]): Promise<void> {
    if (taskCodes.length === 0) return
    const response = await this.fetchImpl(`${chatBase(credential)}/v2/activity/growth/tasks/accept`, {
      redirect: 'error',
      method: 'POST',
      headers: chatHeaders(credential),
      body: JSON.stringify({ task_codes: [...taskCodes] }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
  }

  /**
   * Claim one task's reward.
   *
   * Two details differ from list/accept and are load-bearing:
   *
   * - The task code rides the PATH, not the body.
   * - It is served by the web origin, not the chat host, and only when the
   *   request carries the growth-centre Origin/Referer plus
   *   `x-client-platform: web`. The chat host's `/reward/claim` path does not
   *   exist and answers 400 "task not completed".
   *
   * A repeat claim answers `already_claimed` with zero credit, which is treated
   * as success so the caller can stay idempotent.
   */
  async claimTaskReward(credential: WorkBuddyCredential, taskCode: string): Promise<{ credit: number; energy: number }> {
    const headers: Record<string, string> = {
      ...billingHeaders(credential),
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.workbuddy.cn',
      'Referer': 'https://www.workbuddy.cn/profile/growth-center',
      'x-client-platform': 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    }
    const response = await this.fetchImpl(
      `https://www.workbuddy.cn/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
      { method: 'POST', redirect: 'error', headers, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) },
    )
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = asRecord(envelope.data)
    if (data['already_claimed'] === true) return { credit: 0, energy: 0 }
    return { credit: numberField(data, 'credit'), energy: numberField(data, 'energy') }
  }
}

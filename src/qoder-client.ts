/**
 * Qoder minimal upstream client.
 *
 * Fetches the callable roster and opens one chat stream. No disk reads here;
 * tokens stay in the caller's memory.
 *
 * Shapes follow `dsh-connect-qoder` (MIT): the `algo/api/v2/model/list`
 * envelope groups its models by product surface, and only the `chat` group is
 * callable. Chat requests normalise `developer` to `system`, because a system
 * message the gateway does not recognise is answered with a permanent
 * `403 {"code":"10605"}` on every retry.
 *
 * Everything the client needs from the outside is injected (credential,
 * `fetchImpl`), so the whole path can be exercised offline.
 *
 * @module dsh-wtq-pool/qoder-client
 */

import { randomUUID } from 'node:crypto'
import type { QoderRegion } from './qoder-discovery'
import { buildCosyAuthHeaders, encodeBody, QODER_GATEWAYS } from './qoder-upstream'

/** One callable Qoder model, as the `chat` group lists it. */
export interface QoderChatModel {
  id: string
  name: string
  /** Largest input window the catalog offers, when it says. */
  maxInputTokens?: number
  /**
   * The model's context window: the size it runs at unless the user picks
   * another in Qoder's own UI (`context_config`'s default entry).
   */
  contextWindow?: number
  supportsImages: boolean
  /** Thinking effort levels the catalog advertises, in upstream order. */
  effortLevels?: string[]
  /** The level the catalog marks as this model's default, when it says. */
  defaultEffort?: string
  /** True when the catalog marks thinking as always on. */
  alwaysThinking?: boolean
}

/** Qoder's thinking ladder, low to high: the upstream's own order. */
export const QODER_EFFORT_ORDER: readonly string[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The levels a catalog row can list: the ladder without "none", which is not a
 * level but the off value. Keeping it out of the table is what stops it from
 * ever being published as a level or picked as a model's default.
 */
const QODER_TABLE_LEVELS: readonly string[] = QODER_EFFORT_ORDER.filter(level => level !== 'none')

/** Upstream failure classes the future gateway answers with. */
export type QoderUpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'

export type QoderChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: QoderUpstreamErrorKind; message: string }

export interface QoderClientCredential {
  userID: string
  token: string
  name?: string
  email?: string
  machineID?: string
}

export interface QoderClientOptions {
  region: QoderRegion
  credential(): Promise<QoderClientCredential>
  /** Injected so the whole path runs offline in checks. */
  fetchImpl?: typeof fetch
}

/** Model directory path; `Encode=1` names the permuted-base64 wire form. */
export const QODER_MODELS_PATH = '/algo/api/v2/model/list?Encode=1'

/** Streaming chat path; `FetchKeys` selects the OpenAI-shaped result field. */
export const QODER_CHAT_PATH =
  '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1'

/** Join a gateway base and an API path without doubling slashes. */
export function qoderEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
/** OpenAPI base per region: the quota surface, not the COSY gateway. */
export const QODER_OPENAPI: Readonly<Record<QoderRegion, string>> = {
  cn: 'https://openapi.qoder.com.cn',
  global: 'https://openapi.qoder.sh',
}
/** Quota usage path (narrow shape); the presentation route is tried first. */
export const QODER_USAGE_PATH = '/api/v2/quota/usage'
/** Presentation usage path (carries dedicated packages); preferred. */
export const QODER_USAGE_PRESENTATION_PATH = '/sash/api/v2/me/usage'
/** Campaign list path; the same payload answers promo rows and the daily check-in round. */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
/**
 * Headers the Qoder IDE itself sends to the OpenAPI host. `Cosy-ClientType: 10`
 * identifies the desktop app. The umid machine-identity block (international
 * daily round only) is deliberately absent: usage needs no block, CN or global.
 */
export function qoderOpenApiHeaders(credential: QoderClientCredential): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.token}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder',
  }
}
/** One quota pool. Only what the card draws: what it holds and what is left. */
export interface QoderQuotaBucket {
  total: number
  remaining: number
}
/** One per-model promotional allowance; unusable rows never surface. */
export interface QoderDedicatedPackage {
  id: string
  name: string
  total: number
  remaining: number
  /** When this package stops being usable, in ms, when the upstream states one. */
  expiresAtMs?: number
}
/** Account usage, shaped the way the IDE panel presents it. */
export interface QoderUsage {
  userQuota?: QoderQuotaBucket
  addOnQuota?: QoderQuotaBucket
  dedicatedPackages: QoderDedicatedPackage[]
  /**
   * When the plan pool's credits run out, in ms — an account-wide date the
   * usage route sends, so it belongs to the plan row alone. The check-in
   * credits in the add-on pool are not covered by it: those are valid for a
   * fixed number of days from each claim (`qoderRewardValidityDaysOf`).
   */
  expiresAtMs?: number
  /**
   * True when the account answered with the "no expiry" sentinel rather than a
   * date. The card then says so instead of inventing a date, and instead of
   * saying nothing at all.
   */
  neverExpires?: boolean
  /** Which route answered: the presentation one or the quota fallback. */
  source: 'presentation' | 'quota'
}
function qoderNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : undefined
}
/** What is left of one pool. The upstream may omit it, so `used` backs it up. */
function qoderRemainingOf(record: Record<string, unknown>, total: number): number {
  const used = Math.max(0, qoderNumber(record['used']) ?? 0)
  return Math.max(0, qoderNumber(record['remaining']) ?? total - used)
}
function qoderQuotaBucket(value: unknown): QoderQuotaBucket | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const total = qoderNumber(record['total'])
  // A pool the route names stays a pool even with nothing in it: an account
  // with no plan at all reports 0/0, and that row is the one that says the
  // plan never expires. Only a pool the route does not name is dropped, and a
  // nonsense negative total.
  if (total === undefined || total < 0) return undefined
  return { total, remaining: qoderRemainingOf(record, total) }
}
function qoderDedicatedPackage(value: unknown): QoderDedicatedPackage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
  const total = qoderNumber(record['total'])
  if (id === '' || total === undefined || total <= 0) return undefined
  const expiresAtMs = qoderEpochMs(record['expiresAt'] ?? record['expires_at'])
  return {
    id,
    name: typeof record['name'] === 'string' ? record['name'] as string : '',
    total,
    remaining: qoderRemainingOf(record, total),
    ...expiresAtMs === undefined ? {} : { expiresAtMs },
  }
}
/** Anything below this epoch-millisecond value must be seconds (1e12 ms ≈ 2001). */
const QODER_EPOCH_SECONDS_BOUNDARY_MS = 1e12
/**
 * A date past this is not a date: the API spells "no expiry at all" as the
 * largest timestamp it can write, which read as `9999-12-31` on the card.
 * Nothing a user can hold outlives the year 2200, so the ceiling is a
 * generous one and only sentinels fall past it.
 */
const QODER_EPOCH_CEILING_MS = 7258118400000

function qoderRawEpochMs(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value < QODER_EPOCH_SECONDS_BOUNDARY_MS ? Math.floor(value * 1000) : Math.floor(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Coerce one upstream timestamp (seconds, ms, RFC 3339) into epoch
 * milliseconds, dropping the far-future value that means "never expires".
 */
export function qoderEpochMs(value: unknown): number | undefined {
  const ms = qoderRawEpochMs(value)
  return ms !== undefined && ms <= QODER_EPOCH_CEILING_MS ? ms : undefined
}

/** Card-facing check-in state, after `status.checkin`. */
export interface QoderCheckinState {
  active: boolean
  todayCheckedIn: boolean
  amount?: number
  unit?: string
  validDays?: number
  endsAt?: number
  /**
   * When the next claimable round opens, in ms, when this account has a round
   * that is not open yet. Qoder's daily window runs 10:00 → 09:59 Beijing, so
   * before 10:00 the card can say when the next one starts instead of "no
   * check-in"; the automatic pass uses the same value to come back at 10:00.
   */
  opensAt?: number
}
/** MIME-free label for the one campaign type that actually pays out. */
const QODER_CLAIM_BENEFIT_ACTION = 'CLAIM_BENEFIT'
/** Status of a round this account has already collected. */
const QODER_CLAIMED_STATUS = 'CLAIMED'

/**
 * Ceiling on one chat stream, for a caller that did not pass its own signal.
 *
 * The same bound the Trae gateway applies: a stream can legitimately run for
 * minutes, but a black-holed host must not leave the response - and the
 * upstream connection behind it - pending for the rest of the process.
 */
const CHAT_STREAM_TIMEOUT_MS = 120_000
/**
 * Bound on one read against the COSY gateway or the OpenAPI surface (directory,
 * usage, campaigns, a claim), for a caller that did not pass its own signal.
 * Every one of them has to be bounded: the check-in path issues them one account
 * after another, and a black-holed host would otherwise leave the socket and the
 * fetch pending for the rest of the process.
 */
const DIRECTORY_TIMEOUT_MS = 30_000
function qoderBenefitOf(campaign: unknown): { amount: number; kind: string; validDays?: number } | undefined {
  const benefit = (campaign as { benefit?: unknown } | null | undefined)?.benefit
  if (benefit === null || typeof benefit !== 'object') return undefined
  const record = benefit as { amount?: unknown; kind?: unknown; validity?: { mode?: unknown; days?: unknown } | null | undefined }
  const amount = Number(record.amount)
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  // Only the relative mode means "this many days after the claim". Another
  // mode may carry a `days` that means something else entirely, and the card
  // would then promise an expiry the upstream never stated.
  const relative = record.validity?.mode === 'RELATIVE_DAYS'
  const validityDays = Number(record.validity?.days)
  return {
    amount,
    kind: typeof record.kind === 'string' ? record.kind as string : 'CREDITS',
    ...(relative && Number.isFinite(validityDays) && validityDays > 0 ? { validDays: validityDays } : {}),
  }
}
function qoderWindowOpenAt(campaign: unknown, nowMs: number): boolean {
  const record = campaign as { startAt?: unknown; beginAt?: unknown; endAt?: unknown } | null | undefined
  const startAt = qoderEpochMs(record?.startAt ?? record?.beginAt)
  const endAt = qoderEpochMs(record?.endAt)
  if (startAt !== undefined && nowMs < startAt) return false
  if (endAt !== undefined && nowMs > endAt) return false
  return true
}
function qoderClaimableCampaignOf(payload: unknown, nowMs: number): Record<string, unknown> | undefined {
  const holder = payload as { campaigns?: unknown } | null | undefined
  const list = holder?.campaigns
  if (!Array.isArray(list)) return undefined
  for (const entry of list as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const campaign = entry as Record<string, unknown>
    if (campaign['actionType'] !== QODER_CLAIM_BENEFIT_ACTION) continue
    if (!qoderWindowOpenAt(campaign, nowMs)) continue
    return campaign
  }
  return undefined
}
/**
 * Id of today's round when it can be claimed right now, else undefined. Kept
 * out of the card-facing state on purpose: callers read the list and claim in
 * the same breath, so the id is never held long enough to go stale.
 */
export function qoderClaimableCampaignIdOf(payload: unknown, nowMs: number = Date.now()): string | undefined {
  const campaign = qoderClaimableCampaignOf(payload, nowMs)
  if (campaign === undefined || campaign['claimStatus'] === QODER_CLAIMED_STATUS) return undefined
  const id = campaign['campaignId']
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * How long a claimed reward stays usable, in days, when the upstream states a
 * rule instead of a date.
 *
 * The credits a daily check-in pays out land in the add-on pool, and the usage
 * routes carry no date for that pool — the only expiry the API states for it
 * is this rule ("valid 30 days after claiming"). The shortest rule wins: an
 * account holding rounds of different lengths expires soonest, and that is
 * the number worth showing on the pool.
 */
export function qoderRewardValidityDaysOf(payload: unknown): number | undefined {
  const holder = payload as { campaigns?: unknown } | null | undefined
  const list = holder?.campaigns
  if (!Array.isArray(list)) return undefined
  let days: number | undefined
  for (const entry of list as unknown[]) {
    const validDays = qoderBenefitOf(entry)?.validDays
    if (validDays === undefined) continue
    if (days === undefined || validDays < days) days = validDays
  }
  return days
}

/**
 * When the credits the newest claimed check-in round paid out run out, in ms.
 *
 * The usage routes report that pool only as a sum, and the campaign list is the
 * one place that dates it: a round states a one-day claim window and a validity
 * in days, and the credits can only have been claimed inside that window — so
 * the window's opening plus the validity is the date, exact to within the day
 * a claim can land in. Only a round already claimed counts: one still open has
 * paid out nothing. Newest wins, because its credits are the last to go.
 */
export function qoderRewardExpiryMs(payload: unknown): number | undefined {
  const holder = payload as { campaigns?: unknown } | null | undefined
  const list = holder?.campaigns
  if (!Array.isArray(list)) return undefined
  let openedAt: number | undefined
  let validDays: number | undefined
  for (const entry of list as unknown[]) {
    const record = entry as Record<string, unknown> | null | undefined
    if (record === null || typeof record !== 'object') continue
    if (record['actionType'] !== QODER_CLAIM_BENEFIT_ACTION) continue
    if (record['claimStatus'] !== QODER_CLAIMED_STATUS) continue
    // Only a round that states a relative validity can be dated at all, so it
    // is the only kind that competes: a round without one must not win the
    // comparison and then leave the row with no date.
    const days = qoderBenefitOf(record)?.validDays
    if (days === undefined) continue
    const startedAt = qoderEpochMs(record['startAt']) ?? qoderEpochMs(record['beginAt'])
    if (startedAt === undefined) continue
    if (openedAt === undefined || startedAt > openedAt) {
      openedAt = startedAt
      validDays = days
    }
  }
  return openedAt === undefined || validDays === undefined ? undefined : openedAt + validDays * 86_400_000
}

/**
 * The card-facing check-in state. No campaign id is published: the claim route
 * re-reads the list, so a stale id could never be clicked from this state.
 * Unknown `claimStatus` reads as claimable; an upstream `active:false` without
 * a `CLAIM_BENEFIT` round (e.g. international without umid) reads as inactive.
 */
export function qoderCheckinStateFrom(payload: unknown, nowMs: number = Date.now()): QoderCheckinState {
  const campaign = qoderClaimableCampaignOf(payload, nowMs)
  if (campaign === undefined) {
    const opensAt = qoderNextOpenAt(payload, nowMs)
    return { active: false, todayCheckedIn: false, ...opensAt === undefined ? {} : { opensAt } }
  }
  const benefit = qoderBenefitOf(campaign)
  const endsAt = qoderEpochMs((campaign as { endAt?: unknown })['endAt'])
  return {
    active: true,
    todayCheckedIn: (campaign as { claimStatus?: unknown })['claimStatus'] === QODER_CLAIMED_STATUS,
    ...(benefit === undefined
      ? {}
      : {
          amount: benefit.amount,
          unit: benefit.kind === 'CREDITS' ? 'credits' : benefit.kind.toLowerCase(),
          ...(benefit.validDays === undefined ? {} : { validDays: benefit.validDays }),
        }),
    ...(endsAt === undefined ? {} : { endsAt }),
  }
}

/**
 * When the next round opens, for an account whose current round is not
 * claimable right now (already collected, or its window has not started).
 *
 * Qoder re-issues the daily round at 10:00 Beijing and the window then runs to
 * 09:59 the next day, so before 10:00 this is the honest answer to "when can I
 * claim" — and the moment the automatic pass comes back for.
 */
function qoderNextOpenAt(payload: unknown, nowMs: number): number | undefined {
  const holder = payload as { campaigns?: unknown } | null | undefined
  const list = holder?.campaigns
  if (!Array.isArray(list)) return undefined
  let soonest: number | undefined
  for (const entry of list as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue
    const campaign = entry as Record<string, unknown>
    if (campaign['actionType'] !== QODER_CLAIM_BENEFIT_ACTION) continue
    if (campaign['claimStatus'] === QODER_CLAIMED_STATUS) continue
    const startAt = qoderEpochMs(campaign['startAt'] ?? campaign['beginAt'])
    if (startAt === undefined || nowMs >= startAt) continue
    if (soonest === undefined || startAt < soonest) soonest = startAt
  }
  return soonest
}
/**
 * Claim path for one campaign id. The caller reads the list immediately
 * before claiming: the daily round is re-issued with a new id each day, so an
 * id remembered from an earlier read is a stale one.
 */
export function qoderClaimCampaignPath(campaignId: string): string {
  return `${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`
}
/** What one claim answered, after `normalizeClaimResult`. */
export interface QoderClaimResult {
  claimed: boolean
  replayed: boolean
  amount?: number
  expiresAt?: number
}
/**
 * Read back what a claim answered. A repeat answers `replayed: true` and
 * grants nothing rather than failing, so both fresh and replayed are success.
 * `amount` is present only when this call actually paid out.
 */
export function qoderNormalizeClaimResult(payload: unknown, campaign?: unknown): QoderClaimResult {
  const payloadRecord = payload as { data?: unknown } | null | undefined
  const body = (payloadRecord?.data !== null && typeof payloadRecord?.data === 'object' ? payloadRecord.data : payload) as {
    status?: unknown; replayed?: unknown; success?: unknown; benefit?: { amount?: unknown } | null | undefined; expiresAt?: unknown
  } | null | undefined
  const status = typeof body?.status === 'string' ? body.status as string : ''
  const replayed = body?.replayed === true
  const granted = status === QODER_CLAIMED_STATUS || replayed || body?.success === true
  const amountValue = Number(body?.benefit?.amount ?? (typeof campaign !== 'undefined' ? qoderBenefitOf(campaign)?.amount : undefined))
  const expiresAt = qoderEpochMs(body?.expiresAt)
  return {
    claimed: granted,
    replayed,
    ...(!replayed && Number.isFinite(amountValue) && amountValue > 0 ? { amount: amountValue } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** Map an HTTP status onto the failure class the future gateway answers with. */
export function classifyQoderUpstreamError(status: number): QoderUpstreamErrorKind {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

/** Flatten a content value into plain text; image blocks contribute nothing. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'text') text += typeof block.text === 'string' ? block.text : ''
  }
  return text
}

/**
 * OpenAI messages → the endpoint's message vocabulary.
 *
 * An assistant turn that only called tools carries no content; the endpoint
 * rejects a null content field, so an empty string is sent. A tool result
 * without its calling id, or an assistant tool call without one, throws with
 * the reason — the gateway would refuse it anyway, and an early throw names
 * the missing link instead of a bare upstream 400.
 */
export function toQoderMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return []
  const out: Array<Record<string, unknown>> = []
  for (const raw of messages as Array<Record<string, unknown>>) {
    if (raw === null || typeof raw !== 'object') continue
    if (raw['role'] === 'system' || raw['role'] === 'developer') {
      out.push({ role: 'system', content: textOf(raw['content']) })
      continue
    }
    if (raw['role'] === 'user') {
      // Content parts are kept as they are, `image_url` blocks included: Qoder's
      // own client leaves them in the message and refuses a vision-less model
      // that is handed one, and the image form it builds is the OpenAI one
      // (`{type:'image_url', image_url:{url:'data:...'}}`). Collapsing the array
      // to its text is what made a question about a picture arrive without one.
      const content = raw['content']
      out.push({ role: 'user', content: Array.isArray(content) ? content : textOf(content) })
      continue
    }
    if (raw['role'] === 'assistant') {
      const toolCalls: Array<Record<string, unknown>> = []
      if (Array.isArray(raw['tool_calls'])) {
        for (const call of raw['tool_calls'] as Array<Record<string, unknown>>) {
          if (call === null || typeof call !== 'object') continue
          const id = call['id']
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error('toQoderMessages: assistant tool_call is missing an id; the tool loop cannot match the result back to it')
          }
          const fn = call['function']
          const name = typeof fn === 'object' && fn !== null
            ? (fn as Record<string, unknown>)['name']
            : (call as Record<string, unknown>)['name']
          if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`toQoderMessages: assistant tool_call "${id}" has no function name; the gateway cannot dispatch it`)
          }
          const args = typeof fn === 'object' && fn !== null
            ? (fn as Record<string, unknown>)['arguments']
            : (call as Record<string, unknown>)['arguments']
          toolCalls.push({
            id,
            type: 'function',
            function: {
              name,
              arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
            },
          })
        }
      }
      const entry: Record<string, unknown> = { role: 'assistant', content: textOf(raw['content']) }
      if (toolCalls.length > 0) entry['tool_calls'] = toolCalls
      out.push(entry)
      continue
    }
    if (raw['role'] === 'tool' || raw['role'] === 'toolResult') {
      const toolCallId = raw['tool_call_id'] ?? raw['toolCallId']
      if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
        throw new Error('toQoderMessages: tool result message is missing tool_call_id; it cannot be linked to the calling assistant turn')
      }
      out.push({ role: 'tool', tool_call_id: toolCallId, content: textOf(raw['content']) })
    }
  }
  return out
}

/**
 * Tool definitions → the endpoint's function schema. The OpenAI shape passes
 * through; a bare `{ name, description, parameters }` descriptor is wrapped.
 */
export function toQoderTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return []
  return (tools as Array<Record<string, unknown>>).map((tool, index) => {
    if (tool !== null && typeof tool === 'object') {
      const fn = tool['function']
      if (fn !== null && typeof fn === 'object') {
        const name = (fn as Record<string, unknown>)['name']
        if (typeof name !== 'string' || name.length === 0) {
          throw new Error(`toQoderTools: tool at index ${index} has no function name; the gateway cannot register it`)
        }
        return {
          type: 'function',
          function: {
            name,
            description: (fn as Record<string, unknown>)['description'] ?? '',
            parameters: (fn as Record<string, unknown>)['parameters'] ?? { type: 'object', properties: {} },
          },
        }
      }
      const name = tool['name']
      if (typeof name === 'string' && name.length > 0) {
        return {
          type: 'function',
          function: {
            name,
            description: tool['description'] ?? '',
            parameters: tool['parameters'] ?? { type: 'object', properties: {} },
          },
        }
      }
    }
    throw new Error(`toQoderTools: tool at index ${index} has no name; the gateway cannot register it`)
  })
}

/**
 * OpenAI request body → the flat `agent_chat_generation` literal.
 *
 * Only the endpoint's own fields are sent: optional Pi/OpenAI fields
 * (temperature, top_p, tool_choice, …) would fail validation. `max_tokens`
 * is forwarded only when the caller actually specifies a positive integer —
 * reasoning and the answer share this budget upstream, so no default is
 * invented here. `is_reasoning` is sent only when the caller states it: a
 * fabricated `false` answers `provider_error` 1210 ("该模型始终思考，
 * 不支持关闭思考") on models that always think.
 */
export function buildQoderChatBody(source: string, model: string, options: {
  enableThinking?: boolean
  reasoningEffort?: string
  sessionId?: string
} = {}): string {
  const input = JSON.parse(source) as Record<string, unknown>
  const recordID = randomUUID()
  const messages = toQoderMessages(input['messages'])
  const lastUser = [...messages].reverse().find(message => message['role'] === 'user')
  // `textOf` also reads a user turn whose content is a part list, which is what
  // a turn carrying an image has: the title and `chat_context.text` are built
  // from this, and an image-only turn would otherwise name itself "".
  const lastText = textOf(lastUser?.['content'])
  const parameters: Record<string, unknown> = {}
  const maxTokens = input['max_tokens'] ?? input['max_completion_tokens']
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    parameters['max_tokens'] = maxTokens
  }
  if (options.enableThinking === true) {
    parameters['enable_thinking'] = true
    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
      parameters['reasoning_effort'] = options.reasoningEffort
    }
  } else if (options.enableThinking === false) {
    parameters['enable_thinking'] = false
  }
  return JSON.stringify({
    request_id: randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: options.sessionId ?? `xdpool-${randomUUID()}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    aliyun_user_type: '',
    system: '',
    messages,
    tools: toQoderTools(input['tools']),
    parameters,
    chat_context: {
      chatPrompt: '',
      // Kept as the directory's own client sends it (`null`): the image rides in
      // `messages`, and this key is part of the envelope's shape.
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: model, ...options.enableThinking === undefined ? {} : { is_reasoning: options.enableThinking } },
        originalContent: lastText,
      },
      features: [],
      text: lastText,
    },
    model_config: {
      key: model,
      source: 'system',
      ...options.enableThinking === undefined ? {} : { is_reasoning: options.enableThinking },
    },
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: randomUUID(),
      name: lastText.slice(0, 30),
      begin_at: Date.now(),
    },
  })
}

/**
 * The `chat` group of a directory envelope, or a named error when the shape
 * moved. Naming the groups that DID arrive keeps the next upstream rename
 * instantly readable instead of a bare "no chat group".
 */
export function readQoderCatalogShape(data: unknown): unknown[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Qoder model list shape changed: top level is ${Array.isArray(data) ? 'an array' : typeof data}, not a group envelope`)
  }
  const envelope = data as Record<string, unknown>
  if (!('chat' in envelope)) {
    throw new Error(`Qoder model list shape changed: no \`chat\` group; groups present: ${Object.keys(envelope).slice(0, 12).join(', ') || '(none)'}`)
  }
  const chat = envelope['chat']
  if (!Array.isArray(chat)) {
    throw new Error(`Qoder model list shape changed: \`chat\` is ${chat === null ? 'null' : typeof chat}, not an array`)
  }
  return chat
}

/**
 * The window a Qoder model runs at, from `context_config`.
 *
 * The catalog offers several sizes per model (`1M`, `200K`, `400K`) and marks
 * the one in force with `is_default`. A row that names no default keeps its
 * largest, which is the reading that cannot promise less than the model has.
 */
function qoderContextWindowOf(record: Record<string, unknown>): number | undefined {
  const config = record['context_config']
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  const tokenCountOf = (entry: unknown): number | undefined => {
    if (entry === null || typeof entry !== 'object') return undefined
    const value = (entry as Record<string, unknown>)['token_count']
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  }
  const entries = Object.values(config as Record<string, unknown>)
  const preferred = entries.find((entry) => entry !== null && typeof entry === 'object'
    && (entry as Record<string, unknown>)['is_default'] === true)
  const chosen = tokenCountOf(preferred)
  if (chosen !== undefined) return chosen
  const sizes = entries.map(tokenCountOf).filter((value): value is number => value !== undefined)
  return sizes.length === 0 ? undefined : Math.max(...sizes)
}

/** One directory row → one callable model, or undefined when unusable. */
export function qoderModelOf(entry: unknown): QoderChatModel | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const record = entry as Record<string, unknown>
  if (typeof record['key'] !== 'string' || record['key'].length === 0) return undefined
  if (record['enable'] === false) return undefined
  if (typeof record['display_name'] !== 'string' || record['display_name'].length === 0) return undefined
  const config = record['thinking_config'] as
    { enabled?: { efforts?: unknown }; disabled?: unknown } | undefined
  const efforts = config?.enabled?.efforts
  const isShape = efforts !== null && typeof efforts === 'object' && !Array.isArray(efforts)
  // Upstream order, not key order: the catalog lists the levels arbitrarily.
  const effortLevels = isShape
    ? QODER_TABLE_LEVELS.filter(level => Object.prototype.hasOwnProperty.call(efforts, level))
    : []
  const defaultEffort = isShape
    ? QODER_TABLE_LEVELS.find(level => {
      const row = (efforts as Record<string, unknown>)[level]
      return row !== null && typeof row === 'object' && (row as Record<string, unknown>)['is_default'] === true
    })
    : undefined
  const maxInputTokens = typeof record['max_input_tokens'] === 'number' && Number.isFinite(record['max_input_tokens']) && record['max_input_tokens'] > 0
    ? record['max_input_tokens']
    : undefined
  // The window and input budget are independent; the directory states no output limit.
  const contextWindow = qoderContextWindowOf(record) ?? maxInputTokens
  return {
    id: record['key'] as string,
    name: record['display_name'] as string,
    ...maxInputTokens === undefined ? {} : { maxInputTokens },
    ...contextWindow === undefined ? {} : { contextWindow },
    supportsImages: record['is_vl'] === true,
    ...effortLevels.length === 0 ? {} : { effortLevels },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...effortLevels.length > 0 && config?.disabled === undefined ? { alwaysThinking: true } : {},
  }
}

/**
 * Qoder upstream client: chat, usage, campaigns and the model directory.
 * `fetchImpl` is injectable for offline checks.
 */
export class QoderUpstreamClient {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: QoderClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch }

  private baseUrl(): string { return QODER_GATEWAYS[this.options.region] }

  /**
   * Read the callable roster for this region. A row the parser cannot use is
   * skipped rather than failing the whole directory; a shape that moved
   * throws a named error.
   */
  async fetchModels(signal?: AbortSignal): Promise<QoderChatModel[]> {
    const credential = await this.options.credential()
    const url = qoderEndpoint(this.baseUrl(), QODER_MODELS_PATH)
    const headers = buildCosyAuthHeaders(Buffer.alloc(0), url, credential)
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      // A directory read with no bound of its own would hold the gateway's
      // in-flight promise forever, and every later request would wait on it.
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`Qoder model list failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    }
    const chat = readQoderCatalogShape(await response.json() as unknown)
    const models: QoderChatModel[] = []
    for (const raw of chat) {
      const model = qoderModelOf(raw)
      if (model !== undefined) models.push(model)
    }
    return models
  }
  private openApiBase(): string { return QODER_OPENAPI[this.options.region] }
  /**
   * Read the account's usage, shaped the way the IDE panel presents it.
   *
   * Two routes carry different halves: the presentation route includes the
   * per-model dedicated packages, `quota/usage` is the older narrower shape.
   * Either alone renders something useful, so the first failing falls back to
   * the second rather than failing the whole read. Both failing throws — the
   * caller reports "usage unavailable" instead of an empty panel.
   */
  async fetchUsage(signal?: AbortSignal): Promise<QoderUsage> {
    const credential = await this.options.credential()
    const headers = qoderOpenApiHeaders(credential)
    const read = async (path: string): Promise<unknown> => {
      const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), path), {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Qoder usage failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
      return await response.json() as unknown
    }
    let payload: unknown
    let source: QoderUsage['source'] = 'presentation'
    try {
      payload = await read(QODER_USAGE_PRESENTATION_PATH)
    } catch (error) {
      if (signal?.aborted) throw error
      source = 'quota'
      payload = await read(QODER_USAGE_PATH)
    }
    const envelope = payload === null || typeof payload !== 'object' ? {} : payload as Record<string, unknown>
    const usage = (envelope['qoderUsage'] ?? envelope['data'] ?? payload) as unknown
    if (usage === null || typeof usage !== 'object') throw new Error('Qoder usage answered no usable document')
    const record = usage as Record<string, unknown>
    const userQuota = qoderQuotaBucket(record['user_quota'] ?? record['userQuota'])
    const addOnQuota = qoderQuotaBucket(record['add_on_quota'] ?? record['addOnQuota'])
    const rawExpiry = record['expiresAt'] ?? record['expires_at']
    const expiresAtMs = qoderEpochMs(rawExpiry)
    // "No expiry at all" arrives as the largest date the API can write rather
    // than as an absent field, so a value that is there but cannot be a date
    // means exactly that — and saying so beats both a date centuries away and
    // an unexplained blank.
    const neverExpires = expiresAtMs === undefined
      && rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== ''
    const rawPackages = record['dedicated_resource_packages'] ?? record['dedicatedResourcePackages']
    const now = Date.now()
    const dedicatedPackages = Array.isArray(rawPackages)
      // A package past its own expiry is not a package the user can spend, and
      // Qoder keeps reporting one with credits left on it. WorkBuddy drops the
      // same shape upstream (`src/upstream.ts`), so without this the panel showed
      // an expired row with a red "expiring soon" badge that never went away.
      ? rawPackages.map(qoderDedicatedPackage)
        .filter((entry): entry is QoderDedicatedPackage => entry !== undefined)
        .filter((entry) => entry.expiresAtMs === undefined || entry.expiresAtMs > now)
      : []
    if (userQuota === undefined && addOnQuota === undefined && dedicatedPackages.length === 0) {
      throw new Error('Qoder usage contained no usable quota')
    }
    return {
      ...userQuota === undefined ? {} : { userQuota },
      ...addOnQuota === undefined ? {} : { addOnQuota },
      dedicatedPackages,
      ...expiresAtMs === undefined ? {} : { expiresAtMs },
      ...neverExpires ? { neverExpires: true } : {},
      source,
    }
  }
  /**
   * Read the raw campaigns payload once. One round trip answers both the
   * promotional rows and the daily check-in round; the pure selectors above
   * split it without a second request.
   */
  async fetchCampaigns(signal?: AbortSignal): Promise<unknown> {
    const credential = await this.options.credential()
    const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), QODER_CAMPAIGNS_PATH), {
      method: 'GET',
      headers: qoderOpenApiHeaders(credential),
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Qoder campaigns failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    return await response.json() as unknown
  }
  /**
   * Claim one campaign's benefit, returning the raw answer. A repeat answers
   * `replayed: true` rather than failing; `qoderNormalizeClaimResult` narrows it.
   */
  async claimCampaign(campaignId: string, signal?: AbortSignal): Promise<unknown> {
    if (typeof campaignId !== 'string' || campaignId.length === 0) {
      throw new Error('Qoder check-in failed: no campaign id to claim')
    }
    const credential = await this.options.credential()
    const response = await this.fetchImpl(qoderEndpoint(this.openApiBase(), qoderClaimCampaignPath(campaignId)), {
      method: 'POST',
      headers: { ...qoderOpenApiHeaders(credential), 'Content-Type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(DIRECTORY_TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Qoder check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      const contentType = response.headers.get('content-type') ?? 'no content-type'
      throw new Error(`Qoder check-in: response is not valid JSON (${contentType}) — ${text.slice(0, 300)}`)
    }
  }



  /**
   * Open one chat stream for a model. The caller owns the SSE translation;
   * a refusal answers as a classified error with the body truncated.
   */
  async chatStream(openAiBody: string, model: string, options: {
    enableThinking?: boolean
    reasoningEffort?: string
    sessionId?: string
    signal?: AbortSignal
    /** Endpoint routing headers (model key + source); sent alongside the COSY set. */
    extraHeaders?: Record<string, string>
  } = {}): Promise<QoderChatResult> {
    let plain: string
    try {
      plain = buildQoderChatBody(openAiBody, model, options)
    } catch {
      return { ok: false, status: 400, kind: 'client', message: 'invalid JSON request' }
    }
    const credential = await this.options.credential()
    const url = qoderEndpoint(this.baseUrl(), QODER_CHAT_PATH)
    const bodyBytes = encodeBody(plain)
    const headers = buildCosyAuthHeaders(bodyBytes, url, credential)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers, ...options.extraHeaders },
        body: bodyBytes,
        redirect: 'error',
        signal: options.signal === undefined ? AbortSignal.timeout(CHAT_STREAM_TIMEOUT_MS) : AbortSignal.any([options.signal, AbortSignal.timeout(CHAT_STREAM_TIMEOUT_MS)]),
      })
    } catch (error) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, status: response.status, kind: classifyQoderUpstreamError(response.status), message: text.slice(0, 300) || `Qoder returned HTTP ${response.status}` }
    }
    return { ok: true, response }
  }
}

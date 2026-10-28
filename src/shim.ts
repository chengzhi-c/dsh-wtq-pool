/**
 * Loopback OpenAI-compatible endpoint with multi-account failover.
 *
 * The pi-ai provider points here. Each chat request acquires an account from
 * the pool; when the upstream answers with a rate limit, the shim cools that
 * account down, takes the next one, and retries in the same request — so a
 * `429 soft_rate` never reaches the user as a turn failure.
 *
 * Security model: the server binds 127.0.0.1 only, rejects a non-loopback Host
 * or Origin, and caps the body. The bearer header is not a credential here — the
 * real token comes from the pool — so it is only required to have the Bearer
 * shape. The guards follow corrinehu/dsh-workbuddy-connect (MIT, Copyright
 * (c) 2026 Corrine Hu), which designed and validated them.
 *
 * @module dsh-wtq-pool/shim
 */

import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { POOL_HOLD_MS, type WorkBuddyAccount, type WorkBuddyAccountPool } from './accounts'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog'
import { classifyUpstreamError, isHardCreditText, parseRateLimitReset, retryAfterSeconds, WorkBuddyUpstreamClient, type UpstreamErrorKind, type WorkBuddyRegion } from './upstream'
import { SseDecoder } from './trae-sse'

export interface ShimLogger {
  info?(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WorkBuddyShim {
  ready: Promise<void>
  baseUrl(): string
  /** The bound loopback port; 0 until `ready` resolves. */
  port(): number
  close(): Promise<void>
}

export interface WorkBuddyShimOptions {
  pool: WorkBuddyAccountPool
  client: WorkBuddyUpstreamClient
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
  /**
   * Restrict this shim to one gateway. Two shims run side by side — one
   * per region — and each must only ever draw accounts that belong to its
   * own gateway. Absent means "every account" (a single-region deployment).
   */
  region?: WorkBuddyRegion
  /**
   * Preferred loopback port, tried at listen time. The host reads this
   * provider's base URL out of the manifest before the plugin process starts,
   * so the address has to be stable across restarts — an ephemeral port would
   * leave the published provider row pointing at nothing. 0 (the default)
   * asks the OS for any free port, which is what tests want.
   */
  port?: number
  /**
   * Ids this run publishes. Discovery lists these and no others.
   * Absent means the whole directory.
   */
  listedIds?: () => readonly string[]
}

/**
 * Loopback guards, the request body bound and the server shell live in
 * `./loopback` — one copy, shared with the Trae and Qoder gateways.
 */
import { boundedRetryAfterSeconds, channelCheckRefusal, createLoopbackServer, guardsPass, isJsonContentType, listedModels, PEEK_MAX_BYTES, PEEK_MAX_CHUNKS, readRequestBody, relayStreamOf, requestPathname, safeMessage, unapprovedChannelRefusal, writeChunk, writeJson, writeOpenAIError } from './loopback'
import { LOG_PREFIX } from './log'

/** Whether one SSE data frame carries a non-null `finish_reason`. */
function carriesFinishReason(data: string): boolean {
  try {
    const parsed = JSON.parse(data) as { choices?: Array<{ finish_reason?: unknown }> }
    return Array.isArray(parsed.choices)
      && parsed.choices.some(choice => typeof choice?.finish_reason === 'string' && choice.finish_reason !== '')
  } catch {
    return false
  }
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  waf_block: 502,
  not_found: 404,
  server: 502,
  client: 400,
  model_tier: 400,
  account_restricted: 403,
  transport: 502,
  aborted: 499,
}

/**
 * How long one account keeps a model it is not entitled to out of rotation.
 *
 * A plan does not change inside a working day, and the upstream names no
 * window of its own. A day is long enough that the gate costs one refusal per
 * account per day, and short enough that a plan bought later comes back
 * without a restart.
 */
const MODEL_TIER_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * The business code an account-level 200 envelope carries.
 *
 * `classifyUpstreamError` only reads codes on the statuses the upstream uses
 * for failures, so a refusal wearing a 200 was classed `client` and answered as
 * a one-off 502. These are the codes that make it the same account property a
 * non-200 answer would carry.
 */
function classifyEnvelopeCode(code: string | undefined, text: string): UpstreamErrorKind | undefined {
  if (code === '6004') return 'soft_rate'
  if (code === '11158') return 'model_tier'
  if (code === '11140') return 'account_restricted'
  if (code === '12153') return 'session_dead'
  if (isHardCreditText(text)) return 'hard_credit'
  // A prose-only refusal carries no business code; the status is 200, so the
  // shared classifier would otherwise only see success. Its 200 branch already
  // knows the limit and session sentences the older deployments send.
  const kind = classifyUpstreamError(200, text)
  return kind === 'client' ? undefined : kind
}


/** Stable key for one conversation: a hash of its first user message. */
function conversationKeyOf(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return undefined
    for (const entry of parsed.messages) {
      if (typeof entry !== 'object' || entry === null) continue
      const message = entry as Record<string, unknown>
      if (message['role'] !== 'user') continue
      const content = typeof message['content'] === 'string'
        ? message['content']
        : JSON.stringify(message['content'] ?? '')
      return createHash('sha256').update(content).digest('hex').slice(0, 32)
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Read enough of a 200 body to tell an SSE stream from a refusal wearing a 200.
 *
 * WorkBuddy answers a refusal with a JSON envelope and an upstream hiccup can
 * end the body before the first frame; both leave the status code claiming
 * success. The head is what decides: a body that opens with `{` or `[` is the
 * envelope, a body that already ended empty is no answer at all, and anything
 * else is relayed as the stream it claims to be.
 *
 * The bytes the peek took are returned so the relay can put them back in front.
 */
async function peekAnswerHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ head: Uint8Array[]; ended: boolean; refusal?: string; code?: string; body?: string }> {
  const head: Uint8Array[] = []
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let ended = false
  let jsonLooking = false
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      ended = true
      break
    }
    head.push(next.value)
    bytes += next.value.byteLength
    text += decoder.decode(next.value, { stream: true })
    const trimmed = text.replace(/^\uFEFF/, '').trimStart()
    if (trimmed === '') {
      // Nothing but whitespace so far: keep reading within the same bounds the
      // sibling gateways peek with, so a silent upstream cannot park the turn.
      if (bytes >= PEEK_MAX_BYTES || head.length >= PEEK_MAX_CHUNKS) break
      continue
    }
    jsonLooking = trimmed.startsWith('{') || trimmed.startsWith('[')
    if (!jsonLooking) break
    // An envelope is read whole before it is judged, bounded: one that never
    // ends is reported as a refusal rather than relayed as a stream.
    if (ended || bytes >= PEEK_MAX_BYTES / 8 || head.length >= PEEK_MAX_CHUNKS) break
  }
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (trimmed === '' && ended) {
    return { head, ended, refusal: 'workbuddy returned an empty answer stream' }
  }
  if (!jsonLooking) return { head, ended }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const code = parsed['code'] ?? parsed['errCode'] ?? parsed['errorCode']
    const msg = parsed['msg'] ?? parsed['message'] ?? parsed['error']
    const detail = typeof msg === 'string' && msg.trim() !== '' ? msg.trim() : ''
    const named = code === undefined || code === null || code === 0 || code === '0' ? '' : `code ${String(code)}`
    const sentence = [named, detail].filter(part => part !== '').join(' · ')
    return {
      head,
      ended,
      // The raw envelope is kept for the reset-time reader: `refusal` is a
      // rewritten sentence, so a structured `resetAt` field would be lost before
      // the rate-limit branch could see it.
      body: trimmed,
      refusal: sentence === ''
        ? 'workbuddy answered 200 with a JSON body where a stream was expected'
        : `workbuddy answered 200 with ${sentence}`,
      ...named === '' ? {} : { code: String(code) },
    }
  } catch {
    return {
      head,
      ended,
      body: trimmed,
      refusal: `workbuddy answered 200 with a body that is neither a stream nor an envelope: ${safeMessage(trimmed.slice(0, 200))}`,
    }
  }
}

/**
 * The effort to put back on a request that carries none.
 *
 * Some providers treat the field as mandatory and reject the whole request
 * without it (`glm-5.1` answers HTTP 400 / 11133 "the request parameters were
 * rejected by the model provider", although the same request with `off` or any
 * rung of its ladder is served). The model's own declared default is what a
 * client that expresses no preference should get.
 *
 * A default outside the model's own ladder is not sent: answering the refusal
 * with a level the upstream also refuses would spend a second call to produce
 * the same error.
 */
function declaredEffortOf(catalog: WorkBuddyCatalog, modelId: string): string | undefined {
  const model = rosterFor(catalog).find((entry) => entry.id === modelId)
  const effort = model?.defaultThinkingLevel
  if (effort === undefined || effort === '') return undefined
  const supported = model?.supportedEfforts
  if (supported !== undefined && supported.length > 0 && !supported.includes(effort)) return undefined
  return effort
}

/**
 * The roster a request may target: the user's selection, else the whole catalog.
 *
 * A switch that turned every model off leaves `visible()` empty while the models
 * are still callable, so the full roster is the fallback. Read through `typeof`
 * rather than calling directly: this runs inside a live request, and a catalog
 * object that cannot answer must not turn a chat completion into a 500.
 */
function rosterFor(catalog: WorkBuddyCatalog): readonly WorkBuddyModelInfo[] {
  const visible = typeof catalog.visible === 'function' ? catalog.visible() : []
  if (visible.length > 0) return visible
  return typeof catalog.current === 'function' ? catalog.current() : []
}

/** The same body with `reasoning_effort` filled in, when it names no effort yet. */
function withReasoningEffort(prepared: string, effort: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const request = body as Record<string, unknown>
  // An empty string is "no preference" spelled differently, not a named level.
  const named = request['reasoning_effort']
  if (typeof named === 'string' && named !== '') return undefined
  request['reasoning_effort'] = effort
  return JSON.stringify(request)
}

/**
 * The upstream's code for "the request parameters were rejected by the model
 * provider": the refusal `glm-5.1` answers a request that carries no effort
 * with. It is a general invalid-parameter code, not an effort-specific one, so
 * the retry it triggers is gated on the request having named no effort at all -
 * that is the one parameter this plugin can tell is missing.
 */
const PARAMETER_REJECTION = /"code"\s*:\s*"?11133\b/

/** True when an upstream failure body means the request overran the model's
 *  context window (OpenAI `context_length_exceeded`, WorkBuddy code 11115 /
 *  "input length too long"). Surfaced as a friendly hint, never auto-truncated. */
function isContextTooLong(body: string): boolean {
  if (body.includes('context_length_exceeded')) return true
  if (body.includes('input length too long')) return true
  if (body.includes('"code":11115')) return true
  if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true
  return false
}

/**
 * How long a spent or dead session is held out of rotation.
 *
 * `penalize` takes an absolute reset rather than a duration, and the duration
 * itself lives with the pool that owns the hold: see `POOL_HOLD_MS` in
 * `./accounts`. Handing the duration straight to `penalize` once put the reset
 * in 1970, which reads as already past and falls back to the configured
 * cooldown, so the hold never took effect at all.
 */
const holdUntil = (): number => Date.now() + POOL_HOLD_MS

/** Turn an upstream `Retry-After` (seconds) into the absolute reset `penalize` wants. */
function resetFromRetryAfter(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  return Date.now() + seconds * 1000
}

/** What a gateway with no usable account answers, and why. */
export interface UnavailableAnswer {
  status: number
  code: string
  detail: string
  /** Present only for a rate limit, which is the only reason with a deadline. */
  retryAfterSeconds?: number
}

/**
 * The answer for a gateway whose every account is present but none is usable.
 *
 * The status follows the reason, not the timestamps. A `session` hold also
 * writes a cooldown, so answering 429 whenever every reset sat in the future
 * told the user to wait out a rate limit when the remedy was to sign in again,
 * and put every other remedy below it out of reach.
 *
 * The remedy is the message: every reason here needs a different one, so the
 * answer names the reason that applies rather than sending the user to a
 * setting that was never the problem.
 *
 * A deadline travels with any answer that contains a rate-limited account, not
 * only with the 429: the host keeps `Retry-After` on a 5xx too, and a mixed pool is
 * the one case where waiting is part of the remedy for a request that will
 * otherwise succeed a minute later. Each host then clamps that wait to its own
 * retry budget, so a long deadline shortens rather than being ignored.
 */
export function unavailableAnswer(
  pool: Pick<WorkBuddyAccountPool, 'unavailableReason'>,
  live: readonly WorkBuddyAccount[],
  now: number,
  modelId: string,
): UnavailableAnswer {
  const reasons = live.map(account => pool.unavailableReason(account.id, now, modelId))
  const only = new Set(reasons).size === 1 ? reasons[0] : null
  const limited = live.filter((_, index) => reasons[index] === 'rate-limited')
  // Bounded like every other Retry-After this plugin sends: a hold can
  // legitimately last a day, and handing that to the caller parks it for the
  // whole window on the strength of one number.
  const retryAfterSeconds = limited.length === 0
    ? undefined
    : boundedRetryAfterSeconds(Math.ceil((Math.min(...limited.map(account => Math.max(
      account.cooldownUntilMs,
      account.modelCooldowns[modelId] ?? 0,
    ))) - now) / 1000))
  if (only === 'rate-limited') {
    return { status: 429, code: 'soft_rate', detail: `every account is rate-limited for model ${modelId}`, retryAfterSeconds }
  }
  // Steady state, not just the discovering turn: the first refusal explains
  // itself from the rotation loop, and every request after it lands here.
  if (only === 'plan') {
    return {
      status: 400,
      code: 'model_tier',
      detail: `no WorkBuddy account has model ${modelId} in its plan; pick another model, or add an account whose plan includes it`,
    }
  }
  if (only === 'restricted by the upstream') {
    return {
      status: 403,
      code: 'account_restricted',
      detail: 'every WorkBuddy account was restricted by the upstream; appeal the restriction in the WorkBuddy console, or add another account',
    }
  }
  const detail = only === 'sign-in expired'
    ? 'every WorkBuddy sign-in for this gateway has expired; sign in again in the desktop app'
    : only === 'sign-in refused'
      ? 'every WorkBuddy sign-in was refused by the upstream; sign in again in the desktop app'
      : only === 'on hold'
        ? `every WorkBuddy account is out of credits or otherwise on hold for model ${modelId}`
        : only === 'under its credit reserve'
          ? 'no account is available within its configured credit reserve'
          : `no WorkBuddy account is available for model ${modelId}`
  return { status: 503, code: 'accounts_unavailable', detail, retryAfterSeconds }
}

export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const { pool, client, catalog } = options
  const region = options.region
  const logger = options.logger
  const maxAttempts = 8

  const server = createLoopbackServer({ port: options.port, label: 'workbuddy shim', handle, logger })
  const ready = server.ready

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guardsPass(req, res)) return
    const url = requestPathname(req.url)
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      writeJson(res, 200, { ok: true, pool: pool.status() })
      return
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      // The host rebuilds the picker from this route. `visible()` is the
      // selection; the declaration is that list after the publish cap.
      const selected = catalog.visible()
      const directory = selected.length > 0 ? selected : catalog.current()
      const ids = options.listedIds?.()
      const served = ids === undefined ? directory : listedModels(directory, ids)
      writeJson(res, 200, {
        object: 'list',
        data: served.map(model => ({
          id: model.id,
          object: 'model',
          created: 0,
          owned_by: 'workbuddy',
        })),
      })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  /**
   * Serve one chat completion, rotating accounts on rate limits.
   *
   * A rate-limited account is cooled for exactly the window the upstream
   * reports (when parseable) and the next account is tried immediately, so a
   * pool with any healthy member never surfaces a 429 to the caller.
   */
  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }

    // The controller is armed before the body is read, and watches the RESPONSE
    // stream rather than the request: `req` emits `close` as soon as the body
    // has been read, which is true of every normal request too, so listening
    // there cannot tell "the client went away" from "we have the body". `res`
    // closing is the client no longer waiting, and an upstream call that outlives
    // it keeps spending the account's credits for output nobody receives.
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    const raw = (await readRequestBody(req)).toString('utf8')
    const prepared = client.prepareChatBody(raw)
    const conversationKey = conversationKeyOf(raw)

    // The request's target model. The upstream rate limit is per-model ("可切换
    // 其他模型继续使用"), so cooldowns are keyed by (account, model): a 429 on
    // `hy4-preview` only cools that model on the account, never the whole one.
    let modelId: string | undefined
    try {
      const parsed = JSON.parse(raw) as { model?: unknown }
      modelId = typeof parsed.model === 'string' && parsed.model !== '' ? parsed.model : undefined
    } catch {
      modelId = undefined
    }

    // An empty or model-less body is answered here rather than spent upstream:
    // the other two gateways both reject it locally, and a round-trip cannot
    // produce an answer without a target model.
    if (modelId === undefined) {
      writeOpenAIError(res, 400, 'invalid_request_error', 'model is required')
      return
    }

    const tried: string[] = []
    // Accounts whose sign-in could not be refreshed during this request. They
    // stay available for later requests, but retrying one here only repeats the
    // same failed round trip and starves the healthy accounts behind it.
    const skipped = new Set<string>()
    let last: { kind: UpstreamErrorKind; status: number; message: string } | undefined
    let exhaustedByRateLimit = false
    // Built on first use: the retry below is the only caller, and the answer does
    // not change inside one request. Every request would otherwise pay a full
    // parse+stringify of the whole conversation for a branch almost none take.
    let effortFallback: string | undefined
    let effortFallbackBuilt = false

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      const account = await pool.acquire(modelId, region, conversationKey, skipped)
      if (account === undefined) {
        // Distinguish "never signed in" from "every account is rate-limited":
        // they need opposite remedies, so they must not share a status code.
        if (exhaustedByRateLimit && last !== undefined) {
          // The wording follows the cause, because the remedy does: a spent
          // billing account is topped up, a dead session re-authenticated, a
          // WAF block waited out, and only a 429 clears on its own. Calling
          // every one of them "rate-limited" sent the user looking for a
          // cooldown that was never the problem.
          const model = ` for model ${modelId}`
          const subject = last.kind === 'waf_block'
            ? 'every WorkBuddy account was blocked by the upstream gateway (WAF)'
            : last.kind === 'hard_credit'
              ? `every WorkBuddy account is out of credits${model}`
              : last.kind === 'session_dead'
                ? `every WorkBuddy sign-in is no longer accepted${model}`
                : last.kind === 'model_tier'
                  ? `no WorkBuddy account can use model ${modelId}`
                  : last.kind === 'account_restricted'
                    ? 'every WorkBuddy account was restricted by the upstream'
                    : last.kind === 'transport'
                      ? `the upstream host could not be reached on any account${model}`
                      : `every account is rate-limited${model}`
          const advice = last.kind === 'soft_rate'
            ? 'resets at the upstream window'
            : last.kind === 'model_tier'
              ? 'pick another model, or add an account whose plan includes it'
              : last.kind === 'account_restricted'
                ? 'appeal the restriction in the WorkBuddy console, or add another account'
                : last.kind === 'transport'
                  ? 'check the connection to the upstream host'
                  : 'sign in again in the desktop app'
          writeOpenAIError(
            res,
            KIND_STATUS[last.kind],
            last.kind,
            `${subject} (tried ${tried.length}: ${tried.join(', ')}); ` +
              `${advice} — ${last.message.slice(0, 200)}`,
          )
          return
        }
        // Every account present but none usable is not "never signed in": that
        // message sends the user to re-authenticate over a switch they flipped
        // themselves.
        const regionAccounts = pool.list(region)
        const switchedOff = regionAccounts.filter(account => pool.isDisabled(account.id))
        if (regionAccounts.length > 0 && switchedOff.length === regionAccounts.length) {
          writeOpenAIError(
            res,
            403,
            'accounts_switched_off',
            `every account for this gateway is switched off in the plugin panel (${switchedOff.map(account => account.label).join(', ')}); switch one back on`,
          )
          return
        }
        if (regionAccounts.length > 0) {
          const now = Date.now()
          const live = regionAccounts.filter(account => !pool.isDisabled(account.id))
          // `soft_rate` is the kind a client retries by itself; every other
          // reason needs the user, so it answers 503 with the remedy.
          const answer = unavailableAnswer(pool, live, now, modelId)
          if (answer.retryAfterSeconds !== undefined) {
            res.setHeader('Retry-After', String(answer.retryAfterSeconds))
          }
          writeOpenAIError(res, answer.status, answer.code, answer.detail)
          return
        }
        writeOpenAIError(
          res,
          401,
          'not_signed_in',
          'no WorkBuddy credential found; sign in on the desktop app (or set WORKBUDDY_AUTH_FILE)',
        )
        return
      }
      tried.push(account.label)

      let result = await client.chatStream(account.credential, prepared, controller.signal)
      let refreshOutcome: 'refreshed' | 'refused' | 'failed' | undefined
      if (!result.ok && result.kind === 'session_dead') {
        const failure = result
        refreshOutcome = await pool.refreshAccountOutcome(account.id)
        if (refreshOutcome === 'failed') {
          // The refresh endpoint did not answer; that says nothing about this
          // sign-in. Parking the account for six hours over one bad round trip
          // took a healthy account out of rotation, so the next account gets
          // the turn and this one stays available.
          logger?.warn?.(`${LOG_PREFIX}: ${account.label} could not refresh its sign-in; trying the next account without holding it`)
          skipped.add(account.id)
          last = {
            kind: 'transport',
            status: 502,
            message: `could not refresh the sign-in: ${failure.message}`,
          }
          exhaustedByRateLimit = true
          continue
        }
      }
      if (refreshOutcome === 'refreshed') {
        // A caller that hung up while the refresh was in flight has already
        // stopped waiting: the retry would spend one more upstream call on a
        // turn nobody reads, and come back classed as `aborted` anyway.
        if (controller.signal.aborted) return
        result = await client.chatStream(account.credential, prepared, controller.signal)
      }
      // One retry, only for the missing-parameter refusal: a request that named
      // no effort at all and was rejected for it is served with the model's own
      // declared default. Retrying every 400 would spend a second upstream call
      // on requests that are genuinely malformed.
      if (!result.ok && result.kind === 'client'
        && PARAMETER_REJECTION.test(result.message) && !controller.signal.aborted) {
        if (!effortFallbackBuilt) {
          effortFallbackBuilt = true
          const effort = declaredEffortOf(catalog, modelId)
          effortFallback = effort === undefined ? undefined : withReasoningEffort(prepared, effort)
        }
        if (effortFallback !== undefined) {
          // Logged because the retry is invisible otherwise: a turn that took two
          // upstream calls looks like a slow model unless the reason is written
          // down somewhere.
          logger?.info?.(`${LOG_PREFIX}: ${modelId} refused a request that named no effort; retrying with the model's declared default`)
          result = await client.chatStream(account.credential, effortFallback, controller.signal)
        }
      }

      if (result.ok) {
        // The attached relay stream, not `response.body`: see `relayStreamOf`.
        const reader = relayStreamOf(result.response).getReader()
        let sawDone = false
        let sawFinish = false
        let envelopeFailure: UpstreamErrorKind | undefined
        const decoder = new TextDecoder()
        const sse = new SseDecoder()
        const startStream = (): void => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          })
          // Headers before the first token: Node holds them until the first body
          // write, so a slow or queued upstream showed the client no response at
          // all until it produced something. A 200 whose body is not a stream is
          // decided before this, so that answer still reaches the caller as a
          // status and a sentence instead of a stream that never starts.
          res.flushHeaders()
        }
        /**
         * End the relayed stream in a shape the client can finish on.
         *
         * Destroying the socket instead left a 200 with a truncated body and no
         * terminator, which is a turn the caller can only end by timing out and
         * cannot tell from a cancel. The two sibling gateways already end theirs
         * with an in-band error frame, a finish chunk and `[DONE]`; this is that
         * same contract, and the error text is redacted because this frame is the
         * one place a stream failure reaches the client without passing through
         * `writeOpenAIError`.
         */
        const failInBand = (error: unknown): void => {
          if (controller.signal.aborted || !res.writable) return
          logger?.warn?.(LOG_PREFIX + ': upstream stream failed mid-flight', safeMessage(error))
          try {
            res.write(`data: ${JSON.stringify({
              error: { message: safeMessage(error), type: 'upstream_error' },
            })}\n\n`)
            // A finish chunk before the terminator, as both sibling bridges send:
            // a client that waits for a non-null `finish_reason` otherwise reads
            // this as a turn that never finished.
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`)
            res.end('data: [DONE]\n\n')
          } catch {
            /* the client is already gone; nothing left to answer */
          }
        }
        /** End the response with `[DONE]` unless the upstream already sent it. */
        function closeWithoutDone(): void {
          if (sawDone || !res.writable) return
          logger?.warn?.(LOG_PREFIX + ': upstream stream ended without [DONE]')
          // A truncated stream that carried content but no finish frame is a
          // turn the client cannot close: the terminator alone leaves the last
          // `finish_reason` null, which reads as a turn still in flight. The
          // sibling bridges already send this frame before their terminator.
          if (!sawFinish) {
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`)
          }
          res.end('data: [DONE]\n\n')
        }

        /**
         * Relay the stream, watching for `[DONE]` on the way through.
         *
         * Read and written here rather than piped: the terminal frame has to
         * reach the client before the response is ended, so the frame that
         * carries `[DONE]` is written out and the loop stops on it.
         */
        const relayLoop = (async (): Promise<void> => {
          // A 200 is not a promise that an answer follows. Read the head before
          // answering: an empty body, or the JSON envelope a channel check
          // answers with, otherwise reached the client framed as a turn that
          // never started, and the refusal sentence reached nobody.
          let head: Uint8Array[] = []
          let ended = false
          try {
            const peeked = await peekAnswerHead(reader)
            head = peeked.head
            ended = peeked.ended
            if (peeked.refusal !== undefined) {
              await reader.cancel().catch(() => {})
              logger?.warn?.(`${LOG_PREFIX}: ${account.label} answered 200 with no stream: ${peeked.refusal}`)
              // A prompt-screen refusal is the request's, not the account's:
              // rotating spends every sign-in and still answers the same way.
              if (peeked.code === '11128' || unapprovedChannelRefusal(peeked.refusal) !== undefined) {
                writeOpenAIError(res, 400, 'upstream_channel_check', channelCheckRefusal())
                return
              }
              const envelopeKind = classifyEnvelopeCode(peeked.code, peeked.refusal)
              // A 200 envelope can still be an account-level refusal (a rate
              // limit, a spent balance, a dead session, the 11158 plan gate).
              // Answering it as one upstream 502 skipped rotation and left the
              // account at the head of the queue, so the next request hit the
              // same refusal while healthy accounts sat idle.
              if (envelopeKind === 'soft_rate' || envelopeKind === 'hard_credit'
                || envelopeKind === 'session_dead' || envelopeKind === 'account_restricted'
                || envelopeKind === 'model_tier') {
                last = { kind: envelopeKind, status: 200, message: peeked.refusal }
                exhaustedByRateLimit = true
                envelopeFailure = envelopeKind
                if (envelopeKind === 'soft_rate') {
                  // The 200 envelope is the same rate-limit answer the 429 path
                  // receives, so its later header/body reset outranks the
                  // default cooldown here too. Ignoring them brought the account
                  // back while the window was still standing.
                  const bodyReset = parseRateLimitReset(peeked.body ?? peeked.refusal)
                  const headerReset = resetFromRetryAfter(retryAfterSeconds(result.response.headers))
                  const resetAtMs = bodyReset !== undefined && bodyReset > Date.now()
                    ? (headerReset === undefined ? bodyReset : Math.max(bodyReset, headerReset))
                    : headerReset
                  pool.penalize(account.id, resetAtMs, modelId)
                } else if (envelopeKind === 'model_tier') {
                  pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS)
                } else if (envelopeKind === 'session_dead') {
                  const refreshOutcome = await pool.refreshAccountOutcome(account.id)
                  if (refreshOutcome === 'refused') {
                    pool.penalize(account.id, holdUntil(), undefined, 'session')
                  } else if (refreshOutcome === 'failed') {
                    // A refresh endpoint that did not answer says nothing about
                    // this sign-in. Parking it for six hours took a healthy
                    // account out of rotation; skip it for this request instead.
                    skipped.add(account.id)
                    last = {
                      kind: 'transport',
                      status: 502,
                      message: `could not refresh the sign-in: ${peeked.refusal.slice(0, 200)}`,
                    }
                  }
                  // `refreshed`: the next attempt rides the new access token,
                  // exactly as the non-200 session-dead path does.
                } else {
                  pool.penalize(account.id, holdUntil(), undefined,
                    envelopeKind === 'hard_credit' ? 'spent' : 'restricted')
                }
                return
              }
              writeOpenAIError(res, 502, 'upstream_error', peeked.refusal)
              return
            }
          } catch (error: unknown) {
            // A stream that dies before its first byte is the same mid-flight
            // failure one frame later, so it ends in the same place: the client
            // gets headers, an error frame and a terminator it can finish on.
            startStream()
            failInBand(error)
            return
          }
          logger?.info?.(`${LOG_PREFIX}: served by ${account.label}`)
          startStream()
          let headIndex = 0
          try {
            for (;;) {
              // The bytes the peek already took are replayed first, in order.
              const replayed = headIndex < head.length ? head[headIndex++] : undefined
              const { done, value } = replayed !== undefined
                ? { done: false, value: replayed }
                : ended ? { done: true, value: undefined } : await reader.read()
              if (done || value === undefined) break
              if (!res.writable) return
              // Honours the client's socket: writing past a full buffer would
              // park the whole answer in this process instead of slowing the read
              // from the upstream, as the two sibling gateways already do.
              await writeChunk(res, value)
              try {
                const decoded = decoder.decode(value, { stream: true })
                const events = sse.push(decoded)
                if (!sawFinish && events.some(event => carriesFinishReason(event.data))) sawFinish = true
                if (events.some(event => event.data === '[DONE]')) {
                  // The terminal frame is the last thing the client needs. A
                  // stream that sent content but no finish frame gets one here,
                  // before the terminator, or the last `finish_reason` stays
                  // null and the turn reads as unfinished.
                  if (!sawFinish && res.writable) {
                    res.write(`data: ${JSON.stringify({
                      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    })}\n\n`)
                    sawFinish = true
                  }
                  // Ending the response here is what closes the turn:
                  // `closeWithoutDone` deliberately does nothing once `[DONE]`
                  // has been seen. The upstream is cancelled rather than
                  // drained, so a stream that keeps talking after its
                  // terminator is not read any further.
                  sawDone = true
                  if (res.writable) res.end()
                  await reader.cancel().catch(() => {})
                  return
                }
              } catch {
                // Malformed frames are relayed as they arrived; the tail flush at
                // the end is what decides whether `[DONE]` was really missing.
              }
            }
            if (!sawDone) {
              try {
                const rest = decoder.decode()
                const events = rest === '' ? sse.finish() : [...sse.push(rest), ...sse.finish()]
                if (events.some(event => event.data === '[DONE]')) sawDone = true
                if (events.some(event => carriesFinishReason(event.data))) sawFinish = true
              } catch {
                // Same as above: the frames already relayed stand.
              }
            }
            closeWithoutDone()
          } catch (error: unknown) {
            // The client hanging up aborts this read through `controller`. That
            // is this shim working as designed and it arrives here shaped like an
            // upstream failure, so the signal is what tells the two apart.
            failInBand(error)
          } finally {
            try { reader.releaseLock() } catch { /* already released */ }
          }
        })()
        await relayLoop
        // The peek found an account-level refusal before any byte was sent, so
        // the hold above is already applied and the next account gets the turn.
        if (envelopeFailure === undefined) return
        continue
      }

      last = { kind: result.kind, status: result.status, message: result.message }

      /**
       * Rotate past every failure that is a property of the ACCOUNT rather than
       * of the request.
       *
       * Any of them left uncooled stays at the head of the queue in the default
       * `priority` mode — the account is still `available()`, nothing else moved
       * it — so every later request walks straight back into the same failure
       * while the healthy accounts behind it sit idle.
       *
       * What each one is cooled with differs, because what clears it differs. A
       * 429 cools one model on the upstream's own window, since the upstream
       * itself allows switching models on the same account. A spent account and
       * a dead session do not come back on their own — the balance has to change
       * or the user has to sign in again — so they take the hold below; the
       * configured window is sized for a limit that expires, and using it put a
       * 402 back at the head of the queue every minute. A WAF page is the
       * gateway's own and clears on its own within minutes, so it takes the
       * configured window rather than a hold that would park a healthy account
       * for hours over a transient block.
       *
       * A `transport` failure is the network path's, not the account's, so the
       * rotation stops: every account here reaches the same host, and trying
       * each one just spends another header timeout before answering. An
       * `aborted` turn is the client's own doing and stops the loop too.
       */
      if (result.kind === 'aborted') break

      if (result.kind === 'transport') {
        last = { kind: result.kind, status: result.status, message: result.message }
        exhaustedByRateLimit = true
        break
      }

      if (result.kind !== 'soft_rate' && result.kind !== 'waf_block'
        && result.kind !== 'hard_credit' && result.kind !== 'session_dead'
        && result.kind !== 'model_tier'
        && result.kind !== 'account_restricted') break

      exhaustedByRateLimit = true
      if (result.kind === 'soft_rate') {
        // Cool only this model on this account; the account's other models stay
        // usable (the upstream explicitly allows switching to another model).
        // The later of the upstream's own `Retry-After` and its body reset is
        // the one that keeps the account out for the whole window. Taking a
        // shorter body value over a longer header brought it back while the
        // limit was still standing.
        //
        // A body reset that has already passed is not an answer, though — it is
        // a stale or clock-skewed timestamp, and taking it over a live header
        // dropped the account onto the 60 s default while the upstream had
        // named a window of minutes.
        const bodyReset = parseRateLimitReset(result.message)
        const headerReset = resetFromRetryAfter(result.retryAfter)
        const resetAtMs = bodyReset !== undefined && bodyReset > Date.now()
          ? (headerReset === undefined ? bodyReset : Math.max(bodyReset, headerReset))
          : headerReset
        pool.penalize(account.id, resetAtMs, modelId)
      } else if (result.kind === 'model_tier') {
        // The plan gate clears only when the subscription changes, so this model
        // stays out of this account's rotation for a day rather than for the
        // upstream's rate-limit window. The account itself is not cooled: it
        // serves every other model, and parking it would take those away too.
        pool.blockModel(account.id, modelId, Date.now() + MODEL_TIER_HOLD_MS)
      } else if (result.kind === 'account_restricted') {
        // The vendor restricted this account, and no retry with the same sign-in
        // lifts it. It takes the hold rather than a cooldown: the window is a
        // guess at when an operator might revisit the appeal, not a limit that
        // expires, and the pool reports the reason rather than "rate-limited".
        pool.penalize(account.id, holdUntil(), undefined, 'restricted')
      } else if (result.kind === 'hard_credit' || result.kind === 'session_dead') {
        // A spent account and a dead session do not come back on their own: the
        // credit balance has to change, or the user has to sign in again. The
        // default cooldown window is sized for a limit that expires, and the
        // two-hour cap above it exists to bound a mis-parsed reset, so this
        // hold names itself as one and is held until the next balance read or a
        // manual cooldown reset rather than returning to the head of the queue
        // every minute.
        //
        // The reason travels with the hold because only one of the two clears on
        // a balance read: a probe that finds credits says nothing about a
        // sign-in the upstream still refuses, and releasing both let a 401'ing
        // account back to the head of the queue on every probe cycle.
        pool.penalize(
          account.id,
          holdUntil(),
          undefined,
          result.kind === 'hard_credit' ? 'spent' : 'session',
        )
      } else {
        pool.penalize(account.id)
      }
      logger?.warn(
        `${LOG_PREFIX}: ${account.label} ${result.kind} on ${modelId} ` +
          `(attempt ${attempt + 1}/${maxAttempts}); rotating`,
      )
    }

    if (last === undefined) {
      writeOpenAIError(res, 500, 'internal', 'chat request exhausted without a result')
      return
    }
    // A context-window overrun is a clear, actionable condition — surface a
    // friendly hint instead of a bare upstream echo. The provider must NOT
    // silently truncate or summarise the user's conversation (that drops
    // context and can answer wrongly); the right move is telling the user.
    if (isContextTooLong(last.message)) {
      const subject = `the conversation exceeds ${modelId}'s context window`
      writeOpenAIError(
        res,
        400,
        'context_length_exceeded',
        `${subject}. Shorten the conversation, start a new chat, or pick a model with a larger window ` +
          `(e.g. hy4-preview).`,
      )
      return
    }
    // A refusal aimed at the caller's identity is not something rotation can
    // clear, so it is answered with the cause and the way forward rather than
    // the vendor's block of tips.
    const unapproved = unapprovedChannelRefusal(last.message)
    if (unapproved !== undefined) {
      writeOpenAIError(res, 400, 'upstream_channel_check', unapproved)
      return
    }
    writeOpenAIError(
      res,
      KIND_STATUS[last.kind],
      last.kind,
      `workbuddy upstream ${last.kind} (http ${last.status}) after ${tried.length} account(s) [${tried.join(' → ')}]: ${last.message.slice(0, 400)}`,
    )
  }

  return {
    ready,
    port: server.port,
    baseUrl: server.baseUrl,
    close: server.close,
  }
}

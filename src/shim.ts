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
import { Readable } from 'node:stream'
import type { WorkBuddyAccountPool } from './accounts'
import type { WorkBuddyCatalog } from './catalog'
import { parseRateLimitReset, WorkBuddyUpstreamClient, type UpstreamErrorKind, type WorkBuddyRegion } from './upstream'
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
import { createLoopbackServer, guardsPass, isJsonContentType, listedModels, readRequestBody, safeMessage, writeJson, writeOpenAIError } from './loopback'
import { LOG_PREFIX } from './log'
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  waf_block: 502,
  not_found: 502,
  server: 502,
  client: 400,
  transport: 502,
  aborted: 499,
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
 * Neither condition clears by itself: the credit balance has to change, or the
 * user has to sign in again. The configured cooldown window is sized for a
 * limit that expires, and using it here put a spent account back at the head of
 * the queue every minute, where it failed again and burned the attempts of the
 * healthy accounts behind it. This hold is a fallback, not a verdict: a manual
 * cooldown reset, a re-scan and a balance read that finds credits again all
 * release it.
 */
const SPENT_ACCOUNT_HOLD_MS = 6 * 60 * 60 * 1000

/**
 * The hold as the absolute reset `penalize` expects.
 *
 * `penalize` takes a timestamp, not a duration: handing it the duration put the
 * reset in 1970, which reads as already past and falls back to the configured
 * cooldown, so the hold never took effect at all.
 */
const spentAccountHoldUntil = (): number => Date.now() + SPENT_ACCOUNT_HOLD_MS

/** Turn an upstream `Retry-After` (seconds) into the absolute reset `penalize` wants. */
function resetFromRetryAfter(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  return Date.now() + seconds * 1000
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
    const url = req.url ?? '/'
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
    let last: { kind: UpstreamErrorKind; status: number; message: string } | undefined
    let exhaustedByRateLimit = false

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (controller.signal.aborted) return

      const account = await pool.acquire(modelId, region, conversationKey)
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
                : last.kind === 'transport'
                  ? `the upstream host could not be reached on any account${model}`
                  : `every account is rate-limited${model}`
          const advice = last.kind === 'soft_rate'
            ? 'resets at the upstream window'
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
          const resets = regionAccounts.filter(account => !pool.isDisabled(account.id))
            .map(account => Math.max(account.cooldownUntilMs, account.modelCooldowns[modelId] ?? 0))
          if (resets.every(until => until > now)) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Math.min(...resets) - now) / 1000))))
            writeOpenAIError(res, 429, 'soft_rate', `every account is rate-limited for model ${modelId}`)
          } else {
            writeOpenAIError(res, 503, 'accounts_unavailable', 'no account is available within its configured credit reserve')
          }
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
      if (!result.ok && result.kind === 'session_dead' && await pool.refreshAccount(account.id)) {
        // A caller that hung up while the refresh was in flight has already
        // stopped waiting: the retry would spend one more upstream call on a
        // turn nobody reads, and come back classed as `aborted` anyway.
        if (controller.signal.aborted) return
        result = await client.chatStream(account.credential, prepared, controller.signal)
      }

      if (result.ok) {
        // A 200 with no stream body is a refusal the status code hides, exactly
        // as the other two gateways treat it: answering it as an empty stream
        // would leave the host waiting for a turn that never started.
        if (result.response.body === null) {
          writeOpenAIError(res, 502, 'upstream_error', 'workbuddy returned no stream')
          return
        }
        logger?.info?.(`${LOG_PREFIX}: served by ${account.label}`)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        // Headers before the first token: Node holds them until the first body
        // write, so a slow or queued upstream showed the client no response at
        // all until it produced something.
        res.flushHeaders()
        let sawDone = false
        const decoder = new TextDecoder()
        const sse = new SseDecoder()
        const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
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
            res.end('data: [DONE]\n\n')
          } catch {
            /* the client is already gone; nothing left to answer */
          }
        }
        body.on('error', (error: unknown) => {
          // The client hanging up aborts this read through `controller` — the
          // abort is this shim working as designed, and it arrives here shaped
          // like an upstream failure. Recorded, the thousands of them buried the
          // failures that matter; the signal is what tells the two apart.
          failInBand(error)
        })
        // The upstream can also just stop, without erroring and without having
        // sent `[DONE]`. The error branch above covers the crash; this covers the
        // quiet hang-up, which otherwise leaves the host waiting for a turn that
        // will never be marked finished.
        body.on('end', () => {
          try {
            // The tail is flushed, not assumed: a final event without its
            // terminating newline, and a multi-byte character split across the
            // last two chunks, both surface only here. Without the flush a
            // `[DONE]` that did arrive reads as a stream that ended without
            // one, and the answer gains a second terminator.
            const rest = decoder.decode()
            const events = rest === '' ? sse.finish() : [...sse.push(rest), ...sse.finish()]
            if (events.some(event => event.data === '[DONE]')) sawDone = true
          } catch {
            // A malformed tail is the upstream's problem: the frames already
            // piped stand, and the close below still ends the stream.
          }
          closeWithoutDone()
        })

        /** End the response with `[DONE]` unless the upstream already sent it. */
        function closeWithoutDone(): void {
          if (sawDone || !res.writable) return
          logger?.warn?.(LOG_PREFIX + ': upstream stream ended without [DONE]')
          res.end('data: [DONE]\n\n')
        }
        // Pipe first so the terminal frame reaches the client before we end it.
        body.pipe(res)
        body.on('data', (chunk: Buffer) => {
          try {
            if (!sse.push(decoder.decode(chunk, { stream: true })).some(event => event.data === '[DONE]')) return
            sawDone = true
            body.unpipe(res)
            res.end()
            body.destroy()
          } catch (error: unknown) {
            body.destroy(error instanceof Error ? error : new Error(String(error)))
          }
        })
        return
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
       * next sign-in is tried as well. An `aborted` turn is the client's own
       * doing and stops the loop immediately.
       */
      if (result.kind === 'aborted') break

      if (result.kind !== 'soft_rate' && result.kind !== 'waf_block'
        && result.kind !== 'hard_credit' && result.kind !== 'session_dead'
        && result.kind !== 'transport') break

      exhaustedByRateLimit = true
      if (result.kind === 'soft_rate') {
        // Cool only this model on this account; the account's other models stay
        // usable (the upstream explicitly allows switching to another model).
        // The upstream's own `Retry-After` outranks the body parse, and both
        // outrank the configured window: guessing short meant the account came
        // back into rotation while the limit was still standing.
        //
        // A body reset that has already passed is not an answer, though — it is
        // a stale or clock-skewed timestamp, and taking it over a live header
        // dropped the account onto the 60 s default while the upstream had
        // named a window of minutes.
        const bodyReset = parseRateLimitReset(result.message)
        const resetAtMs = bodyReset !== undefined && bodyReset > Date.now()
          ? bodyReset
          : resetFromRetryAfter(result.retryAfter)
        pool.penalize(account.id, resetAtMs, modelId)
      } else if (result.kind === 'hard_credit' || result.kind === 'session_dead') {
        // A spent account and a dead session do not come back on their own: the
        // credit balance has to change, or the user has to sign in again. The
        // default cooldown window is sized for a limit that expires, and the
        // two-hour cap above it exists to bound a mis-parsed reset, so this
        // hold names itself as one and is held until the next balance read or a
        // manual cooldown reset rather than returning to the head of the queue
        // every minute.
        pool.penalize(account.id, spentAccountHoldUntil(), undefined, true)
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

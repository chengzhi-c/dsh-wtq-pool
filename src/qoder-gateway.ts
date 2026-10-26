/**
 * Qoder loopback gateway.
 *
 * Stands the Qoder path up on a real 127.0.0.1 endpoint with the same routes
 * and the same guards as the Trae gateway.
 *
 * Everything the gateway needs from the outside is injected (credentials,
 * `fetchImpl`), so the whole path can be exercised offline.
 *
 * @module dsh-wtq-pool/qoder-gateway
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLoopbackServer, guardsPass, isJsonContentType, liftUpstreamMessage, listedModels, pumpToResponse, readRequestBody, relayStreamOf, requestPathname, retryAfterHeader, writeJson, writeOpenAIError } from './loopback'
import type { QoderRegion } from './qoder-discovery'
import type { QoderChatModel, QoderClientCredential, QoderUpstreamErrorKind } from './qoder-client'
import { QoderUpstreamClient } from './qoder-client'
import { openQoderResponse, qoderRequestBody } from './qoder-shim'
import { LOG_PREFIX } from './log'

export interface QoderGatewayLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface QoderGatewayOptions {
  region: QoderRegion
  /** Sign-ins found on this machine. `'chat'` is a turn that should advance rotation; every other read must not. */
  credentials(purpose?: 'chat'): Promise<QoderClientCredential[]>
  /** Injected so the whole path runs offline in checks. */
  fetchImpl?: typeof fetch
  /** Preferred loopback port; 0 asks the OS for any free one. */
  port?: number
  logger?: QoderGatewayLogger
  /** Ids this run publishes. Discovery lists these and no others. Absent means the whole directory. */
  listedIds?: () => readonly string[]
  /**
   * Told when one sign-in's attempt failed for a reason that is the sign-in's
   * own, with the wait the upstream named when it named one.
   *
   * The rotation below is per request: it moves the failed sign-in to the back
   * of this attempt list and nothing more. This callback is what lets the
   * host keep it out of the lead on the next request too, which is the half a
   * per-request rotation cannot do — a daily limit otherwise costs one failed
   * round trip on every single request.
   */
  onAttemptFailure?(credential: QoderClientCredential, outcome: { status: number; kind?: QoderUpstreamErrorKind; retryAfter?: string | null }): void
}

export interface QoderGateway {
  ready: Promise<void>
  baseUrl(): string
  port(): number
  /** Models last read from the upstream directory; empty until a refresh. */
  models(): readonly QoderChatModel[]
  close(): Promise<void>
}

const MODELS_TTL_MS = 10 * 60 * 1000
/**
 * How long a failed directory read is not retried.
 *
 * Each attempt walks five upstream functions, each with its own 30s timeout,
 * so a black-holed directory host otherwise stalled every chat request for the
 * length of the whole walk before it could answer 503.
 */
const CATALOG_FAILURE_BACKOFF_MS = 30_000

export function createQoderGateway(options: QoderGatewayOptions): QoderGateway {
  const logger = options.logger
  let cachedModels: readonly QoderChatModel[] = []
  let catalogAt = 0
  let catalogFailedAt = 0
  let catalogErrorText = ''
  let catalogInFlight: Promise<QoderChatModel[]> | undefined

  /**
   * Every sign-in that could read the directory, in the order the chat path
   * would try them.
   *
   * The directory is a per-account read like any other: a sign-in the upstream
   * has revoked answers 401 on it, and reading with the first one only left the
   * whole gateway answering 503 and publishing no provider row while a healthy
   * sign-in sat beside it unused.
   */
  async function directoryCredentials(): Promise<QoderClientCredential[]> {
    const credentials = await options.credentials()
    return credentials.filter(credential => credential.token !== '')
  }

  function clientFor(credential: QoderClientCredential): QoderUpstreamClient {
    return new QoderUpstreamClient({
      region: options.region,
      credential: async () => credential,
      ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    })
  }

  /** Read the directory, at most once per TTL even under concurrent requests. */
  async function models(): Promise<readonly QoderChatModel[]> {
    const fresh = Date.now() - catalogAt < MODELS_TTL_MS
    if (fresh && cachedModels.length > 0) return cachedModels
    if (catalogInFlight !== undefined) return catalogInFlight
    // A read that just failed is not retried on the next request: the cached
    // roster serves in the meantime, and a cold cache fails fast instead of
    // walking five upstream functions again.
    if (catalogFailedAt > 0 && Date.now() - catalogFailedAt < CATALOG_FAILURE_BACKOFF_MS) {
      if (cachedModels.length > 0) return cachedModels
      throw new Error(`Qoder model directory read failed recently, backing off: ${catalogErrorText}`)
    }
    catalogInFlight = (async () => {
      try {
        // Walk the sign-ins until one answers: the directory is a per-account
        // read, and a revoked sign-in fails it the same way it fails a chat.
        const candidates = await directoryCredentials()
        if (candidates.length === 0) throw new Error('no Qoder sign-in found on this machine')
        let lastError: unknown
        for (const credential of candidates) {
          try {
            const read = await clientFor(credential).fetchModels()
            cachedModels = read
            catalogAt = Date.now()
            catalogFailedAt = 0
            return read
          } catch (error: unknown) {
            lastError = error
          }
        }
        throw lastError ?? new Error('no Qoder sign-in could read the model directory')
      } catch (error: unknown) {
        catalogFailedAt = Date.now()
        catalogErrorText = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        catalogInFlight = undefined
      }
    })()
    return catalogInFlight
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    const watcher = new AbortController()
    res.on('close', () => watcher.abort())
    const raw = (await readRequestBody(req)).toString('utf8')
    let model = ''
    try { model = (JSON.parse(raw) as Record<string, unknown>)['model'] as string ?? '' } catch { model = '' }
    if (typeof model !== 'string' || model.trim() === '') {
      writeOpenAIError(res, 400, 'invalid_request_error', 'model is required')
      return
    }
    // Trimmed once, here, so the roster check, the reply and the `X-Model-Key`
    // header all name the same string: Trae's gateway does this, and without it
    // `" glm"` is a 404 here and a success there.
    model = model.trim()

    // The directory is read first so an unknown model fails fast with a 404
    // rather than burning a quota attempt upstream; a fallback to the cached
    // roster keeps a transient directory failure from turning into a refusal.
    let reason = 'Qoder model directory is not available yet'
    let roster = await models().catch((error: unknown) => {
      reason = 'Qoder model directory could not be read: ' + String(error instanceof Error ? error.message : error)
      return cachedModels
    })
    if (watcher.signal.aborted) return
    if (roster.length === 0) roster = cachedModels
    if (roster.length === 0) {
      writeOpenAIError(res, 503, 'upstream_unavailable', reason)
      return
    }
    if (!roster.some(entry => entry.id === model)) {
      writeOpenAIError(res, 404, 'not_found', `model not in the Qoder directory: ${model}`)
      return
    }

    let credentials: QoderClientCredential[]
    try {
      credentials = (await options.credentials('chat')).filter(credential => credential.token !== '')
    } catch (error: unknown) {
      writeOpenAIError(res, 503, 'upstream_unavailable', String(error instanceof Error ? error.message : error))
      return
    }
    if (credentials.length === 0) {
      writeOpenAIError(res, 503, 'upstream_unavailable', 'no Qoder sign-in found on this machine')
      return
    }
    if (watcher.signal.aborted) return
    const directory = roster.find(entry => entry.id === model)
    const call = qoderRequestBody(raw, model, directory)

    /**
     * One sign-in's attempt: the chat call plus the peek that turns a refusal
     * hidden in the stream into a real status.
     *
     * The peek is inside the attempt because a refusal is usually a property of
     * the sign-in (an expired login, a subscription gate), which is exactly
     * what the next sign-in in the ordered list is for.
     */
    const attemptOnce = async (credential: QoderClientCredential): Promise<
      | { ok: true; relayed: Response }
      | { ok: false; status: number; message: string; kind?: QoderUpstreamErrorKind; retryAfter?: string | null }
    > => {
      const result = await clientFor(credential).chatStream(call.body, call.model, {
        ...call.options,
        extraHeaders: {
          'X-Model-Key': model,
          'X-Model-Source': 'system',
        },
        signal: watcher.signal,
      })
      if (!result.ok) return { ok: false, status: result.status, message: result.message, kind: result.kind, retryAfter: result.retryAfter }
      // The relay ends a failed stream in a shape the client can finish on, so
      // the failure never surfaces as a stream error - `onFailure` is what keeps
      // it in the log. A caller hang-up is consumed by the relay's own cancel and
      // never reaches this, which is the half of the contract that matters: one
      // warning per cancelled turn buried everything else.
      let relayed: Response
      try {
        relayed = await openQoderResponse(result.response, model, {
          onFailure: (error: unknown) => {
            logger?.warn?.(LOG_PREFIX + ': qoder relay stream failed mid-flight', error)
            // A sign-in that dies mid-turn has already proved it cannot serve,
            // and the hold below is the only thing that keeps the next request
            // from paying the same round trip on it. A caller hang-up is not the
            // sign-in's doing, so it is excluded on the same term the WorkBuddy
            // relay uses.
            if (!(error instanceof Error && error.name === 'AbortError') && !watcher.signal.aborted) {
              options.onAttemptFailure?.(credential, { status: 0, kind: 'server' })
            }
          },
        })
      } catch (error: unknown) {
        // The connection died while the peek was still reading, before a byte
        // reached the client. Letting it through answered the turn with a
        // plugin-level 500 and never tried the next sign-in; as a transport
        // failure it rotates like any other - but a caller hang-up is not the
        // sign-in's doing. Rotating on it also held the account, so pressing
        // stop in the middle of a slow first byte cooled a healthy sign-in.
        const gone = watcher.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        if (gone) return { ok: false, status: 0, kind: 'aborted', message: 'the caller went away while the answer was being read' }
        return { ok: false, status: 0, kind: 'server', message: `relay read failed: ${String(error instanceof Error ? error.message : error)}` }
      }
      if (relayed.status !== 200) {
        // A failure that arrived before any output: answer it as a real status
        // instead of a stream the client would read as an empty turn.
        const detail = await relayed.text().catch(() => '')
        return { ok: false, status: relayed.status, message: detail, retryAfter: relayed.headers.get('retry-after') }
      }
      return { ok: true, relayed }
    }

    /**
     * Rotate past a failure that belongs to the sign-in rather than to the
     * request: an expired login, a subscription gate, a rate limit. A malformed
     * body or an unknown model fails the same way on every account, so it is
     * answered as-is.
     */
    const rotates = (status: number, kind: QoderUpstreamErrorKind | undefined): boolean => {
      // A caller hang-up is not the sign-in's doing: there is nobody left to
      // answer, and rotating would spend the next account on a dropped request.
      if (kind === 'aborted') return false
      if (status === 0) return true
      return kind === 'authentication' || kind === 'soft_rate' || kind === 'hard_credit'
        || status === 401 || status === 402 || status === 429
    }

    let opened:
      | { ok: true; relayed: Response }
      | { ok: false; status: number; message: string; kind?: QoderUpstreamErrorKind; retryAfter?: string | null }
      | undefined
    for (let index = 0; index < credentials.length; index += 1) {
      if (watcher.signal.aborted) return
      const credential = credentials[index]
      if (credential === undefined) continue
      const attempt = await attemptOnce(credential)
      if (attempt.ok) {
        opened = attempt
        break
      }
      opened = attempt
      if (!rotates(attempt.status, attempt.kind)) break
      // The sign-in's own failure, reported before the next attempt: the host
      // keeps it out of the lead on the requests after this one.
      options.onAttemptFailure?.(credential, {
        status: attempt.status,
        ...attempt.kind === undefined ? {} : { kind: attempt.kind },
        ...attempt.retryAfter === undefined ? {} : { retryAfter: attempt.retryAfter },
      })
      // Only worth a line while there is someone left to rotate to.
      if (index < credentials.length - 1) {
        logger?.warn?.(
          `${LOG_PREFIX}: qoder sign-in failed on ${model} (http ${attempt.status}); rotating`,
        )
      }
    }

    if (opened === undefined || !opened.ok) {
      // The caller hung up mid-rotation: there is no socket left to answer, and
      // writing the 502 would only reach the error sink.
      if (opened !== undefined && opened.kind === 'aborted') return
      const status = opened?.status ?? 502
      const retryAfter = retryAfterHeader(opened?.retryAfter)
      if (retryAfter !== undefined) res.setHeader('Retry-After', retryAfter)
      const lifted = liftUpstreamMessage(opened?.message ?? '')
      writeOpenAIError(
        res,
        // A transport failure reports status 0; `writeHead(0)` throws, and the
        // answer the client gets is a 500 about the status code rather than the
        // refusal it can act on.
        status === 0 ? 502 : status,
        'upstream_error',
        lifted === '' ? 'Qoder refused the request' : lifted,
      )
      return
    }
    const relayed = opened.relayed
    if (relayed.body === null) {
      writeOpenAIError(res, 502, 'upstream_error', 'Qoder returned no stream')
      return
    }
    // The peek can take seconds on a slow first token; a caller who stopped
    // waiting in that window still has a response object that reports writable.
    // Cancel the bridge too: its push loop is parked on this stream's queue and
    // would otherwise keep one timer alive for the rest of the process.
    if (watcher.signal.aborted) {
      void relayStreamOf(relayed).cancel().catch(() => {})
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // Headers before the first token: Node holds them until the first body
    // write, and a queued or thinking upstream otherwise shows the client no
    // response at all until it produces something.
    res.flushHeaders()
    // The bridge's own stream, not the wrapper `Response` puts around it, and
    // pumped directly rather than through `Readable.fromWeb`: both adapters
    // stop delivering a stream this plugin built in the plugin process.
    void pumpToResponse(relayStreamOf(relayed), res).catch((error: unknown) => {
      // Transport-level only: a relay failure arrives through `onFailure`
      // above, so anything reaching here is the socket itself. An `AbortError`
      // is this gateway's own `res.on('close')` reaching the relay - the caller
      // stopped waiting, which is the intended path, not a Qoder failure, and
      // one warning per cancelled turn buried everything worth reading.
      const aborted = watcher.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (!aborted) {
        logger?.warn?.(LOG_PREFIX + ': qoder relay stream failed mid-flight', error)
      }
      if (res.writable) res.end()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guardsPass(req, res)) return
    const url = requestPathname(req.url)
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      const credentials = await options.credentials().catch(() => [])
      writeJson(res, 200, { ok: true, source: 'qoder', credentials: credentials.length, models: cachedModels.length })
      return
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      let served: readonly QoderChatModel[]
      try {
        served = await models()
      } catch (error: unknown) {
        served = cachedModels
        // An empty list is never returned: the host discards a provider whose
        // discovery came back empty, which would strip the whole group. So a
        // directory that cannot be read right now is an honest 503.
        if (served.length === 0) {
          writeOpenAIError(res, 503, 'upstream_unavailable', String(error instanceof Error ? error.message : error))
          return
        }
        logger?.warn?.(LOG_PREFIX + ': qoder directory refresh failed; serving the cached roster')
      }
      const ids = options.listedIds?.()
      const listed = ids === undefined ? served : listedModels(served, ids)
      writeJson(res, 200, {
        object: 'list',
        data: listed.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'qoder' })),
      })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  const server = createLoopbackServer({ port: options.port, label: 'qoder gateway', handle, logger })
  const ready = server.ready

  const port = server.port
  const baseUrl = server.baseUrl

  return {
    ready,
    baseUrl,
    port,
    models: () => cachedModels,
    close: server.close,
  }
}

/**
 * Trae SOLO loopback gateway.
 *
 * Stands the Trae path up on a real 127.0.0.1 endpoint with the same routes
 * and the same guards as the WorkBuddy shim.
 *
 * Everything the gateway needs from the outside is injected (credentials,
 * identity, `fetchImpl`), so the whole path can be exercised offline.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLoopbackServer, guardsPass, isJsonContentType, liftUpstreamMessage, listedModels, pumpToResponse, readRequestBody, relayStreamOf, requestPathname, retryAfterHeader, writeJson, writeOpenAIError } from './loopback'
import type { TraeCredential } from './trae-discovery'
import type { TraeIdentity, TraeReasoningCapability, TraeSoloModel, TraeSoloVariant, TraeUpstreamErrorKind } from './trae-upstream'
import { TraeSoloUpstreamClient, mergeTraeDirectory, traeVariantFor } from './trae-upstream'
import { openTraeResponse, classifyTraeFailure, type TraeFailure } from './trae-shim'
import { LOG_PREFIX } from './log'

export interface TraeGatewayLogger {
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

export interface TraeGatewayOptions {
  /** Sign-ins found on this machine. `'chat'` is a turn that should advance rotation; every other read must not. */
  credentials(purpose?: 'chat'): Promise<TraeCredential[]>
  /** Request identity for the credential being used. */
  identity(credential: TraeCredential): Promise<TraeIdentity>
  /** Injected so the whole path runs offline in checks. */
  fetchImpl?: typeof fetch
  /** Preferred loopback port; 0 asks the OS for any free one. */
  port?: number
  logger?: TraeGatewayLogger
  /** Ids this run publishes. Discovery lists these and no others. Absent means the whole directory. */
  listedIds?: () => readonly string[]
  /**
   * The window this plugin publishes for a model, when the host knows it.
   *
   * Max mode is a second, larger window the upstream serves only on request, and
   * it is billed on the larger tier's terms. It is therefore asked for only when
   * the published declaration really exceeds the model's default window.
   */
  publishedWindowOf?: (modelId: string) => number | undefined
  /**
   * Told when one sign-in's attempt failed for a reason that is the sign-in's
   * own, with the wait the upstream named when it named one.
   *
   * The rotation below is per request: it moves the failed sign-in to the back
   * of this attempt list and nothing more. This callback is what lets the
   * host keep it out of the lead on the next request too, which is the half a
   * per-request rotation cannot do — a spent allowance otherwise costs one
   * failed round trip on every single request.
   */
  onAttemptFailure?(credential: TraeCredential, outcome: { retryAfter?: string | null }): void
}

export interface TraeGateway {
  ready: Promise<void>
  baseUrl(): string
  port(): number
  /** Models last read from the upstream directory; empty until a refresh. */
  models(): readonly TraeSoloModel[]
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

/** Model ids the directory says are callable, with the function that owns each. */
function functionMapOf(models: readonly TraeSoloModel[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const model of models) {
    if (model.function !== undefined && model.function !== '') map.set(model.id, model.function)
  }
  return map
}

/** What reasoning levels each model advertises, keyed by model id. */
function capabilityMapOf(models: readonly TraeSoloModel[]): Map<string, TraeReasoningCapability> {
  const map = new Map<string, TraeReasoningCapability>()
  for (const model of models) {
    // Every listed model is mapped, an empty set when it advertises nothing:
    // "this model offers no levels" and "this model is not in the directory"
    // are different facts, and only the second may let a level through as the
    // client spelled it.
    map.set(model.id, model.reasoning ?? { supported: [] })
  }
  return map
}

/**
 * Whether a failure says this model is not served by the function that was asked.
 *
 * Trae answers `4001` in its own envelope when the chosen function does not know
 * the `config_name`, which is a fact about the function rather than about the
 * request. Every other 4xx is the request's own and is passed through untouched.
 */
function functionGone(status: number, kind: TraeUpstreamErrorKind | undefined, message: string): boolean {
  if (kind === 'not_found') return true
  if (status !== 400) return false
  // Two spellings reach here: the raw envelope when the refusal arrives as an
  // HTTP body, and the prose `code 4001 · upstream: …` the in-stream bridge
  // builds when the same refusal arrives as an SSE error frame. Only the first
  // was recognised, so a stale function that answered in the stream failed the
  // whole turn instead of handing it to another answer.
  return /"code"\s*:\s*"?4001\b/.test(message) || /\bcode 4001\b/.test(message)
}

export function createTraeGateway(options: TraeGatewayOptions): TraeGateway {
  const logger = options.logger

  let cachedModels: readonly TraeSoloModel[] = []
  let catalogAt = 0
  let catalogFailedAt = 0
  let catalogErrorText = ''
  let catalogInFlight: Promise<readonly TraeSoloModel[]> | undefined

  /**
   * Every sign-in that could read the directory, in the order the chat path
   * would try them.
   *
   * The directory is a per-account read like any other: a sign-in the upstream
   * has revoked answers 401 on all five of its functions, and reading with the
   * first one only left the whole gateway answering 503 and publishing no
   * provider row while a healthy sign-in sat beside it unused.
   */
  async function directoryCredentials(): Promise<TraeCredential[]> {
    const credentials = await options.credentials()
    return credentials.filter(credential => credential.accessToken !== '')
  }

  function clientFor(credential: TraeCredential): TraeSoloUpstreamClient {
    return new TraeSoloUpstreamClient({
      credential: async () => credential,
      identity: async () => options.identity(credential),
      ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
    })
  }

  /** Read the directory, at most once per TTL even under concurrent requests. */
  async function models(): Promise<readonly TraeSoloModel[]> {
    const fresh = Date.now() - catalogAt < MODELS_TTL_MS
    if (fresh && cachedModels.length > 0) return cachedModels
    if (catalogInFlight !== undefined) return catalogInFlight
    // A read that just failed is not retried on the next request: the cached
    // roster serves in the meantime, and a cold cache fails fast instead of
    // walking five upstream functions again.
    if (catalogFailedAt > 0 && Date.now() - catalogFailedAt < CATALOG_FAILURE_BACKOFF_MS) {
      if (cachedModels.length > 0) return cachedModels
      throw new Error(`Trae model directory read failed recently, backing off: ${catalogErrorText}`)
    }
    catalogInFlight = (async () => {
      try {
        // Walk the sign-ins until one answers: the directory is a per-account
        // read, and a revoked sign-in fails it the same way it fails a chat.
        const candidates = await directoryCredentials()
        if (candidates.length === 0) throw new Error('no Trae sign-in found on this machine')
        let lastError: unknown
        for (const credential of candidates) {
          try {
            const read = await clientFor(credential).fetchModels()
            // A partial read is merged into what is already known rather than
            // replacing it. The function that failed is one that would have
            // listed models, and the ones only it lists are absent from this
            // answer - keeping them callable is the difference between a
            // degraded roster and a model that answers 404 for a full TTL.
            cachedModels = read.partial ? mergeTraeDirectory(cachedModels, read.models) : read.models
            catalogAt = Date.now()
            catalogFailedAt = 0
            return cachedModels
          } catch (error: unknown) {
            lastError = error
          }
        }
        throw lastError ?? new Error('no Trae sign-in could read the model directory')
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
    model = model.trim()

    // The directory is read first so the request carries the function that
    // actually lists this model; a fallback to the cached roster keeps a
    // transient directory failure from turning into a 4001 upstream.
    const directory = await models().catch(() => cachedModels)
    if (watcher.signal.aborted) return
    let functions = functionMapOf(directory)
    if (functions.size === 0) functions = functionMapOf(cachedModels)
    if (functions.size === 0) {
      writeOpenAIError(res, 503, 'upstream_unavailable',
        catalogErrorText !== '' ? catalogErrorText : 'Trae model directory is not available yet')
      return
    }
    // A model the directory does not list is refused here, on the same terms as
    // Qoder's gateway. Without it any string the caller sends becomes a
    // `config_name` upstream, which answers 4001 with its own error text — a
    // quota attempt spent to learn something the roster already knew.
    if (!directory.some(entry => entry.id === model) && !cachedModels.some(entry => entry.id === model)) {
      writeOpenAIError(res, 404, 'not_found', `model not in the Trae directory: ${model}`)
      return
    }

    // The window the host is holding for this model, and the entry it belongs to,
    // are read before the credential scan below: that scan awaits, and a directory
    // refresh landing during it would leave this request pairing one generation's
    // entry with another generation's published figure.
    const published = options.publishedWindowOf?.(model)
    const entry = directory.find((row) => row.id === model) ?? cachedModels.find((row) => row.id === model)
    const serving = entry === undefined ? undefined : traeVariantFor(entry, published)

    /**
     * Which functions to try for this model, in order.
     *
     * The published answer leads. A partial directory read still carries the answer
     * of a function that has just failed, so the leader can be a function the
     * upstream no longer serves - and then every request for the model fails while
     * an answer that did arrive this time sits unused. The rest of the answers are
     * the fallback, one attempt each, taken only for a refusal that says this model
     * is not there.
     */
    const functionOrder: string[] = []
    const pushFunction = (name: string | undefined): void => {
      if (name !== undefined && name !== '' && !functionOrder.includes(name)) functionOrder.push(name)
    }
    pushFunction(serving?.function ?? functions.get(model))
    // The window in force: what the host published, else the model's own default.
    const target = published ?? entry?.contextWindow
    if (entry !== undefined && target !== undefined) {
      const reach = (row: TraeSoloVariant): number => Math.max(row.contextWindow ?? 0, row.maxContextWindow ?? 0)
      // Answers that can still reach the published window come first, then the
      // ones that cannot: a narrower answer is a worse fit than the leader but a
      // better outcome than refusing the turn outright, and the upstream rejects
      // it on its own if the request really does not fit.
      const answering = [...(entry.variants ?? [])].sort((a, b) => {
        const fits = (row: TraeSoloVariant): number => (reach(row) >= target ? 1 : 0)
        return fits(b) - fits(a) || reach(b) - reach(a) || (b.maxTokens ?? 0) - (a.maxTokens ?? 0)
      })
      for (const row of answering) pushFunction(row.function)
    }

    let credentials: TraeCredential[]
    try {
      credentials = (await options.credentials('chat')).filter(credential => credential.accessToken !== '')
    } catch (error: unknown) {
      writeOpenAIError(res, 503, 'upstream_unavailable', String(error instanceof Error ? error.message : error))
      return
    }
    if (credentials.length === 0) {
      writeOpenAIError(res, 503, 'upstream_unavailable', 'no Trae sign-in found on this machine')
      return
    }
    if (watcher.signal.aborted) return
    const capabilities = capabilityMapOf([...cachedModels, ...directory])

    /**
     * One sign-in's attempt: the chat call plus the peek that turns a refusal
     * hidden in the stream into a real status. The peek is inside the attempt
     * because a refusal is usually a property of the sign-in (an expired login,
     * a subscription gate), which is what the next sign-in is for.
     */
    const attemptOnce = async (credential: TraeCredential, functionName: string | undefined): Promise<
      | { ok: true; relayed: Response }
      | { ok: false; status: number; message: string; kind?: TraeUpstreamErrorKind; retryAfter?: string | null }
    > => {
      // The level the client picked is translated into Trae's own spelling from
      // what this model advertises; a level it does not advertise is left out
      // rather than sent as a spelling SOLO would ignore.
      const result = await clientFor(credential).chatStream(
        raw,
        watcher.signal,
        functionName,
        capabilities.get(model),
        undefined,
        // Max mode is asked for only when the published window is above the tier
        // this function serves: that is the case the host sized its budget for.
        // The window has to be *stated* for that comparison to mean anything: a
        // row that names only an output budget has no default tier to exceed, and
        // reading it as 0 put the Max flag on every request to it.
        published !== undefined && serving !== undefined
          && serving.contextWindow !== undefined && published > serving.contextWindow,
      )
      if (!result.ok) return { ok: false, status: result.status, message: result.message, kind: result.kind, retryAfter: result.retryAfter }
      // A relay failure ends the stream in a shape the client can finish on, so
      // it never surfaces as a stream error - this is what keeps it in the log. A
      // caller hang-up is consumed by the relay's own cancel and never arrives
      // here, which is the half that matters: one warning per cancelled turn
      // buried every failure worth reading.
      let relayed: Response
      try {
        relayed = await openTraeResponse(result.response, model, {
          onFailure: (error: unknown) => {
            logger?.warn?.(LOG_PREFIX + ': trae relay stream failed mid-flight', error)
            // A sign-in that dies mid-turn has already proved it cannot serve,
            // and the hold is the only thing that keeps the next request from
            // paying the same round trip on it. A caller hang-up is not the
            // sign-in's doing, so it is excluded.
            if (!(error instanceof Error && error.name === 'AbortError') && !watcher.signal.aborted) {
              // A refusal that arrived mid-stream still names an account-level
              // condition; reporting every one as `server` lost its kind and the
              // upstream's own wait, so a sign-in that had just expired or hit
              // its daily limit was retried after the default cooldown.
              const failure = (error as { traeFailure?: TraeFailure }).traeFailure
              if (failure !== undefined) {
                const classified = classifyTraeFailure(failure)
                options.onAttemptFailure?.(credential, {
                  ...classified.retryAfterSeconds === undefined ? {} : { retryAfter: String(classified.retryAfterSeconds) },
                })
              } else {
                options.onAttemptFailure?.(credential, {})
              }
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
    const rotates = (status: number, kind: TraeUpstreamErrorKind | undefined): boolean => {
      // A caller hang-up is not the sign-in's doing: there is nobody left to
      // answer, and rotating would spend the next account on a dropped request.
      if (kind === 'aborted') return false
      if (status === 0) return true
      return kind === 'authentication' || kind === 'soft_rate' || kind === 'hard_credit'
        || status === 401 || status === 402 || status === 429
    }

    let opened:
      | { ok: true; relayed: Response }
      | { ok: false; status: number; message: string; kind?: TraeUpstreamErrorKind; retryAfter?: string | null }
      | undefined
    for (let index = 0; index < credentials.length; index += 1) {
      if (watcher.signal.aborted) return
      const credential = credentials[index]
      if (credential === undefined) continue
      let attempt = await attemptOnce(credential, functionOrder[0])
      // A refusal that names this model ("not in the directory / 4001") is about the
      // function chosen, not about the request: another answer may still serve it.
      for (let candidate = 1; candidate < functionOrder.length; candidate += 1) {
        if (attempt.ok) break
        if (!functionGone(attempt.status, attempt.kind, attempt.message)) break
        logger?.warn?.(`${LOG_PREFIX}: ${model} is refused by ${functionOrder[candidate - 1]} (http ${attempt.status}); trying ${functionOrder[candidate]}`)
        attempt = await attemptOnce(credential, functionOrder[candidate])
      }
      if (attempt.ok) {
        opened = attempt
        break
      }
      opened = attempt
      if (!rotates(attempt.status, attempt.kind)) break
      // The sign-in's own failure, reported before the next attempt: the host
      // keeps it out of the lead on the requests after this one.
      options.onAttemptFailure?.(credential, {
        ...attempt.retryAfter === undefined ? {} : { retryAfter: attempt.retryAfter },
      })
      // Only worth a line while there is someone left to rotate to.
      if (index < credentials.length - 1) {
        logger?.warn?.(
          `${LOG_PREFIX}: trae sign-in failed on ${model} (http ${attempt.status}); rotating`,
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
        lifted === '' ? 'Trae SOLO refused the request' : lifted,
      )
      return
    }
    const relayed = opened.relayed
    if (relayed.body === null) {
      writeOpenAIError(res, 502, 'upstream_error', 'Trae SOLO returned no stream')
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
    // Before the first token, not with it: Node holds headers back until the
    // first body write, so a queued or thinking upstream left the client with
    // no response at all for as long as that took.
    res.flushHeaders()
    // Read the bridge's own stream rather than the wrapper `Response` puts
    // around it, and pump it directly rather than through `Readable.fromWeb`:
    // both adapters stop delivering this plugin-built stream after the first
    // chunks in the plugin process, which stalled the turn before a frame
    // reached the client.
    void pumpToResponse(relayStreamOf(relayed), res).catch((error: unknown) => {
      // Transport-level only: a relay failure arrives through `onFailure`
      // above, so anything reaching here is the socket itself. An `AbortError`
      // is this gateway's own `res.on('close')` reaching the relay - the caller
      // stopped waiting, which is the intended path, not a Trae failure, and
      // one warning per cancelled turn buried everything worth reading.
      const aborted = watcher.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (!aborted) {
        logger?.warn?.(LOG_PREFIX + ': trae relay stream failed mid-flight', error)
      }
      if (res.writable) res.end()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guardsPass(req, res)) return
    const url = requestPathname(req.url)
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      const credentials = await options.credentials().catch(() => [])
      writeJson(res, 200, { ok: true, source: 'trae', credentials: credentials.length, models: cachedModels.length })
      return
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      let served: readonly TraeSoloModel[]
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
        logger?.warn?.(LOG_PREFIX + ': trae directory refresh failed; serving the cached roster')
      }
      const ids = options.listedIds?.()
      const listed = ids === undefined ? served : listedModels(served, ids)
      writeJson(res, 200, {
        object: 'list',
        data: listed.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'trae' })),
      })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      await chatCompletions(req, res)
      return
    }
    writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  const server = createLoopbackServer({ port: options.port, label: 'trae gateway', handle, logger })
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

/**
 * Trae SOLO loopback gateway.
 *
 * Stands the Trae path up on a real 127.0.0.1 endpoint with the same routes
 * and the same guards as the WorkBuddy shim.
 *
 * Everything the gateway needs from the outside is injected (credentials,
 * identity, `fetchImpl`), so the whole path can be exercised offline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { answerRequest, guardsPass, isJsonContentType, listedModels, readRequestBody, writeJson, writeOpenAIError } from './loopback'
import type { TraeCredential } from './trae-discovery'
import type { TraeIdentity, TraeReasoningCapability, TraeSoloModel } from './trae-upstream'
import { TraeSoloUpstreamClient } from './trae-upstream'
import { openTraeResponse } from './trae-shim'

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

export function createTraeGateway(options: TraeGatewayOptions): TraeGateway {
  const logger = options.logger

  let cachedModels: readonly TraeSoloModel[] = []
  let catalogAt = 0
  let catalogInFlight: Promise<TraeSoloModel[]> | undefined

  async function firstCredential(purpose?: 'chat'): Promise<TraeCredential> {
    const credentials = await options.credentials(purpose)
    const usable = credentials.find(credential => credential.accessToken !== '')
    if (usable === undefined) throw new Error('no Trae sign-in found on this machine')
    return usable
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
    catalogInFlight = (async () => {
      try {
        const credential = await firstCredential()
        const read = await clientFor(credential).fetchModels()
        cachedModels = read
        catalogAt = Date.now()
        return read
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
      writeOpenAIError(res, 503, 'upstream_unavailable', 'Trae model directory is not available yet')
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

    let credential: TraeCredential
    try {
      credential = await firstCredential('chat')
    } catch (error: unknown) {
      writeOpenAIError(res, 503, 'upstream_unavailable', String(error instanceof Error ? error.message : error))
      return
    }
    if (watcher.signal.aborted) return
    // The level the client picked is translated into Trae's own spelling from
    // what this model advertises; a level it does not advertise is left out
    // rather than sent as a spelling SOLO would ignore.
    const capabilities = capabilityMapOf(directory)
    const result = await clientFor(credential).chatStream(
      raw,
      watcher.signal,
      functions.get(model),
      capabilities.get(model),
    )
    if (!result.ok) {
      if (result.status === 0) {
        writeOpenAIError(res, 502, 'upstream_error', result.message)
        return
      }
      writeOpenAIError(res, result.status, 'upstream_error', result.message)
      return
    }

    // A relay failure ends the stream in a shape the client can finish on, so
    // it never surfaces as a stream error - this is what keeps it in the log. A
    // caller hang-up is consumed by the relay's own cancel and never arrives
    // here, which is the half that matters: one warning per cancelled turn
    // buried every failure worth reading.
    const relayed = await openTraeResponse(result.response, model, {
      onFailure: (error: unknown) => {
        logger?.warn?.('dsh-wtq-pool: trae relay stream failed mid-flight', error)
      },
    })
    if (relayed.status !== 200) {
      // A failure that arrived before any output: answer it as a real status
      // instead of a stream the client would read as an empty turn.
      const detail = await relayed.text().catch(() => '')
      writeOpenAIError(res, relayed.status, 'upstream_error', detail === '' ? 'Trae SOLO refused the request' : detail)
      return
    }
    if (relayed.body === null) {
      writeOpenAIError(res, 502, 'upstream_error', 'Trae SOLO returned no stream')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const body = Readable.fromWeb(relayed.body as Parameters<typeof Readable.fromWeb>[0])
    // Transport-level only: a relay failure arrives through `onFailure` above,
    // so anything reaching here is the socket itself. An `AbortError` is this
    // gateway's own `res.on('close')` reaching the relay - the caller stopped
    // waiting, which is the intended path, not a Trae failure, and one warning
    // per cancelled turn buried everything worth reading. Every other error is
    // logged: the failures that matter arrive after the response headers, where
    // no client-side signal is involved and the old caller-signal gate silenced
    // them entirely.
    body.on('error', (error: unknown) => {
      const aborted = watcher.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (!aborted) {
        logger?.warn?.('dsh-wtq-pool: trae relay stream failed mid-flight', error)
      }
      if (res.writable) res.end()
    })
    body.pipe(res)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guardsPass(req, res)) return
    const url = req.url ?? '/'
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
        logger?.warn?.('dsh-wtq-pool: trae directory refresh failed; serving the cached roster')
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

  const server: Server = createServer((req, res) => {
    void answerRequest(res, () => handle(req, res), logger)
  })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(options.port ?? 0, '127.0.0.1')
  // Registered once, here, rather than per close: stopping a gateway twice is
  // normal, and a listener per call would pile up on a server that is already
  // down. An unhandled 'error' on the server would take the plugin's process
  // with it.
  server.on('error', (error: unknown) => {
    logger?.warn?.('dsh-wtq-pool: trae gateway server error', error)
  })

  const port = (): number => {
    const address = server.address()
    return address === null || typeof address === 'string' ? 0 : address.port
  }
  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('trae gateway has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  return {
    ready,
    baseUrl,
    port,
    models: () => cachedModels,
    close: async () => {
      // A keep-alive socket from an in-flight chat would otherwise keep the
      // listener (and this process at unload) alive until the client gives up.
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

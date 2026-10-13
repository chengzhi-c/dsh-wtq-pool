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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { answerRequest, guardsPass, isJsonContentType, listedModels, readRequestBody, writeJson, writeOpenAIError } from './loopback'
import type { QoderRegion } from './qoder-discovery'
import type { QoderChatModel, QoderClientCredential } from './qoder-client'
import { QoderUpstreamClient } from './qoder-client'
import { openQoderResponse, qoderRequestBody } from './qoder-shim'

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

export function createQoderGateway(options: QoderGatewayOptions): QoderGateway {
  const logger = options.logger
  let cachedModels: readonly QoderChatModel[] = []
  let catalogAt = 0
  let catalogInFlight: Promise<QoderChatModel[]> | undefined

  async function firstCredential(purpose?: 'chat'): Promise<QoderClientCredential> {
    const credentials = await options.credentials(purpose)
    const usable = credentials.find(credential => credential.token !== '')
    if (usable === undefined) throw new Error('no Qoder sign-in found on this machine')
    return usable
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

    let credential: QoderClientCredential
    try {
      credential = await firstCredential('chat')
    } catch (error: unknown) {
      writeOpenAIError(res, 503, 'upstream_unavailable', String(error instanceof Error ? error.message : error))
      return
    }
    if (watcher.signal.aborted) return
    const directory = roster.find(entry => entry.id === model)
    const call = qoderRequestBody(raw, model, directory)
    const result = await clientFor(credential).chatStream(call.body, call.model, {
      ...call.options,
      extraHeaders: {
        'X-Model-Key': model,
        'X-Model-Source': 'system',
      },
      signal: watcher.signal,
    })
    if (!result.ok) {
      if (result.status === 0) {
        writeOpenAIError(res, 502, 'upstream_error', result.message)
        return
      }
      writeOpenAIError(res, result.status, 'upstream_error', result.message)
      return
    }

    // The relay ends a failed stream in a shape the client can finish on, so
    // the failure never surfaces as a stream error - `onFailure` is what keeps
    // it in the log. A caller hang-up is consumed by the relay's own cancel and
    // never reaches this, which is the half of the contract that matters: one
    // warning per cancelled turn buried everything else.
    const relayed = await openQoderResponse(result.response, model, {
      onFailure: (error: unknown) => {
        logger?.warn?.('dsh-wtq-pool: qoder relay stream failed mid-flight', error)
      },
    })
    if (relayed.status !== 200) {
      // A failure that arrived before any output: answer it as a real status
      // instead of a stream the client would read as an empty turn.
      const detail = await relayed.text().catch(() => '')
      const status = relayed.status
      const retryAfter = relayed.headers.get('retry-after')
      if (retryAfter !== null) res.setHeader('Retry-After', retryAfter)
      writeOpenAIError(res, status, 'upstream_error', detail === '' ? 'Qoder refused the request' : detail)
      return
    }
    if (relayed.body === null) {
      writeOpenAIError(res, 502, 'upstream_error', 'Qoder returned no stream')
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
    // waiting, which is the intended path, not a Qoder failure, and one warning
    // per cancelled turn buried everything worth reading. Every other error is
    // logged: the failures that matter arrive after the response headers, where
    // no client-side signal is involved and the old caller-signal gate silenced
    // them entirely.
    body.on('error', (error: unknown) => {
      const aborted = watcher.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      if (!aborted) {
        logger?.warn?.('dsh-wtq-pool: qoder relay stream failed mid-flight', error)
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
        logger?.warn?.('dsh-wtq-pool: qoder directory refresh failed; serving the cached roster')
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
    logger?.warn?.('dsh-wtq-pool: qoder gateway server error', error)
  })

  const port = (): number => {
    const address = server.address()
    return address === null || typeof address === 'string' ? 0 : address.port
  }
  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('qoder gateway has no listening address')
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

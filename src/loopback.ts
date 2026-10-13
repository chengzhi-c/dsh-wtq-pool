/**
 * Loopback endpoint guards, shared by every gateway this plugin serves.
 *
 * Each gateway binds 127.0.0.1 and the host reads its base URL from the
 * manifest before the plugin process starts, so the loopback bind cannot be the
 * only thing bounding it: a browser page on the same machine can reach
 * 127.0.0.1 too. The Host / Origin / bearer checks below are that boundary, and
 * there is exactly one copy of them — WorkBuddy's shim and the Trae gateway
 * both import this module, because two copies of a security check are two
 * chances to drift.
 *
 * @module dsh-wtq-pool/loopback
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the port, and unwrap an IPv6 bracket, so only the host name remains. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host must name loopback; drops DNS-rebinding attempts before routing. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** A present Origin must be loopback; non-browser clients send none and pass. */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Chat POSTs must carry a JSON body type (blocks simple-request CSRF). */
export function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/**
 * Whether a chat request's bearer may reach the gateway.
 *
 * These endpoints are registered with `authKind: 'none'`, so the host sends no
 * `Authorization` header at all or echoes the sentinel
 * `Bearer dsh-no-auth`. A provider row the user added by hand — which is
 * how a reasoning menu can be attached to these models at all, because the
 * host discards `thinkingLevels` from a plugin declaration — is created as
 * `api_key_and_base_url` and therefore always sends `Bearer <its own key>`.
 * Refusing that shape would leave the workaround with a 401.
 *
 * The header is not a credential for this endpoint: the real token comes from
 * the pool. The loopback bind and the Host / Origin guards are what bound it.
 */
export function bearerAccepted(req: IncomingMessage): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return true
  return /^Bearer\s+(.+)$/i.test(header.trim())
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** The error shape every OpenAI-compatible client expects. */
export function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message: redactSecrets(message), type: kind, code: kind } })
}

/**
 * Credential shapes in any text that leaves this process.
 *
 * The log path redacts these in the host entry; this is the client path, which runs
 * before anything reaches a log and so had no redaction at all. An upstream that
 * quotes the request it was sent — Trae's 401 echoes the `Cloud-IDE-JWT` header —
 * put a live token in the response body the caller reads.
 *
 * Both shapes an echo actually takes are covered: the header form, with whatever
 * scheme the vendor uses (`Bearer COSY.…` for Qoder, `Cloud-IDE-JWT …`,
 * `X-Cloudide-Token …` and `X-Ide-Token …` for Trae, `X-Refresh-Token:` for
 * WorkBuddy), and the field form, in the camelCase spelling this plugin itself
 * sends and parses (`accessToken`, `refreshToken`) as well as the snake_case
 * one a query string carries. The three-part JWT needs no key at all: it is
 * recognisable on its own, and the opaque prefixes are Qoder's own.
 *
 * Trae's tokens are opaque, not JWTs, so only the scheme rules cover them -
 * which is why every header name the plugin itself sends is listed there. A
 * space-separated echo of one the list missed printed the whole credential.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // A scheme that carries the credential itself, in either the `Bearer <value>`
  // header form or the `"Cosy-Key":"<value>"` form a quoted JSON echo takes. This
  // runs before the bare-JWT rule below: a JWT replaced first would leave the
  // scheme rule matching the replacement's own text and print a half-redaction.
  // The value is a bounded token run, not `\S+` - the greedy form ate the rest of
  // the line, destroying the fields after it and truncating the body mid-JSON -
  // and the eight-character floor is what keeps a prose word (`invalid Bearer
  // format`) from being taken for a credential.
  [/\b(Bearer|Cosy-Key|Cloud-IDE-JWT|X-Cloudide-Token|X-Ide-Token|X-Refresh-Token|X-Api-Key)\b([\s:="'\\]{1,6})[A-Za-z0-9_+/.=~-]{8,}/gi, '$1$2[redacted]'],
  [/\beyJ[A-Za-z0-9_+/.=-]+(?:\.[A-Za-z0-9_+/.=-]+){0,2}/g, '[redacted token]'],
  [/\b(qoder-oauth-token-)[A-Za-z0-9_+/.=-]+/g, '$1[redacted]'],
  [/\b(rt_)[A-Za-z0-9_+/.=-]+/g, '$1[redacted]'],
  /**
   * A field whose name says it is a credential, and its value.
   *
   * The key and both quotes may carry JSON escaping, because an upstream that
   * quotes the request it was sent nests the credential one escape layer down
   * (`{\"accessToken\":\"…\"}`) — the shape Trae's and Qoder's 401 bodies
   * actually take. The value class carries the base64 punctuation (`+ / =`)
   * and the dot, or a real token would be redacted only up to its first such
   * character and the tail would still reach the client.
   *
   * The value must be at least six characters and carry a letter, which is what
   * keeps this off an upstream business code: `"code":6004` and `code=11115` are
   * the actionable half of an error, and a bare `code` is deliberately not a key
   * here for the same reason (`"code":"soft_rate"` is the classification, not a
   * secret).
   */
  [/((?:\\{0,2}["']?)(?:access_?token|refresh_?token|id_?token|auth_?token|oauth_?token|api_?key|secret|token)(?:\\{0,2}["']?\s*[:=]\s*\\{0,2}["']?))(?=[A-Za-z0-9_+/.=-]{6,})(?=[A-Za-z0-9_+/.=-]*[A-Za-z_-])[A-Za-z0-9_+/.=-]+/gi, '$1[redacted]'],
  [/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '[redacted path]'],
  [/\\\\[^\r\n"'<>|]+/g, '[redacted path]'],
  [/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, '$1[redacted path]$1'],
]

/**
 * Strip credential shapes out of text bound for a client.
 *
 * Applied at the one place every gateway error passes through, so a new caller
 * cannot introduce a second unredacted path.
 */
export function redactSecrets(text: string): string {
  let out = typeof text === 'string' ? text : String(text)
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Models a discovery answer may name.
 *
 * The host rebuilds the picker from `GET /v1/models`, so these ids are the
 * ones the manifest publishes. An empty publication falls back to the
 * directory: an empty discovery answer makes the host drop the provider.
 */
export function listedModels<T extends { id: string }>(directory: readonly T[], listedIds: readonly string[]): readonly T[] {
  if (listedIds.length === 0) return directory
  const allowed = new Set(listedIds)
  const picked = directory.filter(model => allowed.has(model.id))
  return picked.length > 0 ? picked : directory
}

/** The largest chat body a gateway will buffer before refusing the request. */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Raised when a request body passes {@link REQUEST_BODY_LIMIT}. */
class BodyTooLargeError extends Error {}

/**
 * Buffer one request body, refusing anything past {@link REQUEST_BODY_LIMIT}.
 *
 * A body that arrives in pieces is counted as it arrives, so an endless upload
 * is cut off by size rather than by the client finishing it. Live here for the
 * same reason as the guards above: three gateways each reading their own limit
 * is three limits to keep in step.
 *
 * The rejection carries the reason through to the caller so the answer is a
 * 413 the client can act on, not a 500 that reads as a bug in this plugin.
 */
export function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new BodyTooLargeError('request body too large'))
        // Destroyed behind the answer, not in front of it: the socket is what
        // carries the 413 back, so killing it here would leave the client with a
        // reset and no reason for it.
        setImmediate(() => { if (!req.destroyed) req.destroy() })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
/**
 * Answer one request, absorbing everything the handler can throw.
 *
 * A gateway hands work to a socket the other side may hang up on at any
 * moment — the host's own fetch times out, the user cancels a stream, a panel
 * refresh is abandoned. Node reports that as an `error` event on the response,
 * and an `error` event with no listener throws inside the process: in a plugin
 * subprocess that is a dead plugin. So the sink is installed in one place,
 * beside the loopback guards it belongs with, rather than in three gateways.
 */
export async function answerRequest(
  res: ServerResponse,
  handle: () => Promise<void>,
  log?: { warn?(...args: unknown[]): void },
): Promise<void> {
  res.on('error', (error: unknown) => {
    log?.warn?.('dsh-wtq-pool: response socket closed mid-write', error)
  })
  try {
    await handle()
  } catch (error: unknown) {
    // The reason is recorded before the answer is written: a 500 the client can
    // read but the log cannot explain is a bug report nobody can act on.
    log?.warn?.('dsh-wtq-pool: request failed', error)
    try {
      if (!res.headersSent) {
        if (error instanceof BodyTooLargeError) {
          writeOpenAIError(res, 413, 'request_too_large', String(error.message))
          return
        }
        writeOpenAIError(res, 500, 'internal', String(error))
      }
      else res.end()
    } catch (writeError: unknown) {
      log?.warn?.('dsh-wtq-pool: could not answer a failed request', writeError)
    }
  }
}

/**
 * Apply the three request guards, answering the refusal itself.
 *
 * Answers `true` when the request may be routed and `false` once a refusal has
 * been written, so a gateway's `handle` reads as "guarded, then routed". The
 * refusals live here for the same reason the predicates do: three gateways
 * spelling out 403/403/401 is three chances to answer a different status, and
 * the Host and Origin refusals have no caller of their own to test them.
 */
export function guardsPass(req: IncomingMessage, res: ServerResponse): boolean {
  if (!hostIsLoopback(req.headers.host)) {
    writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
    return false
  }
  if (!originIsLoopback(req.headers.origin)) {
    writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
    return false
  }
  if (!bearerAccepted(req)) {
    writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
    return false
  }
  return true
}

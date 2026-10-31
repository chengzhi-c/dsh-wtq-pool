/**
 * Loopback endpoint guards, shared by every gateway this plugin serves.
 *
 * Each gateway binds 127.0.0.1 and the host reads its base URL from the
 * manifest before the plugin process starts, so the loopback bind cannot be the
 * only thing bounding it: a browser page on the same machine can reach
 * 127.0.0.1 too. The Host / Origin / bearer checks below are that boundary, and
 * there is exactly one copy of them — the WorkBuddy shim and the Trae and Qoder
 * gateways all import this module, because two copies of a security check are
 * two chances to drift.
 *
 * The server shell itself lives here too, for the same reason: the boilerplate
 * that binds 127.0.0.1 and tears the listener down was written out three times
 * and had already drifted on the one detail that decides whether teardown
 * finishes at all.
 *
 * `readJsonBody`, `answerRequest`'s `answerFailure` parameter, the optional
 * `res.on?.()` and the exported `BodyTooLargeError` have no caller in the
 * PI-Desktop build: they exist for the DSH web panel, which that build does not
 * ship, and they arrived here because this module is kept byte-identical across
 * the two. If the two ever stop being synced, those four are the first things to
 * delete.
 *
 * @module dsh-wtq-pool/loopback
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { LOG_PREFIX } from './log'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** Strip the port, and unwrap an IPv6 bracket, so only the host name remains. */
function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  // A bare IPv6 literal carries its own colons and no port, so the port-stripping
  // below would otherwise eat everything after the first one and answer with a
  // fragment nothing matches. `::1` is the spelling a hand-written client sends.
  if (hostname.split(':').length > 2) return hostname
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/** Host must name loopback; drops DNS-rebinding attempts before routing. */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * The pathname of a request target.
 *
 * `req.url` keeps the query string and may be an absolute-form proxy target;
 * routing compared it whole, so `?api-version=…` or `GET http://host/v1/…`
 * answered 404 on every route.
 */
export function requestPathname(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '/'
  try {
    return new URL(raw, 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

/** A present Origin must be loopback; non-browser clients send none and pass. */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname)
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // A client that sniffs the body instead of the header can be talked into
    // reading JSON as markup; every other writer here says so.
    'X-Content-Type-Options': 'nosniff',
    // Nothing any of these routes answers is cacheable: a panel document, a
    // model list and an error are all reads of live state.
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * An error's text, redacted and bounded, for anything that leaves the process.
 *
 * One copy for the log path and the client path: two copies of a redaction
 * rule are two chances to drift, and the panel's copy had already drifted from
 * the host entry's on the plain-object case.
 */
export function safeMessage(error: unknown): string {
  const text = error && typeof error === 'object' && 'message' in error && (error as { message?: unknown }).message
    ? String((error as { message: unknown }).message)
    : String(error)
  return redactSecrets(text).slice(0, 500)
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
 * one a query string carries. Qoder's signed headers ride account and machine
 * identity (`Cosy-User`, `Cosy-Machinetoken`, `X-User-Id`), so they are listed
 * too: an echoed request that prints them identifies the account as surely as
 * a token does. The three-part JWT needs no key at all: it is recognisable on
 * its own, and the opaque prefixes are Qoder's own.
 *
 * Trae's tokens are opaque, not JWTs, so only the scheme rules cover them -
 * which is why every header name the plugin itself sends is listed there. A
 * space-separated echo of one the list missed printed the whole credential, and
 * four were missing: `Cosy-Machineid` (the same value `Cosy-Machinetoken`
 * carries) plus `x-machine-id`, `x-device-id` and `x-uid`, the Trae machine,
 * device and account ids. Qoder's identity headers were listed and Trae's were
 * not, which is the drift the sentence above is meant to prevent.
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
  [/\b(Bearer|Cosy-Key|Cosy-Machineid|Cosy-Machinetoken|Cosy-User|Cloud-IDE-JWT|X-Cloudide-Token|X-Ide-Token|X-Refresh-Token|X-Api-Key|X-User-Id|x-device-id|x-machine-id|x-uid)\b([\s:="'\\]{1,6})[A-Za-z0-9_+/.=~-]{8,}/gi, '$1$2[redacted]'],
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
  // An address names an account as surely as its label does, and this text
  // reaches logs and client-facing errors. Mask it before the path rules below.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[account]'],
  [/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '[redacted path]'],
  [/\\\\[^\r\n"'<>|]+/g, '[redacted path]'],
  [/(['"])(\/(?!\/)[^'"\r\n]+)\1/g, '$1[redacted path]$1'],
  // An unquoted POSIX absolute path, for the same reason the Windows rule above
  // needs no quotes. It is deliberately narrower than "anything with a slash in
  // it": the extension is required, and a segment may carry spaces but not start
  // with one, so `POST /v1/chat/completions returned 4001` and `and/or` survive
  // intact - that is the actionable half of an error and destroying it would
  // trade a path disclosure for an undiagnosable one. A dot-directory with no
  // extension anywhere (`/root/.trae-cn/trae-jwt-token`) is not matched; the
  // identity readers never print those paths in the first place.
  [/(?<![\w./])\/(?:[\w.@-]+(?: [\w.@-]+)*\/)+[\w.@-]+(?: [\w.@-]+)*\.[A-Za-z][\w]*/g, '[redacted path]'],
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
 * The vendor's channel check, answered as what it is.
 *
 * WorkBuddy's upstream inspects the system and assistant turns for wording that
 * belongs to a client it does not serve, and answers business code 11128. The
 * plugin already moves the system prompt into the first user turn and retries
 * once (`chatStream`); a second refusal means the blocked wording is somewhere
 * that move does not reach, or the host changed its screen again. Every account
 * of that region answers the same way, so rotation cannot clear it, and the
 * vendor body is a wall of mixed Chinese and English tips that names no cause a
 * user can act on. The sentence below says what happened and what does work.
 */
export function unapprovedChannelRefusal(text: string): string | undefined {
  if (!/"code"\s*:\s*"?11128\b/u.test(text) && !/\bcode 11128\b/u.test(text)) return undefined
  return channelCheckRefusal()
}

/** The sentence a refused prompt is answered with, whatever shape the body has. */
export function channelCheckRefusal(): string {
  return (
    'the WorkBuddy host refused this conversation at its client check (11128). That ' +
    'screen reads system and assistant turns for wording that belongs to a client it ' +
    'does not serve, so remove client-identifying text from the conversation, start a ' +
    'new one, or use Trae or Qoder for this prompt.'
  )
}

/**
 * The `finish_reason` one turn is reported with.
 *
 * A turn that emitted tool calls says `tool_calls`, because that is what an
 * OpenAI client looks for before it acts on them. It must not say that *over*
 * what the upstream reported: `length` and `content_filter` describe how the
 * turn ended, and a tool call cut off by the output budget is exactly the case
 * where acting on its arguments spends a request on half a JSON body. So only
 * the verdict that carries nothing of its own - `stop`, or nothing at all - is
 * replaced.
 */
export function openAIFinishReason(upstream: string | undefined, sawToolCalls: boolean): string {
  const stated = upstream === undefined || upstream === '' || upstream === 'null' ? undefined : upstream
  if (stated !== undefined && stated !== 'stop') return stated
  return sawToolCalls ? 'tool_calls' : 'stop'
}

/**
 * Models a discovery answer may name.
 *
 * The host rebuilds the picker from `GET /v1/models`, so these ids are the
 * ones the manifest publishes. An empty publication falls back to the
 * directory: an empty discovery answer makes the host drop the provider. A
 * publication that names only ids the roster no longer carries falls back the
 * same way, because that is a roster that moved since the declaration was
 * written; the next declaration rebuild re-applies the selection, and an empty
 * answer in the meantime would cost the user the provider row itself.
 */
export function listedModels<T extends { id: string }>(directory: readonly T[], listedIds: readonly string[]): readonly T[] {
  if (listedIds.length === 0) return directory
  const allowed = new Set(listedIds)
  const picked = directory.filter(model => allowed.has(model.id))
  return picked.length > 0 ? picked : directory
}

/**
 * Lift the message out of an upstream error envelope.
 *
 * The Trae and Qoder gateways relay the upstream's own JSON error document as
 * the message of their OpenAI-shaped error, which double-wraps it: the client
 * then reads a serialized document where a sentence should be. Parsed here,
 * once, so every gateway answers in the upstream's own words; redacted,
 * because that document is exactly where an echoed credential would ride.
 */
export function liftUpstreamMessage(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // A body that is not JSON is relayed as it came, which is what makes a
    // plain-text refusal readable - but it is still upstream text on its way to
    // a client, so it is redacted like every parsed branch below.
    return redactSecrets(text)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return redactSecrets(text)
  const record = parsed as Record<string, unknown>
  const error = record['error']
  if (typeof error === 'string' && error.trim() !== '') return redactSecrets(error)
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>)['message']
    if (typeof message === 'string' && message.trim() !== '') return redactSecrets(message)
  }
  if (typeof record['message'] === 'string' && record['message'].trim() !== '') {
    return redactSecrets(record['message'])
  }
  // A document that carried no sentence lifts to nothing, so the caller's own
  // fallback answers instead of relaying `{}` or a page of HTML as the message.
  return ''
}

/** Longest wait a client is told to honour, in seconds. */
const RETRY_AFTER_CEILING_SECONDS = 2 * 60 * 60

/**
 * One wait time in whole seconds, bounded, or nothing when it is not a wait.
 *
 * A client that honours a `Retry-After` stops asking for that long, so one
 * malformed value must not be able to park an account for years. Both readers
 * of the header come through here rather than each carrying its own ceiling.
 */
export function boundedRetryAfterSeconds(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(Math.ceil(seconds), RETRY_AFTER_CEILING_SECONDS)
}

/**
 * A `Retry-After` worth sending, or nothing.
 *
 * The upstream's own wait time, bounded and validated. An empty string, prose
 * or a number of years is dropped rather than forwarded.
 */
export function retryAfterHeader(value: unknown): string | undefined {
  const seconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  const bounded = boundedRetryAfterSeconds(seconds)
  return bounded === undefined ? undefined : String(bounded)
}

/** The largest chat body a gateway will buffer before refusing the request. */
const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/**
 * How long an oversized upload may take to finish before the socket is closed
 * anyway. Node's own request timeout still bounds a client that never ends.
 */
const BODY_DRAIN_GRACE_MS = 10_000

/** Raised when a request body passes the `limitBytes` bound it was read with. */
export class BodyTooLargeError extends Error {}

/**
 * Buffer one request body, refusing anything past the `limitBytes` bound it is
 * given, which defaults to {@link REQUEST_BODY_LIMIT}.
 *
 * A body that arrives in pieces is counted as it arrives, so an endless upload
 * is cut off by size rather than by the client finishing it. Live here for the
 * same reason as the guards above: three gateways each reading their own limit
 * is three limits to keep in step.
 *
 * The rejection carries the reason through to the caller so the answer is a
 * 413 the client can act on, not a 500 that reads as a bug in this plugin.
 */
export function readRequestBody(req: IncomingMessage, limitBytes: number = REQUEST_BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    // A client that names a body past the limit is refused before the first
    // byte is read. Waiting for the bytes to arrive held the request for as
    // long as the client chose to send them - a declared 100 MiB with nothing
    // behind it hung until Node's own request timeout.
    const declared = Number(req.headers?.['content-length'])
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new BodyTooLargeError('request body too large'))
      // Armed before the listeners that clear it: a request that ends on its
      // own must not leave the timer holding the closure for the full grace.
      const grace = setTimeout(() => { if (!req.destroyed) req.destroy() }, BODY_DRAIN_GRACE_MS)
      grace.unref()
      const done = (): void => { clearTimeout(grace); if (!req.destroyed) req.destroy() }
      req.on('end', done)
      req.on('error', done)
      return
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        // Once: the rest of the upload keeps arriving chunk by chunk, and
        // re-running this branch attached a fresh pair of listeners per chunk.
        if (!refused) {
          refused = true
          reject(new BodyTooLargeError('request body too large'))
          // Drained, not destroyed: with a large upload mid-stream the OS answers
          // a destroy with RST, and the 413 the caller is about to write is
          // discarded with the socket. Letting the body finish (or the grace
          // timer below fire for a client that never ends) closes cleanly.
          const grace = setTimeout(() => { if (!req.destroyed) req.destroy() }, BODY_DRAIN_GRACE_MS)
          grace.unref()
          const done = (): void => { clearTimeout(grace); if (!req.destroyed) req.destroy() }
          req.on('end', done)
          req.on('error', done)
        }
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
  handle: () => void | Promise<void>,
  log?: { warn?(...args: unknown[]): void },
  /** How a caught failure is answered; the default is the OpenAI error shape. */
  answerFailure?: (res: ServerResponse, error: unknown) => void,
): Promise<void> {
  // The optional call is deliberate: the panel contract test answers through a
  // response object that implements only the write half, and a real
  // ServerResponse always carries `on`.
  res.on?.('error', (error: unknown) => {
    log?.warn?.(LOG_PREFIX + ': response socket closed mid-write', error)
  })
  try {
    await handle()
  } catch (error: unknown) {
    // The reason is recorded before the answer is written: a 500 the client can
    // read but the log cannot explain is a bug report nobody can act on.
    log?.warn?.(LOG_PREFIX + ': request failed', error)
    const answer = answerFailure ?? ((target: ServerResponse, caught: unknown): void => {
      if (caught instanceof BodyTooLargeError) {
        writeOpenAIError(target, 413, 'request_too_large', String(caught.message))
      } else {
        writeOpenAIError(target, 500, 'internal', String(caught))
      }
    })
    try {
      if (!res.headersSent) answer(res, error)
      else res.end()
    } catch (writeError: unknown) {
      log?.warn?.(LOG_PREFIX + ': could not answer a failed request', writeError)
    }
  }
}

/**
 * Read a bounded JSON body; an empty or malformed body reads as `{}`.
 *
 * The bound and the drain grace come from {@link readRequestBody}'s, because a
 * panel POST is a request like any other and a second size policy is a second
 * policy to keep in step. The parse is lenient on purpose: a panel call that
 * carries no body is a read, not a malformed write.
 *
 * The limit is a parameter rather than a constant because the panel's requests
 * are a channel name and a handful of settings, and it accepts a thousand times
 * less than a chat body does.
 */
export async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number = REQUEST_BODY_LIMIT,
): Promise<Record<string, unknown>> {
  const raw = (await readRequestBody(req, limitBytes)).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * How far a relay reads ahead before giving up on finding a failure.
 *
 * The peek has to see far enough to catch a refusal that arrives after the
 * first content bytes, and stop soon enough that a healthy stream is not held
 * back. Both vendors use the same bound: a peek that stops earlier answers a
 * failure as a truncated success, and one that reads further delays every turn.
 */
export const PEEK_MAX_CHUNKS = 64

/**
 * The byte ceiling on the same peek, counted as the chunks arrive.
 *
 * The chunk count alone bounds a vendor that answers in many small pieces; this
 * one bounds a vendor that puts a whole refusal in a single large chunk, which
 * is the other way to hold a healthy stream back.
 */
export const PEEK_MAX_BYTES = 262_144

/**
 * The relay stream a `Response` was built from.
 *
 * `Response` wraps the stream it is given in another `ReadableStream`, and in
 * the plugin process that wrapper stops delivering to its reader after the
 * first chunks: the caller holds a 200 whose body never arrives. The bridges
 * hand their stream over under this key as well, and the gateways pump that one
 * directly. Nothing that reads `response.body` is affected.
 */
export const RELAY_STREAM = Symbol.for('wtq-pool.relay-stream')

/** Attach the unwrapped relay stream to a response built around it. */
export function withRelayStream<T extends Response>(response: T, stream: ReadableStream<Uint8Array>): T {
  Object.defineProperty(response, RELAY_STREAM, { value: stream, enumerable: false })
  return response
}

/** The stream to relay: the attached one when present, else the response body. */
export function relayStreamOf(response: Response): ReadableStream<Uint8Array> {
  const attached = (response as unknown as Record<symbol, ReadableStream<Uint8Array> | undefined>)[RELAY_STREAM]
  if (attached !== undefined) return attached
  if (response.body === null) throw new Error('response carries no body')
  return response.body as ReadableStream<Uint8Array>
}

/**
 * Write one relayed chunk, waiting while the client's socket is full.
 *
 * A relay that ignores the false return of `res.write` keeps reading the
 * upstream at full speed and parks the whole answer inside the plugin process,
 * competing with the gateways and the panel for one event loop.
 */
export async function writeChunk(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.destroyed || res.writableEnded) return
  if (res.write(Buffer.from(chunk))) return
  if (res.destroyed) return
  await new Promise<void>((resolve) => {
    const wake = (): void => {
      res.off('drain', wake)
      res.off('close', wake)
      resolve()
    }
    res.once('drain', wake)
    res.once('close', wake)
  })
}

/**
 * Relay one web stream to a Node response, honouring backpressure.
 *
 * Written out rather than `Readable.fromWeb` + `pipe`: that adapter stops
 * delivering a stream this plugin built itself, so the client held a 200 whose
 * body never arrived. Ends the response once the source ends; a read or write
 * failure is the caller's to classify.
 */
export async function pumpToResponse(source: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = source.getReader()
  const releaseLock = (): void => {
    try { reader.releaseLock() } catch { /* already released by a broken source */ }
  }
  // A client that hung up during the peek leaves a response that is destroyed
  // but still reports `writable`; writing then parks forever because neither
  // drain nor close will fire again.
  if (res.destroyed || res.writableEnded) {
    await reader.cancel().catch(() => {})
    releaseLock()
    return
  }
  const cancel = (): void => { void reader.cancel().catch(() => {}) }
  res.once('close', cancel)
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      // A close can land between the read and the write; writing a destroyed
      // response raises ERR_STREAM_DESTROYED and reads as a mid-write failure.
      await writeChunk(res, next.value)
      if (res.destroyed || res.writableEnded) break
    }
  } finally {
    res.off('close', cancel)
    releaseLock()
  }
  if (res.writable && !res.destroyed) res.end()
}

/** The part of a reader the replay needs, so a peek can queue its last read. */
export type ReplayReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value: Uint8Array | undefined }

export interface ReplayReader {
  read(): Promise<ReplayReadResult>
  cancel(reason?: unknown): Promise<void>
}

/**
 * Replay the bytes a peek consumed, then drain the rest of the upstream.
 *
 * The relay hands the client a stream it already read the head of, so the bytes
 * that were buffered while looking for a failure have to be put back in front of
 * the reader's remainder. Cancelling has to reach the upstream reader: a caller
 * that hangs up otherwise leaves the upstream socket open until it ends on its
 * own, which for a long turn is the whole conversation.
 */
export function replaySource(
  buffered: readonly Uint8Array[],
  reader: ReplayReader,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const bytes = buffered[index]
      if (bytes !== undefined) {
        index += 1
        controller.enqueue(bytes)
        return
      }
      if (ended) {
        controller.close()
        return
      }
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}) },
  })
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
  // A cross-site GET (an <img> probe) carries no Origin, so the checks above
  // let it through to routes that start account or directory reads. Browsers
  // label it here; a native client sends no such header and is unaffected.
  // `same-site` is another loopback port (ports are not part of the site), which
  // a local client may legitimately use; only a remote page is `cross-site`.
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    writeOpenAIError(res, 403, 'origin_not_allowed', 'cross-site request to a loopback gateway')
    return false
  }
  if (!bearerAccepted(req)) {
    writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
    return false
  }
  return true
}

/**
 * One loopback HTTP server, bound and torn down the same way everywhere.
 *
 * The WorkBuddy shim and the Trae and Qoder gateways each wrote out their own
 * `createServer` / `listen` / `close` block. One copy here is what stops the next
 * gateway writing a fourth, and `handle` is the only hook: everything else a
 * gateway varies — its port, the name its errors carry — is data, so there is
 * nothing left to get subtly wrong.
 *
 * Teardown makes two calls, and their ORDER is the whole point:
 *
 * - `closeAllConnections()` first aborts the turns that are still in flight.
 * - `server.close()` then stops listening and waits for its connections to end.
 *   They end at once, because they were just destroyed.
 *
 * Reversed, `close()` waits for a chat that is mid-stream to finish on its own,
 * and the abort that would have ended it sits behind the wait, so it never runs:
 * teardown blocks on the upstream instead of on the user, and the plugin process
 * stays alive with it. That is the order the shim had.
 *
 * The idle case hides all of this. A client that finished a turn holds an idle
 * keep-alive socket, and `close()` drops those itself, so with nothing in flight
 * every ordering resolves and the difference is invisible. Only a turn that is
 * still streaming makes it show, which is the fixture the teardown test uses.
 */
export function createLoopbackServer(options: {
  /** Preferred port, tried at listen time; 0 asks the OS for any free one. */
  port?: number
  /** Names this endpoint in its own errors and its server-error log. */
  label: string
  /** One request, routed; a throw is answered by {@link answerRequest}. */
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  /** Where a failed request is recorded, if anywhere. */
  logger?: { warn?(...args: unknown[]): void }
}): {
  ready: Promise<void>
  port(): number
  baseUrl(): string
  close(): Promise<void>
} {
  const server = createServer((req, res) => {
    void answerRequest(res, () => options.handle(req, res), options.logger)
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
    options.logger?.warn?.(LOG_PREFIX + ': ' + options.label + ' server error', safeMessage(error))
  })
  return {
    ready,
    /** The bound port, or 0 before `listening` (or after close). */
    port: () => {
      const address = server.address()
      return address === null || typeof address === 'string' ? 0 : address.port
    },
    baseUrl: () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        throw new Error(options.label + ' has no listening address')
      }
      return `http://127.0.0.1:${address.port}`
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * Qoder response frame decoding.
 *
 * Turns one gateway response into frames the Qoder gateway can act on. Pure
 * text handling — no network, no disk, no credentials.
 */
/** What one decoded frame means. */
export type QoderFrame =
  | { type: 'chunk'; chunk: Record<string, unknown> }
  | { type: 'failure'; code: string; detail: string; signals: string; retryAfterSeconds: number }
  | { type: 'unknown'; reason: 'unparseable' | 'unnamed'; data: unknown }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return isPlainObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a code is the success-range acknowledgement Qoder sends for a
 * container it accepted. `{"code":0}` and `{"code":200}` are how it acks.
 *
 * Exported because the check-in parser asks the same question: it treated any
 * non-zero code as a refusal, so a claim acknowledged with `{"code":200}`
 * reached the panel as "the upstream refused it". One answer to one question.
 */
export function isAcknowledgementCode(value: unknown): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false
  if (typeof value === 'string' && value.length === 0) return false
  const code = Number(value)
  return Number.isFinite(code) && (code === 0 || (code >= 200 && code < 300))
}

/**
 * The code and message a failure frame really carries, however deeply they are
 * wrapped. The walk follows `details`/`error`, or a `message` string that is
 * itself a JSON document, up to 8 levels — bounded so a self-referential
 * payload cannot spin. When it bottoms out on an object (the queue descriptor),
 * that object is far more useful than the string that carried it.
 */
export function unwrapFailure(frame: unknown): { code: string; detail: string; signals: string } {
  let code = ''
  let detail = ''
  const signals: string[] = []
  let node: unknown = frame
  let descended = false
  let codeFromPlainKey = false
  let codeFromErrorSpelling = false
  // Whether the current node was reached by walking into a container
  // (`details`/`error`) rather than by parsing a `message` string. A plain
  // `code` inside a container is the upstream's acknowledgement of that
  // container, not a new business code, so it must not replace one already read
  // from the envelope; a `code` inside a message string is the real refusal the
  // envelope wrapped, so it may.
  let arrivedViaContainer = false
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node)) break
    const errorSpelling = node['errorCode'] ?? node['errcode']
    const levelCode = errorSpelling ?? node['code']
    // Both spellings occur: a quoted `"10605"` and a bare JSON number.
    // Normalising the number keeps it usable for exact matching downstream.
    //
    // A code spelled `errorCode`/`errcode` is the upstream's own business code
    // and is not replaced by a plain `code` found deeper in the walk: the
    // nested object is a container the upstream acknowledged in its own terms,
    // and its `{"code":0}` used to blank the outer code, which turned a
    // classifiable refusal into an unnamed one the gateway answered 502 for.
    // The same rule covers a plain code already read from the envelope, but only
    // for an acknowledgement: `{"code":10605,"details":{"code":0}}` is one
    // refusal and the nested `0` only acks the container, while
    // `{"code":0,"details":{"code":10605}}` carries the refusal in the container
    // and keeps its 10605.
    const acknowledgement = arrivedViaContainer && codeFromPlainKey && isAcknowledgementCode(levelCode)
    if (errorSpelling !== undefined || (!codeFromErrorSpelling && !acknowledgement)) {
      if (typeof levelCode === 'string' && levelCode.length > 0) {
        code = levelCode
        codeFromPlainKey = errorSpelling === undefined
        codeFromErrorSpelling = errorSpelling !== undefined
      } else if (typeof levelCode === 'number' && Number.isFinite(levelCode)) {
        code = String(levelCode)
        codeFromPlainKey = errorSpelling === undefined
        codeFromErrorSpelling = errorSpelling !== undefined
      }
    }
    // Outer text wins unless it is only a JSON wrapper. The envelope carries
    // the vendor's own sentence ("Login expired"); a nested container usually
    // adds request ids, and letting its `message` overwrite the outer one
    // erased the only words the failure classifier can act on.
    //
    // The walked-away text is still collected in `signals`: when the outer
    // sentence is generic and the nested one names the cause, the classifier
    // needs the nested one even though the card should show the outer one.
    const message = node['message'] ?? node['errorMessage']
    if (typeof message === 'string' && message.trim() !== '' && !signals.includes(message)) signals.push(message)
    if ((detail === '' || tryJsonObject(detail) !== undefined)
      && typeof message === 'string' && message.length > 0) detail = message
    // A container that arrived as a bare string is the message. Qoder spells a
    // refusal `{"choices":[],"error":"Login expired"}` as often as it spells one
    // with a code, and reading only the object form dropped those frames as
    // unnamed, which answered the client with an empty turn.
    const flat = typeof node['error'] === 'string' ? node['error']
      : typeof node['details'] === 'string' ? node['details']
        : undefined
    if (flat !== undefined && flat.trim() !== '' && !signals.includes(flat)) signals.push(flat)
    if (detail === '' && flat !== undefined && flat.length > 0) detail = flat
    const nested = isPlainObject(node['details']) ? node['details'] : isPlainObject(node['error']) ? node['error'] : undefined
    const next = nested ?? (typeof message === 'string' ? tryJsonObject(message) : undefined)
    if (next === undefined) break
    node = next
    arrivedViaContainer = nested !== undefined
    descended = true
  }
  // The walked-into object is a better description than the string that led
  // to it only when no message was found on the way down. Replacing a message
  // that is already there throws away the one line the user can act on: a
  // "Login expired" frame carrying a `details` object came back as
  // `{"reqId":1}`, and because that text no longer said what happened, the
  // sign-in-expired branch downstream stopped matching and the turn answered
  // 502 instead of 401 - so the client never re-prompted for a login.
  if (descended && detail === '' && isPlainObject(node)) {
    detail = JSON.stringify(node)
  }
  // A success-range code under the plain `code` key is an acknowledgement, not
  // a refusal, whether or not it carries words: `{"code":0}` is how Qoder acks,
  // and reading it as a failure answered a healthy turn with a 502. The error
  // spellings carry business codes in that range, so they keep what they say.
  //
  // `detail` goes with the code. Clearing one and keeping the other was the
  // same failure in a new shape: `{"code":0,"message":"success"}` lost its code
  // here, still carried "success" as its detail, and the decoder's
  // `code === '' && detail === ''` test then read the frame as a refusal - a
  // healthy turn answered 502 with the word "success", or content truncated
  // mid-stream when the ack arrived between two chunks.
  if (codeFromPlainKey && isAcknowledgementCode(code)) {
    code = ''
    detail = ''
  }
  return { code, detail, signals: signals.join('\n') }
}

/**
 * The gateway's retry hint, when the frame carries one.
 *
 * A carried `0` is the decoder's "no hint" placeholder, not a real wait. The
 * hint may sit on the envelope, in a nested container, or inside a message that
 * is itself a JSON document; the walk reads all three so a queue descriptor is
 * not lost when the outer sentence is the one worth showing.
 */
export function retryAfterSecondsOf(frame: unknown): number {
  const seen = new Set<object>()
  let node: unknown = frame
  for (let depth = 0; depth < 8; depth++) {
    if (!isPlainObject(node) || seen.has(node)) break
    seen.add(node)
    const direct = node['retryAfterSeconds']
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
    const message = node['message'] ?? node['errorMessage']
    const nested = isPlainObject(node['details']) ? node['details'] : isPlainObject(node['error']) ? node['error'] : undefined
    const next = nested ?? (typeof message === 'string' ? tryJsonObject(message) : undefined)
    if (next === undefined) break
    node = next
  }
  return 0
}

/**
 * The layer holding the frame's content, and the envelope it came in.
 *
 * A `body` wrapper is Qoder's own envelope: the frame's content sits one level
 * down, and so does its refusal. Reading only the inner object dropped an
 * envelope's `errorCode`/`code` - `{"body":{"choices":[]},"code":401,"message":
 * "Login expired"}` reached the decoder as a nameless inner object, so the turn
 * answered 200 with an empty stream and never rotated to the next account,
 * leaving the user without the re-login prompt that a 401 produces. Both are
 * returned so a refusal found in either one is honoured.
 *
 * `envelope` is undefined when the payload has no wrapper, so the caller can
 * tell "no outer layer" from "an outer layer with nothing to say".
 */
function qoderFrameParts(
  payload: string,
): { envelope: Record<string, unknown> | undefined; content: Record<string, unknown> } | undefined {
  const outer = tryJsonObject(payload)
  if (outer === undefined) return undefined
  const body = outer['body']
  const inner = typeof body === 'string' ? tryJsonObject(body) : isPlainObject(body) ? body : undefined
  return inner === undefined ? { envelope: undefined, content: outer } : { envelope: outer, content: inner }
}

/**
 * Classify one data payload. A token-accounting frame carries `choices: []`
 * with a top-level `usage`; it must be forwarded as a chunk, not read as a
 * failure. Anything with neither output nor a name — a bare `{ success: true }`
 * keepalive, or a payload whose shape moved — is reported as unknown rather
 * than guessed at. A frame that carries an empty `choices` and no usage is a
 * failure frame wearing a chunk's clothes: the upstream reports refusals that
 * way, and forwarding it as a chunk answered the client with an empty turn.
 */
export function decodeQoderFrame(payload: string): QoderFrame {
  const parts = qoderFrameParts(payload)
  if (parts === undefined) return { type: 'unknown', reason: 'unparseable', data: payload }
  const { envelope, content } = parts
  const choices = content['choices']
  const hasOutput = Array.isArray(choices) && choices.length > 0
  const hasUsage = content['usage'] !== undefined && content['usage'] !== null
  if (hasOutput || hasUsage) {
    // A refusal wrapped around real output still counts: a final frame carrying
    // both a finish reason and a daily-limit code was forwarded as a chunk, so
    // the refusal vanished and the request never rotated to another account.
    // Only the envelope is read here, because a refusal inside the content would
    // be part of the answer itself.
    if (envelope !== undefined) {
      const outer = unwrapFailure(envelope)
      if (outer.code !== '' || outer.detail !== '') {
        return {
          type: 'failure',
          code: outer.code,
          detail: outer.detail,
          signals: outer.signals,
          retryAfterSeconds: retryAfterSecondsOf(envelope),
        }
      }
    }
    return { type: 'chunk', chunk: content }
  }
  // Decide on what the walk actually found rather than on top-level fields
  // alone: a frame whose only code sits under `error`/`details`, or inside a
  // JSON document in `message`, would otherwise read as an unnamed frame and
  // be dropped — presenting the user with an empty turn.
  //
  // The envelope is read first: a `body` wrapper keeps its refusal there, and
  // reading only the inner object turned a 401 into an empty 200 turn.
  for (const layer of envelope === undefined ? [content] : [envelope, content]) {
    const { code, detail, signals } = unwrapFailure(layer)
    if (code === '' && detail === '') continue
    return { type: 'failure', code, detail, signals, retryAfterSeconds: retryAfterSecondsOf(layer) }
  }
  return { type: 'unknown', reason: 'unnamed', data: content }
}

/**
 * One unterminated line may not grow without bound; chat deltas are small.
 * The ceiling is a memory guard on the upstream's answer, which no request-body
 * limit bounds: a frame this size is a stream gone wrong, not a chat delta.
 */
const MAX_LINE_CHARS = 64 * 1024 * 1024

/**
 * Incremental reader for the Qoder wire form: one JSON payload per `data:`
 * line. Qoder sends no `event:`/`id:`/`retry` fields, so this stays a plain
 * line reader instead of duplicating a full SSE event parser.
 */
export class QoderFrameDecoder {
  private buffer = ''
  private done = false

  /** Whether the wire has supplied its terminal marker, independent of TCP EOF. */
  get ended(): boolean { return this.done }
  /** Payloads seen so far; `[DONE]` ends the stream and yields nothing. */
  push(chunk: string): string[] {
    if (this.done) return []
    this.buffer += chunk
    const payloads: string[] = []
    // The SSE line separators, the lone `\r` included: a stream that ends its
    // lines with a bare carriage return is a legal one, and reading only `\n`
    // buffered the whole stream until the line guard threw. A `\r` at the very
    // end of the buffer is held back, because the `\n` that pairs with it may
    // still be in the next chunk.
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer)
      if (match === null || match.index === undefined) break
      if (match[0] === '\r' && match.index + 1 === this.buffer.length) break
      const line = this.buffer.slice(0, match.index).trim()
      this.buffer = this.buffer.slice(match.index + match[0].length)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload.length === 0) continue
      if (payload === '[DONE]') { this.done = true; return payloads }
      payloads.push(payload)
    }
    // What is left has no newline in it, so nothing will ever reduce it: a
    // stream that keeps sending bytes without ending a line is a stream this
    // reader must stop buffering.
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = ''
      throw new Error('sse line exceeded ' + MAX_LINE_CHARS + ' characters without a newline')
    }
    return payloads
  }

  /** Flush a final payload the upstream left without a trailing newline. */
  finish(): string[] {
    if (this.done) return []
    this.done = true
    const line = this.buffer.trim()
    this.buffer = ''
    if (!line.startsWith('data:')) return []
    const payload = line.slice(5).trim()
    return payload.length === 0 || payload === '[DONE]' ? [] : [payload]
  }
}

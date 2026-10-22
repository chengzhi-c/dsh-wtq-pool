/**
 * Trae SOLO ↔ OpenAI relay translation.
 *
 * The layer that makes a Trae model answer an OpenAI client: it translates the
 * request envelope, then translates the answer back. `src/shim.ts` — which is
 * bound to the WorkBuddy pool, upstream client and catalog — is untouched by
 * this.
 */
import { randomUUID } from 'node:crypto'
import type { TraeStreamEvent } from './trae-sse'
import { SseDecoder, decodeTraeEvent } from './trae-sse'
import { PEEK_MAX_BYTES, PEEK_MAX_CHUNKS, openAIFinishReason, redactSecrets, replaySource, retryAfterHeader, withRelayStream } from './loopback'

/** What the gateway must answer when Trae refuses inside the stream. */
export interface TraeFailure {
  code?: number
  message: string
  extra?: unknown
}

export type TraeRelayErrorKind = 'hard_credit' | 'soft_rate' | 'authentication' | 'client' | 'server'

/**
 * Words a Trae refusal uses for a sign-in the upstream no longer accepts.
 *
 * Trae answers a stale login inside the stream, on the same `event: error`
 * frame a bad request uses, and it often carries no code at all — the sentence
 * is the whole refusal. Matching only on the code answered those as a 502
 * server failure, which is the one class the gateway does not rotate on, so
 * every request paid one round trip and the healthy sign-ins beside it were
 * never tried. The Qoder path in this same plugin classifies the identical
 * frame as an authentication failure.
 */
const TRAE_SIGN_IN_PATTERN = /login expired|not logged in|unauthori[sz]ed|invalid token|token.*(expire|invalid)|\b9095\b/i

interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}

/** Trae's tool calls arrive under either `function_call` or `function`. */
export function normalizeTraeToolCalls(value: unknown): OpenAIToolCallDelta[] {
  if (!Array.isArray(value)) return []
  const calls: OpenAIToolCallDelta[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const rawFunction = typeof record['function_call'] === 'object' && record['function_call'] !== null
      ? record['function_call'] as Record<string, unknown>
      : typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {}
    const fn: { name?: string; arguments?: string } = {
      ...typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {},
      ...typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {},
    }
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...typeof record['id'] === 'string' ? { id: record['id'] } : {},
      ...record['type'] === 'function' ? { type: 'function' as const } : {},
      ...Object.keys(fn).length === 0 ? {} : { function: fn },
    })
  }
  return calls
}

/**
 * A code wherever the frame chose to put it: top level, or one level down.
 *
 * The nested containers spell it as a string (`"errorCode": "1005"`), so both
 * spellings are read; the floor below is what keeps a success-range code from
 * counting as a refusal.
 */
function numericCodeOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return undefined
}

/** A JSON document a frame hid inside its `message` field. */
function embeddedJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch { /* not a document; the text stays the message */ }
  return undefined
}

/**
 * Recognise the failure Trae hides in an otherwise healthy stream.
 *
 * The shape decides, not the event name. A refusal has arrived as `event:
 * error`, as a bare top-level `code`, nested under `error`/`details`, as a JSON
 * document inside `message`, and on the `output` and `done` event names - which
 * the shape decoder files as an empty delta and a terminator, so a refusal that
 * arrived either way was answered with an empty 200 turn and no error at all.
 *
 * Two boundaries keep the widening honest. A frame that already carries output
 * is content, whatever else it says: the peek stops at the first byte of a
 * reply, and a refusal only counts when the turn produced nothing. And a bare
 * code in the 400..1004 band counts for nothing on its own - Trae's business
 * codes start at 1005 and its wire errors sit at 4000 and above, while that
 * band is where bookkeeping frames carry codes that are not refusals, so a code
 * there needs a message to name the failure. Bookkeeping frames themselves
 * (usage, queue, progress) are never refusals.
 */
export function traeFailureOf(decoded: TraeStreamEvent): TraeFailure | undefined {
  if (decoded.type === 'usage' || decoded.type === 'queue' || decoded.type === 'progress') return undefined
  if (decoded.type === 'delta' && (decoded.text !== ''
    || (decoded.reasoning !== undefined && decoded.reasoning !== '')
    || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) return undefined
  const payload = decoded.type === 'unknown'
    ? decoded.data as Record<string, unknown> | undefined
    : decoded.raw
  if (payload === undefined) return undefined
  const eventName = decoded.event
  let code = numericCodeOf(payload['code'])
  let message = typeof payload['message'] === 'string' ? payload['message'] : ''
  let extra = payload['extra']
  // Whether the words came from an error-shaped place. A frame that names its
  // own error is a refusal whatever else it carries, while a bare `message` is
  // too generic to be one on its own.
  let named = false
  // A container that arrived as a bare string is the message. Trae spells a
  // refusal `{"error":"Login expired"}` as often as it spells one with a code,
  // and reading only the object form let those through as an empty turn.
  const flat = typeof payload['error'] === 'string' ? payload['error']
    : typeof payload['details'] === 'string' ? payload['details']
      : undefined
  if (message === '' && flat !== undefined && flat.length > 0) {
    message = flat
    named = true
  }
  if (code === undefined) {
    for (const container of [payload['error'], payload['details']]) {
      if (typeof container !== 'object' || container === null || Array.isArray(container)) continue
      const record = container as Record<string, unknown>
      const found = numericCodeOf(record['code'] ?? record['errorCode'])
      if (found === undefined && (message !== '' || typeof record['message'] !== 'string')) continue
      if (found !== undefined) code = found
      if (message === '' && typeof record['message'] === 'string') {
        message = record['message']
        named = true
      }
      if (extra === undefined) extra = record['extra']
      if (found !== undefined) break
    }
  }
  if (code === undefined && message !== '') {
    const embedded = embeddedJson(message)
    if (embedded !== undefined) {
      code = numericCodeOf(embedded['code'] ?? embedded['errorCode'])
      if (code === undefined) {
        // The document hid its error as a string rather than a code: the same
        // spelling the outer frame uses, one layer down.
        const nested = typeof embedded['error'] === 'string' ? embedded['error']
          : typeof embedded['details'] === 'string' ? embedded['details']
            : undefined
        if (nested !== undefined && nested.length > 0) {
          message = nested
          named = true
        }
      }
      if (code !== undefined && typeof embedded['message'] === 'string') message = embedded['message']
    }
  }
  // A keepalive that happens to carry `code: 0`, or a success-range code, is an
  // acknowledgement rather than a refusal.
  if (code !== undefined && code < 400) code = undefined
  // A code in the undocumented band needs words to be a refusal; above it the
  // code is Trae's own and speaks for itself.
  if (code !== undefined && code < 1005 && message.trim() === '') code = undefined
  if (eventName !== 'error' && code === undefined && !named) return undefined
  return {
    ...code === undefined ? {} : { code },
    message,
    ...extra === undefined ? {} : { extra },
  }
}

/**
 * The wait a Trae failure asks for, when it asks.
 *
 * A queue or limit frame carries it inside its message as a JSON document, the
 * same envelope Qoder uses. Reading it is what lets a queued Trae account be
 * answered 429 with the wait and rotated past, instead of a 502 that ends the
 * turn.
 */
export function traeRetryAfterSeconds(failure: TraeFailure): number | undefined {
  const embedded = embeddedJson(failure.message)
  const direct = Number(embedded?.['retryAfterSeconds'])
  if (Number.isFinite(direct) && direct > 0) return direct
  const extra = typeof failure.extra === 'object' && failure.extra !== null
    ? failure.extra as Record<string, unknown>
    : undefined
  const nested = Number(extra?.['retryAfterSeconds'])
  return Number.isFinite(nested) && nested > 0 ? nested : undefined
}

/**
 * A readable message for a failure. Trae's own text is often a generic apology
 * that contradicts the code, so it rides along as detail rather than becoming
 * the message.
 */
export function describeTraeFailure(failure: TraeFailure): string {
  const parts: string[] = []
  if (failure.code !== undefined) parts.push(`code ${failure.code}`)
  if (failure.extra !== undefined) {
    const extra = typeof failure.extra === 'string' ? failure.extra : JSON.stringify(failure.extra)
    if (extra !== '') parts.push(extra.slice(0, 200))
  }
  const detail = failure.message.trim()
  // Redacted here, at the one function that assembles this text, because the
  // frame it builds is sent straight to the client: an upstream error frame
  // that quotes the request it was sent carries the credential in `message`,
  // and `extra` is an opaque diagnostic object that may carry it too.
  //
  // The leading separator is dropped when there is nothing in front of it: a
  // refusal with no code and no extra would otherwise be assembled as
  // " · upstream: ...", and that stray bullet reaches the client in the error
  // frame and in the peeked 502 body.
  const head = parts.join(' · ')
  const text = detail === '' ? head : head === '' ? `upstream: ${detail}` : `${head} · upstream: ${detail}`
  // A refusal with neither a code nor words still has to say something: an
  // empty message left the client with an error frame that named nothing at
  // all, and the log with nothing to read either.
  return redactSecrets(text === '' ? 'Trae SOLO refused the request' : text)
}

/**
 * HTTP status + error kind for an in-stream failure.
 *
 * `1005` is a subscription gate: 402 is what makes a client stop rather than
 * retry, and it is truthful.
 *
 * Everything else follows the class of Trae's own code. Trae reports its
 * outages inside the stream, on the same `event: error` frame a bad request
 * uses, so flattening all of them to 400 told a client that a dead upstream was
 * its own fault - and a client retries 5xx, never 400. The codes are >= 4000 on
 * the wire, so the leading digit is the class. A frame with no code at all is
 * upstream's fault too: there is no client mistake the gateway could name.
 */
export function classifyTraeFailure(failure: TraeFailure): { status: number; kind: TraeRelayErrorKind; retryAfterSeconds?: number } {
  if (failure.code === 1005) return { status: 402, kind: 'hard_credit' }
  const code = failure.code
  // A queue or limit frame names its own wait, inside its message as a JSON
  // document. Answering it as a server failure told the client to retry at once
  // and kept this sign-in out of the rotation, where the Qoder path answers
  // 429 with the wait and moves to the next one.
  const retryAfterSeconds = traeRetryAfterSeconds(failure)
  if (retryAfterSeconds !== undefined) return { status: 429, kind: 'soft_rate', retryAfterSeconds }
  // Read before the code bands: a code-less frame whose sentence names the
  // sign-in is the same refusal a 401 carries, and it is the shape Trae uses
  // most often for one.
  if (TRAE_SIGN_IN_PATTERN.test(`${code ?? ''} ${failure.message}`)) {
    return { status: 401, kind: 'authentication' }
  }
  if (code === undefined) return { status: 502, kind: 'server' }
  if (code >= 5000) return { status: 502, kind: 'server' }
  if (code >= 4290 && code < 4300) return { status: 429, kind: 'client' }
  return { status: 400, kind: 'client' }
}

export interface TraeRelayOptions {
  /** Injected for reproducible chunk ids. */
  id?: string
  created?: number
  /**
   * Told about a failure that arrived after output had already started.
   *
   * The stream itself ends in a shape the client can finish on, so the error
   * never reaches it as a stream error and would otherwise leave nothing
   * behind at all. This is how the gateway still records it.
   */
  onFailure?: (error: unknown) => void
}

/**
 * Translate a Trae byte stream into an OpenAI chat-completion SSE stream.
 *
 * Terminal behaviour is the part worth stating: Trae may send both an `event:
 * done` and a trailing `[DONE]`, so exactly one finish chunk goes out; a clean
 * EOF with no done event still gets one, because a client waits for a non-null
 * `finish_reason` before it stops; and exactly one `data: [DONE]` closes it.
 */
export function bridgeTraeStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  options: TraeRelayOptions = {},
): ReadableStream<Uint8Array> {
  const id = options.id ?? `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = options.created ?? Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const sse = new SseDecoder()
  const reader = source.getReader()
  let cancelled = false
  // A producer parked on a full queue waits for this; the consumer's next read
  // (pull) or its cancel resolves it, with a slow re-check as a fallback.
  let wakeRoom: (() => void) | undefined
  const waitForRoom = (): Promise<void> => new Promise((resolve) => {
    let settled = false
    const wake = (): void => {
      if (settled) return
      settled = true
      wakeRoom = undefined
      resolve()
    }
    wakeRoom = wake
    setTimeout(wake, 50)
  })
  let sawToolCalls = false
  let emittedFinishReason = false
  let upstreamDone = false
  // OpenAI-shaped usage, widened past `number` because the cache breakdown
  // nests under `prompt_tokens_details`.
  let usage: Record<string, number | Record<string, number>> | undefined

  const chunk = (delta: Record<string, unknown> | null, finishReason: string | null = null): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }],
      ...usage === undefined ? {} : { usage },
    })}\n\n`)
  // Clients that follow the OpenAI shape expect `role` on the first chunk.
  // Emitted lazily, right before the first real delta, so a stream that fails
  // immediately never carries a chunk that could read as output.
  let started = false
  const roleChunk = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (started) return
    started = true
    controller.enqueue(chunk({ role: 'assistant', content: '' }))
  }

  const consume = (event: ReturnType<SseDecoder['push']>[number], controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (cancelled) return
    const decoded = decodeTraeEvent(event)
    if (decoded.type === 'done' || event.event === 'done') upstreamDone = true
    // Every frame, not only the ones the decoder could not place: a refusal
    // riding on the `output` or `done` event name reaches the bridge as an empty
    // delta or a terminator, and answering it as content gave the client an
    // empty turn. The peek looks at all of them for the same reason.
    const failure = traeFailureOf(decoded)
    if (failure !== undefined) throw new Error(describeTraeFailure(failure))
    if (decoded.type === 'unknown') return
    if (decoded.type === 'delta') {
      const delta: Record<string, unknown> = {}
      if (decoded.text !== '') delta['content'] = decoded.text
      if (decoded.reasoning !== undefined && decoded.reasoning !== '') delta['reasoning_content'] = decoded.reasoning
      const toolCalls = normalizeTraeToolCalls(decoded.toolCalls)
      if (toolCalls.length > 0) {
        sawToolCalls = true
        delta['tool_calls'] = toolCalls
      }
      if (Object.keys(delta).length > 0) {
        roleChunk(controller)
        controller.enqueue(chunk(delta))
      }
      if (decoded.finishReason === undefined) return
    }
    if (decoded.type === 'usage') {
      // Trae's cache counters are a SUBSET of prompt_tokens (OpenAI convention),
      // so they forward under the canonical spelling; dropping them made every
      // session report "0 cache" even when Trae served a warm prefix.
      const details: Record<string, number> = {
        ...decoded.cacheReadTokens === undefined ? {} : { cached_tokens: decoded.cacheReadTokens },
        ...decoded.cacheWriteTokens === undefined ? {} : { cache_write_tokens: decoded.cacheWriteTokens },
      }
      usage = {
        ...decoded.inputTokens === undefined ? {} : { prompt_tokens: decoded.inputTokens },
        ...decoded.outputTokens === undefined ? {} : { completion_tokens: decoded.outputTokens },
        ...decoded.totalTokens === undefined ? {} : { total_tokens: decoded.totalTokens },
        // Omit the details object entirely when Trae sent neither field, so a
        // provider that never reports cache keeps its previous wire shape.
        ...Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details },
      }
      if (emittedFinishReason) controller.enqueue(chunk(null))
      return
    }
    if (decoded.type !== 'done' && decoded.type !== 'delta') return
    if (emittedFinishReason) return
    emittedFinishReason = true
    controller.enqueue(chunk({}, openAIFinishReason(decoded.finishReason, sawToolCalls)))
  }

  let released = false
  /**
   * Release the upstream reader, once, on the way out.
   *
   * Cancelling it is what frees the upstream socket; a turn that ended normally
   * used to leave the source uncancelled and the reader locked.
   */
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* already released */ }
  }

  return new ReadableStream<Uint8Array>({
    /**
     * Push from one loop rather than pull one chunk at a time.
     *
     * The pull-driven version asked the host to call back for every upstream
     * chunk, and in the plugin process those callbacks stopped arriving after a
     * few kilobytes, leaving a turn that had started and then went silent. A
     * single loop owns the read side; `desiredSize` is the only backpressure, so
     * at most a chunk or two is held ahead of the client.
     */
    start(controller) {
      void (async () => {
        try {
          for (;;) {
            const next = await reader.read()
            if (cancelled) return
            if (!next.done) {
              for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller)
              if (!upstreamDone) {
                while (!cancelled && (controller.desiredSize ?? 1) <= 0) {
                  await waitForRoom()
                }
                continue
              }
            }
            // The decoder is flushed before the SSE tail: a stream that ends in
            // the middle of a multi-byte character holds those bytes, and
            // `finish()` alone left them on the floor with the rest of the tail.
            const rest = decoder.decode()
            const events = rest === '' ? sse.finish() : [...sse.push(rest), ...sse.finish()]
            for (const event of events) consume(event, controller)
            // A clean EOF is a valid termination even without an explicit done
            // event; the client still needs a non-null finish_reason.
            if (!emittedFinishReason) {
              emittedFinishReason = true
              controller.enqueue(chunk({}, openAIFinishReason(undefined, sawToolCalls)))
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            return
          }
        } catch (error: unknown) {
          // Same contract as the Qoder bridge: a failure after output has
          // started cannot change the 200 the client already holds, so the
          // stream ends in the shape a client can finish on - an in-band error
          // frame, the terminal finish chunk, then `[DONE]`.
          if (cancelled) controller.error(error)
          else {
            // An abort is this gateway's own `res.on('close')` reaching the
            // relay: the caller stopped waiting, which is the intended path and
            // not an upstream failure.
            if (!(error instanceof Error && error.name === 'AbortError')) {
              try { options.onFailure?.(error) } catch { /* the frames below are the answer */ }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              error: { message: redactSecrets(error instanceof Error ? error.message : String(error)), type: 'upstream_error' },
            })}\n\n`))
            if (!emittedFinishReason) {
              emittedFinishReason = true
              controller.enqueue(chunk({}, openAIFinishReason(undefined, sawToolCalls)))
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        } finally {
          await release()
        }
      })()
    },
    pull() { wakeRoom?.() },
    cancel(reason) { cancelled = true; wakeRoom?.(); return reader.cancel(reason) },
  })
}

/**
 * Turn one gateway response into something an OpenAI client can consume.
 *
 * A non-2xx answer becomes a JSON error. A 2xx answer is peeked briefly: a
 * failure that arrives before any output is turned into a real HTTP error
 * rather than a 200 stream that ends empty, and everything peeked is replayed
 * so no output is lost.
 */
export async function openTraeResponse(
  response: Response,
  model: string,
  options: TraeRelayOptions = {},
): Promise<Response> {
  if (!response.ok) {
    // The upstream's own HTTP status is already meaningful (401 means the
    // sign-in died, 429 a rate limit) and flattening it through the in-stream
    // code classifier would throw that away.
    const detail = (await response.text().catch(() => '')).slice(0, 1024)
    return Response.json(
      {
        error: {
          message: detail === '' ? `Trae SOLO returned HTTP ${response.status}` : detail,
          type: 'upstream_error',
          code: response.status,
        },
      },
      { status: response.status },
    )
  }
  const source = response.body
  if (source === null) {
    return Response.json({ error: { message: `Trae SOLO response ${response.status} carried no body`, type: 'upstream_error', code: 502 } }, { status: 502 })
  }
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const sse = new SseDecoder()
  const buffered: Uint8Array[] = []
  let bufferedBytes = 0
  let sawOutput = false
  let failure: TraeFailure | undefined
  let ended = false
  let terminal = false
  const inspect = (events: ReturnType<SseDecoder['push']>): void => {
    for (const event of events) {
      const decoded = decodeTraeEvent(event)
      terminal ||= decoded.type === 'done' || event.event === 'done'
      if (decoded.type === 'delta' && (decoded.text !== ''
        || (decoded.reasoning !== undefined && decoded.reasoning !== '')
        || normalizeTraeToolCalls(decoded.toolCalls).length > 0)) sawOutput = true
      failure ??= traeFailureOf(decoded)
      if (sawOutput || failure !== undefined || terminal) break
    }
  }
  try {
    while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        // Flush the tail: a stream cut off before its blank line holds exactly
        // the failure this peek exists to catch, and `push` alone never
        // dispatches it. The decoder is flushed first for the same reason the
        // relay's is: bytes of a split character would otherwise be dropped
        // before the tail they belong to is read.
        const rest = decoder.decode()
        inspect(rest === '' ? sse.finish() : [...sse.push(rest), ...sse.finish()])
        break
      }
      buffered.push(next.value)
      bufferedBytes += next.value.byteLength
      inspect(sse.push(decoder.decode(next.value, { stream: true })))
      if (sawOutput || failure !== undefined || terminal) break
    }
  } catch (error: unknown) {
    // Both `reader.read()` and `SseDecoder.push` throw - the latter by design on
    // an over-long line. Without this the reader was never cancelled, so the
    // upstream socket stayed open until its own idle timeout while the caller
    // saw a 500 that named a parse failure rather than the truncated read.
    await reader.cancel().catch(() => {})
    throw error
  }
  // Nothing has been forwarded yet, so a failure found here can still become a
  // real status code. Once output has started, the stream is already committed.
  if (failure !== undefined && !sawOutput) {
    await reader.cancel().catch(() => {})
    const { status, kind, retryAfterSeconds } = classifyTraeFailure(failure)
    const wait = retryAfterHeader(retryAfterSeconds)
    return Response.json(
      { error: { message: describeTraeFailure(failure), type: 'upstream_error', code: kind === 'hard_credit' ? 402 : status } },
      { status, ...wait === undefined ? {} : { headers: { 'Retry-After': wait } } },
    )
  }
  const replayed = replaySource(buffered, reader, ended)
  const relay = bridgeTraeStream(replayed, model, options)
  return withRelayStream(new Response(relay, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }), relay)
}

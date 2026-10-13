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
import { redactSecrets } from './loopback'

/** What the gateway must answer when Trae refuses inside the stream. */
export interface TraeFailure {
  code?: number
  message: string
  extra?: unknown
}

export type TraeRelayErrorKind = 'hard_credit' | 'client' | 'server'

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

/** Recognise the failure Trae hides in an otherwise healthy stream. */
export function traeFailureOf(decoded: TraeStreamEvent): TraeFailure | undefined {
  if (decoded.type !== 'unknown') return undefined
  const payload = decoded.data as Record<string, unknown> | undefined
  const code = typeof payload?.['code'] === 'number' ? payload['code'] : undefined
  if (decoded.event !== 'error' && !(code !== undefined && code >= 4000)) return undefined
  return {
    ...code === undefined ? {} : { code },
    message: typeof payload?.['message'] === 'string' ? payload['message'] : '',
    ...payload?.['extra'] === undefined ? {} : { extra: payload['extra'] },
  }
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
  return redactSecrets(detail === '' ? parts.join(' · ') : `${parts.join(' · ')} · upstream: ${detail}`)
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
export function classifyTraeFailure(failure: TraeFailure): { status: number; kind: TraeRelayErrorKind } {
  if (failure.code === 1005) return { status: 402, kind: 'hard_credit' }
  const code = failure.code
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
    if (decoded.type === 'unknown') {
      const failure = traeFailureOf(decoded)
      if (failure !== undefined) throw new Error(describeTraeFailure(failure))
      return
    }
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
    controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : decoded.finishReason || 'stop'))
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!cancelled) {
          const next = await reader.read()
          if (cancelled) return
          if (next.done) break
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event, controller)
          if (upstreamDone) break
        }
        if (cancelled) return
        for (const event of sse.finish()) consume(event, controller)
        // A clean EOF is a valid termination even without an explicit done
        // event; the client still needs a non-null finish_reason.
        if (!emittedFinishReason) {
          emittedFinishReason = true
          controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'))
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (error: unknown) {
        // Same contract as the Qoder bridge: a failure after output has started
        // cannot change the 200 the client already holds, so the stream ends in
        // the shape a client can finish on - an in-band error frame, the
        // terminal finish chunk, then `[DONE]`. Erroring the controller left a
        // truncated body with neither marker, which is a turn the caller can
        // only end by timing out.
        if (cancelled) controller.error(error)
        else {
          // An abort is this gateway's own `res.on('close')` reaching the
          // relay: the caller stopped waiting, which is the intended path and
          // not an upstream failure. It arrives before the stream's `cancel`
          // runs, so `cancelled` is still false here and the error itself is
          // the only signal - recorded as a warning it wrote one line per
          // cancelled turn, which buried the failures worth reading.
          if (!(error instanceof Error && error.name === 'AbortError')) options.onFailure?.(error)
          // Redacted here because this frame is the one place a stream error's
          // text reaches the client without passing through `writeOpenAIError`.
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
            controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : 'stop'))
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    },
    cancel(reason) { cancelled = true; return reader.cancel(reason) },
  })
}

/** How far {@link openTraeResponse} reads before giving up on finding a failure. */
const PEEK_MAX_CHUNKS = 64
const PEEK_MAX_BYTES = 262_144

/** Replay the bytes the peek consumed, then drain the rest of the upstream. */
function replaySource(
  buffered: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ended: boolean,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = buffered[index]
      if (chunk !== undefined) {
        index += 1
        controller.enqueue(chunk)
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
        // dispatches it.
        inspect(sse.finish())
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
    const { status, kind } = classifyTraeFailure(failure)
    return Response.json(
      { error: { message: describeTraeFailure(failure), type: 'upstream_error', code: kind === 'hard_credit' ? 402 : status } },
      { status },
    )
  }
  const replayed = replaySource(buffered, reader, ended)
  // The peeked events were already decoded; the bridge must see them once.
  return new Response(bridgeTraeStream(replayed, model, options), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

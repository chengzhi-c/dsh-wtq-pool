/**
 * Qoder ↔ OpenAI relay translation.
 *
 * The layer that makes a Qoder model answer an OpenAI client: it translates
 * the request envelope, then translates the answer back. `src/shim.ts` —
 * which is bound to the WorkBuddy pool, upstream client and catalog — is
 * untouched by this.
 */
import { randomUUID } from 'node:crypto'
import { QODER_EFFORT_ORDER, type QoderChatModel } from './qoder-client'
import { QoderFrameDecoder, decodeQoderFrame, type QoderFrame } from './qoder-sse'
import { PEEK_MAX_BYTES, PEEK_MAX_CHUNKS, openAIFinishReason, redactSecrets, relayStreamOf, replaySource, retryAfterHeader, withRelayStream, type ReplayReadResult, type ReplayReader } from './loopback'
import { readErrorBody } from './upstream'

/**
 * How long a turn that has already emitted its finish chunk waits for anything
 * trailing before the relay ends it itself.
 *
 * Qoder finishes a turn by leaving the socket open: the finish chunk and the
 * usage frame arrive and then nothing, with no `[DONE]` and no close. A relay
 * that waited for the upstream to end left the client on a turn that was already
 * over - measured against the live gateway at seven minutes with no terminal
 * frame. A vendor that does close its stream wins this race and pays nothing.
 */
const TAIL_GRACE_MS = 1_000

/**
 * How long a peek that has seen a frame carrying no output waits for a refusal
 * that may follow it.
 *
 * Qoder opens a turn with a role-only delta. Committing on that frame hid a
 * refusal in the very next one; waiting for output instead kept the 200 from the
 * client for the whole thinking phase. The grace is enough for a refusal that
 * arrives promptly, and short enough that a slow model still gets its headers.
 */
const PEEK_OUTPUT_GRACE_MS = 1_000

/** What the gateway must answer when Qoder refuses inside the stream. */
export interface QoderFailure {
  code: string
  message: string
  /** Every message the walk saw, for matching a cause the display sentence hides. */
  signals?: string
  /** The frame decoder's own retry hint, preferred over digging in the text. */
  retryAfterSeconds?: number
}

/** Retryable queue wait the gateway answers with 429 + Retry-After. */
export class QoderQueueRejection extends Error {
  constructor(readonly retryAfterSeconds: number, message: string) {
    super(message)
    this.name = 'QoderQueueRejection'
  }
}

/** Daily allowance spent: no retry within this session helps. */
export class QoderDailyLimitRejection extends Error {
  constructor(readonly retryAfterSeconds: number, message: string) {
    super(message)
    this.name = 'QoderDailyLimitRejection'
  }
}

/** The sign-in is gone; the user must sign in to the Qoder app again. */
export class QoderSignInExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QoderSignInExpiredError'
  }
}

/** Queue descriptor field names; any two co-occurring mark a queue. */
const QUEUE_MARKERS = ['"queueType"', '"retryAfterSeconds"', '"isQueued"', '"serviceAvailable"']

function queueMarkerCount(text: string): number {
  let count = 0
  for (const marker of QUEUE_MARKERS) {
    if (text.includes(marker)) count += 1
  }
  return count
}

/**
 * Best-effort `retryAfterSeconds` from a queue payload, seconds.
 *
 * A carried `0` is "no hint" (the decoder's placeholder), not a real wait —
 * only a positive value is used directly, otherwise the text is dug through.
 */
function queueSeconds(frame: QoderFrame & { type: 'failure' }): number {
  if (Number.isFinite(frame.retryAfterSeconds) && frame.retryAfterSeconds > 0) return frame.retryAfterSeconds
  // The descriptor sits inside a message that is itself a JSON string. Walk at
  // most four documents so a self-referential payload cannot recurse.
  let text = frame.detail
  for (let depth = 0; depth < 4; depth++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return 0
    }
    if (typeof parsed === 'string') {
      text = parsed
      continue
    }
    if (parsed === null || typeof parsed !== 'object') return 0
    const record = parsed as Record<string, unknown>
    const seconds = Number(record['retryAfterSeconds'])
    if (Number.isFinite(seconds) && seconds > 0) return seconds
    if (typeof record['message'] !== 'string' || record['message'] === text) return 0
    text = record['message']
  }
  return 0
}

/**
 * Map one in-stream failure onto the gateway's answer.
 *
 * Exact code matches decide first, so a sign-in failure is never shadowed by
 * a stray field name; the marker fallback fires only when at least two queue
 * markers co-occur, so an auth error that happens to carry a
 * `retryAfterSeconds` field is not misread as a queue. The daily-limit check
 * runs BEFORE the queue check: a spent allowance arrives WITH queue markers
 * and a multi-hour Retry-After, and classifying it as a queue would turn it
 * into a long sleep instead of a failover.
 */
export function classifyQoderFailure(failure: QoderFailure): { status: number; kind: 'soft_rate' | 'hard_credit' | 'authentication' | 'client'; error: Error } {
  const code = failure.code.trim()
  const text = `${code} ${failure.message} ${failure.signals ?? ''}`
  const frame: QoderFrame & { type: 'failure' } = {
    type: 'failure',
    code,
    detail: failure.message,
    signals: failure.signals ?? '',
    retryAfterSeconds: failure.retryAfterSeconds ?? 0,
  }
  if (code === '110' || /daily.*(limit|quota)|quota.*daily|allowance.*spent/i.test(text)) {
    // The same reader the queue branches use, so a hint carried as a field is
    // honoured as well as one embedded in the message text. Regexing the text
    // alone dropped the top-level `retryAfterSeconds`, so a spent allowance
    // answered with no `Retry-After` at all - the client then retried at once
    // against the same exhausted quota instead of failing over.
    const retryAfter = queueSeconds(frame)
    return {
      status: 429,
      kind: 'hard_credit',
      error: new QoderDailyLimitRejection(Number.isFinite(retryAfter) ? retryAfter : 0, failure.message),
    }
  }
  if (code === '10605') {
    return {
      status: 429,
      kind: 'soft_rate',
      error: new QoderQueueRejection(queueSeconds(frame), failure.message),
    }
  }
  if (/Login expired|TOKEN_EXPIRE|token is not active/i.test(text) || code === '105') {
    return { status: 401, kind: 'authentication', error: new QoderSignInExpiredError(failure.message) }
  }
  if (code === '1210') {
    return { status: 400, kind: 'client', error: new Error(failure.message) }
  }
  if (queueMarkerCount(text) >= 2) {
    return {
      status: 429,
      kind: 'soft_rate',
      error: new QoderQueueRejection(queueSeconds(frame), failure.message),
    }
  }
  if (code === '429') return { status: 429, kind: 'soft_rate', error: new QoderQueueRejection(0, failure.message) }
  if (code === '402') return { status: 402, kind: 'hard_credit', error: new Error(failure.message) }
  return { status: 502, kind: 'client', error: new Error(failure.message) }
}

/**
 * OpenAI request body → the Qoder chat call.
 *
 * The model id and the caller's thinking intent are the only things this adds
 * over the plain envelope: `max_tokens` / `tools` / `messages` pass through
 * the client builder untouched, and `is_reasoning` is only stated when the
 * caller states it (a fabricated `false` is refused with 1210 on models that
 * always think).
 */
export function qoderRequestBody(
  openAiBody: string,
  model: string,
  entry?: QoderChatModel,
  options: { enableThinking?: boolean; reasoningEffort?: string; sessionId?: string } = {},
): { body: string; model: string; options: { enableThinking?: boolean; reasoningEffort?: string; sessionId?: string } } {
  // The picked level is only honoured if it reaches the client builder, so it
  // is read here instead of being left to the caller: without this the menu
  // the host offers would change nothing at all on the wire.
  const requested = readReasoningEffort(openAiBody)
  // Qoder spells the off value "none" where the host drops the field entirely,
  // so both spellings mean the same switch and neither carries a level.
  const off = requested === 'off' || requested === 'none'
  // ...and it is then narrowed to what THIS model accepts. The upstream
  // ignores a level it does not list and answers at its own default, which is
  // what made the picker look dead; a model with no level table at all takes
  // only on/off, so any level is dropped rather than sent.
  const wire = requested === undefined || off ? undefined : qoderWireEffort(requested, entry)
  return {
    body: openAiBody,
    model,
    options: {
      ...options,
      ...requested === undefined ? {} : {
        enableThinking: !off,
        ...wire === undefined ? {} : { reasoningEffort: wire },
      },
    },
  }
}

/**
 * The level Qoder accepts for this model, or undefined when none may be sent.
 *
 * A listed level passes through; an unlisted one moves to the nearest listed
 * level, ties going to the model's own default. A model whose catalog row
 * carries no level table (only on/off) takes no level at all.
 */
export function qoderWireEffort(requested: string, entry?: QoderChatModel): string | undefined {
  const levels = entry?.effortLevels ?? []
  if (levels.length === 0) return undefined
  if (levels.includes(requested)) return requested
  const rank = (level: string): number => QODER_EFFORT_ORDER.indexOf(level)
  const want = rank(requested)
  if (want < 0) return entry?.defaultEffort ?? levels[0]
  const fallback = entry?.defaultEffort === undefined ? want : rank(entry.defaultEffort)
  const distance = (level: string): number => Math.abs(rank(level) - fallback)
  return [...levels].sort((a, b) => {
    const near = Math.abs(rank(a) - want) - Math.abs(rank(b) - want)
    return near !== 0 ? near : distance(a) - distance(b)
  })[0]
}

/**
 * The thinking level a client asked for, in the host's spelling.
 *
 * The host drops the field entirely for "off" (see `requestThinkingLevel`), so
 * a present field always means thinking is wanted; "none" is Qoder's own
 * spelling of the same off value. Anything unrecognized is passed through
 * rather than guessed at.
 */
function readReasoningEffort(openAiBody: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(openAiBody)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const effort = (parsed as Record<string, unknown>)['reasoning_effort']
  return typeof effort === 'string' && effort.trim() !== '' ? effort.trim() : undefined
}

export interface QoderRelayOptions {
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
 * Translate a Qoder byte stream into an OpenAI chat-completion SSE stream.
 *
 * Terminal behaviour mirrors the Trae bridge: exactly one finish chunk goes
 * out (a clean EOF with no done marker still gets one, because a client waits
 * for a non-null `finish_reason` before it stops), and exactly one
 * `data: [DONE]` closes it. A failure that arrives after output started ends
 * the stream as an error; one that arrives before any output is left for the
 * caller (`openQoderResponse`) to turn into a real HTTP status.
 */
export function bridgeQoderStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  options: QoderRelayOptions = {},
): ReadableStream<Uint8Array> {
  const id = options.id ?? `chatcmpl-${randomUUID().replaceAll('-', '').slice(0, 24)}`
  const created = options.created ?? Math.floor(Date.now() / 1000)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const frames = new QoderFrameDecoder()
  let sawToolCalls = false
  let emittedFinishReason = false
  let usage: Record<string, unknown> | undefined
  // Qoder acknowledges and reports progress with frames that have no OpenAI
  // shape. Relaying a comment keeps the downstream socket alive while those
  // frames arrive and the client has nothing to read.
  let lastKeepaliveAt = 0
  const keepalive = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    const now = Date.now()
    if (now - lastKeepaliveAt < 10_000) return
    lastKeepaliveAt = now
    controller.enqueue(encoder.encode(': keepalive\n\n'))
  }
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

  const chunk = (delta: Record<string, unknown> | null, finishReason: string | null = null): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }],
      ...usage === undefined ? {} : { usage },
    })}\n\n`)
  let started = false
  const roleChunk = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (started) return
    started = true
    controller.enqueue(chunk({ role: 'assistant', content: '' }))
  }

  const consume = (payload: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
    if (finished) return
    const decoded = decodeQoderFrame(payload)
    if (decoded.type === 'unknown') {
      keepalive(controller)
      return
    }
    if (decoded.type === 'failure') {
      const { error } = classifyQoderFailure({
        code: decoded.code,
        message: decoded.detail,
        signals: decoded.signals,
        retryAfterSeconds: decoded.retryAfterSeconds,
      })
      throw error
    }
    const inner = decoded.chunk as Record<string, unknown>
    const choices = inner['choices']
    if (Array.isArray(choices)) {
      for (const raw of choices) {
        if (raw === null || typeof raw !== 'object') continue
        const choice = raw as Record<string, unknown>
        const delta = choice['delta']
        if (delta !== null && typeof delta === 'object') {
          const out: Record<string, unknown> = { ...(delta as Record<string, unknown>) }
          const toolCalls = (delta as Record<string, unknown>)['tool_calls']
          if (Array.isArray(toolCalls) && toolCalls.length > 0) sawToolCalls = true
          if (Object.keys(out).length > 0) {
            roleChunk(controller)
            controller.enqueue(chunk(out))
          }
        }
        const finish = choice['finish_reason']
        if (typeof finish === 'string' && finish !== '' && finish !== 'null') {
          if (!emittedFinishReason) {
            emittedFinishReason = true
            controller.enqueue(chunk({}, openAIFinishReason(finish, sawToolCalls)))
            // Over for the client; the vendor's socket is not necessarily over.
            endSoon()
          }
        }
      }
    }
    if (inner['usage'] !== undefined && inner['usage'] !== null && typeof inner['usage'] === 'object') {
      usage = inner['usage'] as Record<string, unknown>
      controller.enqueue(chunk(null))
      // The usage frame follows the finish chunk and nothing comes after it, so
      // the turn ends here rather than at the grace deadline above.
      if (emittedFinishReason) endTurn()
    }
  }

  let released = false
  let tailTimer: ReturnType<typeof setTimeout> | undefined
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined
  let finished = false
  /**
   * End the turn from outside `pull`.
   *
   * The vendor keeps its socket open after the finish chunk, so a timer has to
   * close the relay; waiting for a read that the vendor will never end left the
   * client on a turn that was already over ("still generating" after the text
   * stopped). Closing the controller directly is what makes that independent of
   * whether a read happens to be pending.
   */
  const finalize = (): void => {
    if (finished) return
    finished = true
    clearTail()
    wakeRoom?.()
    try {
      ctrl?.enqueue(encoder.encode('data: [DONE]\n\n'))
      ctrl?.close()
    } catch { /* the consumer is already gone */ }
    void reader.cancel().catch(() => {})
  }
  const endTurn = finalize
  const endSoon = (): void => {
    if (tailTimer !== undefined) return
    tailTimer = setTimeout(finalize, TAIL_GRACE_MS)
    tailTimer.unref?.()
  }
  const clearTail = (): void => {
    if (tailTimer !== undefined) clearTimeout(tailTimer)
    tailTimer = undefined
  }
  /**
   * Release the upstream reader, once, on the way out.
   *
   * Done here rather than only in the failure path: a stream that ran to EOF
   * closes its controller instead of erroring, and that exit skips the catch
   * entirely, so the cancel and the unlock would otherwise only ever run for a
   * failed turn - leaving a normal one with the upstream reader locked and its
   * source uncancelled.
   */
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    clearTail()
    await reader.cancel().catch(() => {})
    try { reader.releaseLock() } catch { /* already released */ }
  }

  return new ReadableStream<Uint8Array>({
    /**
     * Push from one loop rather than pull one chunk at a time.
     *
     * The pull-driven version asked the host to call back for every upstream
     * chunk, and in the plugin process those callbacks stopped arriving after a
     * few kilobytes: the turn opened, streamed a little, and then went silent
     * until the client gave up. One loop owns the read side; `desiredSize` is
     * the only backpressure.
     */
    start(controller) {
      ctrl = controller
      void (async () => {
        try {
          for (;;) {
            if (finished) return
            const next = await reader.read()
            if (cancelled || finished) return
            if (!next.done) {
              for (const payload of frames.push(decoder.decode(next.value, { stream: true }))) consume(payload, controller)
              if (!frames.ended) {
                while (!cancelled && !finished && (controller.desiredSize ?? 1) <= 0) {
                  await waitForRoom()
                }
                continue
              }
            }
            // The decoder is flushed before the frame decoder's tail, for the
            // same reason the WorkBuddy relay's is: bytes of a multi-byte
            // character split across the last two chunks would otherwise be
            // dropped.
            const rest = decoder.decode()
            for (const payload of (rest === '' ? frames.finish() : [...frames.push(rest), ...frames.finish()])) {
              consume(payload, controller)
            }
            // A clean EOF is a valid termination even without an explicit finish
            // chunk, and even when nothing was produced at all: the client still
            // needs a non-null finish_reason and a [DONE]. Trae and WorkBuddy
            // close the same way, and an empty turn is what the OpenAI shape
            // describes - erroring here would leave a client that already has a
            // 200 with a truncated response instead.
            if (!finished) {
              if (!emittedFinishReason) {
                emittedFinishReason = true
                controller.enqueue(chunk({}, openAIFinishReason(undefined, sawToolCalls)))
              }
              finalize()
            }
            return
          }
        } catch (error: unknown) {
          // A failure after output started cannot change the 200 the client
          // already has, so the stream has to end the way a client can act on:
          // an in-band error frame, the terminal finish chunk, then [DONE].
          // A caller hang-up is the one case that stays an error: nobody is
          // left to read the frames.
          if (cancelled) controller.error(error)
          else if (!finished) {
            if (!(error instanceof Error && error.name === 'AbortError')) {
              try { options.onFailure?.(error) } catch { /* the frames below are the answer */ }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              // Redacted here because this frame is the one place a stream error's
              // text reaches the client without passing through `writeOpenAIError`.
              error: { message: redactSecrets(error instanceof Error ? error.message : String(error)), type: 'upstream_error' },
            })}\n\n`))
            if (!emittedFinishReason) {
              emittedFinishReason = true
              controller.enqueue(chunk({}, openAIFinishReason(undefined, sawToolCalls)))
            }
            finalize()
          }
        } finally {
          await release()
        }
      })()
    },
    pull() { wakeRoom?.() },
    cancel(reason) { cancelled = true; clearTail(); wakeRoom?.(); return reader.cancel(reason) },
  })
}

/**
 * Whether a Qoder chunk carries output a client would actually see.
 *
 * A role-only delta and a usage-only frame both have `choices`, but neither is
 * output: a refusal that follows them can still become a real status code and
 * let the next account try. Counting any non-empty `choices` as output committed
 * the stream at 200 and skipped failover.
 */
function qoderChunkHasOutput(chunk: Record<string, unknown>): boolean {
  const choices = chunk['choices']
  if (!Array.isArray(choices)) return false
  for (const raw of choices) {
    if (raw === null || typeof raw !== 'object') continue
    const delta = (raw as Record<string, unknown>)['delta']
    if (delta === null || typeof delta !== 'object') continue
    const fields = delta as Record<string, unknown>
    if (typeof fields['content'] === 'string' && fields['content'] !== '') return true
    if (typeof fields['reasoning_content'] === 'string' && fields['reasoning_content'] !== '') return true
    const calls = fields['tool_calls']
    if (Array.isArray(calls) && calls.length > 0) return true
  }
  return false
}

/**
 * Whether a Qoder chunk closes the turn, even if the socket stays open.
 *
 * Qoder reports a completed turn with a `finish_reason` and often a trailing
 * usage frame, then leaves the connection open. The peek must stop there or it
 * waits for the upstream idle watchdog on a turn that has already finished.
 */
function qoderChunkIsTerminal(chunk: Record<string, unknown>): boolean {
  const choices = chunk['choices']
  if (Array.isArray(choices)) {
    for (const raw of choices) {
      if (raw === null || typeof raw !== 'object') continue
      const finish = (raw as Record<string, unknown>)['finish_reason']
      if (finish !== undefined && finish !== null) return true
    }
  }
  return chunk['usage'] !== undefined && chunk['usage'] !== null
}

/**
 * Turn one gateway response into something an OpenAI client can consume.
 *
 * A non-2xx answer becomes a JSON error, and so does a 2xx with no body at all.
 * A 2xx answer is peeked briefly: a failure that arrives before any output is
 * turned into a real HTTP error rather than a 200 stream that ends empty, and
 * everything peeked is replayed so no output is lost. A body that ends without
 * ever producing output is forwarded as-is, so the client reads an empty turn.
 */
export async function openQoderResponse(
  response: Response,
  model: string,
  options: QoderRelayOptions = {},
): Promise<Response> {
  if (!response.ok) {
    // The refusal body is read to a fixed bound: an unbounded `text()` let a
    // huge or never-ending error body hold the gateway open for the account's
    // whole timeout before the 1024-byte preview was even cut.
    const detail = await readErrorBody(response, 1024)
    return Response.json(
      {
        error: {
          message: detail === '' ? `Qoder returned HTTP ${response.status}` : detail,
          type: 'upstream_error',
          code: response.status,
        },
      },
      { status: response.status },
    )
  }
  if (response.body === null) {
    return Response.json({ error: { message: `Qoder response ${response.status} carried no body`, type: 'upstream_error', code: 502 } }, { status: 502 })
  }
  const source = relayStreamOf(response)
  const reader = source.getReader()
  const decoder = new TextDecoder()
  const frames = new QoderFrameDecoder()
  const buffered: Uint8Array[] = []
  let bufferedBytes = 0
  let sawOutput = false
  let sawTerminal = false
  let sawQuiet = false
  let graceDeadline = 0
  let pendingRead: Promise<ReplayReadResult> | undefined
  let failure: QoderFailure | undefined
  let ended = false
  const inspect = (payloads: string[]): void => {
    for (const payload of payloads) {
      const decoded = decodeQoderFrame(payload)
      if (decoded.type === 'chunk') {
        const chunk = decoded.chunk as Record<string, unknown>
        if (qoderChunkHasOutput(chunk)) sawOutput = true
        if (qoderChunkIsTerminal(chunk)) sawTerminal = true
        // A role-only frame says the turn has started but carries no answer. It
        // must not commit the stream before the refusal that may follow it, but
        // it must not hold the headers for a slow first token either: the loop
        // below gives the next frame a short grace, then commits.
        if (!sawOutput && !sawTerminal && Array.isArray(chunk['choices']) && chunk['choices'].length > 0) sawQuiet = true
      } else if (decoded.type === 'failure') {
        failure ??= {
          code: decoded.code,
          message: decoded.detail,
          signals: decoded.signals,
          retryAfterSeconds: decoded.retryAfterSeconds,
        }
      }
      if (sawOutput || sawTerminal || failure !== undefined) break
    }
  }
  try {
    while (buffered.length < PEEK_MAX_CHUNKS && bufferedBytes < PEEK_MAX_BYTES) {
      let next: ReplayReadResult
      if (graceDeadline === 0) {
        next = await reader.read()
      } else {
        // The read is kept, not abandoned: a slow model that has only sent its
        // role frame must still stream once its first token arrives. If the
        // grace ends first, the queued read is handed to the relay below.
        const read = reader.read()
        pendingRead = read
        // A caller that never reads the body (or cancels before the queued read
        // settles) would otherwise leave this rejection unhandled. The relay
        // still sees the rejection when it awaits the same promise.
        read.catch(() => {})
        const remaining = Math.max(0, graceDeadline - Date.now())
        let timer: ReturnType<typeof setTimeout> | undefined
        const timedOut = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), remaining)
        })
        let winner: { result: ReplayReadResult } | undefined
        try {
          winner = await Promise.race([read.then((result) => ({ result })), timedOut])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
        if (winner === undefined) break
        next = winner.result
        pendingRead = undefined
      }
      if (next.done) {
        ended = true
        // The decoder is flushed before the frame decoder's tail: a stream cut
        // off mid-character holds exactly the bytes the failure may sit behind.
        const rest = decoder.decode()
        inspect(rest === '' ? frames.finish() : [...frames.push(rest), ...frames.finish()])
        break
      }
      buffered.push(next.value)
      bufferedBytes += next.value.byteLength
      inspect(frames.push(decoder.decode(next.value, { stream: true })))
      if (sawOutput || sawTerminal || failure !== undefined || frames.ended) break
      if (sawQuiet && graceDeadline === 0) graceDeadline = Date.now() + PEEK_OUTPUT_GRACE_MS
    }
  } catch (error: unknown) {
    // An upstream that resets mid-peek rejects the read, and the decoder throws
    // on an over-long line. Either way the reader has to be released, or the
    // upstream socket stays open after the caller has already been answered.
    pendingRead = undefined
    await reader.cancel().catch(() => {})
    throw error
  }
  // Nothing has been forwarded yet, so a failure found here can still become a
  // real status code. Once output has started, the stream is already committed.
  if (failure !== undefined && !sawOutput) {
    await reader.cancel().catch(() => {})
    const { status, error } = classifyQoderFailure(failure)
    const retryAfter = error instanceof QoderQueueRejection || error instanceof QoderDailyLimitRejection
      ? error.retryAfterSeconds
      : undefined
    // Validated and bounded like the HTTP path's: a wait of years is not a wait
    // any client should honour, and a malformed one is not a value at all.
    const wait = retryAfter === undefined ? undefined : retryAfterHeader(retryAfter)
    return Response.json(
      {
        error: {
          message: error.message === '' ? `Qoder refused the request (${failure.code})` : error.message.slice(0, 1024),
          type: 'upstream_error',
          code: status,
          ...retryAfter === undefined || !(retryAfter > 0) ? {} : { retryAfterSeconds: retryAfter },
        },
      },
      {
        status,
        ...wait === undefined ? {} : { headers: { 'Retry-After': wait } },
      },
    )
  }
  // A grace that ran out leaves its read in flight. Handing the relay the same
  // promise keeps the first token, and its byte order, instead of starting a
  // second read against the locked reader.
  const relayReader: ReplayReader = {
    async read() {
      const queued = pendingRead
      if (queued !== undefined) {
        pendingRead = undefined
        return queued
      }
      return reader.read()
    },
    cancel(reason) { return reader.cancel(reason) },
  }
  const replayed = replaySource(buffered, relayReader, ended)
  const relay = bridgeQoderStream(replayed, model, options)
  return withRelayStream(new Response(relay, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  }), relay)
}

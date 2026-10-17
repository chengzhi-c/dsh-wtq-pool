/**
 * Trae SOLO stream decoding.
 *
 * The chat relay needs this half: Trae's `llm_utils_chat` names its own SSE
 * events (`output`, `token_usage`, `request_wait_in_queue`, …) instead of
 * OpenAI's `chat.completion.chunk`, so something has to decode incrementally
 * and normalise before the pool's gateway can relay it. Pure text handling: no
 * network, no disk, no token material.
 */
export interface SseEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/** Incremental SSE decoder supporting CRLF, chunk splits and multi-line data. */

/**
 * One unterminated line may not grow without bound; chat deltas are small.
 * The ceiling is a memory guard on the upstream's answer, which no request-body
 * limit bounds: a frame this size is a stream gone wrong, not a chat delta.
 */
const MAX_LINE_CHARS = 64 * 1024 * 1024

/**
 * How much one event's accumulated `data:` lines may hold.
 *
 * The line guard above measures the unterminated tail, which stays small on a
 * stream that keeps ending its lines: every `data:` line lands in `data` and
 * only a blank line drains it, so an upstream that emits framed events without
 * ever separating them grew this array without any ceiling touching it.
 */
const MAX_DATA_CHARS = 4 * 1024 * 1024

export class SseDecoder {
  private buffer = ''
  private event: string | undefined
  private id: string | undefined
  private retry: number | undefined
  private data: string[] = []
  private dataChars = 0

  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []
    while (true) {
      // A lone trailing CR is held back: it may be the first half of a CRLF the
      // next chunk completes, and splitting on it early cut a line in two.
      const match = /\r\n|\n|\r/.exec(this.buffer)
      if (match === null || match.index === undefined) break
      if (match[0] === '\r' && match.index + 1 === this.buffer.length) break
      const line = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      const emitted = this.consumeLine(line)
      if (emitted !== undefined) events.push(emitted)
    }
    // What is left has no newline in it, so nothing will ever reduce it: a
    // stream that keeps sending bytes without ending a line is a stream this
    // decoder must stop buffering.
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = ''
      throw new Error('sse line exceeded ' + MAX_LINE_CHARS + ' characters without a newline')
    }
    if (this.dataChars > MAX_DATA_CHARS) {
      this.data = []
      this.dataChars = 0
      throw new Error('sse event exceeded ' + MAX_DATA_CHARS + ' characters of data without a separator')
    }
    return events
  }

  /** Flush a trailing event the upstream never terminated with a blank line. */
  finish(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer !== '') {
      // A stream that ended on a bare carriage return leaves it on the buffer,
      // and consuming it as part of the value kept `[DONE]` from matching.
      const tail = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
      const emitted = this.consumeLine(tail)
      this.buffer = ''
      if (emitted !== undefined) events.push(emitted)
    }
    const final = this.dispatch()
    if (final !== undefined) events.push(final)
    return events
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return undefined
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') {
      this.data.push(value)
      this.dataChars += value.length + 1
    }
    else if (field === 'id' && !value.includes('\0')) this.id = value
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value)
    return undefined
  }

  private dispatch(): SseEvent | undefined {
    if (this.data.length === 0) {
      this.event = undefined
      this.retry = undefined
      return undefined
    }
    const result: SseEvent = {
      ...this.event === undefined || this.event === '' ? {} : { event: this.event },
      data: this.data.join('\n'),
      ...this.id === undefined ? {} : { id: this.id },
      ...this.retry === undefined ? {} : { retry: this.retry },
    }
    this.event = undefined
    this.retry = undefined
    this.data = []
    this.dataChars = 0
    return result
  }
}

/** What one upstream event means, already normalised for the relay. */
export type TraeStreamEvent =
  | { type: 'queue'; position?: number }
  | { type: 'progress'; notice: unknown }
  | { type: 'delta'; text: string; reasoning?: string; toolCalls?: unknown; finishReason?: string; event?: string; raw?: Record<string, unknown> }
  | {
    type: 'usage'
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    /**
     * Trae's prompt-cache accounting on the `token_usage` event (verified
     * 2026-09-22): a byte-identical 9224-token
     * prompt reports `prompt_tokens: 9224` while `cache_read_input_tokens`
     * rises to 9216, so these are a SUBSET of `prompt_tokens` — the OpenAI
     * convention, not Anthropic's exclusive one. Forwarding them as
     * `cached_tokens` is therefore arithmetically correct.
     */
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  | { type: 'done'; finishReason: string; event?: string; raw?: Record<string, unknown> }
  | { type: 'unknown'; event?: string; data: unknown }

/** Normalise one decoded SSE event. Never throws on malformed payloads. */
export function decodeTraeEvent(event: SseEvent): TraeStreamEvent {
  if (event.data === '[DONE]') return { type: 'done', finishReason: 'stop' }
  let payload: unknown
  try { payload = JSON.parse(event.data) as unknown } catch {
    return { type: 'unknown', ...event.event === undefined ? {} : { event: event.event }, data: event.data }
  }
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  if (event.event === 'request_wait_in_queue') {
    return { type: 'queue', ...typeof record['position'] === 'number' ? { position: record['position'] } : {} }
  }
  if (event.event === 'progress_notice') return { type: 'progress', notice: payload }
  if (event.event === 'token_usage') {
    return {
      type: 'usage',
      ...typeof record['prompt_tokens'] === 'number' ? { inputTokens: record['prompt_tokens'] } : {},
      ...typeof record['completion_tokens'] === 'number' ? { outputTokens: record['completion_tokens'] } : {},
      ...typeof record['total_tokens'] === 'number' ? { totalTokens: record['total_tokens'] } : {},
      ...typeof record['reasoning_tokens'] === 'number' ? { reasoningTokens: record['reasoning_tokens'] } : {},
      ...typeof record['cache_read_input_tokens'] === 'number' ? { cacheReadTokens: record['cache_read_input_tokens'] } : {},
      ...typeof record['cache_creation_input_tokens'] === 'number' ? { cacheWriteTokens: record['cache_creation_input_tokens'] } : {},
    }
  }
  const delta = {
    type: 'delta' as const,
    text: typeof record['response'] === 'string' ? record['response'] : '',
    ...typeof record['reasoning_content'] === 'string' ? { reasoning: record['reasoning_content'] } : {},
    ...record['tool_calls'] === undefined || record['tool_calls'] === null ? {} : { toolCalls: record['tool_calls'] },
    ...typeof record['finish_reason'] === 'string' ? { finishReason: record['finish_reason'] }
      : event.event === 'done' ? { finishReason: 'stop' } : {},
    // The frame as it arrived, kept so a refusal riding on an `output` or
    // `done` event name can still be recognised: the shape decoder files those
    // as an empty delta or a terminator, and the code and message it carried
    // would otherwise be invisible.
    raw: record,
    ...event.event === undefined ? {} : { event: event.event },
  }
  if (delta.text !== '' || (delta.reasoning !== undefined && delta.reasoning !== '')
    || (Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0)) return delta
  if (event.event === 'done' || delta.finishReason !== undefined) {
    return { type: 'done', finishReason: delta.finishReason ?? 'stop', raw: record, ...event.event === undefined ? {} : { event: event.event } }
  }
  if (event.event === 'output' || record['response'] !== undefined || record['reasoning_content'] !== undefined || delta.toolCalls !== undefined) {
    return delta
  }
  return { type: 'unknown', ...event.event === undefined ? {} : { event: event.event }, data: payload }
}

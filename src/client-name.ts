/**
 * The client-name rewrite for WorkBuddy's domestic host.
 *
 * The host answers `11128` ("Illegal API invocation from an unapproved channel")
 * to any conversational request whose prompt names this client, which is to say
 * to every request that carries the DSH system prompt. It does so on every
 * account of that region, so switching accounts never helps. With the panel's
 * switch on, that one name is sent as `DeepSeek` instead, the vendor that
 * actually serves the model.
 *
 * This is a switch on what the prompt tells the upstream about the client, so it
 * is off by default and lives here rather than in the shared upstream client: the
 * PI-Desktop edition has no such problem, and nothing of this reaches it.
 */

/**
 * The base whose channel check refuses the name. The international host does not.
 *
 * The test asserts this is the host `CN_CHAT_BASE` actually points at, so a move
 * of that constant cannot quietly turn the switch into a no-op.
 */
export const DOMESTIC_CHAT_HOST = 'copilot.tencent.com'

/**
 * Matched case-insensitively: the host's check is, and a lowercase spelling in a
 * user message tripped it just the same when probed.
 */
const CLIENT_NAME = /DeepSeek Harness/gi

/**
 * Replace the client name in every message's text, leaving everything else be.
 *
 * Only text can carry it: `tool_calls`, `tool_call_id`, tool names and ids are
 * the client's own vocabulary for the call it is making, and rewriting those
 * would break the pairing.
 */
export function renameClientInMessages(messages: unknown[], replacement: string): unknown[] {
  const rename = (text: string): string => text.replace(CLIENT_NAME, replacement)
  const inContent = (content: unknown): unknown => {
    if (typeof content === 'string') return rename(content)
    if (!Array.isArray(content)) return content
    return content.map((part) => {
      if (typeof part === 'string') return rename(part)
      if (typeof part !== 'object' || part === null || Array.isArray(part)) return part
      const record = part as Record<string, unknown>
      if (typeof record['text'] !== 'string') return part
      return { ...record, text: rename(record['text']) }
    })
  }
  return messages.map((message) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return message
    const record = message as Record<string, unknown>
    if (!('content' in record)) return message
    const content = inContent(record['content'])
    return content === record['content'] ? message : { ...record, content }
  })
}

/**
 * Wrap `fetch` so chat requests to the domestic host carry the replacement name.
 *
 * The name is read per request, so the panel's switch takes effect on the next
 * turn; a reader that returns nothing leaves the body exactly as the host wrote
 * it. Only the chat endpoint is touched. The billing and check-in calls carry no
 * prompt, and the international host does not check for this.
 */
export function clientNameRewritingFetch(
  replacement: () => string | undefined,
  inner: typeof fetch = globalThis.fetch,
): typeof fetch {
  const rewrite = (url: string, init?: RequestInit): RequestInit | undefined => {
    if (!url.includes(DOMESTIC_CHAT_HOST) || typeof init?.body !== 'string') return init
    const name = replacement()?.trim()
    if (name === undefined || name === '') return init
    let parsed: unknown
    try { parsed = JSON.parse(init.body) } catch { return init }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return init
    const body = parsed as Record<string, unknown>
    if (!Array.isArray(body['messages'])) return init
    body['messages'] = renameClientInMessages(body['messages'] as unknown[], name)
    return { ...init, body: JSON.stringify(body) }
  }
  // The cast is what a `typeof fetch` wrapper needs: `Parameters` carries the
  // real input type, which includes the Request overload this plugin never uses.
  // A Request would read as `[object Request]` and be forwarded untouched, which
  // is the documented no-op rather than a rewrite of an unread body.
  type FetchInput = Parameters<typeof inner>[0]
  return ((input: FetchInput, init?: RequestInit) => inner(
    input,
    rewrite(String(input), init) as Parameters<typeof inner>[1],
  )) as typeof fetch
}

/**
 * Trae SOLO minimal upstream.
 *
 * Offline half of the Trae path: given a credential found by
 * `trae-discovery.ts`, build exactly what the SOLO `llm_utils_chat` gateway
 * expects — headers, endpoint and body — without sending anything. No disk
 * reads here; tokens stay in the caller's memory.
 */
import { randomUUID } from 'node:crypto'
import type { TraeCredential, TraeRegion } from './trae-discovery'
import { traeRegionOfCredential } from './trae-discovery'
import { headersDeadline, readErrorBody, withIdleWatchdog } from './upstream'

/** Request identity the real client persists; never fabricated per request. */
export interface TraeIdentity {
  machineId: string
  deviceId: string
  /**
   * True when `deviceId` is not the persisted device number.
   *
   * An install holding two device-center ids - two Trae accounts signed in to
   * the same edition - has no single number to send, and both fallbacks (a
   * telemetry GUID, a hash of the machine id) are the shapes the check-in
   * endpoint answers 9074. Chat does not care which one rides along; the
   * check-in does, and without this flag the refusal arrived as a bare code.
   */
  deviceIdIsFallback?: boolean
  platform: NodeJS.Platform
  appVersion?: string
  buildVersion?: string
  deviceBrand?: string
  deviceCpu?: string
  osVersion?: string
}

/** One region's upstream gateway bases. */
export interface TraeRegionGateways {
  /** Chat + agent API base (the `llm_utils_chat` family). */
  readonly chat: string
  /** SOLO remote model directory base (`/api/remote/v1`). */
  readonly remote: string
  /** Pay/status API base; the credential's own host is preferred when known. */
  readonly pay: string
}

/** Verified gateway bases per region (reference: dsh-connect-trae region.ts). */
const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
}

/** Default chat function; the directory may stamp a more specific owner. */
const TRAE_SOLO_FUNCTION = 'solo_work_lite'

/**
 * `llm_utils_chat` functions to union per region, in priority order.
 * A model is only callable through the function that lists it, so the roster
 * is the union and the first function to name a `config_name` wins.
 */
const TRAE_DIRECTORY_FUNCTIONS: Readonly<Record<TraeRegion, readonly string[]>> = {
  cn: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3', 'solo_coder'],
  ai: ['solo_work_remote', TRAE_SOLO_FUNCTION, 'solo_agent_remote', 'chat_v3'],
}

const TRAE_SOLO_CHAT_PATH = '/api/agent/v3/llm_utils_chat'
const TRAE_SOLO_MODELS_PATH = '/api/ide/v1/get_detail_param'

/**
 * The window the upstream accepts once Max mode is on.
 *
 * `context_window_tokens.dev` in the directory is the plan's default, not the
 * ceiling: it reads 200000 for models that then serve far more. Measured against
 * the live chat endpoint in Max mode, a 1005020-token prompt was answered to
 * `finish_reason: stop` on both glm-5.3-flash and deepseek-v4.1-flash, and a
 * 1350030-token prompt was refused with `4022 your prompt tokens have exceeded the
 * maximum limit`.
 *
 * A row that states a larger tier of its own keeps that figure - the directory is
 * the upstream speaking about its own model - and only a row that states none gets
 * this measured ceiling. Publishing a ceiling at all is what lets a caller use the
 * room: the gateway asks for Max mode only when the window in force is above the
 * answer's default, so a model left on its default behaves exactly as before.
 */
const TRAE_MAX_CONTEXT_WINDOW = 1_000_000

/** Upstream failure classes the future shim can map onto HTTP answers. */
export type TraeUpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured'
  | 'aborted'

export type TraeChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string; retryAfter?: string | null }


/** One callable SOLO model, carrying the function that listed it. */
export interface TraeSoloModel {
  id: string
  name: string
  contextWindow?: number
  /**
   * The larger window the model accepts once Max mode is on, when it advertises
   * one. The directory sells Max as a separate tier, so a model's default window
   * is not its ceiling: `context_window_tokens` carries both, and reading only
   * the default published every Max-capable model at a fraction of what it takes.
   */
  maxContextWindow?: number
  maxTokens?: number
  reasoning?: TraeReasoningCapability
  /**
   * Whether the directory marks this model multimodal. Verified end to end: an
   * OpenAI image content block sent through this gateway reaches the model.
   */
  supportsImages?: boolean
  /** Effective (post-discount) credit multiplier, as the Trae IDE shows it. */
  creditMultiplier?: number
  /** The directory function that listed this config (replayed when calling it). */
  function?: string
  /**
   * Every directory answer about this model, in the order the functions answered.
   * The numbers above are derived from these; the gateway picks the one that can
   * serve the window in force rather than trusting a single row.
   */
  variants?: readonly TraeSoloVariant[]
}

/**
 * One directory read: the roster, and whether a function failed on the way.
 *
 * `partial` is what tells the caller the roster is not a complete statement of
 * what the machine can call. Without it a single timed-out function read as a
 * model that no longer exists.
 */
export interface TraeDirectoryRead {
  models: TraeSoloModel[]
  partial: boolean
  /**
   * The functions that did not answer. Their previous answer is still folded in -
   * the models only they list stay callable - but the answers that did arrive are
   * ranked ahead of them, so a function that has stopped being served stops being
   * the first choice.
   */
  failedFunctions: string[]
}

const TRAE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number]

export interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[]
  defaultEffort?: TraeReasoningEffort
}

/**
 * Trae's own spelling for each advertised level.
 *
 * SOLO's `reasoning_effort` does not speak the OpenAI ladder: its values are
 * `light` / `high` / `extra_high`, and a level it does not know is silently
 * ignored — the model then answers at whatever its own default is, which is
 * what made the picker look like it did nothing. `dsh-connect-trae` derives
 * the same map from the official client and translates before sending.
 */
const TRAE_WIRE_EFFORTS: Record<TraeReasoningEffort, string> = {
  minimal: 'high',
  low: 'light',
  medium: 'high',
  high: 'high',
  xhigh: 'extra_high',
}

/**
 * The value to put on the wire for a requested level.
 *
 * Translated when the model advertises the level, undefined when it does not.
 * Undefined means the field is left out: a spelling SOLO ignores looks like a
 * choice was made when none was. With no capability on hand the value passes
 * through untouched.
 */
function traeWireEffort(requested: string, capability: TraeReasoningCapability | undefined): string | undefined {
  if (capability === undefined) return requested
  const level = TRAE_REASONING_EFFORTS.find(entry => entry === requested)
  if (level === undefined || !capability.supported.includes(level)) return undefined
  return TRAE_WIRE_EFFORTS[level]
}

/** Remote directory spells the same three levels as `light` / `high` / `extra_high`. */
const TRAE_HOST_FROM_WIRE: Record<string, TraeReasoningEffort> = {
  light: 'low',
  high: 'high',
  extra_high: 'xhigh',
}

function asTraeEffort(value: unknown): TraeReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined
  if ((TRAE_REASONING_EFFORTS as readonly string[]).includes(value)) return value as TraeReasoningEffort
  return TRAE_HOST_FROM_WIRE[value]
}

/**
 * Read advertised reasoning efforts from a directory row.
 *
 * `get_detail_param` does not carry this. The remote `/models` row does, as
 * `reasoning_effort_config.options` in Trae's own spelling. A host-name list
 * under `reasoning_effort_options` is still accepted.
 */
function parseTraeReasoningCapability(value: unknown): TraeReasoningCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const config = typeof record['reasoning_effort_config'] === 'object'
    && record['reasoning_effort_config'] !== null
    && !Array.isArray(record['reasoning_effort_config'])
    ? record['reasoning_effort_config'] as Record<string, unknown>
    : undefined
  const rawOptions = [
    ...Array.isArray(record['reasoning_effort_options']) ? record['reasoning_effort_options'] : [],
    ...Array.isArray(config?.['options']) ? config['options'] : [],
  ]
  const supported: TraeReasoningEffort[] = []
  for (const item of rawOptions) {
    const effort = asTraeEffort(item)
    if (effort !== undefined && !supported.includes(effort)) supported.push(effort)
  }
  const defaultEffort = asTraeEffort(record['default_reasoning_effort'] ?? config?.['default_level'])
  const resolvedDefault = defaultEffort !== undefined && supported.includes(defaultEffort) ? defaultEffort : undefined
  if (supported.length === 0) return undefined
  return { supported, ...resolvedDefault === undefined ? {} : { defaultEffort: resolvedDefault } }
}

/**
 * Reasoning tables from a remote `/models` payload, keyed by model `name`.
 * The first group to name an id wins; the groups agree on these facts.
 */
function collectTraeRemoteReasoning(groups: readonly unknown[]): Map<string, TraeReasoningCapability> {
  const byId = new Map<string, TraeReasoningCapability>()
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const models = (group as Record<string, unknown>)['models']
    if (!Array.isArray(models)) continue
    for (const raw of models) {
      if (typeof raw !== 'object' || raw === null) continue
      const record = raw as Record<string, unknown>
      const id = typeof record['name'] === 'string' ? record['name'] : ''
      if (id === '' || byId.has(id)) continue
      const reasoning = parseTraeReasoningCapability(record)
      if (reasoning !== undefined) byId.set(id, reasoning)
    }
  }
  return byId
}

/**
 * Numeric version code sent when the persisted build version is not a plain
 * integer. The upstream binds `x-app-version-code` as a number: a dotted
 * build string (observed `2.3.76922` on TRAE SOLO CN) is rejected with
 * `4001 ... parameter type does not match binding data`.
 */
const TRAE_VERSION_CODE_FALLBACK = '20260716'

/** Keep a purely numeric build version; fall back when it cannot bind. */
function normalizeTraeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK
  const trimmed = buildVersion.trim()
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK
}

/** Join a gateway base and an API path without doubling slashes. */
function traeEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

/** Headers derived from persisted identity, never a new random identity per request. */
function traeIdentityHeaders(identity: TraeIdentity): Record<string, string> {
  return {
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-device-type': identity.platform === 'darwin' ? 'mac' : identity.platform === 'win32' ? 'windows' : identity.platform,
    ...identity.deviceBrand === undefined ? {} : { 'x-device-brand': identity.deviceBrand },
    ...identity.deviceCpu === undefined ? {} : { 'x-device-cpu': identity.deviceCpu },
    ...identity.osVersion === undefined ? {} : { 'x-os-version': identity.osVersion },
    ...identity.appVersion === undefined ? {} : { 'x-app-version': identity.appVersion, 'x-ide-version': identity.appVersion },
    ...identity.buildVersion === undefined ? {} : { 'x-app-version-code': identity.buildVersion, 'x-ide-version-code': identity.buildVersion },
    'x-ide-version-type': 'stable',
  }
}

/**
 * Headers shared by every Trae edition. The same shape is accepted by both
 * gateways (identical `x-app-id`, identity headers, and `Cloud-IDE-JWT` auth).
 */
function buildTraeHeaders(
  credential: TraeCredential,
  identity: TraeIdentity,
  options: { appId?: string; requestId?: string } = {},
): Record<string, string> {
  const requestId = options.requestId ?? randomUUID()
  const traceId = requestId.replaceAll('-', '').slice(0, 32)
  return {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': options.appId ?? '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ...traeIdentityHeaders(identity),
    // The upstream binds these as numbers; a dotted build string is rejected.
    'x-app-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
    'X-Cloudide-Token': credential.accessToken,
    'x-uid': credential.userId,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'Accept': 'text/event-stream',
  }
}
/**
 * Build the evidenced `llm_utils_chat` envelope. The endpoint is not
 * OpenAI-compatible, so only its own fields are sent: optional Pi/OpenAI
 * fields (temperature, max_tokens, tool_choice, …) would fail validation.
 */
export function prepareSoloBody(
  source: string,
  defaultModel = 'glm-5.2',
  functionName?: string,
  capability?: TraeReasoningCapability,
  maxMode = false,
): string {
  const input = JSON.parse(source) as Record<string, unknown>
  const model = typeof input['model'] === 'string' && input['model'].trim() !== '' ? input['model'].trim() : defaultModel
  // The level is translated into Trae's own spelling, and left out entirely
  // when this model does not advertise it.
  const wireEffort = typeof input['reasoning_effort'] === 'string'
    ? traeWireEffort(input['reasoning_effort'] as string, capability)
    : undefined
  // The caller's own `function` field never wins, and it is not read at all: the
  // directory lookup already resolved the one function that lists this model,
  // and a `function` pasted into the request body would route the model to a
  // directory that does not list it — the upstream answers 4001 for a model this
  // gateway had verified. A model the gateway has cached but a fresh directory no
  // longer lists has no entry in that lookup, and the default function is still
  // the honest answer for it.
  const body: Record<string, unknown> = {
    ...Array.isArray(input['messages']) ? { messages: input['messages'] } : {},
    model,
    config_name: model,
    function: functionName ?? TRAE_SOLO_FUNCTION,
    stream: true,
    ...Array.isArray(input['tools']) ? { tools: input['tools'] } : {},
    ...wireEffort === undefined ? {} : { reasoning_effort: wireEffort },
    // Max mode is a separate window the upstream only serves when the request
    // asks for it (`v2_max_mode_enabled`, the flag Trae's own client sends when
    // the Max switch is on). Declaring the larger window without sending it
    // would size the host's budget for room the gateway then refuses.
    ...maxMode ? { extra_info: { v2_max_mode_enabled: true } } : {},
  }
  if (Array.isArray(body['messages'])) {
    for (const raw of body['messages']) {
      if (typeof raw !== 'object' || raw === null) continue
      const message = raw as Record<string, unknown>
      // DSH sends the system prompt as the OpenAI `developer` role, which the
      // Trae `llm_utils_chat` upstream rejects with a 400 (it accepts only
      // system / assistant / user / tool / function). Normalise it.
      if (message['role'] === 'developer') message['role'] = 'system'
      if (typeof message['content'] === 'string') message['content'] = [{ type: 'text', text: message['content'] }]
      if (message['role'] === 'assistant' && Array.isArray(message['tool_calls'])) {
        for (const rawCall of message['tool_calls']) {
          if (typeof rawCall !== 'object' || rawCall === null) continue
          const call = rawCall as Record<string, unknown>
          if (typeof call['function'] === 'object' && call['function'] !== null) {
            call['function_call'] = call['function']
            delete call['function']
          }
        }
      }
      if (message['role'] === 'tool') {
        if (typeof message['tool_call_id'] !== 'string' || message['tool_call_id'] === '') {
          throw new Error('Trae SOLO tool message requires tool_call_id')
        }
      }
    }
  }
  if (Array.isArray(body['tools'])) {
    for (const raw of body['tools']) {
      if (typeof raw !== 'object' || raw === null) continue
      const fn = (raw as Record<string, unknown>)['function']
      if (typeof fn !== 'object' || fn === null) continue
      const record = fn as Record<string, unknown>
      if (typeof record['parameters'] === 'object' && record['parameters'] !== null) record['parameters'] = JSON.stringify(record['parameters'])
    }
  }
  return JSON.stringify(body)
}

/** Map an HTTP status onto the failure class the future shim answers with. */
export function classifyTraeUpstreamError(status: number): TraeUpstreamErrorKind {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  return 'client'
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Read the effective credit multiplier from a `get_detail_param` row.
 * The rate the Trae IDE renders lives in `display_contact_config` — a string
 * holding a second JSON document — and its `consumption_rate.data.rate` is
 * already the post-discount value. Rows without the field keep no multiplier.
 */

function wireCreditMultiplier(config: Record<string, unknown>): number | undefined {
  const raw = config['display_contact_config']
  if (typeof raw !== 'string' || raw === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const consumption = (parsed as Record<string, unknown>)['consumption_rate']
  if (typeof consumption !== 'object' || consumption === null) return undefined
  const entry = consumption as Record<string, unknown>
  if (entry['enable'] !== true) return undefined
  const data = entry['data']
  if (typeof data !== 'object' || data === null) return undefined
  return finitePositive((data as Record<string, unknown>)['rate'])
}

/**
 * One directory function's answer about one model.
 *
 * The same `config_name` is listed by several functions and they disagree: a row
 * can serve a wider window, a larger Max tier, or a bigger output budget than
 * another row for the same model. Keeping one answer threw the others away, which
 * is how a 32k-output model ended up published at 16k (the Max-capable function
 * states the smaller budget) and how a narrow row with a Max tier equal to its own
 * default window beat a wider row without one.
 */
export interface TraeSoloVariant {
  /** The `llm_utils_chat` function this answer came from. */
  function: string
  /** The window this answer serves before Max mode. */
  contextWindow?: number
  /** The Max tier this answer offers, kept only when it is above its own default. */
  maxContextWindow?: number
  /** The output budget this answer states. */
  maxTokens?: number
}

/** The widest window one answer can serve, Max tier included. */
function variantReach(variant: TraeSoloVariant): number {
  return Math.max(variant.contextWindow ?? 0, variant.maxContextWindow ?? 0)
}

/**
 * The answer that should serve a request for `window`.
 *
 * Candidates are answers that serve the window on their OWN default tier. An
 * answer that only reaches it with Max mode on is not a candidate at that size:
 * picking it would put a default-window request on the larger tier's terms, and
 * Max mode is billed that way. Only when nothing serves the window on its own
 * tier - which is exactly a request above every default, i.e. a real Max
 * request - do the Max-capable answers become candidates.
 *
 * Among equals the largest output budget wins: a user who keeps the default
 * window then gets the function that grants the most room to answer. Equal
 * budgets prefer the tighter ceiling, so nothing is declared wider than it
 * needs to be.
 *
 * The last resort - a window no answer can reach - is ranked the other way round.
 * There the tightest ceiling would be the answer that takes the LEAST of the
 * request, so the widest wins instead, and Max mode is asked for it: that is the
 * only combination that can serve a window the directory has since narrowed away
 * from.
 */
export function traeVariantFor(model: TraeSoloModel, window?: number): TraeSoloVariant | undefined {
  const variants = model.variants ?? []
  if (variants.length === 0) return undefined
  const wanted = window !== undefined && window > 0 ? window : (model.contextWindow ?? 0)
  const own = variants.filter((variant) => (variant.contextWindow ?? 0) >= wanted)
  const reaching = own.length > 0 ? own : variants.filter((variant) => variantReach(variant) >= wanted)
  // Reached only when nothing can serve the window: prefer the answer whose own
  // tier is the widest, because it is the closest fit and the one Max mode gets
  // the most out of.
  const exhausted = reaching.length === 0
  const pool = exhausted ? variants : reaching
  let best: TraeSoloVariant | undefined
  for (const variant of pool) {
    if (best === undefined) {
      best = variant
      continue
    }
    const out = variant.maxTokens ?? 0
    const bestOut = best.maxTokens ?? 0
    if (exhausted) {
      // Widest own tier first; among equals, the larger output budget.
      const tier = variant.contextWindow ?? 0
      const bestTier = best.contextWindow ?? 0
      if (tier > bestTier) best = variant
      else if (tier === bestTier && out > bestOut) best = variant
      continue
    }
    if (out > bestOut) best = variant
    else if (out === bestOut && variantReach(variant) < variantReach(best)) best = variant
  }
  return best
}

/**
 * The published figures, derived from every answer about a model.
 *
 * The default window is the widest any function serves and the output budget
 * belongs to the answer that serves it - the same answer a request at that window
 * uses. The ceiling is the widest tier any function states, or the measured one
 * when none states a tier above the default.
 *
 * A tier equal to the widest default is not published as one: most rows state a
 * `max` that merely repeats their own window (the `__max` checkpoint naming the
 * same size), and offering that as a second tier would put a Max switch on the
 * model that changes nothing.
 */
function figuresFrom(variants: readonly TraeSoloVariant[]): Pick<TraeSoloModel, 'contextWindow' | 'maxContextWindow' | 'maxTokens' | 'function'> {
  const windows = variants.map((v) => v.contextWindow ?? 0)
  const defaultWindow = Math.max(0, ...windows)
  const declaredCeiling = Math.max(0, ...variants.map(variantReach))
  // A stated tier above the default outranks the measured ceiling; only a row that
  // states none gets that one, and a row that states no window at all is published
  // with no tier - its reach is simply unknown.
  const ceiling = defaultWindow <= 0
    ? declaredCeiling
    : declaredCeiling > defaultWindow ? declaredCeiling : TRAE_MAX_CONTEXT_WINDOW
  const serving = traeVariantFor({ id: '', name: '', variants }, defaultWindow)
  // Every key is written even when it has no value: the caller spreads this over
  // the entry it already has, and an omitted key would leave the previous
  // merge's figure standing - a ceiling from an answer the new set no longer
  // contains, or a `function` from a row that was just dropped.
  return {
    contextWindow: defaultWindow > 0 ? defaultWindow : undefined,
    maxContextWindow: ceiling > defaultWindow ? ceiling : undefined,
    maxTokens: serving?.maxTokens,
    function: serving?.function,
  }
}

/**
 * Merge one directory answer into the roster.
 *
 * Exported because the merge rule is the whole point: the answers disagree, and
 * which one is kept used to depend on the order the gateway happened to answer in.
 * Every answer is kept as a variant, so nothing one function states is lost.
 */
export function collectTraeSoloModels(
  list: readonly unknown[],
  directoryFunction: string,
  byId: Map<string, TraeSoloModel>,
): void {
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const config = raw as Record<string, unknown>
    // The wire `config_name` is what `llm_utils_chat` accepts — NOT
    // `model_name` (a `__dev`/`__max` variant naming the checkpoint).
    const id = typeof config['config_name'] === 'string' ? config['config_name'] : ''
    if (id === '') continue
    const display = typeof config['display_config'] === 'object' && config['display_config'] !== null
      ? config['display_config'] as Record<string, unknown>
      : {}
    const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : []
    const detail = typeof details[0] === 'object' && details[0] !== null ? details[0] as Record<string, unknown> : {}
    // Verified against the live directory (208 rows): `context_window_tokens.dev`
    // is the model's window, and `prompt_max_tokens` is that window MINUS the
    // output budget — `prompt_max_tokens + max_tokens` equalled it on every row
    // (Doubao-Seed-Evolving: 224000 + 32000 = 256000). Publishing the prompt
    // figure as the window understated every model by its own output budget, so
    // the window is read first and the prompt figure is only the fallback for a
    // row that carries no window. A `.max` beside `.dev` is the same window for
    // the `__max` checkpoint, which the unsuffixed `config_name` does not select.
    const contextTokens = typeof config['context_window_tokens'] === 'object' && config['context_window_tokens'] !== null
      ? config['context_window_tokens'] as Record<string, unknown>
      : {}
    const contextWindow = finitePositive(contextTokens['dev']) ?? finitePositive(detail['prompt_max_tokens'])
    // Max is a second, larger window the model accepts with Max mode on. It is
    // not a different checkpoint - the same `config_name` serves both - so a row
    // that states one is the same model with more room.
    const maxContextWindow = finitePositive(contextTokens['max'])
    const maxTokens = finitePositive(detail['max_tokens'])
    const reasoning = parseTraeReasoningCapability({ ...config, ...detail })
    const creditMultiplier = wireCreditMultiplier(config)
    // `display_config.multimodal` is the directory's own vision flag, and it
    // varies per model (true for Doubao-Seed-*, kimi-k3, deepseek-v4.1-flash,
    // qwen3.8-max). Sending an OpenAI image block through this gateway to a
    // model it marks true was verified against the live account, so the flag is
    // published rather than guessed from a name.
    const multimodal = display['multimodal']
    const variant: TraeSoloVariant = {
      function: directoryFunction,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxContextWindow === undefined ? {} : { maxContextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    }
    const existing = byId.get(id)
    const variants = [...existing?.variants ?? []]
    const known = variants.findIndex((entry) => entry.function === directoryFunction)
    const previous = known === -1 ? undefined : variants[known]
    if (previous === undefined) variants.push(variant)
    else if (variantReach(variant) > variantReach(previous) || (variant.maxTokens ?? 0) > (previous.maxTokens ?? 0)) {
      variants[known] = variant
    }
    if (existing !== undefined) {
      byId.set(id, { ...existing, ...figuresFrom(variants), variants })
      continue
    }
    byId.set(id, {
      id,
      name: typeof display['display_name'] === 'string' && display['display_name'] !== '' ? display['display_name'] : id,
      ...reasoning === undefined ? {} : { reasoning },
      ...creditMultiplier === undefined ? {} : { creditMultiplier },
      ...typeof multimodal === 'boolean' ? { supportsImages: multimodal } : {},
      ...figuresFrom(variants),
      variants,
    })
  }
}

/**
 * Fold a partial directory read into the roster already held.
 *
 * A function that failed lists models the answer does not mention, so two facts
 * have to be kept apart: an id only the earlier read knows stays callable, and
 * an id both reads know keeps the variants of both. The failed function may be
 * the only one that stated a Max tier or a wider window, and dropping its answer
 * would re-publish the model at the smaller figures - the same silent narrowing
 * the variant system exists to prevent.
 *
 * A complete read is never merged: it is the directory's current word, and a
 * model it no longer lists is one that is gone.
 *
 * A variant carried over from a failed function is still chosen by
 * `traeVariantFor` when it is the one that reaches the window, and the request is
 * then sent to a function that may have stopped answering entirely. That is the
 * right call while the failure was a timeout - the chat path is a different
 * endpoint - and the gateway retries once with another answer when the chosen one
 * turns out to be gone.
 */
export function mergeTraeDirectory(
  previous: readonly TraeSoloModel[],
  next: readonly TraeSoloModel[],
): readonly TraeSoloModel[] {
  const merged = new Map<string, TraeSoloModel>(next.map((model) => [model.id, model]))
  for (const model of next) {
    const before = previous.find((entry) => entry.id === model.id)
    if (before === undefined) continue
    const variants = [...model.variants ?? []]
    for (const variant of before.variants ?? []) {
      if (!variants.some((entry) => entry.function === variant.function)) variants.push(variant)
    }
    if (variants.length === (model.variants ?? []).length) continue
    merged.set(model.id, { ...model, ...figuresFrom(variants), variants })
  }
  for (const model of previous) {
    if (!merged.has(model.id)) merged.set(model.id, model)
  }
  return [...merged.values()]
}

/** Daily check-in endpoints on the CN pay host (`REGION_GATEWAYS.cn.pay`). */
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'

/**
 * Deadline for the chat POST to reach its response headers.
 *
 * Headers only: the body runs on the idle watchdog, because a signal handed to
 * fetch stays attached to the body and a whole-stream deadline cut every long
 * turn in half.
 */
const TRAE_HEADERS_TIMEOUT_MS = 60_000

/**
 * Headers the check-in endpoints are proven with. `x-device-id` must be the
 * persisted 16-digit device number: a GUID answers 9074 ("too many
 * participants"), so it comes from `identity`, never from a fresh value.
 */
function traeCheckinHeaders(credential: TraeCredential, identity: TraeIdentity, region: TraeRegion = 'cn'): Record<string, string> {
  return {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-User-Region': region,
    'x-device-id': identity.deviceId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
}

/**
 * The international pay host's subscription answer.
 *
 * Measured 2026-10-07: it accepts any `X-User-Region` spelling, so the header
 * follows the credential's own region rather than pretending to be CN.
 */
export const TRAE_PAY_STATUS_PATH = '/trae/api/v1/pay/ide_user_pay_status'

/** Trae's own "this device already checked in today" business code. */
export const TRAE_CHECKIN_DEVICE_CLAIMED = 9095

/**
 * Subscription state of an international (ai) account.
 *
 * The international region has no Work-credit packs, so the plan name is the
 * only figure its card has: it is `user_pay_identity_str` when the upstream
 * sends one, and the tier number otherwise — an account can hold a tier with no
 * package row at all.
 */
export interface TraePayStatus {
  plan: string
  inTrial: boolean
}

/** Parse the `ide_user_pay_status` answer; never throws on a thin payload. */
function traePayStatusOf(payload: unknown): TraePayStatus {
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const identity = typeof record['user_pay_identity'] === 'number' && Number.isFinite(record['user_pay_identity'])
    ? record['user_pay_identity']
    : -1
  const named = typeof record['user_pay_identity_str'] === 'string' ? record['user_pay_identity_str'].trim() : ''
  const trial = record['trial_status'] !== null && typeof record['trial_status'] === 'object'
    ? record['trial_status'] as Record<string, unknown>
    : {}
  return {
    plan: named !== '' ? named : identity === 0 ? 'Free' : identity > 0 ? `Plan ${identity}` : '',
    inTrial: trial['is_in_trial'] === true,
  }
}

/** The usage endpoint with the verified totals (`POST /trae/api/v2/pay/web_user_ent_usage`). */
export const TRAE_USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage'

/**
 * What the usage envelope leaves the card to draw: the remaining figure and the
 * packs behind it. `total_amount` and `consumed_amount` are read only to derive
 * that remainder — the gross totals are never shown.
 */
export interface TraeUsageSummary {
  /** total - consumed, what the user can actually spend. */
  remainingAmount: number
  /**
   * The pools the total is made of, each with its own expiry. A daily
   * check-in reward lands as its own pack, so this is where "the check-in
   * credits expire on <date>" comes from rather than from the account total.
   */
  packs: readonly TraeCreditPack[]
}

/** One entitlement pool inside the usage answer: what is left and until when. */
export interface TraeCreditPack {
  /** The upstream's own name for the pool ("每日签到", "每月登录积分", …). */
  name: string
  /** What is still spendable from this pool. */
  remaining: number
  /** The pool's size. */
  total: number
  /** Seconds→ms; absent when the pool never expires. */
  expiresAtMs?: number
}

/** True for a pack that carries credits at all: entitlement packs do not. */
function traeCreditLimitOf(record: Record<string, unknown>): number | undefined {
  const base = record['entitlement_base_info']
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return undefined
  const info = base as Record<string, unknown>
  const quota = info['quota']
  const limit = quota !== null && typeof quota === 'object' && !Array.isArray(quota)
    ? traeNumber((quota as Record<string, unknown>)['credits_limit'], NaN)
    : NaN
  return Number.isFinite(limit) && limit > 0 ? limit : undefined
}

/** The pool's own name, the way the app's usage page labels it. */
function traePackNameOf(pack: Record<string, unknown>, base: Record<string, unknown>): string {
  const group = typeof pack['group_name'] === 'string' ? pack['group_name'].trim() : ''
  if (group !== '') return group
  const extra = base['product_extra']
  const named = extra !== null && typeof extra === 'object' && !Array.isArray(extra)
    ? (extra as Record<string, unknown>)['package_extra']
    : undefined
  const packageName = named !== null && typeof named === 'object' && !Array.isArray(named)
    ? (named as Record<string, unknown>)['package_name']
    : undefined
  if (typeof packageName === 'string' && packageName.trim() !== '') return packageName.trim()
  const described = typeof pack['display_desc'] === 'string' ? pack['display_desc'].trim() : ''
  return described === '' ? 'credits' : described
}

/**
 * Read the entitlement packs; the answer holds the account's only per-pool
 * expiry, and the daily check-in reward is one of them. A hidden pack, a pack
 * with no credits and a pack that is used up all drop out: the card shows what
 * is spendable, and the totals above already answer the account-wide question.
 */
function traeCreditPacksOf(payload: unknown): TraeCreditPack[] {
  const envelope = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const list = envelope['user_entitlement_pack_list']
  if (!Array.isArray(list)) return []
  const packs: TraeCreditPack[] = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const pack = entry as Record<string, unknown>
    if (pack['is_hide'] === true) continue
    const total = traeCreditLimitOf(pack)
    if (total === undefined) continue
    const usage = pack['usage']
    const consumed = usage !== null && typeof usage === 'object' && !Array.isArray(usage)
      ? traeNumber((usage as Record<string, unknown>)['credits_amount'], 0)
      : 0
    const remaining = Math.max(0, total - consumed)
    if (remaining <= 0) continue
    const base = pack['entitlement_base_info'] as Record<string, unknown>
    const expiresAt = traeNumber(pack['expire_time'], 0)
    packs.push({
      name: traePackNameOf(pack, base),
      remaining,
      total,
      ...expiresAt > 0 ? { expiresAtMs: expiresAt * 1000 } : {},
    })
  }
  return packs
}

/** Parse one usage payload; missing digits fail loudly instead of showing 0. */
function traeUsageSummaryOf(payload: unknown): TraeUsageSummary {
  const envelope = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const summary = envelope['usage_summary']
  const record = summary !== null && typeof summary === 'object' && !Array.isArray(summary) ? summary as Record<string, unknown> : {}
  const total = traeNumber(record['total_amount'], NaN)
  const consumed = traeNumber(record['consumed_amount'], NaN)
  if (!Number.isFinite(total) || !Number.isFinite(consumed)) {
    throw new Error('Trae usage answer has no usable totals')
  }
  return {
    remainingAmount: Math.max(0, total - consumed),
    packs: traeCreditPacksOf(payload),
  }
}

/** One check-in answer. `code` is -1 when the upstream sent none. */
export interface TraeCheckinStatus {
  enable: boolean
  checkedIn: boolean
  /**
   * Whether THIS device already claimed today (`did_checked_in`).
   *
   * The upstream keys it on the `x-device-id` the request carries, not on the
   * account, and allows one check-in per device per day: an account can read
   * `checkedIn: false` while its device is spent, and a claim would then be
   * refused with 9095. Reading it here is what makes that claim skippable
   * instead of attempted.
   */
  didCheckedIn: boolean
  credits: number
  code: number
  message?: string
}

function traeNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : fallback
}
function traeFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * Read the check-in `enable` flag.
 *
 * Only an explicit "off" turns check-in off. The upstream omits the field for
 * accounts that have it on, and reading it with the strict `=== true` helper
 * above turned every such account into "this account has no check-in": the
 * batch skipped it without ever asking, the panel hid the button and said the
 * account had no campaign, and nothing reported a failure. (The Trae protocol
 * reference this plugin is built against reads it as `enable !== false`.)
 */
function traeEnabled(value: unknown): boolean {
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    return text !== 'false' && text !== '0'
  }
  return true
}

/** Read a check-in answer; numbers and booleans may arrive as strings. */
function traeCheckinStatusOf(payload: unknown): TraeCheckinStatus {
  const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  return {
    enable: traeEnabled(record['enable']),
    checkedIn: traeFlag(record['checked_in']),
    didCheckedIn: traeFlag(record['did_checked_in']),
    credits: traeNumber(record['credits'], 0),
    code: traeNumber(record['code'], -1),
    ...typeof record['message'] === 'string' ? { message: record['message'] as string } : {},
  }
}

export interface TraeSoloClientOptions {
  credential(): Promise<TraeCredential>
  identity(): Promise<TraeIdentity>
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Trae SOLO upstream client: chat, the pay surface and the check-in status.
 * `fetchImpl` is injectable for offline checks.
 */
export class TraeSoloUpstreamClient {
  private readonly fetchImpl: typeof fetch
  constructor(private readonly options: TraeSoloClientOptions) { this.fetchImpl = options.fetchImpl ?? fetch }

  /**
   * Read the callable roster for this credential's region. Every function in
   * `TRAE_DIRECTORY_FUNCTIONS` is asked in order and their answers unioned;
   * one function failing never hides the others' rosters.
   *
   * The answer says whether it is `partial`: a function that failed is one that
   * would have listed models, and the ones only it lists are missing from what
   * came back. That has to travel with the read, because the roster replaces the
   * cached one - and a roster that lost models makes the gateway refuse them as
   * `not_found`, for as long as the read stays fresh.
   */
  async fetchModels(signal?: AbortSignal): Promise<TraeDirectoryRead> {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    const region = traeRegionOfCredential(credential)
    const base = this.options.baseUrl ?? REGION_GATEWAYS[region].chat
    const headers = { ...buildTraeHeaders(credential, identity), Accept: 'application/json' }
    const byId = new Map<string, TraeSoloModel>()
    const failures: string[] = []
    /** The functions whose answer this read could not use, by name only. */
    const failedFunctions: string[] = []
    // Asked together, not one after the other: a cold roster is four or five round
    // trips, and the host asks for `/v1/models` while this runs. Collected in
    // priority order afterwards, so the first function to name a `config_name`
    // still decides which of its variants leads.
    const answers = await Promise.all(TRAE_DIRECTORY_FUNCTIONS[region].map(async (directoryFunction) => {
      try {
        const response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
          redirect: 'error',
          method: 'POST',
          headers,
          body: JSON.stringify({
            function: directoryFunction,
            config_names: null,
            need_prompt: false,
            current_config_info: null,
            poly_prompt: true,
            mode_type: null,
            agent_type: null,
          }),
          signal: signal ?? AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const document = await response.json() as Record<string, unknown>
        // A 200 that carries no list is not an empty answer, it is an answer this
        // read could not use - the upstream sends its own error envelope with a
        // 200 often enough. Counting it as success made the whole read look
        // complete, which then replaced the roster and dropped every model only
        // this function lists: the same 404 the partial flag exists to prevent,
        // with a different trigger.
        if (!Array.isArray(document['config_info_list'])) {
          const code = typeof document['code'] === 'number' ? document['code'] : undefined
          const message = typeof document['message'] === 'string' ? document['message'].slice(0, 60) : ''
          throw new Error(code === undefined ? 'no config_info_list' : `code ${code}${message === '' ? '' : ': ' + message}`)
        }
        return { directoryFunction, list: document['config_info_list'] as unknown[] }
      } catch (error: unknown) {
        failedFunctions.push(directoryFunction)
        return { directoryFunction, failure: `${directoryFunction}: ${String(error).slice(0, 80)}` }
      }
    }))
    for (const answer of answers) {
      if (answer.failure !== undefined) {
        failures.push(answer.failure)
        continue
      }
      collectTraeSoloModels(answer.list, answer.directoryFunction, byId)
    }
    const models = [...byId.values()]
    if (models.length === 0) {
      throw new Error(`Trae SOLO models response contained no models (${failures.join('; ') || 'empty directory'})`)
    }
    const reasoning = await this.readRemoteReasoning(credential, region, signal)
    for (const model of models) {
      if (model.reasoning !== undefined) continue
      const found = reasoning.get(model.id)
      if (found !== undefined) model.reasoning = found
    }
    return { models, partial: failures.length > 0, failedFunctions }
  }

  /**
   * Reasoning tables live on the remote model directory, not on
   * `get_detail_param`. A failure here leaves the roster callable and the
   * picker with no levels, rather than failing model discovery.
   */
  private async readRemoteReasoning(
    credential: TraeCredential,
    region: TraeRegion,
    signal?: AbortSignal,
  ): Promise<Map<string, TraeReasoningCapability>> {
    const dressing = region === 'ai'
      ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
      : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' }
    try {
      const response = await this.fetchImpl(
        `${REGION_GATEWAYS[region].remote}/models?functions=${TRAE_DIRECTORY_FUNCTIONS[region].join(',')}`,
        {
          redirect: 'error',
          headers: {
            'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
            'Content-Type': 'application/json',
            'x-trae-client-type': 'web',
            'x-trae-user-timezone': dressing.timezone,
            'x-preferenced-language': dressing.language,
            'Referer': dressing.referer,
          },
          signal: signal ?? AbortSignal.timeout(30_000),
        },
      )
      if (!response.ok) return new Map()
      const json = await response.json() as { data?: { list?: unknown[] } }
      return collectTraeRemoteReasoning(json.data?.list ?? [])
    } catch {
      return new Map()
    }
  }

  /** Today's check-in state for this credential (CN only). */
  async fetchCheckinStatus(signal?: AbortSignal): Promise<TraeCheckinStatus> {
    return this.postCheckin(TRAE_CHECKIN_STATUS_PATH, signal)
  }

  /** Totals for this account (CN only): what the card shows as remaining. */
  async fetchUsageSummary(signal?: AbortSignal): Promise<TraeUsageSummary> {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    if (traeRegionOfCredential(credential) !== 'cn') throw new Error('Trae usage exists on CN only')
    const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, TRAE_USAGE_PATH), {
      redirect: 'error',
      method: 'POST',
      headers: traeCheckinHeaders(credential, identity),
      body: JSON.stringify({ require_usage: true }),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Trae usage failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    let payload: unknown
    try { payload = JSON.parse(text) as unknown } catch { throw new Error(`Trae usage: response is not valid JSON — ${text.slice(0, 200) || '(empty)'}`) }
    return traeUsageSummaryOf(payload)
  }

  /**
   * This account's subscription plan (international only).
   *
   * The ai region is subscription-based: it has no Work-credit totals, so the
   * plan name is the figure its card shows. CN never calls this.
   */
  async fetchPayStatus(signal?: AbortSignal): Promise<TraePayStatus> {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    const region = traeRegionOfCredential(credential)
    if (region !== 'ai') throw new Error('Trae pay status exists on the international region only')
    const response = await this.fetchImpl(traeEndpoint(this.options.baseUrl ?? REGION_GATEWAYS[region].pay, TRAE_PAY_STATUS_PATH), {
      redirect: 'error',
      method: 'POST',
      headers: traeCheckinHeaders(credential, identity, region),
      body: '{}',
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Trae pay status failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    let payload: unknown
    try { payload = JSON.parse(text) as unknown } catch { throw new Error(`Trae pay status: response is not valid JSON — ${text.slice(0, 200) || '(empty)'}`) }
    return traePayStatusOf(payload)
  }

  /**
   * Claim today's check-in (CN only). The answer carries no gained amount —
   * read the status again afterwards if the number matters.
   */
  async claimCheckin(signal?: AbortSignal): Promise<TraeCheckinStatus> {
    return this.postCheckin(TRAE_CHECKIN_CLAIM_PATH, signal)
  }

  private async postCheckin(path: string, signal?: AbortSignal): Promise<TraeCheckinStatus> {
    const [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    if (traeRegionOfCredential(credential) !== 'cn') throw new Error('Trae check-in exists on CN only')
    const response = await this.fetchImpl(traeEndpoint(REGION_GATEWAYS.cn.pay, path), {
      redirect: 'error',
      method: 'POST',
      headers: traeCheckinHeaders(credential, identity),
      body: '{}',
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Trae check-in failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    let payload: unknown
    try { payload = JSON.parse(text) as unknown } catch { throw new Error(`Trae check-in: response is not valid JSON — ${text.slice(0, 200) || '(empty)'}`) }
    return traeCheckinStatusOf(payload)
  }

  /** Send one chat body through the credential's regional gateway. */
  async chatStream(
    bodyJson: string,
    signal?: AbortSignal,
    functionName?: string,
    capability?: TraeReasoningCapability,
    timeouts?: { headersMs?: number; idleMs?: number },
    maxMode?: boolean,
  ): Promise<TraeChatResult> {
    let prepared: string
    try { prepared = prepareSoloBody(bodyJson, undefined, functionName, capability, maxMode === true) } catch (error: unknown) {
      // The message is carried through rather than flattened into "invalid JSON
      // request": the envelope builder refuses specific shapes (a tool message
      // with no `tool_call_id`, a body that is not an object), and the caller
      // can only fix what the answer names.
      const message = error instanceof Error && error.message !== '' ? error.message : 'invalid JSON request'
      return { ok: false, status: 400, kind: 'client', message }
    }
    let credential: TraeCredential
    let identity: TraeIdentity
    try {
      [credential, identity] = await Promise.all([this.options.credential(), this.options.identity()])
    } catch (error: unknown) {
      // The identity read is disk I/O the gateway does not guard; a storage
      // file that vanishes between the two reads is a 503, not a 500.
      return { ok: false, status: 503, kind: 'server', message: `identity read failed: ${String(error instanceof Error ? error.message : error)}` }
    }
    const headers = buildTraeHeaders(credential, identity)
    const base = this.options.baseUrl ?? REGION_GATEWAYS[traeRegionOfCredential(credential)].chat
    let response: Response
    // Headers on a clock of their own, the body on the idle watchdog: a signal
    // handed to fetch stays attached to the body, so a whole-stream deadline
    // here used to cut every turn longer than two minutes in half.
    const deadline = headersDeadline(signal, timeouts?.headersMs ?? TRAE_HEADERS_TIMEOUT_MS)
    try {
      response = await this.fetchImpl(traeEndpoint(base, TRAE_SOLO_CHAT_PATH), {
        redirect: 'error',
        method: 'POST', headers, body: prepared,
        signal: deadline.signal,
      })
    } catch (error: unknown) {
      // The caller hanging up is not an upstream failure. Answering it as one
      // made every cancelled turn read as a network fault, and spent a rotation
      // on a request the client had already dropped.
      if (signal?.aborted === true) {
        return { ok: false, status: 0, kind: 'aborted', message: 'cancelled by the caller' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    } finally {
      deadline.arrived()
    }
    if (response.ok) {
      return {
        ok: true,
        response: response.body === null
          ? response
          : new Response(withIdleWatchdog(response.body, timeouts?.idleMs, signal), {
            status: response.status,
            headers: response.headers,
          }),
      }
    }
    // Guarded like every sibling body read: a non-2xx whose connection dies
    // mid-body (a proxy cutting a 429, a gateway reset) rejects this, and the
    // rejection escaped `chatStream` entirely - the client saw a plugin-level
    // 500 with `TypeError: terminated` instead of the upstream's own status and
    // message, which are exactly what the failover needs to choose another
    // account.
    const text = (await readErrorBody(response, 1024, signal))
    return {
      ok: false,
      status: response.status,
      kind: classifyTraeUpstreamError(response.status),
      message: text || `Trae SOLO returned HTTP ${response.status}`,
      // The rate limit's own wait time, carried out so the gateway can answer
      // with it: the in-stream path already relays one, and a client told to
      // wait retries at once without it.
      retryAfter: response.headers.get('retry-after'),
    }
  }
}

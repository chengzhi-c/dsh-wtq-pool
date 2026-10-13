/**
 * dsh-wtq-pool — the DeepSeek Harness entry.
 *
 * This file owns everything host-specific: the Cordis activation, the settings
 * schema, the six provider registrations and the routes that carry the panel.
 * The pool itself lives in `host.ts`, and `pi-compat.ts` bridges it to the
 * services below.
 *
 * @module dsh-wtq-pool
 */

import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import * as piAi from '@earendil-works/pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider, ProviderStreams, TextContent, TranscriptContext } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import z from '@deepseek-ai/schemastery'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'

import { installPi, startRegisteredService, stopRegisteredService, type CommandSpec, type ProviderDescriptor } from './pi-compat'
import { registerPanelRoutes } from './web-panel.ts'
import { ROW_ID } from './ids.ts'
import { onLoad, onUnload, onPanelInvoke } from './host.ts'

export { onLoad, onUnload, onPanelInvoke }

/** The Cordis row id; also the settings namespace this plugin is served under. */
export const name = ROW_ID

/**
 * `settings` is declared so the host renders this plugin's own section instead
 * of reading `undefined` while it builds the provider list; `llm` is the seam
 * the six providers register into.
 */
export const inject = ['llm', 'settings']

/** Settings namespace, used when the running loader entry id cannot be read. */
const FALLBACK_SETTINGS_NS = ROW_ID

/** This package's own root, derived from the compiled entry's location. */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Idle ceiling while one upstream stream read is outstanding. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** Levels the picker accepts, in the order it shows them. */
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Inert pi-ai auth plane.
 *
 * The loopback endpoints authenticate nothing: their guard is the 127.0.0.1
 * bind plus the Host/Origin check, and their own `bearerAccepted` only requires
 * the Authorization header to have a bearer *shape*. A pi-ai credential
 * lifecycle here would therefore invent a secret nothing verifies.
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-wtq-pool: this route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** The sentinel every loopback gateway accepts. */
const LOOPBACK_BEARER = 'dsh-wtq-pool-loopback'

// ------------------------------------------------------------------- config

/**
 * Every field is marked volatile.
 *
 * The settings write gate refuses an entry whose schema declares no volatile
 * field at all, and `describe()` skips such an entry, so an unmarked schema
 * means the card can neither render nor save. Reading a volatile field hands
 * back the live value once peeled (see {@link unwrapVolatile}).
 */
export interface Config {
  /** Master switch. A missing value reads as enabled. */
  enabled?: boolean
  /** Per-vendor switches; a vendor whose switch is off gets no gateway. */
  sourceWorkbuddy?: boolean
  sourceTrae?: boolean
  sourceQoder?: boolean
  /** Explicit WorkBuddy desktop auth-file path override. */
  authFile?: string
  /** Daily check-in: whether it runs, and at which local hours. */
  autoCheckin?: { enabled?: boolean; hours?: number[] }
  /** Rate-limit cooldown per account, in seconds. */
  cooldownSeconds?: number
  /** Per-account credit floor, keyed by account id. */
  creditReserves?: Record<string, number>
  /** Account ids switched off on the panel. */
  disabledAccountIds?: string[]
  /** Regions parked on their own, as `source:region` keys. */
  disabledRegions?: string[]
  /** How the WorkBuddy pool spreads requests. */
  distribution?: 'priority' | 'round-robin' | 'expiry' | 'sticky'
  /** Per-gateway model selection, keyed by gateway. */
  modelSelection?: Record<string, unknown>
  /** Picked WorkBuddy account per region. */
  preferredAccountIds?: Record<string, string>
  /** Picked Trae/Qoder account per region. */
  preferredSourceAccounts?: Record<string, string>
  /** Accounts removed from the pool for good, with their label kept. */
  removedAccounts?: unknown[]
  /** Whether the credits readout is shown beside the composer. */
  showComposerPoints?: boolean
  /** How each Trae/Qoder region spreads requests. */
  sourceDistributions?: Record<string, string>
}

/**
 * Wrap one schema in `volatile()` when the installed schemastery has it.
 *
 * `volatile()` landed in schemastery 3.18.3. Hand-writing `meta.volatile` on an
 * older copy would bypass the host's own `validateVolatileSchema`, so an older
 * builder degrades to the plain schema instead.
 */
function asVolatile<S>(schema: S): S {
  const candidate = schema as unknown as { volatile?: () => S }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

export const Config: z<Config> = z.object({
  enabled: asVolatile(z.boolean().default(true).description('Serve this pool at all')),
  sourceWorkbuddy: asVolatile(z.boolean().default(true).description('Merge the WorkBuddy desktop sign-ins')),
  sourceTrae: asVolatile(z.boolean().default(true).description('Merge the Trae desktop sign-ins')),
  sourceQoder: asVolatile(z.boolean().default(true).description('Merge the Qoder desktop sign-ins')),
  authFile: asVolatile(z.string().description('WorkBuddy desktop auth file (defaults to the app own location)')),
  autoCheckin: asVolatile(z.object({
    enabled: z.boolean().default(false),
    hours: z.array(z.number()).default([]),
  }).description('Daily check-in across every discovered sign-in')),
  cooldownSeconds: asVolatile(z.number().default(60).description('Rate-limit cooldown per account, in seconds')),
  creditReserves: asVolatile(z.dict(z.number()).default({}).description('Per-account credit floor, keyed by account id')),
  disabledAccountIds: asVolatile(z.array(z.string()).default([]).description('Account ids the pool must never pick')),
  disabledRegions: asVolatile(z.array(z.string()).default([]).description('Regions parked on their own, as source:region')),
  distribution: asVolatile(z.union(['priority', 'round-robin', 'expiry', 'sticky']).default('priority').description('How the WorkBuddy pool spreads requests')),
  modelSelection: asVolatile(z.any().description('Per-gateway model selection')),
  preferredAccountIds: asVolatile(z.any().description('Picked WorkBuddy account per region')),
  preferredSourceAccounts: asVolatile(z.any().description('Picked Trae/Qoder account per region')),
  removedAccounts: asVolatile(z.any().description('Accounts removed from the pool for good')),
  showComposerPoints: asVolatile(z.boolean().default(false).description('Show the active account credits beside the composer')),
  sourceDistributions: asVolatile(z.any().description('How each Trae/Qoder region spreads requests')),
}) as z<Config>

/** Peel one volatile reference, if the running line wrapped it. */
function unwrapVolatile<T>(value: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as unknown as { get(): T }).get()
  }
  return value
}

/**
 * Peel volatile references all the way down.
 *
 * The settings document is validated and cloned whole, so a surviving `{get}`
 * wrapper fails validation with `expected string but got [object Object]` and
 * the section then never renders.
 */
function unwrapVolatileDeep<T>(value: T): T {
  const peeled = unwrapVolatile(value)
  if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry)) as T
  if (peeled !== null && typeof peeled === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(peeled)) out[key] = unwrapVolatileDeep(entry)
    return out as T
  }
  return peeled
}

// --------------------------------------------------------------------- host

interface LlmSeam {
  registerAdapter(providerIds: string[], adapter: unknown): (() => void) | undefined
  registerConfigurableProviders(rows: Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: string[]
    declared: boolean
  }>): (() => void) | undefined
  registerModelDiscovery(
    ns: string,
    fn: (request: { provider?: string }, signal?: AbortSignal) => Promise<Array<{
      id: string
      name: string
      contextWindow?: number
      maxTokens?: number
      inputModalities?: string[]
    }>>,
  ): void
}

interface SettingsService {
  configure?(presentation: { auto?: boolean }, owner?: unknown): (() => void) | undefined
  mutate?(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> | void
}

interface RegisterCommandResult {
  kind: 'success' | 'error'
  text?: string
}

interface CommandsService {
  register(definition: {
    name: string
    description: string
    handler: () => RegisterCommandResult | Promise<RegisterCommandResult>
  }): (() => void) | undefined
}

interface ClientContext {
  llm: LlmSeam
  settings: SettingsService
  commands?: CommandsService
  logger: { info?(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void }
  effect(callback: () => unknown, label?: string): unknown
  inject(names: string[], callback: (scoped: ClientContext) => unknown): unknown
  on(name: string, listener: (...args: unknown[]) => void): (() => void) | undefined
  off?(name: string, listener: (...args: unknown[]) => void): void
  get(name: string): unknown
  emit(name: string, ...args: unknown[]): void
  fiber?: { entry?: { id?: unknown, options?: { id?: string } } }
}

/** The namespace the host actually serves this plugin's settings under. */
function settingsNamespaceOf(ctx: ClientContext): string {
  try {
    // The settings service resolves an entry by `options.id`, so that is the
    // name every write has to carry. The canonical loader id is longer for an
    // entry nested inside a bundle, and using it made every write fail with
    // `No configurable plugin entry`.
    const id = ctx.fiber?.entry?.options?.id
    if (typeof id === 'string' && id !== '') return id
    const canonical = ctx.fiber?.entry?.id
    if (typeof canonical === 'string' && canonical !== '') return canonical
  } catch {
    /* the entry id is not readable on every line */
  }
  return FALLBACK_SETTINGS_NS
}

/** The harness data root: an explicit override, then `$DSH_HOME`, then `~/.dsh`. */
function dshHome(): string {
  const override = String(process.env['DSH_HOME'] ?? '').trim()
  return override === '' ? path.join(os.homedir(), '.dsh') : override
}

/** One pi-ai model descriptor pointing at a loopback gateway. */
function toPiModel(
  row: ProviderDescriptor['models'][number],
  baseUrl: string,
  providerId: string,
): Model<Api> {
  const declared = row.thinkingLevels ?? []
  const advertised = declared.filter((level): level is string =>
    (THINKING_LEVELS as readonly string[]).includes(level))
  const map: Record<string, string | null> | undefined = advertised.length === 0
    ? undefined
    : (() => {
        const out: Record<string, string | null> = {}
        for (const level of THINKING_LEVELS) out[level] = advertised.includes(level) ? level : null
        // `off` is the one level whose *absence* means supported: the gateway
        // switches thinking off by sending no parameter at all, so the key is
        // left out when the row offers it and pinned to null when it does not.
        if (!declared.includes('off')) out['off'] = null
        return out
      })()
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : row.id,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: row.supportsImages === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: typeof row.contextWindow === 'number' ? row.contextWindow : 128_000,
    maxTokens: typeof row.maxTokens === 'number' ? row.maxTokens : 32_000,
    reasoning: map !== undefined,
    ...map === undefined ? {} : { thinkingLevelMap: map },
    compat: { supportsReasoningEffort: map !== undefined },
  } as unknown as Model<Api>
}

/** The attachment store the harness hands the adapter; derived, not re-declared. */
type AttachmentStore = Parameters<typeof resolveImageAttachmentAccess>[0]

/**
 * Whether the resolved pi-ai carries the prompt inside the transcript.
 *
 * The host folds `Context.systemPrompt` and `Context.tools` into a leading
 * `role:"system"` message before a provider sees a request, and only a
 * generation that exports `normalizeContext` reads that message back. Which
 * generation this plugin gets is not its own call: the harness resolves
 * `@earendil-works/pi-ai` through the profile's hoisted linker, so a profile
 * that hoists an older generation hands this provider a transcript its own copy
 * of pi-ai never learned to read.
 */
const PI_AI_FOLDS_TRANSCRIPT = typeof piAi.normalizeContext === 'function'

/** The complete prompt of a leading system message: its text, then its sections. */
function promptText(message: { content?: unknown; sections?: Record<string, unknown> }): string {
  const parts = [piAi.contentText(message.content as string | readonly TextContent[])]
  for (const value of Object.values(message.sections ?? {})) {
    if (typeof value === 'string') parts.push(value)
  }
  return parts.filter((part) => part.length > 0).join('\n\n')
}

/**
 * Re-shape one request context into the form the delegate's own generation reads.
 *
 * A generation without `normalizeContext` has no `role:"system"` handling in
 * either its request converter or its context estimator, so the transcript the
 * host folds either throws there (with string content) or drops the prompt and
 * every tool without a word (with block content). Unfolding restores the
 * `{systemPrompt, tools, messages}` form that generation was written against,
 * which is exactly what the fold undoes. On a generation that does fold, the
 * host's transcript is already the expected shape and passes through untouched.
 */
function contextForDelegate(context: unknown): unknown {
  // A generation that folds reads its own transcript: the host's request is
  // already the shape it expects, and re-shaping it would drop the prompt.
  if (PI_AI_FOLDS_TRANSCRIPT) return context
  const messages = (context as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return context
  const leading = messages[0] as
    | { role?: unknown; content?: unknown; sections?: Record<string, unknown>; toolsAdded?: unknown }
    | undefined
  if (leading?.role !== 'system') return context
  const prompt = promptText(leading)
  const tools = Array.isArray(leading.toolsAdded) ? leading.toolsAdded : undefined
  return {
    ...(prompt.length > 0 ? { systemPrompt: prompt } : {}),
    ...(tools === undefined ? {} : { tools }),
    messages: messages.slice(1),
  }
}

/** Wrap one API implementation so every request arrives in the shape it reads. */
function withDelegateShape(api: ProviderStreams): ProviderStreams {
  return {
    ...api,
    stream: (model, context, options) =>
      api.stream(model, contextForDelegate(context) as TranscriptContext, options),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, contextForDelegate(context) as TranscriptContext, options),
  }
}

/**
 * Build one pi-ai provider per declared row, all served by ONE adapter.
 *
 * `registerAdapter` maps a *set* of providers onto one adapter, so registering
 * each row in its own call would leave only the last one owned. One adapter
 * holding one profile per row is what keeps all six alive at once.
 */
function buildAdapter(descriptors: ProviderDescriptor[], ctx: ClientContext): {
  adapter: PiAiAdapter
  profiles: Map<string, ResolvedPiAiProviderProfile>
  providerIds: string[]
} {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  const providerIds: string[] = []
  for (const row of descriptors) {
    providerIds.push(row.id)
    const models = row.models.map((model) => toPiModel(model, row.baseUrl, row.id))
    const base = createProvider({
      id: row.id,
      name: row.name,
      auth: {
        apiKey: {
          name: 'dsh-wtq-pool loopback endpoint',
          async resolve({ credential }: { credential?: { key?: string } | undefined }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: row.name }
          },
        },
      },
      models,
      api: withDelegateShape(openAICompletionsApi()),
    })
    const provider: Provider = { ...base, getModels: () => models }
    profiles.set(row.id, {
      provider: row.id,
      displayName: row.name,
      streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      retryPolicy: resolveRetryPolicy(undefined, `dsh-wtq-pool.${row.id}.retryPolicy`),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      ...REQUEST_IMAGE_BUDGETS,
      piProvider: provider,
    })
  }
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // The gateways check the bearer's shape, not its value: their real guard is
    // the loopback bind plus the Host/Origin check, and the upstream token is
    // resolved per request from the account pool.
    resolveApiKey: async () => LOOPBACK_BEARER,
    resolveAttachments: () => attachments,
    resolveImageAccess: (store, ref) =>
      resolveImageAttachmentAccess(store, (hostPath) => {
        const fsService = ctx.get('fs') as { processPathFromHostPath?(p: string): string } | undefined
        return fsService?.processPathFromHostPath?.(hostPath)
      }, ref),
  })
  const defaults = new Map(descriptors.map(row => [row.id, new Map(row.models
    .filter(model => model.defaultThinkingLevel !== undefined && model.thinkingLevels?.includes(model.defaultThinkingLevel))
    .map(model => [model.id, model.defaultThinkingLevel!]))]))
  const withOptionsDefault = (options: Parameters<PiAiAdapter['stream']>[0]): Parameters<PiAiAdapter['stream']>[0] => {
    const effort = options.reasoningEffort ?? defaults.get(options.provider)?.get(options.model)
    return effort === undefined ? options : { ...options, reasoningEffort: effort as typeof options.reasoningEffort }
  }
  const withModelDefault = (model: Awaited<ReturnType<PiAiAdapter['resolveModel']>>): typeof model => {
    const effort = defaults.get(model.provider)?.get(model.id)
    return effort === undefined || model.reasoning === undefined ? model : {
      ...model, reasoning: { ...model.reasoning, defaultEffort: effort as typeof model.reasoning.defaultEffort },
    }
  }
  // Prepared calls keep their own stream snapshot, so apply the default there too.
  const resolveModel = adapter.resolveModel.bind(adapter)
  const prepareCall = adapter.prepareCall.bind(adapter)
  const stream = adapter.stream.bind(adapter)
  adapter.resolveModel = async (...args) => withModelDefault(await resolveModel(...args))
  adapter.prepareCall = async (...args) => {
    const call = await prepareCall(...args)
    return { model: withModelDefault(call.model), stream: options => call.stream(withOptionsDefault(options)) }
  }
  adapter.stream = options => stream(withOptionsDefault(options))
  return { adapter, profiles, providerIds }
}

/** A stable rendering of what a registration would serve, to skip no-op writes. */
function registrationFingerprint(descriptors: ProviderDescriptor[]): string {
  return JSON.stringify(descriptors.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    models: row.models.map((model) => [
      model.id,
      model.name,
      model.contextWindow,
      model.maxTokens,
      model.supportsImages === true,
      model.thinkingLevels ?? [],
      model.defaultThinkingLevel,
    ]),
  })))
}

/**
 * Activate the plugin.
 *
 * Order matters: the core's `onLoad` builds the pool and the account client,
 * its registered background service brings the gateways up, and the declaration
 * pass that follows is what hands the six rows to {@link LlmSeam}.
 */
export function apply(ctx: ClientContext, config: Config = {}): void {
  const current = (): Config => unwrapVolatileDeep(config)
  const settingsNamespace = settingsNamespaceOf(ctx)
  const notes: string[] = []
  const released: Array<() => void> = []
  const commands = new Map<string, () => void>()
  const unsubscribes: Array<() => void> = []

  let lastRows: ProviderDescriptor[] = []
  let fingerprint = ''
  let disposeRegistration: (() => void) | undefined
  let stopped = false

  const settingsService = ctx.settings as SettingsService

  /** Replace patched top-level fields without merging their dictionaries. */
  const writeSettings = async (patch: Record<string, unknown>): Promise<void> => {
    const mutate = settingsService?.mutate
    if (mutate === undefined) throw new Error('this host exposes no settings mutate()')
    await mutate.call(settingsService, settingsNamespace,
      Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value })))
  }

  installPi({
    getSettings: () => current() as Record<string, unknown>,
    setSettings: writeSettings,
    getDataPath: async () => {
      const dir = path.join(dshHome(), 'dsh-wtq-pool')
      await fs.mkdir(dir, { recursive: true })
      return dir
    },
    onSettingsChanged: (handler) => {
      const listener = (): void => handler(current() as Record<string, unknown>)
      const dispose = ctx.on('loader/volatile-update', listener)
      if (typeof dispose === 'function') unsubscribes.push(dispose)
      else unsubscribes.push(() => ctx.off?.('loader/volatile-update', listener))
    },
    offSettingsChanged: () => {
      for (const dispose of unsubscribes.splice(0)) dispose()
    },
    notify: (text) => {
      notes.push(text)
      ctx.logger.info?.(`dsh-wtq-pool: ${text}`)
    },
    // The card lives on the Plugins page; say where instead of pretending to
    // focus a window this host does not give the plugin.
    openPanel: () => {
      notes.push('面板在 插件页 → WTQ Pool 卡片')
    },
    registerCommand: async (spec: CommandSpec) => {
      // Through `get`, not the property: `commands` is not one of this plugin's
      // injected services, and this host throws on an uninjected property read.
      const service = ctx.get('commands') as CommandsService | undefined
      if (service === undefined) return
      const commandName = spec.id.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()
      notes.length = 0
      const dispose = service.register({
        name: commandName,
        description: spec.title,
        handler: async (): Promise<RegisterCommandResult> => {
          notes.length = 0
          try {
            await spec.run()
            return { kind: 'success', text: notes.join('\n') || spec.title }
          } catch (error: unknown) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
      if (typeof dispose === 'function') commands.set(spec.id, dispose)
    },
    unregisterCommand: async (id: string) => {
      commands.get(id)?.()
      commands.delete(id)
    },
    /**
     * Publish the provider rows.
     *
     * The core rebuilds its declaration on every account scan, model write and
     * settings change, so this is called often; the fingerprint check turns an
     * unchanged set into a no-op instead of a re-registration storm.
     */
    declareProviders: (descriptors) => {
      // Teardown releases the current registration before `onUnload` runs, and
      // `onUnload` republishes. A write landing after that point would create a
      // registration whose effect lives on the llm service's own fiber - nobody
      // is left holding a disposer for it, and the next activation would then
      // find the routes taken. So a stopped loader answers as a refusal instead.
      if (stopped) return { ok: false, changed: false, error: 'the plugin is unloading' }
      try {
        const next = registrationFingerprint(descriptors)
        if (next === fingerprint) return { ok: true, changed: false }
        // The previous registration goes first: the host refuses a second
        // registration of routes that are still held, so the replacement set
        // cannot be built on top of it.
        disposeRegistration?.()
        disposeRegistration = undefined
        lastRows = []
        if (descriptors.length === 0) {
          fingerprint = next
          ctx.emit('llm/adapters-updated')
          return { ok: true, changed: true, providerCount: 0 }
        }
        const built = buildAdapter(descriptors, ctx)
        const releaseAdapter = ctx.llm.registerAdapter(built.providerIds, built.adapter)
        // Held from here on, before the directory rows are attempted: a throw
        // in the second call must not leave the adapter this one just
        // registered owned by the llm fiber with nothing holding its release,
        // or every later pass fails with a duplicate-route error.
        let releaseRows: (() => void) | undefined
        disposeRegistration = () => {
          releaseAdapter?.()
          releaseRows?.()
        }
        releaseRows = ctx.llm.registerConfigurableProviders(descriptors.map((row) => ({
          provider: row.id,
          displayName: row.name,
          settingsNs: settingsNamespace,
          settingsPath: [],
          declared: false,
        })))
        // Committed only once both registrations are held, so model discovery
        // never advertises a route the host is not serving.
        lastRows = descriptors
        fingerprint = next
        ctx.emit('llm/adapters-updated')
        return { ok: true, changed: true, providerCount: descriptors.length }
      } catch (error: unknown) {
        // Nothing of this attempt is kept: release whatever it registered and
        // clear the fingerprint so the next declaration pass retries it.
        disposeRegistration?.()
        disposeRegistration = undefined
        lastRows = []
        fingerprint = ''
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.error('dsh-wtq-pool: provider registration failed', error)
        return { ok: false, changed: false, error: message }
      }
    },
  })

  // The settings form, on whichever line is running. `installSection` does not
  // exist on 0.2, where `configure` registers the presentation policy and the
  // loader announces edits through `loader/volatile-update`.
  try {
    if (typeof settingsService?.configure === 'function') {
      ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}))
    }
  } catch (error: unknown) {
    ctx.logger.warn?.('dsh-wtq-pool: settings section unavailable', error)
  }

  // Registration is answered from the last declaration, so the discovery hook
  // can afford to be a plain closure. It is bound to the activation effect: an
  // unloaded plugin must not keep answering a namespace it no longer serves.
  ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNamespace, async (request: { provider?: string }) => {
    const wanted = request?.provider
    const rows: Array<{ id: string; name: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[] }> = []
    for (const row of lastRows) {
      if (wanted !== undefined && row.id !== wanted) continue
      for (const model of row.models) {
        rows.push({
          id: model.id,
          name: typeof model.name === 'string' ? model.name : model.id,
          ...typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {},
          ...typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {},
          inputModalities: model.supportsImages === true ? ['text', 'image'] : ['text'],
        })
      }
    }
    return rows
  }), 'dsh-wtq-pool: model discovery')
  ctx.inject(['webServer'], (webCtx) => {
    registerPanelRoutes(webCtx as never, {
      pluginRoot: PLUGIN_ROOT,
      invoke: (channel, payload) => onPanelInvoke(channel, payload),
      // On the child fiber, not the plugin's own: a re-provided `webServer`
      // re-runs this callback, and its effect has to be released with the fiber
      // that owns the routes.
      effect: (callback) => webCtx.effect(callback, 'dsh-wtq-pool: panel routes'),
      logger: ctx.logger,
    })
  })

  ctx.effect(() => async () => {
    stopped = true
    lastRows = []
    // Awaited, not fired and forgotten: the engine keeps its gateways in
    // module-global maps, so a reload that repopulates them while this teardown
    // is still closing the old ones would have the old continuation clear the
    // new activation's entries.
    await stopRegisteredService()
    for (const dispose of commands.values()) dispose()
    commands.clear()
    for (const dispose of unsubscribes.splice(0)) dispose()
    disposeRegistration?.()
    disposeRegistration = undefined
    await onUnload()
  })

  void onLoad()
    .then(() => {
      // Checked here as well as in the catch: a teardown that lands while
      // `onLoad` is still pending must not be followed by this activation
      // starting its gateways back up.
      if (!stopped) return startRegisteredService()
      return undefined
    })
    .catch((error: unknown) => {
      if (stopped) return
      ctx.logger.error('dsh-wtq-pool: activation failed', error)
    })
}

/**
 * The capability surface the plugin core is written against.
 *
 * The core (`host.ts`) was written for a host that hands the plugin process a
 * `pi` object: settings, events, commands, a clipboard, a panel and a provider
 * declaration channel. DeepSeek Harness exposes the same capabilities as Cordis
 * services on the plugin `Context` instead, spread across different service
 * names and shapes.
 *
 * Rather than rewrite the core against each of those services, this module
 * adapts the Cordis context to the shape the core already speaks. `index.ts`
 * calls {@link installPi} once at activation; every method below forwards to
 * the bridge it installs.
 *
 * @module dsh-wtq-pool/pi-compat
 */

import { safeMessage } from './loopback'

/** One model row of a provider declaration. */
export interface ProviderModelDescriptor {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  supportsImages?: boolean
  thinkingLevels?: string[]
  defaultThinkingLevel?: string
}

/** One provider row, as the core publishes it. */
export interface ProviderDescriptor {
  id: string
  name: string
  baseUrl: string
  apiStyle?: string
  authKind?: string
  models: ProviderModelDescriptor[]
}

/** Result of a declaration write, for the panel footer. */
export interface DeclarationResult {
  ok: boolean
  changed: boolean
  error?: string
  /** How many rows the attempt carried; reported in the load-time log line. */
  providerCount?: number
}

/** One host command the core registers. */
export interface CommandSpec {
  id: string
  title: string
  category?: string
  keywords?: string[]
  run: () => unknown
}

/**
 * The host capabilities the core needs.
 *
 * Every member is optional: a host line that lacks one reports a clear refusal
 * at the call site instead of failing the whole activation.
 */
export interface PiBridge {
  /** The settings document the user has saved for this plugin. */
  getSettings?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Merge a partial patch into the settings document; throws when refused. */
  setSettings?: (patch: Record<string, unknown>) => Promise<void> | void
  /** A writable directory this plugin may keep its own files in. */
  getDataPath?: () => Promise<string> | string
  /** Subscribe to settings edits made outside this process. */
  onSettingsChanged?: (handler: (next: Record<string, unknown>) => void) => void
  /** Detach the handler {@link onSettingsChanged} installed. */
  offSettingsChanged?: (handler: (next: Record<string, unknown>) => void) => void
  /** Register a host command. */
  registerCommand?: (spec: CommandSpec) => Promise<void> | void
  /** Remove a host command by id. */
  unregisterCommand?: (id: string) => Promise<void> | void
  /** Report something to the user. */
  notify?: (text: string, kind: 'info' | 'warn') => Promise<void> | void
  /** Bring this plugin's own panel to the front. */
  openPanel?: () => Promise<void> | void
  /** Publish the provider rows; the core calls this on every declaration pass. */
  declareProviders?: (descriptors: ProviderDescriptor[]) => DeclarationResult
}

let bridge: PiBridge = {}

/** Install the host bridge. Called once, before the core's `onLoad`. */
export function installPi(next: PiBridge): void {
  bridge = next
}

/** Report a host without this capability: an optional member is a refusal. */
function absent(): never {
  throw new Error('this host does not expose that capability')
}

/**
 * The object the core is written against.
 *
 * Methods forward to {@link installPi}'s bridge. A capability the host does not
 * provide throws rather than silently succeeding, so the core's own error
 * handling decides what a missing capability means at that call site - and its
 * call sites already wrap these in try/catch.
 */
export const pi = {
  plugin: {
    getSettings: (): Promise<Record<string, unknown>> => {
      if (bridge.getSettings === undefined) return Promise.reject(new Error('no settings service'))
      return Promise.resolve(bridge.getSettings())
    },
    setSettings: async (patch: Record<string, unknown>): Promise<void> => {
      if (bridge.setSettings === undefined) absent()
      await bridge.setSettings(patch)
    },
    getDataPath: async (): Promise<string> => {
      if (bridge.getDataPath === undefined) absent()
      return await bridge.getDataPath()
    },
  },
  events: {
    on: (name: string, handler: (next: Record<string, unknown>) => void): void => {
      if (name === 'plugin:settingsChanged' && bridge.onSettingsChanged !== undefined) {
        bridge.onSettingsChanged(handler)
        return
      }
      absent()
    },
    off: (name: string, handler: (next: Record<string, unknown>) => void): void => {
      if (name === 'plugin:settingsChanged' && bridge.offSettingsChanged !== undefined) {
        bridge.offSettingsChanged(handler)
        return
      }
      absent()
    },
  },
  commands: {
    register: async (spec: CommandSpec): Promise<void> => {
      if (bridge.registerCommand === undefined) absent()
      await bridge.registerCommand(spec)
    },
    unregister: async (id: string): Promise<void> => {
      if (bridge.unregisterCommand === undefined) absent()
      await bridge.unregisterCommand(id)
    },
  },
  ui: {
    showToast: async (text: string, kind?: string): Promise<void> => {
      if (bridge.notify === undefined) absent()
      await bridge.notify(text, kind === 'warn' ? 'warn' : 'info')
    },
    openPanel: async (): Promise<void> => {
      if (bridge.openPanel === undefined) absent()
      await bridge.openPanel()
    },
  },
  services: {
    /**
     * The background services the core registers, whose `start` brings every
     * gateway up. Cordis has no second lifecycle stage to hang that on, so the
     * hooks are stashed here for the entry to run itself; `stop` is what the
     * entry's cleanup calls. Keyed by the service's own id, so a registration
     * that repeats one replaces it rather than leaving a second start/stop pair
     * beside a first that is still the only one called.
     */
    register: (service: { id: string; start: () => unknown; stop: () => unknown }): void => {
      services.set(service.id, { start: service.start, stop: service.stop })
    },
  },
  /**
   * Publish provider rows.
   *
   * The host registers providers at runtime rather than reading them from a
   * file, so the callers see the same argument and the same result shape with
   * nothing to reconcile on disk.
   */
  declareProviders: (descriptors: ProviderDescriptor[]): DeclarationResult => {
    if (bridge.declareProviders === undefined) return { ok: false, changed: false, error: 'no provider channel' }
    return bridge.declareProviders(descriptors)
  },
}

/** The hooks the services above registered, in registration order. */
const services = new Map<string, { start: () => unknown; stop: () => unknown }>()

/**
 * Run every service the core registered, if it did.
 *
 * One service's failure must not skip the ones after it: they are registered
 * independently, and a service that never started is a gateway that never
 * bound, which the panel then reports as missing with no reason attached.
 */
export async function startRegisteredService(): Promise<void> {
  for (const service of services.values()) {
    try {
      await service.start()
    } catch (error) {
      // Redacted like every other message this plugin hands out: a start
      // rejection can quote the credential or the absolute path it was reading.
      console.warn('[dsh-wtq-pool] service failed to start:', safeMessage(error))
    }
  }
}

/**
 * Stop every service the core registered, if it did.
 *
 * One service's failure must not skip the ones after it: a gateway that never
 * closed holds its port, and the next start falls back to a temporary one.
 *
 * The map is deliberately NOT cleared. Disabling and re-enabling the plugin
 * runs stop and then start with no load in between, and clearing it here left
 * the re-enable with nothing to start: the gateways never came back until a
 * full reload. Registration is keyed by id, so the next load overwrites rather
 * than accumulates.
 */
export async function stopRegisteredService(): Promise<void> {
  for (const service of services.values()) {
    try {
      await service.stop()
    } catch (error) {
      console.warn('[dsh-wtq-pool] service failed to stop:', safeMessage(error))
    }
  }
}

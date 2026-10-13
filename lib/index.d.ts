import z from "@deepseek-ai/schemastery";
import { SettingsPathOp } from "@deepseek-ai/dsh-settings";
//#region src/host.d.ts
/**
 * dsh-wtq-pool - the plugin's engine.
 *
 * Merges every WorkBuddy, Trae and Qoder desktop sign-in on this machine into
 * one model pool that fails over on its own:
 *
 *   1. discover every sign-in on this machine (read-only),
 *   2. serve each vendor edition from its own loopback OpenAI-compatible
 *      endpoint,
 *   3. publish those endpoints as six providers,
 *   4. rotate to the next account whenever the upstream answers 429.
 *
 * This file is the engine, not the entry: `index.ts` owns the Cordis
 * activation and the provider registrations, and `pi-compat.ts` is the bridge
 * between the two. Everything below is written against that bridge.
 *
 * Upstream traffic uses the platform `fetch` rather than a host network bridge:
 * a bridged response is buffered into text, and a provider contract needs the
 * upstream SSE body relayed as it arrives. Nothing leaves this machine except
 * to the three vendors' own endpoints.
 */
declare function onPanelInvoke(channel: any, payload: any): Promise<any>;
declare function onLoad(): Promise<void>;
declare function onUnload(): Promise<void>;
//#endregion
//#region src/index.d.ts
/** The Cordis row id; also the settings namespace this plugin is served under. */
declare const name = "llm-dsh-xdpool";
/**
 * `settings` is declared so the host renders this plugin's own section instead
 * of reading `undefined` while it builds the provider list; `llm` is the seam
 * the six providers register into.
 */
declare const inject: string[];
/**
 * Every field is marked volatile.
 *
 * The settings write gate refuses an entry whose schema declares no volatile
 * field at all, and `describe()` skips such an entry, so an unmarked schema
 * means the card can neither render nor save. Reading a volatile field hands
 * back the live value once peeled (see {@link unwrapVolatile}).
 */
interface Config {
  /** Master switch. A missing value reads as enabled. */
  enabled?: boolean;
  /** Per-vendor switches; a vendor whose switch is off gets no gateway. */
  sourceWorkbuddy?: boolean;
  sourceTrae?: boolean;
  sourceQoder?: boolean;
  /** Explicit WorkBuddy desktop auth-file path override. */
  authFile?: string;
  /** Daily check-in: whether it runs, and at which local hours. */
  autoCheckin?: {
    enabled?: boolean;
    hours?: number[];
  };
  /** Rate-limit cooldown per account, in seconds. */
  cooldownSeconds?: number;
  /** Per-account credit floor, keyed by account id. */
  creditReserves?: Record<string, number>;
  /** Account ids switched off on the panel. */
  disabledAccountIds?: string[];
  /** Regions parked on their own, as `source:region` keys. */
  disabledRegions?: string[];
  /** How the WorkBuddy pool spreads requests. */
  distribution?: 'priority' | 'round-robin' | 'expiry' | 'sticky';
  /** Per-gateway model selection, keyed by gateway. */
  modelSelection?: Record<string, unknown>;
  /** Picked WorkBuddy account per region. */
  preferredAccountIds?: Record<string, string>;
  /** Picked Trae/Qoder account per region. */
  preferredSourceAccounts?: Record<string, string>;
  /** Accounts removed from the pool for good, with their label kept. */
  removedAccounts?: unknown[];
  /** Whether the credits readout is shown beside the composer. */
  showComposerPoints?: boolean;
  /** How each Trae/Qoder region spreads requests. */
  sourceDistributions?: Record<string, string>;
}
declare const Config: z<Config>;
interface LlmSeam {
  registerAdapter(providerIds: string[], adapter: unknown): (() => void) | undefined;
  registerConfigurableProviders(rows: Array<{
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: string[];
    declared: boolean;
  }>): (() => void) | undefined;
  registerModelDiscovery(ns: string, fn: (request: {
    provider?: string;
  }, signal?: AbortSignal) => Promise<Array<{
    id: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
    inputModalities?: string[];
  }>>): void;
}
interface SettingsService {
  configure?(presentation: {
    auto?: boolean;
  }, owner?: unknown): (() => void) | undefined;
  mutate?(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> | void;
}
interface RegisterCommandResult {
  kind: 'success' | 'error';
  text?: string;
}
interface CommandsService {
  register(definition: {
    name: string;
    description: string;
    handler: () => RegisterCommandResult | Promise<RegisterCommandResult>;
  }): (() => void) | undefined;
}
interface ClientContext {
  llm: LlmSeam;
  settings: SettingsService;
  commands?: CommandsService;
  logger: {
    info?(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  effect(callback: () => unknown, label?: string): unknown;
  inject(names: string[], callback: (scoped: ClientContext) => unknown): unknown;
  on(name: string, listener: (...args: unknown[]) => void): (() => void) | undefined;
  off?(name: string, listener: (...args: unknown[]) => void): void;
  get(name: string): unknown;
  emit(name: string, ...args: unknown[]): void;
  fiber?: {
    entry?: {
      id?: unknown;
      options?: {
        id?: string;
      };
    };
  };
}
/**
 * Activate the plugin.
 *
 * Order matters: the core's `onLoad` builds the pool and the account client,
 * its registered background service brings the gateways up, and the declaration
 * pass that follows is what hands the six rows to {@link LlmSeam}.
 */
declare function apply(ctx: ClientContext, config?: Config): void;
//#endregion
export { Config, apply, inject, name, onLoad, onPanelInvoke, onUnload };
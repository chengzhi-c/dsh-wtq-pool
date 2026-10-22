/**
 * Model catalog with per-model credit multipliers and the user's overrides.
 *
 * A static fallback keeps the provider usable before the first successful
 * upstream call; when the live catalog arrives it replaces the fallback and the
 * provider rebuilds its model list from `visible()`.
 *
 * @module dsh-wtq-pool/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream'

/** One model the provider exposes. */
export interface WorkBuddyModelInfo {
  id: string
  /** Catalog name, as the upstream advertises it. */
  name: string
  /**
   * The user's display-name override (the panel's alias field). It becomes the
   * picker label and the host stores it as the binding's `alias`, so it
   * survives a reload; the wire request still uses `id`.
   */
  alias?: string
  contextWindow: number
  maxOutputTokens: number
  /** Relative credit cost, e.g. 0.79 for `x0.79`. */
  multiplier?: number
  /** Thinking levels the picker may offer. Upstream-declared unless overridden. */
  supportedEfforts?: readonly string[]
  /**
   * Whether the upstream lets thinking be switched off outright. Carried
   * through from `reasoning.canDisableThinking` because the picker only offers
   * an "off" entry when the upstream accepts it; otherwise the lowest declared
   * level is the floor, and inventing an "off" would promise a control that
   * changes nothing upstream.
   */
  canDisableThinking?: boolean
  /** The level a new session opens on, when it is one of the offered levels. */
  defaultThinkingLevel?: string
  supportsImages: boolean
}

/** Static fallback used before the first live catalog fetch. */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: false },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'hy3', name: 'Hy3', contextWindow: 200_000, maxOutputTokens: 128_000, supportsImages: true },
  { id: 'hy4-preview', name: 'Hy4-Preview', contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
]

/**
 * One model's user-editable fields, exactly as the panel's editor writes them.
 *
 * Every field is optional and independently applied: an absent field keeps the
 * catalog value, so a partially-filled override cannot blank the rest.
 */
export interface ModelOverride {
  /** Display-name override. An empty string clears it. */
  alias?: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  /** The levels to offer. An empty list keeps the upstream's own set. */
  thinkingLevels?: readonly string[]
  /** Which offered level a new session opens on. */
  defaultThinkingLevel?: string
}

/** Live catalog with a static fallback behind it. */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS
  private live = false
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection: ModelSelection = {}

  /**
   * Whether the roster in force came from the upstream.
   *
   * False means the static fallback is still standing: this plugin's own guess,
   * not a list the vendor answered with. A saved selection cannot be judged
   * against a guess - doing it reported every model the vendor had added since
   * the fallback was written as retired, and said so on every start for as long
   * as the live read kept failing.
   */
  hasLiveRoster(): boolean {
    return this.live
  }

  /** The catalog as the upstream advertises it, before any override. */
  current(): readonly WorkBuddyModelInfo[] {
    return this.models
  }

  /**
   * The models the provider actually serves, after the user's selection:
   * disabled models are dropped, and each survivor carries its own override.
   *
   * An absent `enabledModelIds` means "everything" - a fresh install with no
   * saved selection must not present an empty picker.
   */
  visible(): readonly WorkBuddyModelInfo[] {
    const enabled = this.selection.enabledModelIds
    const allow = enabled === undefined ? undefined : new Set(enabled)
    const overrides = this.selection.overrides ?? {}
    const bounded = this.live
    return this.models
      .filter(model => allow === undefined || allow.has(model.id))
      .map(model => applyOverride(model, overrides[model.id], bounded))
  }

  /**
   * Replace the catalog with the upstream's own list.
   *
   * An empty list keeps what is there: the static fallback is what a fresh
   * install publishes before any read succeeds, and a wipe here would leave the
   * gateway with nothing to declare. What counts as an answer is decided in
   * `catalogFromUpstream` before this is reached.
   */
  update(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) return
    this.models = models
    this.live = true
  }

  /** Replace the user's selection; the model list is rebuilt from `visible()`. */
  applySelection(selection: ModelSelection): void {
    this.selection = selection
  }
}

/**
 * Fold one override onto a catalog entry.
 *
 * A non-positive window or ceiling is ignored rather than stored: the host
 * rejects a zero value, so writing one would drop the row's number entirely.
 *
 * `bounded` is the catalog's own provenance: when the roster in force came from
 * the upstream, an override may lower a limit but never raise it above what the
 * vendor advertises. The host trusts the declared figure to size its context
 * budget and its compaction threshold, so a window larger than the model really
 * accepts made the host believe it had room the upstream does not have, and the
 * reply was truncated or compacted well before the declared window was full.
 * When the static fallback is still standing the figures are this plugin's own
 * guess, and clamping to them would overwrite a correct saved value with a
 * smaller invented one.
 */
export function applyOverride(
  model: WorkBuddyModelInfo,
  override: ModelOverride | undefined,
  bounded = false,
): WorkBuddyModelInfo {
  const next: WorkBuddyModelInfo = { ...model }
  if (override === undefined) return next
  if (override.alias !== undefined) {
    const alias = override.alias.trim()
    if (alias === '') delete next.alias
    else next.alias = alias
  }
  if (override.contextWindow !== undefined && override.contextWindow > 0) {
    next.contextWindow = bounded
      ? Math.min(override.contextWindow, model.contextWindow)
      : override.contextWindow
  }
  if (override.maxOutputTokens !== undefined && override.maxOutputTokens > 0) {
    next.maxOutputTokens = bounded
      ? Math.min(override.maxOutputTokens, model.maxOutputTokens)
      : override.maxOutputTokens
  }
  if (override.supportsImages !== undefined) next.supportsImages = override.supportsImages
  if (override.thinkingLevels !== undefined && override.thinkingLevels.length > 0) {
    next.supportedEfforts = override.thinkingLevels
  }
  if (override.defaultThinkingLevel !== undefined) {
    next.defaultThinkingLevel = override.defaultThinkingLevel
  }
  return next
}

/** True when the override changes at least one field, i.e. the row shows "高级". */
export function hasOverride(override: ModelOverride | undefined): boolean {
  if (override === undefined) return false
  return override.alias !== undefined
    || override.contextWindow !== undefined
    || override.maxOutputTokens !== undefined
    || override.supportsImages !== undefined
    || override.thinkingLevels !== undefined
    || override.defaultThinkingLevel !== undefined
}

/** The user's model selection, as stored in the plugin settings file. */
export interface ModelSelection {
  /** Absent = every model in the catalog is offered. */
  enabledModelIds?: readonly string[]
  /** Per-model edits, keyed by model id. Absent = every model follows the catalog. */
  overrides?: Readonly<Record<string, ModelOverride | undefined>>
  /**
   * Shapes written by an earlier version. Still read, so an existing settings
   * file keeps working; the host entry folds them into `overrides` on read.
   */
  imageModelIds?: readonly string[]
  contextBudgets?: Readonly<Record<string, number | undefined>>
}

/** Convert one upstream catalog entry into the plugin's model-info shape. */
export function toModelInfo(model: WorkBuddyUpstreamModel): WorkBuddyModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    supportsImages: model.supportsImages ?? false,
    ...model.creditMultiplier === undefined ? {} : { multiplier: model.creditMultiplier },
    ...model.reasoning?.supportedEfforts === undefined ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
    // The upstream's own default, so a model that starts at a non-minimum level
    // publishes that one instead of the plugin's fallback. The declaration only
    // carries it when the level is actually offered, so an upstream that names a
    // level its own roster does not list cannot produce an unusable default.
    ...model.reasoning?.defaultEffort === undefined ? {} : { defaultThinkingLevel: model.reasoning.defaultEffort },
    ...model.reasoning?.canDisableThinking === undefined
      ? {}
      : { canDisableThinking: model.reasoning.canDisableThinking },
  }
}

/** Map the live upstream list, falling back to the static list when empty. */
export function catalogFromUpstream(models: readonly WorkBuddyUpstreamModel[]): readonly WorkBuddyModelInfo[] {
  if (models.length === 0) return FALLBACK_WORKBUDDY_MODELS
  return models.map(toModelInfo)
}

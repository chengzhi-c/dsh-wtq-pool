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
  /** User's model selection. Empty object = follow the catalog unfiltered. */
  private selection: ModelSelection = {}

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
    return this.models
      .filter(model => allow === undefined || allow.has(model.id))
      .map(model => applyOverride(model, overrides[model.id]))
  }

  /**
   * Replace the catalog with the upstream's own list.
   *
   * An empty list keeps what is there: a read that failed is not the upstream
   * saying it has no models, and the fallback behind this class is what a fresh
   * install starts from.
   */
  update(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) return
    this.models = models
  }

  /** Replace the user's selection; the model list is rebuilt from `visible()`. */
  applySelection(selection: ModelSelection): void {
    this.selection = selection
  }

  /** Replace the catalog from the live upstream list; keeps the fallback if empty. */
  updateFromUpstream(models: readonly WorkBuddyUpstreamModel[]): void {
    this.update(catalogFromUpstream(models))
  }

}

/**
 * Fold one override onto a catalog entry.
 *
 * A non-positive window or ceiling is ignored rather than stored: the host
 * rejects a zero value, so writing one would drop the row's number entirely.
 */
export function applyOverride(
  model: WorkBuddyModelInfo,
  override: ModelOverride | undefined,
): WorkBuddyModelInfo {
  const next: WorkBuddyModelInfo = { ...model }
  if (override === undefined) return next
  if (override.alias !== undefined) {
    const alias = override.alias.trim()
    if (alias === '') delete next.alias
    else next.alias = alias
  }
  if (override.contextWindow !== undefined && override.contextWindow > 0) {
    next.contextWindow = override.contextWindow
  }
  if (override.maxOutputTokens !== undefined && override.maxOutputTokens > 0) {
    next.maxOutputTokens = override.maxOutputTokens
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

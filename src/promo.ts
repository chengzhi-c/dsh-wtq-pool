/**
 * Time-boxed promotional windows, which the gateway does not model.
 *
 * Why this is not read from the catalog: the announcements describe promotions
 * the API has no field for. Verified against the live endpoints — Hy4-preview's
 * night window reports `credits: "x0.29"` around the clock, with nothing that
 * says the price depends on the hour. A model whose price really is zero (Hy3
 * domestically) needs no rule here: the catalog already says so.
 *
 * Rules are declared as data, so a new campaign is a table entry and an expiry
 * is automatic: once `until` passes the rule stops applying on its own, which
 * is the only way a time-boxed offer can be encoded without someone having to
 * remember to delete it.
 *
 * @module dsh-wtq-pool/promo
 */

import type { WorkBuddyRegion } from './upstream'

/** A model-id prefix a promotion covers, and the window it is free in. */
export interface PromoRule {
  /**
   * Matched against the model id as a PREFIX.
   *
   * Prefix rather than equality because the gateway ships sibling ids for one
   * product line (`hy4-preview`, `hy4-preview-x`); a promotion covers the
   * family, not one spelling.
   */
  idPrefix: string
  /**
   * Which gateway this promotion belongs to.
   *
   * Load-bearing, not decoration: these announcements are REGIONAL. The
   * domestic window would be an invented discount on the international roster,
   * whose sibling models are priced all day.
   */
  region: WorkBuddyRegion
  /**
   * Clock hours the window is open in, inclusive.
   *
   * A plain set rather than a start/end pair because the window CROSSES
   * MIDNIGHT: 23 and 0-7 are all "inside".
   */
  hours: readonly number[]
  /**
   * Last day the promotion applies, `YYYY-MM-DD`, inclusive.
   *
   * Required rather than optional: an announcement is always time-boxed, and a
   * rule that silently lives forever is how a plugin promises a discount months
   * after it lapsed.
   */
  until: string
}

/**
 * Promotions in force.
 *
 * Source: the WorkBuddy announcement extending Hy4-preview's night window
 * (23:00-08:00 domestic, "其余时间正常消耗积分") to 2026-10-31.
 *
 * When a promotion is extended or a new one starts, edit this table. When one
 * ends, either delete the row or let `until` lapse — both stop the badge.
 */
export const PROMO_RULES: readonly PromoRule[] = [
  { idPrefix: 'hy4-preview', region: 'cn', hours: [23, 0, 1, 2, 3, 4, 5, 6, 7], until: '2026-10-31' },
]

/**
 * The campaign clock: calendar day and hour of one instant.
 *
 * Passed in rather than read from a `Date` here, because the promotions are
 * announced in the campaign's zone (Beijing) and the host machine may be set to
 * any zone. The caller already converts for the check-in schedule, so this
 * module does not carry a second copy of that conversion.
 */
export interface PromoClock {
  /** `YYYY-MM-DD` in the campaign zone. */
  day: string
  /** Hour of the day, 0-23, in the campaign zone. */
  hour: number
}

/** Why a model is worth flagging right now. */
export type PromoStatus =
  /**
   * Inside the window. `untilHour` is when it closes, so the row can say "free
   * until 08:00" rather than just "free" — the same model costs credits an hour
   * later, and the difference is the whole point of the badge.
   */
  | { kind: 'night'; untilHour: number }
  /**
   * Covered by a promotion, but outside its window.
   *
   * Distinct from "no promotion" on purpose: waiting is cheaper, and the row
   * says so without claiming the model is free right now.
   */
  | { kind: 'night-later'; nextHour: number }

/** The first hour the window reopens, searching forward from `hour`. */
function nextWindowHour(rule: PromoRule, hour: number): number | undefined {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24
    if (rule.hours.includes(candidate)) return candidate
  }
  return undefined
}

/** The hour the CURRENT window closes, searching forward from `hour`. */
function windowEndHour(rule: PromoRule, hour: number): number {
  for (let step = 1; step <= 24; step += 1) {
    const candidate = (hour + step) % 24
    if (!rule.hours.includes(candidate)) return candidate
  }
  return hour
}
/**
 * The promotion status of one model at `clock`, for `region`.
 *
 * Returns `undefined` for a model with no promotion, for one whose price is
 * already zero (the catalog says "free" and the panel already shows it, so a
 * second badge would only repeat it), and for every rule whose window is not
 * this model's.
 */
export function promoStatusFor(
  model: { id: string; multiplier?: number },
  clock: PromoClock,
  region: WorkBuddyRegion,
): PromoStatus | undefined {
  if (model.multiplier === 0) return undefined

  for (const rule of PROMO_RULES) {
    if (rule.region !== region) continue
    if (!model.id.startsWith(rule.idPrefix)) continue
    // String comparison is safe for `YYYY-MM-DD` and needs no date parsing.
    if (clock.day > rule.until) continue
    if (rule.hours.includes(clock.hour)) {
      return { kind: 'night', untilHour: windowEndHour(rule, clock.hour) }
    }
    const nextHour = nextWindowHour(rule, clock.hour)
    if (nextHour !== undefined) {
      return { kind: 'night-later', nextHour }
    }
  }
  return undefined
}

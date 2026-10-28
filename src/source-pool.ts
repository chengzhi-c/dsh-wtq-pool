/**
 * The account pool the Trae and Qoder gateways share.
 *
 * `WorkBuddyAccountPool` cools an account the moment the upstream refuses it, so
 * the next request never pays the same failure twice. The two source gateways
 * rotate only inside one request: nothing remembered a spent allowance, and
 * with a single sign-in every request paid one failed round trip before the
 * upstream's own answer, while the client was being told to wait hours. The
 * wait the upstream states is honoured; anything else takes the user's own
 * cooldown setting, the same pace the pool uses for a soft limit.
 *
 * The plugin owns the settings each of those decisions reads, so they are handed
 * in once rather than reached for: the pool itself stays a plain function of its
 * arguments plus the state below, which is what lets a check drive it directly.
 *
 * @module dsh-wtq-pool/source-pool
 */

import { retryAfterHeader } from './loopback'

/** A sign-in as the gateways hand it over; only its expiry is read here. */
export interface SourceCredential {
  expiresAtMs?: number
}

/** The settings-backed readers the pool needs, owned by the plugin that hosts it. */
export interface SourcePoolHost {
  /** How long a refused sign-in is held when the upstream named no wait of its own. */
  cooldownMs(): number
  /** The account the user picked for one source region; "" means automatic. */
  preferredSourceAccount(source: string, region: string): string
  /** How one source spreads requests when no account is picked for the region. */
  sourceDistribution(source: string): string
  /** Storage key for one source region's picked account. */
  sourceRegionKey(source: string, region: string): string
}

/** One pool's state, and the decisions made from it. */
export interface SourcePool {
  /** account key -> the timestamp that account's soonest one-off pack runs out at. */
  sourceCreditExpiry: Map<string, number>
  /** region key -> how far round-robin has walked that region's live accounts. */
  sourceRotation: Map<string, number>
  /** account key -> the timestamp that account's failure hold ends at. */
  sourceFailureHold: Map<string, number>
  sourceCredentialExpired(credential: SourceCredential, now: number): boolean
  /** The key both per-account maps are stored under. */
  accountStateKey(source: string, region: string, label: string): string
  noteSourceFailure(source: string, region: string, label: string, retryAfter?: string | null): void
  packUrgency(source: string, region: string, label: string, now: number): number
  orderSourceCredentials<T extends SourceCredential>(
    source: string,
    region: string,
    credentials: readonly T[],
    labelOf: (credential: T) => string,
    rotate: boolean | "peek",
  ): T[]
}

/** Build the pool the Trae and Qoder gateways share, wired to the host's readers. */
export function createSourcePool(host: SourcePoolHost): SourcePool {
  /**
   * The key one account's state is stored under.
   *
   * The region belongs in it: one label can name a copy in each region (the
   * scanner keys its rows by label *and* region for exactly that reason), so a
   * key without it hands one region's hold and pack expiry to the other region's
   * account.
   */
  function accountStateKey(source: string, region: string, label: string): string {
    return host.sourceRegionKey(source, region) + "\n" + label
  }

  /** account key -> the timestamp that account's soonest one-off pack runs out at. */
  const sourceCreditExpiry = new Map<string, number>()

  /** Unknown expiry sorts last, so it never beats a real deadline. */
  function packUrgency(source: string, region: string, label: string, now: number): number {
    const at = sourceCreditExpiry.get(accountStateKey(source, region, label))
    return typeof at === "number" && at > now ? at : Infinity
  }

  /** Where each source region's rotation stands. Advanced once per chat, never by a directory or health read. */
  const sourceRotation = new Map<string, number>()

  /**
   * Until when a Trae or Qoder sign-in that just failed is kept out of the lead,
   * keyed the way `sourceCreditExpiry` is.
   */
  const sourceFailureHold = new Map<string, number>()

  function noteSourceFailure(source: string, region: string, label: string, retryAfter?: string | null): void {
    const stated = retryAfterHeader(retryAfter)
    const waitMs = stated === undefined ? host.cooldownMs() : Number(stated) * 1000
    sourceFailureHold.set(accountStateKey(source, region, label), Date.now() + waitMs)
  }

  /** Whether one sign-in is inside the hold a failure put on it. */
  function sourceFailureActive(source: string, region: string, label: string, now: number): boolean {
    const key = accountStateKey(source, region, label)
    const until = sourceFailureHold.get(key)
    if (until === undefined) return false
    if (until <= now) {
      sourceFailureHold.delete(key)
      return false
    }
    return true
  }


  /** A sign-in with no expiry is still usable. Only a timestamp that has passed is dead. */
  function sourceCredentialExpired(credential: SourceCredential, now: number): boolean {
    return typeof credential.expiresAtMs === "number" && credential.expiresAtMs > 0 && credential.expiresAtMs <= now
  }

  /**
   * One source region's credentials, in the order its gateway should try them:
   * the picked account first, then tokens that still work before expired ones,
   * and a sign-in the upstream just refused behind the healthy ones.
   *
   * The gateways take the first usable entry and re-read this list per request,
   * so this order is the whole of "which account serves this region" — and
   * putting a live token ahead of a dead one is what keeps a stale sign-in from
   * being the one that answers.
   *
   * A picked account is what the user asked to spend, so it leads in every mode;
   * only "automatic" leaves the choice to the usage mode. Round-robin then walks
   * the list one account per chat. `rotate` is false for model-list and health
   * reads: advancing the cursor there would make the account a chat lands on
   * depend on whichever read ran last.

   */
  function orderSourceCredentials<T extends SourceCredential>(
    source: string,
    region: string,
    credentials: readonly T[],
    labelOf: (credential: T) => string,
    rotate: boolean | "peek",
  ): T[] {
    const now = Date.now()
    const stored = host.preferredSourceAccount(source, region)
    // A stored label only counts while some credential still carries it. The
    // label is the account's own name (`accountName ?? email ?? userId`), so
    // renaming or re-signing in retires it; treating the retired label as a live
    // preference returned here before rotation and the expiry sort could run, and
    // the panel went on showing round-robin while one account served every chat.
    const preferred = stored !== "" && credentials.some((credential) => labelOf(credential) === stored)
      ? stored
      : ""
    const rank = (credential: T): number => {
      const expired = sourceCredentialExpired(credential, now) ? 1 : 0
      // A sign-in the upstream just refused is tried last among the live ones:
      // the request still falls back to it when it is all there is, but a
      // healthy one answers first instead of every request paying the failure.
      const held = expired === 0 && sourceFailureActive(source, region, labelOf(credential), now) ? 1 : 0
      const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1
      return expired * 4 + held * 2 + wanted
    }
    const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right))
    if (preferred === "" && host.sourceDistribution(source) === "expiry") {
      const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now))
      const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now))
      // Urgency decides the order, but only among the accounts that can still
      // answer: a sign-in the upstream just refused is demoted by `rank` for the
      // same reason it is kept out of the rotation, and re-sorting the whole
      // live set by pack urgency put it straight back in the lead whenever it
      // happened to hold the soonest-expiring pack.
      const healthy = live.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now))
      const held = live.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now))
      const byUrgency = (left: T, right: T) =>
        packUrgency(source, region, labelOf(left), now) - packUrgency(source, region, labelOf(right), now)
      healthy.sort(byUrgency)
      held.sort(byUrgency)
      return healthy.concat(held, rest)
    }
    // Rotation may only shuffle the accounts that can still answer: leading with
    // an expired token would spend the request on a failure first. A sign-in the
    // upstream just refused is demoted by `rank` for the same reason, so it stays
    // out of the shuffled segment entirely rather than being shuffled back into
    // the lead on the turn the cursor lands on it.
    const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now))
    const peek = rotate === "peek"
    if ((rotate !== true && !peek) || preferred !== "" || live.length < 2 || host.sourceDistribution(source) !== "round-robin") return ordered
    const healthy = live.filter((credential) => !sourceFailureActive(source, region, labelOf(credential), now))
    const held = live.filter((credential) => sourceFailureActive(source, region, labelOf(credential), now))
    if (healthy.length < 2) return ordered
    const key = host.sourceRegionKey(source, region)
    const step = (sourceRotation.get(key) ?? 0) % healthy.length
    // A preview names the account this request would use without consuming the
    // turn: a panel read must not decide which account the next chat lands on.
    if (!peek) sourceRotation.set(key, step + 1)
    const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now))
    return healthy.slice(step).concat(healthy.slice(0, step), held, rest)
  }

  return {
    sourceCreditExpiry,
    sourceRotation,
    sourceFailureHold,
    sourceCredentialExpired,
    accountStateKey,
    noteSourceFailure,
    packUrgency,
    orderSourceCredentials,
  }
}

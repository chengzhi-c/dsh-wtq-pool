/*
 * This file is a transcription of the plugin's original untyped JavaScript
 * engine, kept line-for-line so the pool's behaviour is unchanged. It carries no
 * type annotations, so it is exempted from `strict` checking; the typed
 * integration around it (`index.ts`, `pi-compat.ts`, `web-panel.ts`, the client
 * half) is checked normally.
 */
// @ts-nocheck
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

import * as path from 'node:path'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { AsyncLocalStorage } from 'node:async_hooks'

import { WorkBuddyAccountPool, candidateAuthDirs, ownSignInDir, writeOwnSignIn } from './accounts'
import {
  WorkBuddyCatalog,
  applyOverride,
  catalogFromUpstream,
  hasOverride,
} from './catalog'
import { createWorkBuddyShim } from './shim'
import {
  CHECKIN_POLL_MS,
  checkinSlotId,
  dueCheckinSlot,
  normaliseCheckinHours,
  zonedDay,
  zonedDayHour,
} from './checkin-time'
import { WorkBuddyUpstreamClient, regionOf, isBuddyThresholdIncomplete } from './upstream'
import { promoStatusFor } from './promo'
import { discoverTraeCredentials, traeRegionOfCredential, traeStorageCandidates, traeWindowsAppNames, resetTraeCredentialCache } from './trae-discovery'
import { createTraeGateway } from './trae-gateway'
import { pickTraeStorageIdentity, resolveTraeIdentity, TRAE_STORAGE_MISSING_PREFIX } from './trae-identity'
import { TraeSoloUpstreamClient, TRAE_CHECKIN_DEVICE_CLAIMED, traeVariantFor } from './trae-upstream'
import { discoverQoderCredentials, resetQoderCredentialCache } from './qoder-credentials'
import { createQoderGateway } from './qoder-gateway'
import { QoderUpstreamClient, qoderClaimableCampaignIdOf, qoderCheckinStateFrom, qoderNormalizeClaimResult, qoderRewardExpiryMs, qoderRewardValidityDaysOf } from './qoder-client'
import { safeMessage } from './loopback'
import { startDeviceLogin, pollDeviceLogin } from './login'
import { createSourcePool } from './source-pool'
import { atRestKeyFailure } from './at-rest'
import { pi } from './pi-compat'

/** The one background service this plugin registers. */
const SERVICE_ID = "provider-host";

/** The two gateways, matching the provider ids this plugin registers. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = { cn: "wtqpool-cn", global: "wtqpool-global" };
const PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool (CN)",
  global: "WTQ Pool (Global)",
};
/** The settings key each source's switch is stored under. */
const SOURCE_SETTING_KEYS = {
  workbuddy: "sourceWorkbuddy",
  trae: "sourceTrae",
  qoder: "sourceQoder",
};
/**
 * The settings key behind one source name, or undefined for anything else.
 *
 * The own-property test is load-bearing: a bare `SOURCE_SETTING_KEYS[source]`
 * answers for `toString`, `constructor` and `__proto__` from the prototype, so a
 * crafted `source` would save under a junk key instead of being refused.
 */
function sourceSettingKey(source) {
  return typeof source === "string" && Object.hasOwn(SOURCE_SETTING_KEYS, source)
    ? SOURCE_SETTING_KEYS[source]
    : undefined;
}
/** Whether one source is switched on in settings. Unknown sources stay off, so a typo can never enable a gateway. */
function sourceEnabled(source) {
  const key = sourceSettingKey(source);
  return key !== undefined && settings.enabled !== false && settings[key] !== false;
}
/**
 * Regions switched off on their own, as `source:region` keys.
 *
 * The source switch covers a whole vendor; this covers one edition of it, so a
 * region whose sign-in is expired or unwanted can be parked without silencing
 * the other one. A parked region gets no gateway, no scan and no provider row.
 */
function disabledRegionKeys() {
  const value = settings.disabledRegions;
  return Array.isArray(value) ? value.filter((key) => typeof key === "string" && key !== "") : [];
}

/** Whether one source region may run: its source is on and the region is not parked. */
function regionEnabled(source, region) {
  return sourceEnabled(source) && !disabledRegionKeys().includes(sourceRegionKey(source, region));
}

/** Regions whose source is switched on and which are not parked. */
function activeRegions() {
  return REGIONS.filter((region) => regionEnabled("workbuddy", region));
}
/**
 * The port block this plugin's gateways live in.
 *
 * Every gateway binds a fixed port derived from this one number, because the
 * published provider row has to name the address the NEXT run will bind - an
 * ephemeral port would leave the row pointing at nothing. The offsets below are
 * spaced by ten so each gateway keeps its own readable slot, and the block sits
 * high enough in the ephemeral range to stay clear of the ports other local
 * tooling picks.
 */
const PORT_BASE = 42831;

/** Preferred loopback port, one per gateway. */
const REGION_PORTS = { cn: PORT_BASE, global: PORT_BASE + 10 };

/**
 * Trae's gateways, kept beside the WorkBuddy pair rather than inside it.
 *
 * Trae's regions are `cn` / `ai` - a different pair from WorkBuddy's
 * `cn` / `global` - and its credentials never enter the WorkBuddy account
 * pool, so they get their own map, ports and provider ids. The two existing
 * WorkBuddy rows above are untouched: nothing migrates and nothing is renamed.
 */
const TRAE_REGIONS = ["cn", "ai"];
const TRAE_PROVIDER_ID_BY_REGION = { cn: "wtqpool-trae-cn", ai: "wtqpool-trae-ai" };
const TRAE_PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool Trae (CN)",
  ai: "WTQ Pool Trae (Global)",
};
/** Trae's pair, in its own slots of the same block. */
const TRAE_PORTS = { cn: PORT_BASE + 20, ai: PORT_BASE + 30 };
const traeGateways = new Map();
/** Regions whose source is switched on and which are not parked. */
function activeTraeRegions() {
  return TRAE_REGIONS.filter((region) => regionEnabled("trae", region));
}
/**
 * Qoder's gateways, kept beside the WorkBuddy pair rather than inside it.
 *
 * Qoder's regions are `cn` / `global` - the same pair as WorkBuddy's - but
 * its credentials never enter the WorkBuddy account pool, so they get their
 * own map, ports and provider ids all the same. Nothing above is touched.
 */
const QODER_REGIONS = ["cn", "global"];
const QODER_PROVIDER_ID_BY_REGION = { cn: "wtqpool-qoder-cn", global: "wtqpool-qoder-global" };
const QODER_PROVIDER_NAME_BY_REGION = {
  cn: "WTQ Pool Qoder (CN)",
  global: "WTQ Pool Qoder (Global)",
};
/** Qoder's pair, in the last two slots. */
const QODER_PORTS = { cn: PORT_BASE + 40, global: PORT_BASE + 50 };
/** region -> { region, gateway, baseUrl, portFallback, lastError }. */
const qoderGateways = new Map();
/** Regions whose source is switched on and which are not parked. */
function activeQoderRegions() {
  return QODER_REGIONS.filter((region) => regionEnabled("qoder", region));
}

/**
 * How hard one run tries to reclaim its preferred port.
 *
 * A busy preferred port is almost always the previous instance still exiting,
 * which is a wait of milliseconds rather than a permanent condition. Giving up
 * instantly made a run fall back to a spare port and publish it, which
 * stranded the host on an address nothing listens on.
 */
const PORT_RESERVE_ATTEMPTS = 6;
const PORT_RESERVE_INTERVAL_MS = 250;

/** Levels the host's thinking picker accepts, in the order it shows them. */
const HOST_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Publication bounds this plugin holds its provider declarations to. */
const MAX_MODELS = 64;
/** Ids one gateway's stored selection may name, well past the published cap. */
const MAX_STORED_MODEL_IDS = 512;
const MAX_TOKEN_BUDGET = 0xffffffff;
/** Longest model id the declaration can publish; anything past it is unroutable. */
const MAX_MODEL_ID_LENGTH = 256;
/**
 * Highest credit floor the panel may store: the reserve is compared against a
 * real balance, so a floor past any balance parks the account for good.
 */
const MAX_CREDIT_RESERVE = 1e9;
/**
 * The figures `index.ts` falls back to when a roster row names none.
 *
 * Exported rather than re-typed there: two copies of the same number drift the
 * moment one of them is retuned, and the drift is invisible until a model
 * without a declared window is published.
 */
export const CONSERVATIVE_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 32000;
const CATALOG_TTL_MS = 30 * 60 * 1000;
/**
 * How long a failed roster read waits before the next attempt.
 *
 * A failed read must not be stamped as freshly read: that parks the static
 * fallback - and with it the wrong model list, for the gateways and for the
 * host's picker - for the whole TTL after one slow start.
 */
const CATALOG_RETRY_MS = 15 * 1000;
/** How many times a roster that could not be read is asked for again. */
const MODEL_RETRY_ATTEMPTS = 4;
/** Used until a shim binds, so a descriptor never carries an empty base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";

/**
 * How long one account's billing answers (credits, check-in) are reused.
 *
 * The panel renders from these cached answers and they refresh behind the first
 * paint, so opening it never waits on a billing call per account.
 */
const PROBE_TTL_MS = 60000;
/** How often the desktop sign-ins are re-read while the service runs. */
const ACCOUNT_WATCH_MS = 60000;
/**
 * Bound on one model-catalog request, so a stalled host cannot stall a load.
 *
 * Ten seconds is well past a healthy roster read, and it also has to fit the
 * budget the host gives `onLoad`: the two regions are read at once, so this
 * timeout is the ceiling on init rather than twice it.
 */
const MODELS_TIMEOUT_MS = 10000;
/**
 * The share of the load path a roster read may take.
 *
 * Nothing in DSH caps how long this plugin's own load may take, so these bounds
 * are the plugin's: the first declaration publishes on time and a slow roster
 * read lands behind it. A read that outruns its share is left to finish behind
 * the answer, and the refresh that follows the service start fills the roster in.
 */
const LOAD_ROSTER_BUDGET_MS = 6000;
const SERVICE_ROSTER_BUDGET_MS = 3000;
/**
 * The share of the same two paths the steps in front of the roster read may
 * take: the gateway reconcilers, the account scan, and the runtime starts.
 *
 * Those steps are disk and port work that can stall on a pathological machine,
 * and the point of publishing early is lost if they are what the load waits
 * on. A step that outruns its budget keeps running behind the answer; the
 * refresh after the service start reconciles whatever it missed.
 */
const LOAD_BOOTSTRAP_BUDGET_MS = 5000;
const SERVICE_BOOTSTRAP_BUDGET_MS = 1500;
/**
 * One whole refresh pass, and how long a forced one waits for the pass it found
 * already running.
 *
 * The panel bridge imposes no call-length cap, so this budget is the plugin's
 * own. Every stage inside a pass is sized against this one deadline, and the
 * port reservations in front of it are capped by their own attempt count - a
 * few seconds at worst when another process holds the preferred ports.
 */
const REFRESH_PASS_BUDGET_MS = 18000;
/**
 * How often the token keep-alive walks the pool.
 *
 * Half of the lifetime the pool assumes for a token that reports none, so a
 * sign-in nobody has used is renewed while it still works rather than at the
 * moment a request needs it.
 */
/**
 * How long a started panel login stays pollable.
 *
 * The browser half is the user's to finish, so it is measured in minutes
 * rather than the seconds a network call gets. Past it the state is dropped and
 * the panel asks the user to start again: the upstream keeps answering
 * `login ing...` for a state that will never complete, so a poll with no
 * deadline would look alive forever.
 */
const DEVICE_LOGIN_TTL_MS = 15 * 60 * 1000;
/**
 * One account-directory walk, on its own clock.
 *
 * A walk reads every `.info` in every auth directory and, on a cold key, asks
 * the OS for the at-rest key, which is the slow part. The host allows a panel
 * call 30 s and the pass that follows has 18 s of its own, so this is sized to
 * leave the walk the larger share and let the pass take what is left.
 */
const POOL_SCAN_BUDGET_MS = 8000;

let settings = {};
/**
 * Bumped by every local mutation of `settings`.
 *
 * A refresh pass reads the document from the host and then awaits for seconds;
 * a save landing in that window is newer than the document the read returns.
 * Comparing this counter across the read is what stops the pass from reverting
 * a switch the user just flipped.
 */
let settingsRevision = 0;
/**
 * Bumped only by writes this process made, never by a document the host pushed.
 *
 * A host announcement that was already in flight when a local save landed is
 * older than that save. `onHostSettingsChanged` captures this counter before it
 * queues, and drops the document when a local write overtook it.
 */
let localSettingsRevision = 0;
let dataPath = "";
/** One runtime per gateway: its shim and catalog. */
const runtimes = new Map();
/**
 * Binds in flight, by region.
 *
 * A rescan and a refresh pass can reach the same region at the same moment, and
 * two binds for one region mean the second loses the preferred port it had just
 * reserved and logs a warning about its own process. The map is what makes the
 * second caller the first one's answer; entries are dropped once the promise
 * settles, so the next pass starts fresh.
 */
const runtimeStarts = new Map();
/**
 * Gateway closes `reconcileRuntimes` started but could not wait for.
 *
 * That function runs synchronously inside settings application, yet a source
 * toggled off and straight back on starts a new gateway while the old one's
 * close is still releasing the port. `startRuntimes` drains this list first, so
 * the new bind lands on a port the old shim has actually let go of instead of
 * falling back to a temporary one nothing was told about.
 */
const pendingRuntimeStops = [];
/**
 * Why one gateway's last start attempt failed, by region.
 *
 * A gateway that could not bind has no runtime at all, which is the same shape
 * as one that has not been started yet - and the two mean opposite things to
 * everything downstream. Without this map a failed start read as "still
 * warming" for as long as the source stayed switched on: its saved roster was
 * republished over a port nothing was listening on, and the panel reported no
 * drift while every request to that address was refused.
 */
const gatewayStartFailures = new Map();
/**
 * Trae/Qoder regions whose gateway could not start, keyed `source:region`.
 *
 * WorkBuddy records its own start failures; without the same record for the two
 * source gateways a region whose bind failed kept the address the host had
 * already registered, so every request to it was refused while the doctor and
 * the panel read the region as healthy. Entries are cleared wherever the
 * gateway is installed or removed, so a switched-off source never reads as a
 * failed one.
 */
const sourceStartFailures = new Map();
/** One in-flight source-gateway start per region, shared by overlapping passes. */
const sourceGatewayStarts = new Map();
/** Provider ids the host has confirmed it is serving, this process's lifetime. */
let publishedIds = new Set();
/**
 * Every provider row this process has published, keyed by provider id.
 *
 * The host registers providers at runtime, so nothing on disk remembers them:
 * the declaration this plugin published IS the record. Keeping it here is also
 * what lets the doctor report a refused registration instead of guessing.
 */
let declarationIndex = new Map();

/** Shared upstream client and account pool, built in onLoad. */
const core = { client: null, pool: null };

/** Handle for the one deferred refresh, so a burst of opens coalesces. */
let refreshTimer = null;
/** The background refresh in flight, so two passes never overlap. */
let refreshInflight = null;
/**
 * Counts activations, so a pass from a retired one can tell that it is stale.
 *
 * A refresh suspends at network awaits, and unload cannot wait for it. Without
 * this the pass resumes after teardown and re-creates what teardown just closed:
 * it binds a fresh gateway on the port and fills maps
 * that were cleared - all ownerless, because unload has already run. Every pass
 * therefore carries the generation it started in and stops at its own await
 * points once that number moves.
 */
let loadGeneration = 0;
let serviceStopped = false;

/**
 * True while `generation` is still the live activation.
 *
 * Every long pass checks this after an await before it touches shared state, so
 * a pass that outlived its activation gives up instead of re-opening gateways
 * and timers the teardown has already closed.
 */
function stillLoaded(generation) {
  return !serviceStopped && generation === loadGeneration;
}
/** The host settings listener, kept so onUnload can detach it. */
let settingsChangedHandler = null;

/** The daily check-in timer, and what it has already collected. */
let autoCheckinTimer = null;
/**
 * Timer that re-reads the desktop sign-ins while the service runs.
 *
 * Once a minute because a switch in the client overwrites the global sign-in
 * file in place: the pool only has the account if it read the file before that.
 */
let accountWatchTimer = null;
/**
 * True while a check-in pass is running, whichever entry point started it.
 *
 * One flag for all three — the scheduled tick, the host command and the panel's
 * "run now" — because two passes writing `autoCheckinLast` would leave the log
 * describing whichever finished last rather than what the user asked for.
 */
let checkinPassRunning = false;
/** Which pass owns the running flag; see `runCheckinPass`. */
let checkinPassToken = 0;
/**
 * True while the growth centre runs on its own, from the panel's card.
 *
 * Separate from `checkinPassRunning` because the two are different passes over
 * the same accounts: a growth run started beside a check-in pass would stack
 * two unpaced request clusters on one account, which is what the upstream
 * reads as a burst. The card refuses while either is running.
 */
let growthPassRunning = false;
/** Which run owns `growthPassRunning`, on the same rule as `checkinPassToken`. */
let growthPassToken = 0;
/**
 * The last standalone growth run, in the shape the scheduled pass records its
 * own growth half in. In memory only: after a restart the card falls back to
 * the growth half of the last scheduled pass, which is persisted with it.
 */
let growthLast = null;
/**
 * The growth centre's last successful read.
 *
 * Published with the status document so a repaint or a fresh panel paints it
 * instead of asking the user to read again; the panel refreshes it when it is old.
 */
let growthRead = null;
/**
 * Which read the answer in flight belongs to.
 *
 * A read walks several accounts and can take seconds, so a user can park a region
 * or drop an account while it runs. Comparing this counter around the await is
 * what stops that answer - computed against the pool as it was - from being
 * written back over the drop that just happened.
 */
let growthReadEpoch = 0;
/** Slots this process has collected, as `YYYY-MM-DDTHH` in the campaign's zone. */
const autoCheckinSlots = new Set();
/** The last automatic pass, for the panel's status line. */
let autoCheckinLast = null;
/** The last keep-alive pass, for the panel's status line. In memory only. */
let keepAliveLast = null;
/**
 * When a deferred pass is owed, in ms; 0 = nothing pending.
 *
 * Qoder's daily round only exists from 10:00 Beijing, so an automatic pass at
 * 09:00 cannot collect it. Rather than adding a second timer, this remembers
 * the opening time and the same timer comes back for it then.
 */
let qoderRetryAt = 0;
/**
 * How long a deferred Qoder round waits before the tick comes back for it
 * after a failure.
 *
 * The deferral is owed once a day, so a failed attempt has to stay owed - but
 * a read that throws every time must not be retried every minute either.
 */
const QODER_RETRY_BACKOFF_MS = 10 * 60 * 1000;
/**
 * Aborted when the service stops, re-armed by every pass that starts.
 *
 * A check-in pass paces its accounts seconds apart and walks a whole pool, so
 * it is still running long after the teardown closed every gateway it was
 * serving. The pacing sleeps wake on this and the per-account loops check it,
 * so a stopping service ends the pass instead of leaving it talking to a host
 * that is no longer there. Re-arming at the pass rather than at the service
 * start is what keeps a hand-started pass working after a stop: the stop
 * retired the pass that was running then, not the ones still to come.
 */
let checkinAbort = new AbortController();
const checkinScope = new AsyncLocalStorage();
function currentCheckinSignal() {
  return checkinScope.getStore() ?? checkinAbort.signal;
}
/**
 * Cat-travel pacing: one pass per account, same throttle as the upstream's own
 * scheduler. A single `travelOne` already fans out to several RPCs, so a tight
 * loop would look like a burst to the upstream.
 */
const TRAVEL_ACCOUNT_DELAY_MS = 800;
/** Pause between two Qoder accounts' check-ins, so a batch does not read as a burst. */
const QODER_ACCOUNT_DELAY_MS = 1000;
/**
 * Pause between two WorkBuddy accounts' check-ins.
 *
 * The same pacing the other sources get: a pass over several accounts with no
 * gap between them is a burst from the upstream's side, and the growth pass
 * that follows walks the same accounts again seconds later.
 */
const CHECKIN_ACCOUNT_DELAY_MS = 700;
/** Trae's check-in pace: 5 s between accounts, ±2 s jitter (the spacing its endpoint is proven with). */
const TRAE_ACCOUNT_DELAY_MS = 5000;
const TRAE_ACCOUNT_JITTER_MS = 2000;
/** Wait after the adopt preflight report before calling buddy/first. */
const TRAVEL_ADOPT_GAP_MS = 1050;
/** Between the check-in burst and the growth burst on the same accounts. */
const GROWTH_AFTER_CHECKIN_MS = 1500;
/** Between one domestic account and the next inside the growth pass. */
const GROWTH_ACCOUNT_DELAY_MS = 400;
/**
 * Pause after lighting the streak before reading it back.
 *
 * The upstream scores the reported chat against the account's streak in its own
 * time: a read issued in the same tick still answers the previous day's
 * counter, so the tier state read right after the report is stale by one day
 * and the pass reports nothing redeemed on the day the tier actually opened.
 */
const STREAK_REPORT_READ_GAP_MS = 1200;
/** Account ids that hit the adopt conversation threshold today (CST day). */
const travelAdoptTried = new Map();

function log(level, message) {
  try {
    console.log("[wtq-pool] " + level + ": " + message);
  } catch {
    /* logging must never break a request */
  }
}

/**
 * One gateway logger line from what a gateway passed it.
 *
 * The gateways call `warn(message, error)`, and an adapter that took only the
 * first argument threw away the only explanation a closed socket or a failed
 * upstream read ever had. Detail goes through the same redaction every other
 * error text gets, so nothing unredacted reaches the log through it.
 */
function gatewayLogLine(prefix, args) {
  return prefix + args.map(safeMessage).join(" ");
}

function regionOfKey(value) {
  return value === "global" ? "global" : "cn";
}

// ---------------------------------------------------------------- settings


/**
 * Read the settings document.
 *
 * `undefined` means the read failed, which is not the same answer as an empty
 * document and must not be treated as one - see {@link adoptHostSettings}.
 */
async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return undefined;
  }
}

/**
 * Replace this process's settings with a fresh read, unless that read failed or
 * a local write landed while it was in flight. Returns whether it replaced them.
 *
 * Two failures are ruled out here. A failed read is not an empty document:
 * returning `{}` let one transient host RPC error wipe this process's copy of
 * `disabledAccountIds`, `removedAccounts`, `creditReserves`, `modelSelection`
 * and the parked regions, and because the panel's save helpers spread that copy
 * before writing one key, the next save made the loss permanent. A read that
 * raced a save is also older than that save by definition, so taking it reverted
 * the switch the user had just flipped.
 */
async function adoptHostSettings() {
  const revision = settingsRevision;
  const next = await loadSettings();
  if (next === undefined) {
    log("warn", "could not read settings; keeping the last known document");
    return false;
  }
  if (settingsRevision !== revision) return false;
  settings = next;
  return true;
}

/**
 * Persist a partial settings patch.
 *
 * Returns false instead of throwing so a request path can never be broken by a
 * rejected write, but the caller still learns that nothing was stored.
 *
 * Every write goes through {@link enqueueWrite}, because a dictionary-shaped
 * setting is read as a whole, edited and written back as a whole. Two of those
 * in flight at once had the second one overwrite the first with the stale copy
 * it read, and the panel answered success for a change that was gone.
 */
async function saveSettings(patch) {
  return enqueueWrite(async () => {
    try {
      await pi.plugin.setSettings(patch);
      settings = { ...settings, ...patch };
      settingsRevision += 1;
      localSettingsRevision += 1;
      return true;
    } catch (error) {
      log("warn", "could not save settings: " + safeMessage(error));
      return false;
    }
  });
}

/**
 * Serialise the settings writes, and re-read before each one runs.
 *
 * The queue is what makes a read-edit-write of a dictionary key safe: the work
 * inside it sees the document the previous write left behind, including one the
 * host's own settings UI made while this one was waiting. A rejected write does
 * not block the next one, because a failed save is a normal outcome the caller
 * already reports.
 */
let writeChain = Promise.resolve();
function enqueueWrite(work) {
  const run = writeChain.then(work, work);
  // The chain carries the outcome of the last write for the NEXT writer, so it
  // must never be a rejected promise itself.
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Read, edit and write one settings key as a single serialised step.
 *
 * A dictionary-shaped setting is written back whole, so the read has to happen
 * inside the queue rather than before it: two channels that both read the old
 * document and then both wrote had the second overwrite the first, and the
 * panel answered success for a change that was already gone. Re-reading before
 * the edit also picks up whatever the host's own settings UI stored while this
 * one was waiting.
 *
 * `mutate` receives the value in force and answers the next one; answering
 * `undefined` means "no change", which skips the write entirely.
 */
async function mutateSettings(key, mutate) {
  return enqueueWrite(async () => {
    // A failed read is not fatal: the last known document is still the best
    // answer available, and refusing the edit would drop a change the user can
    // see they made.
    await adoptHostSettings();
    const current = settings[key];
    const next = await mutate(current);
    if (next === undefined) return true;
    try {
      await pi.plugin.setSettings({ [key]: next });
      settings = { ...settings, [key]: next };
      settingsRevision += 1;
      localSettingsRevision += 1;
      return true;
    } catch (error) {
      log("warn", "could not save settings: " + safeMessage(error));
      return false;
    }
  });
}

/**
 * Drop every cached sign-in read, so the next one sees the machine as it is.
 *
 * The credential readers cache their answer for 30 s and the identity probe is
 * memoised per edition. Both outlive the event that made them stale - a desktop
 * sign-in made while a source was switched off, or while the panel was open - so
 * every path that has to see the current machine drops them first: the settings
 * toggle, the panel's own switch, and a deliberate rescan.
 */
function resetDiscoveryCaches() {
  resetTraeCredentialCache();
  resetQoderCredentialCache();
  // The identity probe is memoised per edition; a desktop sign-in made after
  // the last probe must not keep the hint for the rest of the process.
  traeIdentityBlockers.clear();
}

/**
 * Apply a settings payload the host pushed at this process.
 *
 * The host validates and stores first, then announces the merged document, so a
 * selection edited in the host's own settings UI reaches the running plugin
 * here instead of only after a reload. The selection is re-applied and the
 * declaration republished straight away, because a narrower model list has to
 * reach the picker or the user still sees the models they just disabled.
 */
async function onHostSettingsChanged(next) {
  if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
  // A host announcement that was already in flight when a local save landed
  // carries the document from before that save. Queue it behind the write and
  // drop its stale copy. Re-reading instead of dropping the edit matters: the
  // event can carry a real host edit that raced the save, and the host's stored
  // document is the merge of both. Dropping it left a cooldown edited in the
  // host's settings page unapplied until something else re-read the document.
  const localRevision = localSettingsRevision;
  return enqueueWrite(async () => {
    if (serviceStopped) return false;
    const before = settings;
    if (localSettingsRevision !== localRevision) {
      if (!(await adoptHostSettings())) {
        // The read failed, so there is no merged document to apply. The next
        // state read or reload still sees the host's copy; do not replace this
        // process's copy with the stale event.
        scheduleRefresh("settings");
        return false;
      }
    } else {
      // The host announces the whole merged document, so it replaces this copy
      // rather than being spread over it: a key the settings schema no longer
      // has (or one the host dropped) would otherwise live on in this process
      // and keep steering a decision that no longer reads it.
      settings = next;
      settingsRevision += 1;
    }
    // A source switch changes what has to be discovered, and the credential
    // readers hold their answer for 30 s: without this the refresh that follows
    // the switch would re-read the cache the old switch filled and keep serving
    // the sign-ins it named. Compare against the copy before this event,
    // including the re-read path above.
    const toggled = Object.values(SOURCE_SETTING_KEYS)
      .some((key) => Object.hasOwn(settings, key) && before[key] !== settings[key]);
    if (toggled) {
      resetDiscoveryCaches();
    }
    await applySettingsEverywhere(toggled);
    return true;
  });
}

/**
 * Apply the settings document already in `settings` to everything downstream.
 *
 * Shared by the host-driven change above and the panel's own switches, which
 * write the key first and then ask for the same reconciliation with no new
 * document to merge.
 */
async function applySettingsEverywhere(toggled) {
  applySettingsToCore();
  traeAccountRows = traeAccountRows.filter((row) => regionEnabled("trae", row.region));
  qoderAccountRows = qoderAccountRows.filter((row) => regionEnabled("qoder", row.region));
  // A parked region must lose its gateway now, not at the next refresh: its
  // port would otherwise stay bound and its endpoint would keep serving.
  await reconcileTraeGateways();
  await reconcileQoderGateways();
  syncDeclaration();
  // The cached billing answers belong to the accounts the last switch left in
  // the pool, so only a switch invalidates them. Blanking them on every edit
  // made the panel show `—` for every account until the next probe refilled it,
  // which is what a cooldown edited in the host's own settings card used to do.
  if (toggled) probeCache.clear();
  // A source or region switched from the host's own settings card changes which
  // accounts a read would return, exactly as the panel's switch does. Without this
  // an answer already in flight writes its rows back as freshly read, and the
  // card shows accounts the user just parked for the whole throttle window.
  if (toggled) {
    growthRead = null;
    growthReadEpoch += 1;
  }
  scheduleRefresh("settings");
  return true;
}

/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
  // A reload can arrive without the previous unload, so the handler this call
  // replaces has to be detached first: an orphaned closure kept reacting to
  // every host edit, running a second reconcile and a second declaration write,
  // and it survived the unload that followed.
  unsubscribeFromHostSettings()
  settingsChangedHandler = (next) => {
    // Reconciling the gateways awaits, so the promise is handled here rather
    // than returning anything meaningful to the event source.
    onHostSettingsChanged(next)
      .then((applied) => { if (applied) log("info", "settings changed in the host UI; selection re-applied") })
      .catch((error) => log("warn", "applying host settings failed: " + safeMessage(error)));
  };
  try {
    if (pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", settingsChangedHandler);
      return true;
    }
  } catch (error) {
    log("warn", "could not subscribe to settings changes: " + safeMessage(error));
  }
  settingsChangedHandler = null;
  return false;
}

/** Detach the host settings handler, if one is held. */
function unsubscribeFromHostSettings() {
  const handler = settingsChangedHandler;
  settingsChangedHandler = null;
  if (handler === null) return;
  try {
    if (pi.events && typeof pi.events.off === "function") pi.events.off("plugin:settingsChanged", handler);
  } catch (error) {
    log("warn", "could not unsubscribe from settings changes: " + safeMessage(error));
  }
}


function cooldownMs() {
  const value = Number(settings.cooldownSeconds);
  if (!Number.isFinite(value) || value <= 0) return 60000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.round(value * 1000)));
}

/** The modes other than `priority`, which is what an unrecognised or absent value means. */
const WORKBUDDY_DISTRIBUTIONS = ["round-robin", "expiry", "sticky"];

function distributionSetting() {
  const value = settings.distribution;
  return WORKBUDDY_DISTRIBUTIONS.includes(value) ? value : "priority";
}

/** Hours in force now: what the user configured, or the default. */
function checkinHours() {
  const raw = settings.autoCheckin?.hours;
  return normaliseCheckinHours(Array.isArray(raw) ? raw : []);
}

function autoCheckinEnabled() {
  return settings.autoCheckin?.enabled === true;
}

/**
 * Where the collected check-in slots are remembered between runs.
 *
 * `autoCheckinSlots` is this process's own copy; without a record on disk a
 * restart after the morning hour forgot every slot and re-ran the whole pass.
 * The file holds one array per campaign day, the same shape the desktop twin
 * writes, so the two engines cannot disagree about what a day's record is.
 * `_qoderRetryAt` is metadata beside those arrays: Qoder's deferred round can
 * open hours after the pass that scheduled it, and a reload before then used to
 * lose the day's Qoder credits. A key that is not an array is ignored by the
 * day reader, so the file stays compatible with the twin.
 */
const CHECKIN_SLOTS_FILE = "checkin-slots.json";
/** Days a slots file keeps: a day older than that can never be due again. */
const CHECKIN_SLOTS_KEEP_DAYS = 3;

/**
 * Re-read the slots earlier runs collected, now that the data root is known.
 *
 * Only today's day can ever be due, so this is really about today; the older
 * days stay in the file because the twin writes them and a day boundary in the
 * middle of a pass is no reason to drop the record. A file that is missing or
 * unreadable is a machine with no record yet, which is where a fresh install
 * starts.
 */
function loadCheckinSlots() {
  autoCheckinSlots.clear();
  qoderRetryAt = 0;
  if (dataPath === "") return;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataPath, CHECKIN_SLOTS_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const slots of Object.values(parsed)) {
      if (!Array.isArray(slots)) continue;
      for (const slot of slots) {
        if (typeof slot === "string" && slot !== "") autoCheckinSlots.add(slot);
      }
    }
    // A retry from the current campaign day is actionable even if its time has
    // passed (the tick catches it up). A backoff set just before midnight can
    // land on either side of it, so a retry within two hours of now is kept
    // across the date boundary too; anything older than that would fire against
    // a schedule that has moved on.
    const retry = parsed._qoderRetryAt;
    const now = Date.now();
    if (typeof retry === "number" && Number.isFinite(retry) && retry > 0
      && (zonedDayHour(new Date(retry)).day === zonedDayHour(new Date(now)).day
        || (retry > now - 2 * 60 * 60 * 1000 && retry <= now + 24 * 60 * 60 * 1000))) {
      qoderRetryAt = retry;
    }
  } catch {
    /* no record yet */
  }
}

/**
 * Write the collected slots back, one array per campaign day.
 *
 * Called when a pass has ENDED - collected or failed - rather than when it
 * starts: a pass the process died in the middle of must leave nothing behind,
 * so the next run attempts that day again. The days are pruned on the way out,
 * so the file cannot grow without bound on a machine that runs for months.
 */
function saveCheckinSlots() {
  if (dataPath === "") return;
  const byDay: Record<string, string[]> = {};
  for (const slot of autoCheckinSlots) {
    const day = slot.split("T")[0];
    if (byDay[day] === undefined) byDay[day] = [];
    byDay[day].push(slot);
  }
  const keep = Object.keys(byDay).sort().slice(-CHECKIN_SLOTS_KEEP_DAYS);
  for (const day of Object.keys(byDay)) {
    if (!keep.includes(day)) delete byDay[day];
  }
  // Written after pruning so it is never mistaken for a campaign day.
  if (qoderRetryAt > 0) (byDay as Record<string, unknown>)._qoderRetryAt = qoderRetryAt;
  // Declared out here, where the catch can see it: the cleanup it does on a
  // failed write is the whole point, and a staging name the catch cannot reach
  // leaves the file behind for as long as the plugin is installed.
  const target = path.join(dataPath, CHECKIN_SLOTS_FILE);
  const staging = target + ".tmp";
  try {
    // The host normally creates this directory; without this the slots would
    // silently never persist on a data path it did not make.
    fs.mkdirSync(dataPath, { recursive: true });
    // Written beside its target and renamed, like the declaration: a process
    // killed mid-write leaves the previous file whole rather than a truncated
    // one that reads as a day with no entries.
    fs.writeFileSync(staging, JSON.stringify(byDay), "utf8");
    fs.renameSync(staging, target);
  } catch (error) {
    // A write that failed halfway leaves the staging file behind, and nothing
    // ever renames or overwrites it: the data directory then keeps a stale copy
    // of a day's record next to the real one, for as long as the plugin is
    // installed.
    try {
      fs.rmSync(staging, { force: true });
    } catch {
      /* nothing to clean up */
    }
    // A record that cannot be written costs one repeated pass after the next
    // restart, never the pass itself.
    log("warn", "could not record the collected check-in slots: " + safeMessage(error));
  }
}

function preferredAccountId(region) {
  const value = settings.preferredAccountIds?.[region];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Storage key for one source region's picked account. */
function sourceRegionKey(source, region) {
  return source + ":" + region;
}

/** The account the user picked for one source region; "" means automatic. */
function preferredSourceAccount(source, region) {
  const value = settings.preferredSourceAccounts?.[sourceRegionKey(source, region)];
  return typeof value === "string" ? value : "";
}

/** The picked account per active region of one source, for the panel's picker. */
function sourcePreferredMap(source) {
  const regions = source === "trae" ? activeTraeRegions() : activeQoderRegions();
  const map = {};
  for (const region of regions) map[region] = preferredSourceAccount(source, region);
  return map;
}

/**
 * The Trae/Qoder accounts this run found, for one source.
 *
 * Both the composer chip and the panel picker name an account by this label, and
 * both have to store it. Reading them from here is what lets a choice be checked
 * against the sign-ins that actually exist instead of being written blind.
 */
function sourceAccountLabels(source, region) {
  const rows = source === "trae" ? traeAccountRows : qoderAccountRows;
  return rows
    .filter((row) => row.region === region && row.expired !== true)
    .map((row) => row.label);
}

/**
 * Whether a named account may be stored as the preferred one.
 *
 * An empty label clears the preference, which is always allowed. Any other label
 * has to name an account this run found and that has not expired: storing a name
 * nothing can match leaves the picker silently falling back to its own default,
 * so the click looks like it worked and the same account keeps serving.
 */
function sourceAccountMayBePreferred(source, region, label) {
  if (label === "") return true;
  return sourceAccountLabels(source, region).includes(label);
}

/** Usage modes one source can follow. `expiry` spends the soonest one-off pack first. */
const SOURCE_DISTRIBUTIONS = ["round-robin", "expiry"];

/** How one source spreads requests when no account is picked for the region. */
function sourceDistribution(source) {
  const value = settings.sourceDistributions?.[source];
  return SOURCE_DISTRIBUTIONS.includes(value) ? value : "priority";
}

/** Soonest remaining one-off pack. Monthly and never-expiring pools do not count. */
function nearestPackExpiry(packages) {
  let best;
  const now = Date.now();
  for (const pack of packages || []) {
    if (pack.monthly === true || pack.neverExpires === true) continue;
    const when = typeof pack.expiresAtMs === "number" ? pack.expiresAtMs
      : typeof pack.roundExpiresAtMs === "number" ? pack.roundExpiresAtMs
      : undefined;
    if (typeof when !== "number" || when <= now) continue;
    if (typeof pack.remain === "number" && pack.remain <= 0) continue;
    if (best === undefined || when < best) best = when;
  }
  return best;
}

/**
 * The pool the Trae and Qoder gateways share.
 *
 * `source-pool.ts` holds the logic and the reason it exists; the four readers
 * it needs are this plugin's own settings, handed in once rather than reached
 * for, which is what lets a check drive the pool directly.
 */
const sourcePool = createSourcePool({
  cooldownMs,
  preferredSourceAccount,
  sourceDistribution,
  sourceRegionKey,
});

const {
  sourceCreditExpiry,
  sourceRotation,
  sourceFailureHold,
  sourceCredentialExpired,
  accountStateKey,
  noteSourceFailure,
  orderSourceCredentials,
} = sourcePool;

function noteSourceExpiry(source, region, label, packages) {
  const at = nearestPackExpiry(packages);
  const key = accountStateKey(source, region, label);
  if (at === undefined) sourceCreditExpiry.delete(key);
  else sourceCreditExpiry.set(key, at);
}

/** Account ids switched off on the panel; the pool never picks them. */
function disabledAccountIds() {
  const value = settings.disabledAccountIds;
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id !== "");
}

/** Per-account credit floor from the panel, keyed by account id. */
function creditReserves() {
  const value = settings.creditReserves;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const clean = {};
  for (const [id, raw] of Object.entries(value)) {
    const floor = Number(raw);
    // Clamped to the same ceiling the panel's save path enforces: a hand-edited
    // document could otherwise store a floor past any balance a user could hold,
    // and the account would be parked for good with nothing to act on.
    if (id !== "" && Number.isFinite(floor) && floor > 0) clean[id] = Math.min(Math.floor(floor), MAX_CREDIT_RESERVE);
  }
  return clean;
}

/**
 * Accounts removed from the pool for good, with label and gateway kept so the
 * panel can still offer a restore after the account stops being scanned.
 */
function removedAccounts() {
  const value = settings.removedAccounts;
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry !== null && typeof entry === "object"
    && typeof entry.id === "string" && entry.id !== ""
    && REGIONS.includes(entry.region));
}

/**
 * The saved model selection for one gateway.
 *
 * The original kept a single selection for the whole pool; the port keys it per
 * gateway so the two picker groups can be filtered independently. Absent means
 * "everything enabled" - an unconfigured install must never show an empty list.
 */
function selectionFor(region) {
  return gatewaySelectionFor(regionOfKey(region));
}

/** The stored selection for one raw gateway key, absent means "everything on". */
function gatewaySelectionFor(key) {
  const all = settings.modelSelection && typeof settings.modelSelection === "object" ? settings.modelSelection : {};
  return normalizeSelection(all[key]);
}

/**
 * The ids one gateway's stored selection keeps; null means publish everything.
 * An empty list is the user disabling every model, exactly as it is for the
 * WorkBuddy catalog, and only an absent list means "publish everything". A
 * selection naming no live model is treated as unset, mirroring
 * savedSelectionMatches, so a renamed catalog never empties the group.
 */
function gatewayEnabledIds(key, catalogIds) {
  const enabled = gatewaySelectionFor(key).enabledModelIds;
  if (!Array.isArray(enabled)) return null;
  if (enabled.length === 0) return new Set();
  const known = new Set(catalogIds);
  const kept = enabled.filter((id) => known.has(id));
  return kept.length > 0 ? new Set(kept) : null;
}

/**
 * The selection as the gateway really publishes it, for the panel to render.
 *
 * The declaration normalizes a stored selection whose every id has been renamed
 * away back to "everything on", and the panel has to show that same answer. It
 * used to read the raw stored value, so a catalog rename showed every model
 * unticked while the gateway published all of them, with no way back: ticking
 * them produced the same normalized selection again.
 */
function publishedSelectionFor(key, catalogIds) {
  const stored = gatewaySelectionFor(key);
  const enabled = gatewayEnabledIds(key, catalogIds);
  if (enabled !== null) return { ...stored, enabledModelIds: [...enabled] };
  // Null means "publish everything", which the panel reads as an absent list.
  const { enabledModelIds, ...rest } = stored;
  return rest;
}

/** Stored per-model overrides for one gateway key ("trae:cn", ...), by model id. */
function gatewayOverrides(key) {
  const overrides = gatewaySelectionFor(key).overrides;
  return overrides !== null && typeof overrides === "object" ? overrides : {};
}

/**
 * One Trae/Qoder model as the panel edits it: the value in force, the value the
 * gateway reported, and whether the user changed it. The provider declaration
 * and the status document both read this, so what the editor shows is what gets
 * published.
 */
function sourceModelView(key, model, native) {
  const id = String(model.id || "").trim();
  const override = gatewayOverrides(key)[id] ?? {};
  const nativeName = typeof model.name === "string" && model.name !== "" ? model.name : id;
  const alias = typeof override.alias === "string" && override.alias.trim() !== "" ? override.alias.trim() : undefined;
  // The highest window the model accepts: its Max tier when the directory states
  // one, otherwise the default the row was built at. A stored override may reach
  // this but never past it, so a declaration cannot size the host's budget for
  // room the gateway would refuse.
  const nativeCeiling = Math.max(
    positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
    positiveInteger(native.maxContextWindow, 0),
  );
  // Field names are the pool's, not the gateways': one model shape means the
  // panel's editor reads a Trae row exactly as it reads a WorkBuddy one.
  //
  // Both the panel's editor and the manifest declaration read what follows, so
  // the host's own bounds are applied here: a hand-edited or legacy settings.json
  // with an out-of-range figure would otherwise be published verbatim, and the
  // host rejects a declaration that breaks its bounds. The catalog's figure is the
  // ceiling as well: `sourceModelView` is only reached from a live directory scan,
  // so `native` is what the gateway really accepts, and a larger declared window
  // would size the host's budget past what the gateway can take.
  const declaredWindow = Math.min(
    positiveInteger(
      Number.isFinite(override.contextWindow) ? override.contextWindow : native.contextWindow,
      CONSERVATIVE_CONTEXT_WINDOW,
    ),
    nativeCeiling,
  );
  // The output budget belongs to the function that serves the window in force:
  // above the model's default the Max function states its own, smaller one.
  const outputCeiling = positiveInteger(
    declaredWindow > positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW)
      ? native.maxTokensAtCeiling
      : native.maxTokens,
    positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS),
  );
  return {
    id,
    name: alias ?? nativeName,
    ...alias === undefined ? {} : { alias },
    nativeName,
    contextWindow: declaredWindow,
    maxOutputTokens: Math.min(
      positiveInteger(
        Number.isFinite(override.maxOutputTokens) ? override.maxOutputTokens : outputCeiling,
        DEFAULT_MAX_TOKENS,
      ),
      outputCeiling,
    ),
    nativeContextWindow: native.contextWindow,
    // The model's real ceiling, which for a Max-capable model is above the
    // default tier. The editor sizes its field to this so the user can pick the
    // Max window; the declared value stays whatever is in force above.
    ...nativeCeiling > positiveInteger(native.contextWindow, CONSERVATIVE_CONTEXT_WINDOW)
      ? { maxContextWindow: nativeCeiling }
      : {},
    nativeMaxOutputTokens: positiveInteger(native.maxTokens, DEFAULT_MAX_TOKENS),
    // And the one that applies once the draft reaches above the default window.
    ...native.maxTokensAtCeiling === undefined ? {} : { maxOutputAtCeiling: positiveInteger(native.maxTokensAtCeiling, outputCeiling) },
    supportsImages: typeof override.supportsImages === "boolean" ? override.supportsImages : native.supportsImages,
    nativeSupportsImages: native.supportsImages,
    // The levels the gateway itself advertises, so the panel's editor can offer
    // the control on the same term the WorkBuddy roster does. Without them a
    // Trae or Qoder model that advertises a reason menu showed no way to edit
    // it, and the override the panel did save never reached the declaration.
    ...Array.isArray(native.thinkingLevels) && native.thinkingLevels.length > 0
      ? { nativeThinkingLevels: [...native.thinkingLevels] }
      : {},
    // The user's level list, when they set one. Every other field here has a
    // `native` twin beside it; this one has none because a gateway publishes
    // whatever levels it advertises rather than a stored default, and the
    // declaration decides what to do with an edited list.
    ...Array.isArray(override.thinkingLevels) && override.thinkingLevels.length > 0
      ? { thinkingLevels: override.thinkingLevels }
      : {},
    // The upstream cost, read-only: it is the gateway's price, not a setting, so
    // there is no override and no `nativeMultiplier` beside it. WorkBuddy models
    // carry the same field, which is what the panel's cost chip reads.
    ...native.multiplier === undefined ? {} : { multiplier: native.multiplier },
    advanced: Object.keys(override).length > 0,
  };
}

/** One gateway's models in that shape; `nativeOf` reports what the gateway itself said. */
function sourceRosterFor(key, models, nativeOf) {
  // The roster is the same list the declaration is published from, so it is
  // filtered on the same term: an entry with no id cannot be published, saved or
  // matched to a model, and a roster row that leads nowhere only reads as junk.
  const source = key.split(":")[0];
  return models
    .filter((model) => String(model.id || "").trim() !== "")
    .map((model) => sourceModelView(key, model, nativeOf(model)))
    .filter((view) => isSelectableSourceModel(source, view));
}
/**
 * A source gateway's roster plus the selection that gateway really publishes.
 * One roster pass answers both, so the panel ticks exactly what the declaration
 * emits: a stored selection whose every id has been renamed away normalizes to
 * "publish everything" instead of every model showing unticked while the
 * gateway serves them all.
 */
function sourcePublishedModels(key, models, nativeOf) {
  const roster = sourceRosterFor(key, models, nativeOf);
  return { roster, selection: publishedSelectionFor(key, roster.map((view) => view.id)) };
}

/**
 * Trae's internal slots, by the names the IDE gives them.
 *
 * They are the IDE's own, stable across versions, and are what distinguishes a
 * helper slot from a model — a helper sometimes carries a borrowed display name,
 * so the name alone cannot answer it. The IDE appends a variant suffix to some of
 * them over time (`fast_apply_new`), so the names are matched by prefix.
 */
const TRAE_INTERNAL_MODEL_ID_RE =
  /^(custom_model|search_agent|summary|fast_apply|title_generation|input_optimization|laziness_detection)(_|$)|_(subagent|agent)(_|$)|-(for-)?auto$/;

/**
 * Whether one gateway model is something to offer in the picker.
 *
 * Trae's directory is the IDE's slot table rather than a model catalogue: beside
 * the models it lists the slots the IDE fills in for itself — the
 * `custom_model_*` placeholders it binds to a provider at runtime, the
 * `search_agent_*` and `*_subagent` helpers it drives, the `-auto` entries it
 * routes on its own, and housekeeping endpoints like `summary`. Offering those
 * fills the picker with rows that answer nothing.
 *
 * A model with no name to show is dropped on either source: Trae lists `sagitta`
 * and `aquila` as `—`, which is the whole of what the picker could say about them.
 *
 * Qoder's ids are exempt from the shape test. They are its real names — `qmodel`,
 * `gfmodel`, `kmodel_latest` — and an underscore test written for Trae would
 * delete every one of them.
 */
function isSelectableSourceModel(source, view) {
  // The placeholder test is about the catalog's own names. An alias is a label
  // the user chose, so a punctuation-only one must not delete the model from the
  // roster, the picker and the declaration; the name shown still has to exist.
  const native = typeof view.nativeName === "string" ? view.nativeName.trim() : "";
  const name = typeof view.name === "string" ? view.name.trim() : "";
  if (name === "" || native === "" || !/[\p{L}\p{N}]/u.test(native)) return false;
  if (source !== "trae") return true;
  return !TRAE_INTERNAL_MODEL_ID_RE.test(view.id);
}
function normalizeSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  if (Array.isArray(value.enabledModelIds)) out.enabledModelIds = value.enabledModelIds;
  // Null prototype: an id of `__proto__` is an own key of a JSON-parsed document
  // but assigns the prototype on a plain `map[id] = …`, so that edit vanished
  // while both the save and the read reported success.
  const overrides = Object.create(null);
  if (value.overrides && typeof value.overrides === "object" && !Array.isArray(value.overrides)) {
    for (const [id, entry] of Object.entries(value.overrides)) {
      if (typeof id === "string" && id !== "" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        overrides[id] = { ...entry };
      }
    }
  }
  // Shapes an earlier version wrote at the top level. The settings schema is
  // `z.any()`, so the host does not strip them: without this fold a hand-edited
  // or older settings file silently lost the user's per-model image toggle and
  // context window. The bar matches `parseOverride` on save, so a value no save
  // could have produced is refused here too.
  for (const id of Array.isArray(value.imageModelIds) ? value.imageModelIds : []) {
    if (typeof id === "string" && id !== "") {
      overrides[id] = { ...(overrides[id] || {}), supportsImages: true };
    }
  }
  const budgets = value.contextBudgets && typeof value.contextBudgets === "object" && !Array.isArray(value.contextBudgets)
    ? value.contextBudgets
    : {};
  for (const [id, budget] of Object.entries(budgets)) {
    if (typeof id === "string" && id !== "" && typeof budget === "number"
      && Number.isInteger(budget) && budget > 0 && budget <= MAX_TOKEN_BUDGET) {
      overrides[id] = { ...(overrides[id] || {}), contextWindow: budget };
    }
  }
  if (Object.keys(overrides).length > 0) out.overrides = overrides;
  return out;
}
/**
 * The selection actually applied to one gateway's catalog.
 *
 * A stored selection can name models the live roster no longer carries (the
 * upstream renames and retires models). Applying that verbatim would filter
 * every model out: the picker group would vanish, the panel would show nothing
 * enabled, and no save could be made to look like it took effect. When none of
 * the saved ids exist any more, the selection is treated as unset so the group
 * stays usable, and `selectionStale` tells the panel to say why.
 *
 * Takes the catalog explicitly rather than looking it up in `runtimes`: it is
 * called while a runtime is still being constructed, before it is registered.
 */
function savedSelectionMatches(region, catalog) {
  const enabled = selectionFor(region).enabledModelIds;
  if (!Array.isArray(enabled) || enabled.length === 0 || !catalog) return true;
  const known = new Set(catalog.current().map((model) => model.id));
  return enabled.some((id) => known.has(id));
}

function effectiveSelectionFor(region, catalog) {
  return selectionJudgeable(catalog) && savedSelectionMatches(region, catalog) ? selectionFor(region) : {};
}

/**
 * Whether a saved selection can be judged against this roster at all.
 *
 * Only a roster the upstream answered with can retire an id. The static
 * fallback is this plugin's own guess, and judging against it reported every
 * model the vendor had added since as retired: the user's choice was replaced by
 * the fallback's list and the panel said so on every start, for as long as the
 * live read kept timing out.
 */
function selectionJudgeable(catalog) {
  return catalog !== undefined && catalog.hasLiveRoster() === true;
}

/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
  return selectionJudgeable(catalog) && !savedSelectionMatches(region, catalog);
}

/**
 * Apply the user's selection to one gateway's catalog, after checking it
 * against the roster that gateway actually has.
 *
 * Called when settings change, when a runtime is built, and after the roster is
 * (re)read, because a selection is only meaningful relative to the current
 * catalog: a re-read can retire every id a saved selection names.
 */
function applyEffectiveSelection(region, runtime) {
  const target = runtime ?? runtimes.get(regionOfKey(region));
  if (!target) return;
  target.catalog.applySelection(effectiveSelectionFor(region, target.catalog));
  if (selectionStale(region, target.catalog)) {
    target.lastWarning = "the saved model selection no longer matches the live model list; showing every model";
  }
}

// ------------------------------------------------------------------ network

/** The port one gateway prefers, and the only address it ever publishes. */
function preferredPort(region) {
  const port = REGION_PORTS[region];
  return typeof port === "number" ? port : 0;
}

/**
 * A pause, for the retry loops below.
 *
 * The timer is unref'd: a pause nobody is waiting for any more - the plugin is
 * unloading, or the whole pass it belongs to has already been abandoned - must
 * not be the reason the process stays alive.
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Unref: a pause is never the reason a process should stay alive.
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * A check-in pacing pause a stopping service can cut short.
 *
 * The same unref'd pause as `delay`, plus the abort: a pass that is still
 * spacing its accounts when the service stops would otherwise sit out the
 * whole gap - Trae's is five seconds - before it even notices. The listener is
 * removed on both ways out, so a signal the plugin keeps for its life never
 * collects one.
 */
function checkinDelay(ms) {
  const signal = currentCheckinSignal();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait for `work`, but no longer than `budgetMs`.
 *
 * Resolves to the value when the work finishes in time and `undefined` when the
 * budget runs out. The work is never cancelled - a plugin pass must finish what
 * it started - so the caller's job is to answer on time and let the late result
 * land in whatever cache the panel reads next.
 */
async function settleWithin(work, budgetMs) {
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One deadline, and the two things a bounded pass does with it.
 *
 * `left` is what a step inside the pass is given, and `settle` runs one step
 * against whatever is left, so the pass states its budget once instead of
 * re-deriving the same arithmetic at every step. The deadline is taken when the
 * budget is made, not when the first step starts.
 */
function budget(ms) {
  const deadline = Date.now() + ms;
  const left = () => Math.max(0, deadline - Date.now());
  return { left, settle: (work) => settleWithin(work, left()) };
}

/**
 * Try to bind one specific port once.
 *
 * Resolves the port on success and 0 on failure, so the caller can decide
 * whether to wait and try again instead of moving on immediately.
 */
function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      try {
        server.close();
      } catch {
        /* already gone */
      }
      resolve(0);
    });
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Ask the OS for the gateway's one preferred port.
 *
 * A port busy for a quarter of a second is the previous instance shutting
 * down. Giving up on the first refusal made a run bind an ephemeral port while
 * the declaration kept naming this one, leaving the host on an address nothing
 * listens on.
 *
 * Resolves 0 when the port stays taken. The shim then uses an ephemeral port
 * for this session, and the declaration is rewritten to name the port this
 * run actually bound, so the host is never left on an address nothing
 * listens on.
 */
function reservePort(port) {
  if (typeof port !== "number" || port <= 0) return Promise.resolve(0);
  return (async () => {
    for (let attempt = 0; attempt < PORT_RESERVE_ATTEMPTS; attempt += 1) {
      const bound = await tryPort(port);
      if (bound !== 0) return bound;
      if (attempt < PORT_RESERVE_ATTEMPTS - 1) await delay(PORT_RESERVE_INTERVAL_MS);
    }
    return 0;
  })();
}

// -------------------------------------------------------------- declaration

/** Thinking levels the picker may offer for one model, in host order. */
function thinkingLevelsFor(model) {
  const declared = Array.isArray(model.supportedEfforts)
    ? model.supportedEfforts.filter((level) => HOST_THINKING_LEVELS.includes(level))
    : [];
  if (declared.length === 0) return ["off"];
  // Only a declared set is a choice; "off" is offered only when the upstream
  // says thinking can be switched off. Otherwise the lowest declared level is
  // the floor and an invented "off" would promise a control that does nothing.
  const wanted = model.canDisableThinking === true ? ["off", ...declared] : declared;
  return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}
/**
 * Whether a level list is worth publishing.
 *
 * One real level is still a choice and keeps the model a reasoning one; a lone
 * "off" only says the model cannot think, which the host already reads from an
 * absent level list.
 */
function offersThinking(levels) {
  return levels.some((level) => level !== "off");
}

/** Model label as the picker shows it: name plus the upstream cost suffix. */
function modelDisplayName(model) {
  const label = model.name || model.id;
  if (typeof model.multiplier !== "number" || !Number.isFinite(model.multiplier)) return label;
  return label + " · x" + model.multiplier.toFixed(2);
}

/**
 * The label the picker shows.
 *
 * An alias the user typed is used verbatim: it is a name, not a catalog row, so
 * appending a cost suffix to it would edit the user's own text back. Without an
 * alias the catalog name keeps its suffix, which is the existing behaviour.
 */
function modelLabel(model) {
  const alias = typeof model.alias === "string" ? model.alias.trim() : "";
  return alias === "" ? modelDisplayName(model) : alias;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  // Clamped to the ceiling the host's own validator enforces: a catalog figure
  // of 1e20 was rounded and published verbatim into the manifest.
  return Math.min(MAX_TOKEN_BUDGET, Math.round(number));
}

/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
  const catalog = runtimes.get(region)?.catalog;
  if (!catalog) return [];
  const models = [];
  const seen = new Set();
  for (const model of catalog.visible()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const thinkingLevels = thinkingLevelsFor(model);
    const entry = {
      id,
      name: modelLabel(model),
      contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
      maxTokens: positiveInteger(model.maxOutputTokens, DEFAULT_MAX_TOKENS),
      supportsImages: model.supportsImages === true,
      ...offersThinking(thinkingLevels) ? { thinkingLevels } : {},
    };
    // A default that is not one of the offered levels is dropped rather than
    // published: the host stores it verbatim and the picker would then open on
    // a level it does not list.
    if (typeof model.defaultThinkingLevel === "string"
      && thinkingLevels.includes(model.defaultThinkingLevel)) {
      entry.defaultThinkingLevel = model.defaultThinkingLevel;
    }
    models.push(entry);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** Runtime registration must name the bound gateway, including a fallback port. */
function descriptorFor(region) {
  const runtime = runtimes.get(region);
  const preferred = preferredPort(region);
  const baseUrl = runtime?.baseUrl || (preferred > 0
    ? "http://127.0.0.1:" + preferred + "/v1"
    : PLACEHOLDER_BASE_URL);
  return {
    id: PROVIDER_ID_BY_REGION[region],
    name: PROVIDER_NAME_BY_REGION[region],
    baseUrl,
    apiStyle: "chat_completions",
    authKind: "none",
    models: declarationModels(region),
  };
}

/**
 * Publish the provider rows through the running host.
 *
 * Because registration is a runtime call, this is also where the process's own
 * record of its declaration is kept. The result keeps the shape its callers
 * expect, so `syncDeclaration` and the panel footer are unaffected.
 */
function writeDeclaration(descriptors) {
  const result = pi.declareProviders(descriptors);
  // The index always holds what this run WANTS the host to serve, so a refused
  // registration can be named; `publishedIds` is what the host confirmed. On a
  // refusal nothing of the set is being served - the failed attempt releases
  // whatever it had taken - so the set is cleared rather than left at its last
  // successful value. Keeping that value made a wanted set which was a subset of
  // the last published one look fully registered to `unpublishedDeclarations`.
  declarationIndex = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  publishedIds = result.ok === true
    ? new Set(descriptors.map((descriptor) => descriptor.id))
    : new Set();
  return result;
}

/**
 * Result of the last declaration write, for the panel footer.
 *
 * Starts as not-ok because nothing has been written yet: `ok: true` here read as
 * "the last write succeeded" before any write had been attempted, so a cold load
 * whose first pass failed showed the footer as up to date. The reason travels
 * with it, because a disabled plugin never writes at all and the panel and
 * doctor print the message verbatim - without it the report said "undefined".
 */
const runtimeState = { write: { ok: false, changed: false, error: "the declaration has not been published yet" } };


/**
 * Cache for the auxiliary per-account probes (credits, check-in).
 *
 * Keyed by account id. A panel open reads this cache and schedules the upstream
 * calls behind it, instead of blocking the first paint on 2 calls per account.
 */
const probeCache = new Map();

/**
 * Publish every gateway that is actually usable.
 *
 * A provider row with an empty model list is not registered at all: an adapter
 * route with nothing behind it serves nothing, and registering it would put a
 * dead group in the picker. A gateway that is signed out, unreachable or still
 * starting is therefore left out; the next registration drops the row, which is
 * also how a signed-out edition disappears from the picker.
 */
function syncDeclaration() {
  const publishable = activeRegions().filter((region) => {
    const runtime = runtimes.get(region);
    return runtime && runtime.signedIn && declarationModels(region).length > 0;
  });
  // Trae publishes on the same terms: only with the switch on, only once its
  // directory has answered, and never with an empty model list.
  const publishableTrae = activeTraeRegions().filter((region) => traeDeclarationModels(region).length > 0);
  // Qoder publishes on the same terms: only with the switch on, only once its
  // directory has answered, and never with an empty model list.
  const publishableQoder = activeQoderRegions().filter((region) => qoderDeclarationModels(region).length > 0);
  const anyActive = activeRegions().length > 0 || activeTraeRegions().length > 0 || activeQoderRegions().length > 0;
  // A deliberate switch-off must erase the declaration: leaving a provider row
  // for a source the user disabled would keep serving nothing from that row.
  if (!anyActive) {
    const result = writeDeclaration([]);
    runtimeState.write = result.ok
      ? { ...result, skipped: "every source is switched off; the declaration is cleared" }
      : result;
    return runtimeState.write;
  }
  const activeIds = new Set([
    ...activeRegions().map((region) => PROVIDER_ID_BY_REGION[region]),
    ...activeTraeRegions().map((region) => TRAE_PROVIDER_ID_BY_REGION[region]),
    ...activeQoderRegions().map((region) => QODER_PROVIDER_ID_BY_REGION[region]),
  ]);
  const current = [
    ...publishable.map(descriptorFor),
    ...publishableTrae.map(descriptorForTrae),
    ...publishableQoder.map(descriptorForQoder),
  ];
  const currentIds = new Set(current.map((provider) => provider.id));
  // One warming gateway must not lose its saved roster when a sibling connects.
  // Retention is scoped to that case alone: a gateway whose runtime exists and
  // has answered is definitively signed out or unreachable, and keeping its row
  // published a stale model list for as long as the source stayed switched on -
  // which is what the rule above says must not happen.
  const warming = warmingGatewayIds();
  const retained = declaredProviders().filter((provider) => activeIds.has(provider.id)
    && !currentIds.has(provider.id)
    && warming.has(provider.id));
  const result = writeDeclaration([...current, ...retained]);
  runtimeState.write = result;
  return result;
}

/**
 * The provider ids of the active gateways that are still warming up.
 *
 * "Warming" is the only reason a row is republished for a gateway that cannot
 * publish right now: its roster has not landed yet, so dropping the row would
 * cost a roster it already had. A gateway that has answered is signed out or
 * unreachable, and the rule on {@link syncDeclaration} says its row goes.
 */
function warmingGatewayIds() {
  const ids = new Set();
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    // No runtime yet, or one mid-connect: the roster is still on its way. A
    // region whose start failed is not on its way - it is not coming.
    if (gatewayStartFailures.has(region)) continue;
    if (runtime === undefined || runtime.connecting !== null) ids.add(PROVIDER_ID_BY_REGION[region]);
  }
  for (const [source, gateways, regions, idByRegion] of [
    ["trae", traeGateways, activeTraeRegions(), TRAE_PROVIDER_ID_BY_REGION],
    ["qoder", qoderGateways, activeQoderRegions(), QODER_PROVIDER_ID_BY_REGION],
  ]) {
    for (const region of regions) {
      // A start that failed is exactly as final here as it is for WorkBuddy: the
      // gateway is not coming, so its saved roster must not be retained.
      if (sourceStartFailures.has(source + ":" + region)) continue;
      const entry = gateways.get(region);
      // No gateway yet, or one whose directory read has neither answered nor
      // failed: both are a roster still in flight.
      if (entry === undefined || (entry.gateway.models().length === 0 && entry.lastError === "")) {
        ids.add(idByRegion[region]);
      }
    }
  }
  return ids;
}

/**
 * Ask one Trae/Qoder gateway for its directory once, and record what it said.
 *
 * The message is overwritten either way round: a directory that failed while
 * load was still opening the other gateways and answers a minute later must
 * not keep reporting the first failure for the rest of the process. That is
 * what WorkBuddy's `connect` also does, by clearing before every attempt.
 */
async function warmSourceDirectory(entry, signal) {
  if (signal && signal.aborted) return false;
  // The timeout is not optional: folded into the composite signal it would be
  // dropped for a caller that passes no lifecycle signal — the user-invoked
  // refresh — leaving that path bounded only by the outer pass budget. So it
  // always applies, and the lifecycle signal is added on top when there is one.
  const bounds = [AbortSignal.timeout(DIRECTORY_WARM_TIMEOUT_MS)];
  if (signal) bounds.push(signal);
  try {
    const warm = await fetch(entry.baseUrl + "/v1/models", {
      signal: bounds.length === 1 ? bounds[0] : AbortSignal.any(bounds),
    });
    entry.lastError = warm.ok ? "" : "directory answered HTTP " + warm.status;
  } catch (error) {
    if (signal && signal.aborted) return false;
    // A read this pass gave up on is not a directory that failed: the gateway
    // is still holding a roster, or still fetching one, and a message the user
    // cannot act on is worse than no message.
    entry.lastError = entry.gateway.models().length > 0 ? "" : "directory unavailable: " + safeMessage(error);
    if (entry.lastError !== "") log("warn", "[" + entry.source + ":" + entry.region + "] " + entry.lastError);
  }
  // A roster that lands after the load-time publish would otherwise leave its
  // provider row missing until some later pass happened to refresh: the group
  // reads as having disappeared across a restart. Publishing here is what makes
  // the row appear as soon as the directory really answered; a write that changes
  // nothing is a no-op.
  entry.warmSettled = true;
  if (entry.lastError === "" && entry.gateway.models().length > 0) syncDeclaration();
  return entry.lastError === "";
}

/**
 * How long one directory read may take before a refresh pass gives up on it.
 *
 * The Trae directory walks several upstream endpoints behind the gateway's
 * `/v1/models`, and a gateway whose read has not been bounded leaves every
 * user-invoked refresh waiting on it. This is the ceiling on that wait, not on
 * the read itself: a gateway that stops here keeps fetching and every later
 * refresh sees the roster it lands with.
 */
const DIRECTORY_WARM_TIMEOUT_MS = 8000;

/** Startup warm-up attempts and the gap between them, for a cold machine. */
const DIRECTORY_WARM_ATTEMPTS = 3;
const DIRECTORY_WARM_BACKOFF_MS = 1500;

/**
 * Aborted on unload, and re-created on the next load.
 *
 * The startup warm-up runs detached — it must not hold up the host's answer —
 * so nothing else owns its lifetime. Left alone it outlives the plugin: up to
 * three 8 s attempts plus backoff kept fetching a gateway that had already been
 * closed, and wrote `lastError` onto an entry no map held any more, which is how
 * the next load's log picked up warnings about a run that had just ended.
 */
let warmAbort = new AbortController();

/** Stop every warm-up still in flight. Called from `onUnload`. */
function abortWarmups() {
  warmAbort.abort();
}

/**
 * Warm one gateway's directory, retrying while a startup burst can be blamed.
 *
 * The first attempt runs while load is still reading every other source's
 * storage and opening its sockets, so one failure is not taken as the answer.
 * Whatever survives the retries stays on the entry until a later refresh
 * clears it.
 */
async function warmSourceDirectoryAtStartup(entry, signal) {
  for (let attempt = 1; attempt <= DIRECTORY_WARM_ATTEMPTS; attempt += 1) {
    if (signal && signal.aborted) return false;
    if (await warmSourceDirectory(entry, signal)) return true;
    if (attempt >= DIRECTORY_WARM_ATTEMPTS) break;
    // The pause is part of the chain an abort has to stop, so it races the signal
    // instead of sitting out its full gap after unload. The listener is removed
    // when the pause ends normally: an abort that never comes would otherwise
    // leave one behind per attempt on a signal the plugin keeps for its life.
    if (!signal) {
      await delay(DIRECTORY_WARM_BACKOFF_MS * attempt);
      continue;
    }
    await new Promise((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      delay(DIRECTORY_WARM_BACKOFF_MS * attempt).then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
  return false;
}

// ------------------------------------------------------------------ runtime

/**
 * Create one gateway's runtime: its own catalog and its own loopback endpoint.
 *
 * Each gateway is scoped to its own account slice of the pool, so a CN request
 * can never be served by a global account and vice versa - the two gateways are
 * not interchangeable - and a failing gateway cannot take the other one down.
 *
 * Credentials and identity come from the machine's own Trae installs, read
 * per request rather than cached here, so switching the source off really
 * does stop the scanning. The directory is warmed through the gateway's own
 * `/v1/models` route right after start: until it answers there is no model
 * list, and a gateway with no models is simply not published.
 */
async function createTraeRuntime(region) {
  const preferred = TRAE_PORTS[region];
  // Reserved before the listener exists, for the same reason as WorkBuddy:
  // a run that can have the preferred port must have it, or the address this
  // run registers would describe a run that is not this one.
  const bound = await reservePort(preferred);
  const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
  const gateway = createTraeGateway({
    // Only this region's sign-ins: the two gateways are not interchangeable, so
    // a CN request must never be answered by an international token. The list
    // is ordered by the panel's account pick and usage mode.
    credentials: async (purpose) => orderSourceCredentials(
      "trae",
      region,
      (await discoverTraeCredentials()).credentials.filter((credential) => traeRegionOfCredential(credential) === region),
      traeRowLabel,
      purpose === "chat",
    ),
    identity: (credential) => resolveTraeIdentity(desktopCandidates, credential.edition),
    listedIds: () => traeDeclarationModels(region).map((model) => model.id),
    // The window this run publishes for a model, so Max mode is only asked for
    // when the declaration really exceeds the model's default tier.
    // The window this run publishes for the model: the answer that serves it is
    // the one whose function and Max flag the request has to use. Read from the
    // live declaration because this host registers providers at runtime - the set
    // in force is the set it has, with no restart and no older copy to disagree
    // with (PI-Desktop reads its manifest only at launch, which is why that build
    // reconciles against the loaded copy instead).
    publishedWindowOf: (modelId) => {
      const declared = traeDeclarationModels(region).find((model) => model.id === modelId);
      return declared === undefined ? undefined : declared.contextWindow;
    },
    onAttemptFailure: (credential, outcome) => {
      noteSourceFailure("trae", region, traeRowLabel(credential), outcome.retryAfter);
    },
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[trae:" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[trae:" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[trae:" + region + "] ", args)),
    },
  });
  await gateway.ready;
  const entry = { region, gateway, baseUrl: gateway.baseUrl(), portFallback: bound !== preferred, preferredPort: preferred, lastError: "", source: "trae", warmSettled: false };
  // The fallback is silent otherwise: the published row names the port this
  // session actually bound, and the one thing the panel cannot show on its own
  // is that a restart will move it back. Same warning the WorkBuddy shim logs
  // for the same race.
  if (entry.portFallback) {
    log("warn", "[trae:" + region + "] preferred port " + preferred + " is held by another process; " +
      "serving this session on port " + gateway.port());
  }
  // Never let the directory read hold up init: the host gives the plugin only
  // seconds to answer it, and a slow or failing directory must not spend that
  // budget. The gateway is listening by now, so the roster lands behind the
  // answer - the message above reports a failure while one lasts, and every
  // refresh asks again.
  // A rejection here would be an unhandled one in the plugin's own process,
  // which is how a plugin dies; the warm-up itself never throws, and this keeps
  // a future edit from turning it into one.
  warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[trae:" + region + "] directory warm-up failed: " + safeMessage(error)));
  return entry;
}

/** Start and stop Trae gateways so the map matches the source switch exactly. */
async function reconcileTraeGateways() {
  const generation = loadGeneration;
  if (!stillLoaded(generation) || serviceStopped) return;
  const active = activeTraeRegions();
  for (const [region, entry] of Array.from(traeGateways)) {
    if (!stillLoaded(generation) || serviceStopped) return;
    if (active.includes(region)) continue;
    traeGateways.delete(region);
    sourceStartFailures.delete("trae:" + region);
    try {
      await entry.gateway.close();
    } catch (error) {
      log("warn", "[trae:" + region + "] gateway did not close cleanly: " + safeMessage(error));
    }
  }
  for (const region of active) {
    if (!stillLoaded(generation) || serviceStopped) return;
    if (traeGateways.has(region)) continue;
    const key = "trae:" + region;
    // A rescan can reconcile beside the background refresh. Without the shared
    // promise both bind; the loser's EADDRINUSE then marks a healthy region as
    // failed, and addressDrift reports a gateway that is actually serving. The
    // second caller waits for that start, so a rescan still sees the gateway.
    const pending = sourceGatewayStarts.get(key);
    if (pending !== undefined) {
      await pending.catch(() => {});
      continue;
    }
    const starting = createTraeRuntime(region);
    sourceGatewayStarts.set(key, starting);
    try {
      const entry = await starting;
      if (!stillLoaded(generation) || !activeTraeRegions().includes(region) || traeGateways.has(region)) {
        await entry.gateway.close();
      } else {
        traeGateways.set(region, entry);
        sourceStartFailures.delete(key);
      }
    } catch (error) {
      // A start from the activation being torn down must not put its failure on
      // the next activation's healthy gateway.
      if (stillLoaded(generation)) {
        // Recorded before the log line, so nothing downstream has to read the
        // log to tell a failed start from one that has not finished.
        sourceStartFailures.set(key, safeMessage(error));
        log("warn", "[trae:" + region + "] gateway could not start: " + safeMessage(error));
      }
    } finally {
      if (sourceGatewayStarts.get(key) === starting) sourceGatewayStarts.delete(key);
    }
  }
}

/** What a Trae gateway itself reported for one model. */
function traeNativeOf(model) {
  const devWindow = positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW);
  // The larger window the same model accepts with Max mode on. Trae sells Max as
  // a separate tier: the row states both, and the default is not the ceiling.
  const maxWindow = positiveInteger(model.maxContextWindow, 0);
  const ceiling = Math.max(devWindow, maxWindow);
  return {
    contextWindow: devWindow,
    maxTokens: positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS),
    // The same model states a smaller output budget through the function that
    // serves its Max tier, so the budget follows the window in force: keeping the
    // default gets the wider budget, reaching for Max gets that function's own.
    ...maxWindow > devWindow
      ? { maxTokensAtCeiling: positiveInteger(traeVariantFor(model, ceiling)?.maxTokens, positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS)) }
      : {},
    // The highest window this model accepts, so the panel's ceiling is the
    // model's real room rather than the default tier's.
    ...maxWindow > devWindow ? { maxContextWindow: maxWindow } : {},
    // The directory's own vision flag. An OpenAI image content block goes
    // through this gateway untouched (`prepareSoloBody` keeps the message list,
    // only turning a string into a text block), and a live request with a solid
    // red PNG came back naming the colour - so the flag is published as the
    // directory states it rather than guessed from a model name. A row that
    // states nothing stays false.
    supportsImages: model.supportsImages === true,
    // The levels this model advertises, in the host's own names, so the panel's
    // editor can offer the control and a stored override has something to edit.
    thinkingLevels: (model.reasoning ? model.reasoning.supported : [])
      .filter((level) => HOST_THINKING_LEVELS.includes(level)),
    // The directory's own effective (post-discount) rate, the same figure the
    // IDE prints beside a model. A row that states none stays unlabelled rather
    // than being given a guessed cost, so this is spread rather than defaulted.
    ...Number.isFinite(model.creditMultiplier) ? { multiplier: model.creditMultiplier } : {},
  };
}

function traeDeclarationModels(region) {
  const gateway = traeGateways.get(region)?.gateway;
  if (!gateway) return [];
  const models = [];
  const seen = new Set();
  const roster = gateway.models().map((model) => String(model.id || "").trim());
  const enabled = gatewayEnabledIds("trae:" + region, roster);
  for (const model of gateway.models()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    if (enabled !== null && !enabled.has(id)) continue;
    seen.add(id);
    // The stored per-model edits apply here, exactly as they do for WorkBuddy:
    // the panel edits a model and this is what the provider row then declares.
    const native = traeNativeOf(model);
    // The directory is the IDE's slot table, so it is filtered on the same term
    // the panel's roster is — see `isSelectableSourceModel`.
    const view = sourceModelView("trae:" + region, model, native);
    if (!isSelectableSourceModel("trae", view)) continue;
    // The levels this model actually advertises. Without them the host opens
    // its whole ladder - including `max`, which Trae has no word for - and the
    // picker would offer choices SOLO ignores.
    const advertised = native.thinkingLevels;

    // The user's edit, when they made one: the panel saves it and the row then
    // shows "advanced", so a stored list that never reaches the declaration is
    // an edit that reads as saved and changes nothing.
    const edited = Array.isArray(view.thinkingLevels) && view.thinkingLevels.length > 0
      ? view.thinkingLevels.filter((level) => HOST_THINKING_LEVELS.includes(level))
      : [];
    const levels = edited.length > 0 ? HOST_THINKING_LEVELS.filter((level) => edited.includes(level)) : advertised;
    models.push({
      id: view.id,
      // Same label rule as WorkBuddy's declaration: the user's alias verbatim,
      // otherwise the catalog name with its cost suffix.
      name: modelLabel(view),
      contextWindow: view.contextWindow,
      maxTokens: view.maxOutputTokens,
      supportsImages: view.supportsImages,
      // An empty list is read by the host as "offer every level". A lone
      // "off" is how a model with no Trae levels is kept off that ladder.
      thinkingLevels: offersThinking(levels) ? levels : ["off"],
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** One Trae provider declaration, same shape as {@link descriptorFor}. */
function descriptorForTrae(region) {
  const preferred = TRAE_PORTS[region];
  return {
    id: TRAE_PROVIDER_ID_BY_REGION[region],
    name: TRAE_PROVIDER_NAME_BY_REGION[region],
    baseUrl: traeGateways.get(region)?.baseUrl
      ? traeGateways.get(region).baseUrl + "/v1"
      : "http://127.0.0.1:" + preferred + "/v1",
    apiStyle: "chat_completions",
    authKind: "none",
    models: traeDeclarationModels(region),
  };
}

/** One discovered Qoder sign-in, shaped as the client and gateway consume it. */
function qoderClientCredential(credential) {
  return {
    userID: credential.userID,
    token: credential.token,
    ...credential.name === "" ? {} : { name: credential.name },
    ...credential.email === "" ? {} : { email: credential.email },
    ...credential.machineID === undefined ? {} : { machineID: credential.machineID },
  };
}

/**
 * Start one Qoder gateway on its own fixed port.
 *
 * Credentials come from the machine's own Qoder installs, read per request
 * rather than cached here, so switching the source off really does stop the
 * scanning. The directory is warmed through the gateway's own `/v1/models`
 * route right after start: until it answers there is no model list, and a
 * gateway with no models is simply not published.
 */
async function createQoderRuntime(region) {
  const preferred = QODER_PORTS[region];
  // Reserved before the listener exists, for the same reason as WorkBuddy:
  // a run that can have the preferred port must have it, or the address this
  // run registers would describe a run that is not this one.
  const bound = await reservePort(preferred);
  const gateway = createQoderGateway({
    region,
    // Only this region's sign-ins, in the order the panel's account pick and
    // usage mode ask for: the gateway serves the first usable one.
    credentials: async (purpose) => {
      const found = await discoverQoderCredentials();
      const mine = found.credentials.filter((credential) => credential.region === region);
      return orderSourceCredentials("qoder", region, mine, qoderRowLabel, purpose === "chat").map(qoderClientCredential);
    },
    listedIds: () => qoderDeclarationModels(region).map((model) => model.id),
    onAttemptFailure: (credential, outcome) => {
      // The gateway holds mapped credentials, so the label is rebuilt here the
      // way `qoderRowLabel` builds it from the raw one.
      const label = typeof credential.name === "string" && credential.name !== ""
        ? credential.name
        : credential.userID;
      noteSourceFailure("qoder", region, label, outcome.retryAfter);
    },
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[qoder:" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[qoder:" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[qoder:" + region + "] ", args)),
    },
  });
  await gateway.ready;
  const entry = { region, gateway, baseUrl: gateway.baseUrl(), portFallback: bound !== preferred, preferredPort: preferred, lastError: "", source: "qoder", warmSettled: false };
  // The fallback is silent otherwise: the published row names the port this
  // session actually bound, and the one thing the panel cannot show on its own
  // is that a restart will move it back. Same warning the WorkBuddy shim logs
  // for the same race.
  if (entry.portFallback) {
    log("warn", "[qoder:" + region + "] preferred port " + preferred + " is held by another process; " +
      "serving this session on port " + gateway.port());
  }
  // Off the init path for the same reason as Trae's: the directory read must
  // never hold the plugin's answer to the host.
  warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[qoder:" + region + "] directory warm-up failed: " + safeMessage(error)));
  return entry;
}

/** Start and stop Qoder gateways so the map matches the source switch exactly. */
async function reconcileQoderGateways() {
  const generation = loadGeneration;
  if (!stillLoaded(generation) || serviceStopped) return;
  const active = activeQoderRegions();
  for (const [region, entry] of Array.from(qoderGateways)) {
    if (!stillLoaded(generation) || serviceStopped) return;
    if (active.includes(region)) continue;
    qoderGateways.delete(region);
    sourceStartFailures.delete("qoder:" + region);
    try {
      await entry.gateway.close();
    } catch (error) {
      log("warn", "[qoder:" + region + "] gateway did not close cleanly: " + safeMessage(error));
    }
  }
  for (const region of active) {
    if (!stillLoaded(generation) || serviceStopped) return;
    if (qoderGateways.has(region)) continue;
    const key = "qoder:" + region;
    const pending = sourceGatewayStarts.get(key);
    if (pending !== undefined) {
      await pending.catch(() => {});
      continue;
    }
    const starting = createQoderRuntime(region);
    sourceGatewayStarts.set(key, starting);
    try {
      const entry = await starting;
      if (!stillLoaded(generation) || !activeQoderRegions().includes(region) || qoderGateways.has(region)) {
        await entry.gateway.close();
      } else {
        qoderGateways.set(region, entry);
        sourceStartFailures.delete(key);
      }
    } catch (error) {
      if (stillLoaded(generation)) {
        sourceStartFailures.set(key, safeMessage(error));
        log("warn", "[qoder:" + region + "] gateway could not start: " + safeMessage(error));
      }
    } finally {
      if (sourceGatewayStarts.get(key) === starting) sourceGatewayStarts.delete(key);
    }
  }
}

function qoderNativeOf(model) {
  return {
    // The window the model runs at, not the input budget inside it: Qoder's
    // catalog publishes `context_config` with the sizes and marks the one in
    // force; `max_input_tokens` is a separate input budget.
    contextWindow: positiveInteger(model.contextWindow ?? model.maxInputTokens, CONSERVATIVE_CONTEXT_WINDOW),
    // The directory publishes no output limit anywhere — all eleven of its
    // groups carry the same keys and none of them is one — so this is the
    // plugin's own ceiling rather than the model's, and the panel's per-model
    // override is where a user sets the real one.
    maxTokens: DEFAULT_MAX_TOKENS,
    // The directory marks vision-capable models; anything else stays false
    // rather than guessing from the model name.
    supportsImages: model.supportsImages === true,
    // The levels this model advertises, in the host's own names, so the panel's
    // editor can offer the control and a stored override has something to edit.
    thinkingLevels: qoderThinkingLevelsFor(model),
  };
}

/**
 * Thinking levels one Qoder model may offer, in host order.
 *
 * Qoder's ladder spells "off" as "none", which the host does not use, so the
 * table is filtered to the host's own names first. A row whose catalog entry
 * carries no level table only takes thinking on or off, which the declaration
 * publishes as a lone "off" - an absent list would open the host's whole
 * ladder on a model that has no levels to offer.
 */
function qoderThinkingLevelsFor(model) {
  const declared = Array.isArray(model.effortLevels)
    ? model.effortLevels.filter((level) => HOST_THINKING_LEVELS.includes(level))
    : [];
  if (declared.length === 0) return [];
  const wanted = model.alwaysThinking === true ? declared : ["off", ...declared];
  return HOST_THINKING_LEVELS.filter((level) => wanted.includes(level));
}

/** The models one Qoder gateway publishes, after its directory has been read. */
function qoderDeclarationModels(region) {
  const gateway = qoderGateways.get(region)?.gateway;
  if (!gateway) return [];
  const models = [];
  const seen = new Set();
  const roster = gateway.models().map((model) => String(model.id || "").trim());
  const enabled = gatewayEnabledIds("qoder:" + region, roster);
  for (const model of gateway.models()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    if (enabled !== null && !enabled.has(id)) continue;
    seen.add(id);
    // The stored per-model edits apply here exactly as they do for WorkBuddy.
    const native = qoderNativeOf(model);
    const view = sourceModelView("qoder:" + region, model, native);    // Same term as the panel's roster, so the two lists cannot drift apart.
    if (!isSelectableSourceModel("qoder", view)) continue;
    const levels = native.thinkingLevels;
    // The user's edit, when they made one. Qoder's own table comes from the
    // catalog; a stored list the declaration never read was an edit that
    // reported success and changed nothing.
    const edited = Array.isArray(view.thinkingLevels) && view.thinkingLevels.length > 0
      ? view.thinkingLevels.filter((level) => HOST_THINKING_LEVELS.includes(level))
      : [];
    const published = edited.length > 0
      ? HOST_THINKING_LEVELS.filter((level) => edited.includes(level))
      : levels;
    models.push({
      id: view.id,
      name: view.name,
      contextWindow: view.contextWindow,
      maxTokens: view.maxOutputTokens,
      supportsImages: view.supportsImages,
      // Same rule as Trae's: an empty list is read by the host as "offer every
      // level", and a lone "off" is how a model is kept off that ladder. A
      // stored `["off"]`-only edit therefore has to reach the declaration, or
      // the save reads as done and changes nothing.
      thinkingLevels: offersThinking(published) ? published : ["off"],
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

/** One Qoder provider declaration, same shape as {@link descriptorFor}. */
function descriptorForQoder(region) {
  const preferred = QODER_PORTS[region];
  return {
    id: QODER_PROVIDER_ID_BY_REGION[region],
    name: QODER_PROVIDER_NAME_BY_REGION[region],
    baseUrl: qoderGateways.get(region)?.baseUrl
      ? qoderGateways.get(region).baseUrl + "/v1"
      : "http://127.0.0.1:" + preferred + "/v1",
    apiStyle: "chat_completions",
    authKind: "none",
    models: qoderDeclarationModels(region),
  };
}

async function createRuntime(region) {
  const runtime = {
    region,
    baseUrl: PLACEHOLDER_BASE_URL,
    catalog: new WorkBuddyCatalog(),
    signedIn: false,
    lastError: "",
    lastWarning: "",
    portFallback: false,
    connecting: null,
    /** A stopped gateway cannot commit a catalog fetch that finishes later. */
    retired: false,
    catalogFetchedAtMs: 0,
  };
  applyEffectiveSelection(region, runtime);
  // The preferred port is reserved before the listener is created, so a run
  // that can have it does have it - which is what keeps the registered address
  // true.
  const preferred = preferredPort(region);
  const bound = await reservePort(preferred);
  // A port of 0 hands the shim an ephemeral port: the gateway still works this
  // session, but it is no longer the preferred address, so the state
  // is recorded rather than hidden.
  runtime.portFallback = bound === 0;
  if (runtime.portFallback) {
    log("warn", "[" + region + "] preferred port " + preferred + " is held by another process; " +
      "serving this session on an ephemeral port");
  }
  runtime.shim = createWorkBuddyShim({
    pool: core.pool,
    client: core.client,
    catalog: runtime.catalog,
    listedIds: () => declarationModels(region).map((model) => model.id),
    region,
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[" + region + "] ", args)),
    },
  });
  await runtime.shim.ready;
  runtime.baseUrl = runtime.shim.baseUrl() + "/v1";
  return runtime;
}

/**
 * One bind per region, whoever asks first.
 *
 * A rescan and the refresh pass can both reach a region with no runtime at the
 * same moment. Each used to reserve the preferred port and bind its own shim, so
 * one of them lost the bind and logged "the preferred port is held by another
 * process" - about this very process, whose first bind had not finished. Sharing
 * the in-flight promise makes the second caller the first one's answer.
 */
function startRuntimeOnce(region) {
  const existing = runtimeStarts.get(region);
  if (existing !== undefined) return existing;
  // Deleted by identity: a teardown clears the whole map, so by the time this
  // one settles a newer activation's start may be the entry here, and removing
  // that would let a third caller bind the same region a second time.
  const started = createRuntime(region).finally(() => {
    if (runtimeStarts.get(region) === started) runtimeStarts.delete(region);
  });
  runtimeStarts.set(region, started);
  return started;
}

/**
 * Take ownership of a runtime that has finished binding, or release it.
 *
 * Both callers of `startRuntimeOnce` land here with the same object, so
 * "somebody already put a runtime in the map" cannot be read as "mine is not
 * wanted": the other caller's entry is this very runtime. Releasing on that
 * reading closed a gateway that was serving and left a stopped object in the map
 * no later pass would rebuild.
 *
 * `unwanted` covers the reasons nobody is waiting for a gateway at all: the
 * activation it was started for is gone, the service stopped, or the region was
 * switched off while the shim was binding.
 *
 * A runtime already in the map outranks `unwanted`: the two callers of one
 * activation (`startRuntimes` and the refresh pass) share one bind, so a runtime
 * that one of them has already registered must not be closed by the other, whose
 * `unwanted` is about a generation or a region switch of its own. `runtimes.has`
 * is every later pass's only re-entry test, so a stopped entry there would take
 * the region out until the next teardown.
 *
 * This host's `onLoad` clears both maps, so it never shares a bind across a
 * reload; PI-Desktop clears them too and relies on this same ordering within one
 * activation.
 */
async function settleStartedRuntime(region, runtime, unwanted) {
  const held = runtimes.get(region);
  if (held === runtime) return true;
  // A runtime that another caller already released is not adopted, whoever asks:
  // that caller's activation had ended, so the map has to stay empty for a later
  // pass to rebuild from.
  if (runtime.retired === true) return false;
  // Both remaining releases close the gateway and leave the map alone, so they are
  // one branch: `unwanted` says nobody is waiting for it, and `held` says another
  // runtime already serves the region. Neither can keep it.
  if (unwanted || held !== undefined) {
    await stopRuntime(runtime);
    return false;
  }
  runtimes.set(region, runtime);
  gatewayStartFailures.delete(region);
  return true;
}

/**
 * Start every active WorkBuddy gateway that is not running yet.
 *
 * One gateway's failure is logged and left out, on the same terms as the Trae
 * and Qoder reconciles: the shim's `listen` can lose the port race that
 * `reservePort` opened between reserving and binding, and that must not take the
 * whole plugin down - the other region still has a roster to publish, and a
 * plugin that fails to load publishes nothing at all. Read end to end the two
 * regions cost one bound rather than two, which is why the reads run together.
 */
async function startRuntimes() {
  const generation = loadGeneration;
  if (!stillLoaded(generation)) return;
  // Gateways a settings change retired may still be closing; their ports are
  // only reusable once those closes settle. See `pendingRuntimeStops`.
  if (pendingRuntimeStops.length > 0) await Promise.all(pendingRuntimeStops.splice(0));
  await Promise.all(activeRegions().map(async (region) => {
    if (runtimes.has(region)) return;
    try {
      const runtime = await startRuntimeOnce(region);
      await settleStartedRuntime(region, runtime, !stillLoaded(generation) || !activeRegions().includes(region));
    } catch (error) {
      // A rejected bind from the activation being torn down must not overwrite
      // the next activation's healthy record for the same region.
      if (stillLoaded(generation)) {
        gatewayStartFailures.set(region, safeMessage(error));
        log("warn", "[workbuddy:" + region + "] gateway could not start: " + safeMessage(error));
      }
    }
  }));
}

async function stopRuntime(runtime) {
  // Idempotent, because one release path can outlive another: a refresh pass that
  // gave up waiting registers an observer for the same bind a second caller may
  // have just released, and closing a closed shim depends on internals of `net`
  // rather than on anything this file states.
  if (runtime.retired === true) return;
  runtime.retired = true;
  runtime.signedIn = false;
  // The next start for this region begins from a clean slate: a failure left
  // recorded here would keep a gateway that is being closed on purpose out of
  // the "still warming" set the whole time it is down.
  gatewayStartFailures.delete(runtime.region);
  if (runtime.shim) await runtime.shim.close().catch((error) => {
    log("warn", "[workbuddy:" + runtime.region + "] gateway did not close cleanly: " + safeMessage(error));
  });
}

/**
 * Come back for a roster that could not be read.
 *
 * Retries are cheap: a gateway with no account answers without a request, and
 * one whose read succeeded skips it on the freshness check.
 *
 * The handles are tracked so a stop or an unload can clear them: a retry that
 * outlived its activation fired into the next one and triggered a full refresh
 * pass nobody asked for.
 */
const modelRetryTimers = new Set<ReturnType<typeof setTimeout>>();
function scheduleModelRetries(attempt = 1) {
  if (serviceStopped) return;
  const timer = setTimeout(() => {
    modelRetryTimers.delete(timer);
    scheduleRefresh('model-list-retry');
    if (attempt < MODEL_RETRY_ATTEMPTS) scheduleModelRetries(attempt + 1);
  }, CATALOG_RETRY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  modelRetryTimers.add(timer);
}

/** Drop every pending roster retry. */
function clearModelRetries(): void {
  for (const timer of modelRetryTimers) clearTimeout(timer);
  modelRetryTimers.clear();
}

/**
 * Bring one gateway online: seed its catalog from that gateway's own account.
 *
 * The catalog is per gateway because the two do not advertise the same roster;
 * seeding both from one account showed a CN list on the international
 * provider. A gateway with no account keeps its static fallback, which is what
 * keeps its model list non-empty (and therefore publishable) before any
 * upstream call succeeds.
 */
async function connect(runtime, force) {
  // Stopped before this call began, or while it was in flight: everything below
  // writes shared state this runtime no longer owns.
  if (runtime.retired) return false;
  runtime.lastError = "";
  runtime.lastWarning = "";
  const regionAccounts = core.pool.list(runtime.region);
  // The first account whose sign-in the upstream still accepts, not simply the
  // first on file: a refused sign-in reads the roster with a token the gateway
  // turns away, and the static fallback then stands in for a roster a healthy
  // account on the same gateway would have read. With every account refused the
  // first one still reads, so the failure names the sign-in rather than
  // reporting the region as unsigned.
  const account = regionAccounts.find((item) => core.pool.activeHold(item.id)?.reason !== "session") ?? regionAccounts[0];
  if (account === undefined) {
    runtime.signedIn = false;
    runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
    // A region with no sign-in yet is not the same as one that will never have
    // one: the load-time account scan can still be running, and parking the
    // gateway for the whole TTL here left it serving the static fallback - the
    // wrong model list - for half an hour after every slow start. Only a
    // finished scan may park it.
    if (core.pool.status().lastScanAtMs === 0) {
      runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
      scheduleModelRetries();
      return false;
    }
    // Mark this gateway as settled even though nothing was fetched: a gateway
    // with no account can never become "fresh" on its own, and without this the
    // panel would poll to its attempt cap every time it opens for a pool that
    // is legitimately empty on one side.
    runtime.catalogFetchedAtMs = Date.now();
    return false;
  }
  runtime.signedIn = true;
  // Cached opens reuse the roster; a manual refresh bypasses its TTL.
  if (force === true || !catalogFresh(runtime)) {
    try {
      const models = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchModels(
          credential,
          AbortSignal.timeout(MODELS_TIMEOUT_MS),
        ));
      if (runtime.retired) return false;
      runtime.catalog.update(catalogFromUpstream(models));
      runtime.catalogFetchedAtMs = Date.now();
    } catch (error) {
      runtime.lastWarning = "model list failed: " + safeMessage(error);
      // Keep the previous roster (or the static fallback), but do not count a
      // failed read as a fresh one: stamping it fresh parked that fallback - and
      // with it the wrong model list, for the gateways and for the host's
      // picker - for the whole TTL after one slow start. The next attempt comes
      // on the retry clock instead.
      runtime.catalogFetchedAtMs = Date.now() - CATALOG_TTL_MS + CATALOG_RETRY_MS;
      scheduleModelRetries();
    }
  }
  // Re-check the saved selection against the roster now in force: a re-read may
  // have retired ids it names, and a failure leaves the previous roster up.
  applyEffectiveSelection(runtime.region, runtime);
  // Stopped while the fetch above was in flight: the runtime is held by no map
  // any more, so nothing here may claim it signed in.
  if (runtime.retired) return false;
  return true;
}

/** True while one gateway's model roster is still inside its refresh window. */
function catalogFresh(runtime) {
  if (runtime.catalogFetchedAtMs === 0) return false;
  return Date.now() - runtime.catalogFetchedAtMs < CATALOG_TTL_MS;
}

/**
 * Whether the panel should come back for a refreshed document.
 *
 * True while a pass is running (its result has not been rendered yet) and while
 * anything it would fill in is missing or stale: a stale model roster, billing
 * probes that are cold or past their TTL, or a cooldown whose end will
 * un-stale the accounts it covers. Scheduling is de-duplicated separately in
 * `scheduleRefresh`, so reporting an in-flight pass here is safe and is what
 * keeps the poll alive until the numbers actually land.
 */
function refreshNeeded() {
  if (serviceStopped) return false;
  if (refreshInflight !== null) return true;
  for (const runtime of runtimes.values()) {
    if (runtime.connecting) return true;
    if (!catalogFresh(runtime)) return true;
  }
  return probesStale() || cooldownPending();
}
/**
 * Whether any account the panel is showing is waiting on a cooldown to lapse.
 *
 * A pool whose every account is cooling answers "nothing to refresh", so the
 * panel stopped polling and the figures stayed stale until the user clicked
 * Refresh or the poll hit its attempt cap. The cooldown's own end is what
 * un-stales them, so it is the deadline the panel waits for.
 */
function cooldownPending() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    if (account.cooldownUntilMs > now) return true;
  }
  return false;
}

/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    // A cooling account is never probed (see statusDocument), so it can never
    // have a cache entry: counting it would keep every state call reporting a
    // detection pass in progress while the cooling lasts. A switched-off
    // account is skipped for the same reason, and counting it held the panel's
    // polling open for a row that never probes.
    if (account.cooldownUntilMs > now
      || core.pool.isDisabled(account.id)
      || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    const cached = probeCache.get(account.id);
    if (cached === undefined || now - cached.atMs >= PROBE_TTL_MS) return true;
    // A cooling account gets a check-in-only entry. Once its cooldown ends that
    // entry is still inside the TTL, so without this the scheduler treated it
    // as current and the card could keep an old balance or none until a manual
    // refresh. Only a full read clears the marker.
    if (cached.checkinOnly === true) return true;
  }
  return false;
}

/**
 * Run a refresh behind the current turn, at most one at a time.
 *
 * Deferring it to the next tick is what keeps a panel open cheap: the caller
 * answers from cache first and the detection lands behind the rendered page.
 * This is the *background* flavour, so it respects each gateway's refresh
 * window instead of forcing a roster fetch that load already did.
 */
function scheduleRefresh(reason) {
  if (serviceStopped) return;
  if (refreshTimer !== null || refreshInflight !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + safeMessage(error)));
  }, 0);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

async function refreshRuntime(runtime, reason, force) {
  if (runtime.connecting !== null) {
    const inFlight = runtime.connecting;
    if (force !== true) return inFlight;
    // A forced pass may not collapse onto a background read that skipped the
    // roster because it was still fresh: waiting for it answers the click with
    // the figures it already had, and the button exists precisely for the case
    // where a background read failed. It waits for that read to end and then
    // runs its own, which is the one that re-reads.
    await inFlight.catch(() => {});
    // Another pass claimed the gateway while this one waited: that read is the
    // newest there is, so it is awaited rather than duplicated.
    if (runtime.connecting !== null) return runtime.connecting;
  }
  runtime.connecting = (async () => {
    try {
      const ok = await connect(runtime, force === true);
      return { ok, reason };
    } finally {
      runtime.connecting = null;
    }
  })();
  return runtime.connecting;
}

/**
 * What a pass answers once its activation is gone.
 *
 * The document is deliberately not built: this plugin is no longer loaded, so
 * nobody is reading the answer, and reading the shared state it was built from
 * is exactly what must not happen during a teardown.
 */
function stalePass() {
  return { stale: true };
}

/**
 * Re-read settings, re-apply them, re-seed every gateway's catalog, then
 * republish. `force` decides whether each gateway's roster is refetched even
 * inside its refresh window: `true` for a user-invoked pass, `false` for the
 * background one that follows a panel open.
 *
 * Concurrent passes are collapsed: the background pass would otherwise
 * duplicate the work of the pass a Refresh click just started. The collapse
 * keeps awaiting the pass it found, whichever kind this call is, so a forced
 * click can never end up running a second pass beside the first. The one
 * exception is a forced click meeting a background pass: waiting for it to the
 * end would answer the click with figures it already had, so that click runs
 * its own pass. What it must not do is release the slot when its own work ends
 * - the background pass is still running, and a caller arriving in that window
 * would start a pass beside it. The slot therefore outlives both.
 */
async function refreshAll(reason, force) {
  if (serviceStopped) return await statusDocument({ allowNetwork: false });
  const wantForce = force === true;
  // A pass already in flight is collapsed onto and awaited to the end. Two
  // forced clicks collapse the same way: the second one's figures would be the
  // first one's, and running both reconciled the same gateways twice and wrote
  // the declaration twice, in an order that need not match the last pass.
  let previous = null;
  if (refreshInflight !== null) {
    const current = refreshInflight;
    if (!wantForce || current.force) return await current.promise;
    previous = current.promise.catch(() => {});
  }
  // The activation this pass belongs to. Every stage below checks it after its
  // await: unload bumps the counter, and a pass that resumes afterwards must not
  // re-open the gateways and timers it just closed.
  const generation = loadGeneration;
  const run = async () => {
    // One deadline for the whole pass. The panel bridge imposes no call-length
    // cap, so this is the plugin's own bound, and the stages below would
    // otherwise add their own budgets up to well past it; each stage now gets
    // what is left of this one and a stage that runs out of time leaves its
    // result for the next pass. The port reservations before it are capped by
    // their own attempt count, and cost a few seconds at worst when another
    // process holds the preferred ports.
    const { left, settle } = budget(REFRESH_PASS_BUDGET_MS);
    await adoptHostSettings();
    if (!stillLoaded(generation)) return stalePass();
    applySettingsToCore();
    // The pool was emptied by a switch-off, so the regions coming back have no
    // accounts to sign their gateways in with. `pool.acquire` scans lazily, but
    // only once a chat request arrives through a gateway - too late to publish a
    // model list, which is what the panel and the picker read.
    if (poolNeedsScan) {
      poolNeedsScan = false;
      await settle(core.pool.scan());
      if (!stillLoaded(generation)) return stalePass();
    }
    for (const region of activeRegions()) {
      // Gateways a settings change retired may still be closing; their ports
      // are only reusable once those closes settle. `startRuntimes` drains the
      // same list before it binds, for the same reason - see
      // `pendingRuntimeStops`.
      if (pendingRuntimeStops.length > 0) {
        await Promise.all(pendingRuntimeStops.splice(0));
        // Checked before the bind rather than only after it: a service that
        // stopped during the drain used to cost one full port reservation and
        // shim bind before the pass discovered it was stale, which is the
        // window in which the next activation can lose the preferred port.
        if (!stillLoaded(generation)) return stalePass();
      }
      if (runtimes.has(region)) continue;
      // Wrapped exactly like `startRuntimes`: `createRuntime` rejects when the
      // shim loses the port race its own reservation opened, and one region
      // losing that race must not skip the other rows of this pass.
      const starting = startRuntimeOnce(region);
      let runtime;
      try {
        runtime = await settle(starting);
      } catch (error) {
        gatewayStartFailures.set(region, safeMessage(error));
        log("warn", "[" + region + "] gateway could not start: " + safeMessage(error));
        continue;
      }
      // A start that outran the budget is not abandoned: its shim binds the
      // port regardless, so leaving it unowned would make every later pass find
      // its own orphan holding the preferred port and report address drift.
      if (runtime === undefined) {
        // Released only when nobody registered it: a second caller shares this
        // promise, and its own `runtimes.set` is the one that matters.
        starting.then((late) => { if (runtimes.get(region) !== late) return stopRuntime(late) }).catch(() => {});
        continue;
      }
      // Both races - a stale generation and a region switched off while the
      // runtime was awaited - resolve through `settleStartedRuntime`, the same
      // way `startRuntimes` resolves them: see there for why a registered
      // runtime that IS this one is the winner rather than a loser to release.
      await settleStartedRuntime(region, runtime, !stillLoaded(generation) || !activeRegions().includes(region));
    }
    // Trae gateways follow the same switch, and are reconciled before the
    // declaration is written so their rows can join this run's publish.
    await settle(reconcileTraeGateways());
    if (!stillLoaded(generation)) return stalePass();
    // Qoder gateways follow the same switch on the same terms.
    await settle(reconcileQoderGateways());
    if (!stillLoaded(generation)) return stalePass();
    // The Trae and Qoder strips list their own local sign-ins, which no pool
    // cache holds; read them here so the panel can show who is found. A failed
    // read leaves the previous list rather than claiming "no sign-in".
    await settle(refreshSourceAccounts());
    if (!stillLoaded(generation)) return stalePass();
    // A gateway whose directory never answered - it failed, or the read that
    // runs behind init is still in flight - is asked again here, so a cold or
    // failing directory recovers on its own instead of being reported for the
    // rest of the process. Gateways that already hold a roster are left
    // alone, and the batch is concurrent, so the cost is one read.
    await settle(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())]
      .filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0)
      .map((entry) => warmSourceDirectory(entry))));
    if (!stillLoaded(generation)) return stalePass();
    // Concurrent, not one after the other: two rosters read end to end can
    // spend a whole panel call on their own.
    await settle(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, reason, wantForce))));
    if (!stillLoaded(generation)) return stalePass();
    syncDeclaration();
    return await statusDocument({ allowNetwork: true, budgetMs: left() });
  };
  const entry = { force: wantForce, promise: null };
  // A pass invoked directly (the panel's wait-for-refresh, a rescan, a manual
  // check-in run) leaves the deferred background timer armed, and that timer
  // fired a second full pass behind the one just run. Cancelled here, where the
  // direct pass starts, rather than inside the timer: the timer's whole job is
  // to be the deferred version of this call.
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  entry.promise = (async () => {
    try {
      return await run();
    } finally {
      // The slot is released only once everything this pass started beside has
      // finished. Releasing it when this pass's own work ended is what let a
      // third caller start a pass while the background one was still running.
      if (previous !== null) await previous;
      if (refreshInflight === entry) refreshInflight = null;
    }
  })();
  refreshInflight = entry;
  return await entry.promise;
}

/**
 * The sign-ins found on this machine for the sources that are not pool
 * accounts, reduced to what the panel shows: a label, the region, and whether
 * the token is still fresh. No token material leaves this function.
 */
let traeAccountRows = [];
let qoderAccountRows = [];

/**
 * The name one Trae account is listed and claimed under.
 *
 * A Trae-generated `username` can read as a stranger (`zhang san xyz`), so the
 * email is what the panel shows next to it; the label itself stays the app's
 * own name so it matches what the desktop app displays.
 */
function traeRowLabel(credential) {
  return credential.accountName ?? credential.email ?? credential.userId;
}

/**
 * The app one Trae sign-in came from.
 *
 * One account keeps a copy in every Trae app it was signed into (and one in the
 * CLI), and the scanner folds those copies into a single account. Naming the
 * copy that won is what makes that fold readable: without it the account just
 * looks like it lost a row.
 */
function traeAppLabelOf(credential) {
  if (credential.source === "cli") return "Trae CLI";
  return traeWindowsAppNames(credential.edition)[0];
}

/** The name one Qoder account is listed and claimed under. */
function qoderRowLabel(credential) {
  return credential.name === "" ? credential.userID : credential.name;
}

/**
 * How long the Trae and Qoder sign-in lists may take in total.
 *
 * Each account's probe is already bounded, but a machine with several sign-ins
 * to a source would add those bounds end to end, and the host allows a panel
 * call 30 s. Past this budget a row keeps the figures it already has. The
 * figure is deliberately a slice of a refresh pass rather than most of it: the
 * pass still has a roster read and a document to answer with.
 */
const SOURCE_ACCOUNTS_BUDGET_MS = 8000;

/**
 * How long one Trae or Qoder account's probe may take.
 *
 * Trae's probes read at once, so this bounds that whole list; Qoder paces its
 * reads, so the deadline above is what bounds that list instead.
 */
const SOURCE_PROBE_TIMEOUT_MS = 8000;
/**
 * Read one Trae account's check-in state and quota for its card. Quota is the
 * verified pay endpoint (`web_user_ent_usage`, same surface dsh-connect-trae
 * ships); the check-in row is CN-only. A failed probe keeps the previous
 * row's figures — a flaky network is not "no quota".
 */
async function traeRowProbe(credential, previous) {
  if (sourceCredentialExpired(credential, Date.now())) return previous;
  try {
    const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
    const client = new TraeSoloUpstreamClient({
      credential: async () => credential,
      identity: () => resolveTraeIdentity(desktopCandidates, credential.edition),
    });
    // The international region is subscription-based: it has no Work-credit
    // totals and no daily check-in, so its usage surface is the plan the pay
    // host reports. CN reads the check-in and the credit totals instead.
    if (traeRegionOfCredential(credential) !== "cn") {
      const pay = await client.fetchPayStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS));
      return {
        checkin: undefined,
        usage: pay.plan === "" ? undefined : { plan: { name: pay.plan, inTrial: pay.inTrial } },
      };
    }
    const [status, usage] = await Promise.all([
      client.fetchCheckinStatus(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
      client.fetchUsageSummary(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
    ]);
    return {
      checkin: {
        active: status.enable !== false,
        todayCheckedIn: status.checkedIn === true,
        deviceCheckedIn: status.didCheckedIn === true,
        credits: status.credits,
        // The card's "what today is worth" line reads `amount`, the same name
        // Qoder's campaign answer uses. `credits` is the reward the status
        // endpoint reports for today's check-in; the member bonus is left out
        // because nothing in this plugin's reads proves the account is a member.
        amount: status.credits,
        unit: "credits",
      },
      // The same credit shape a pool account uses, so one renderer draws
      // both: the total is what is left, and every pack carries its own
      // expiry — a daily check-in reward is one of those packs.
      usage: { credits: traeSourceCredits(usage) },
    };
  } catch {
    return previous;
  }
}

/**
 * One Trae usage answer folded into the credit shape the panel renders, so a
 * source account and a pool account are drawn by the same code. Each pack
 * keeps its own expiry because that is the only place it exists: the daily
 * check-in reward lands as a pack of its own, so "when do the check-in credits
 * run out" is answered per row rather than per account.
 */
function traeSourceCredits(usage) {
  const packages = usage.packs.map((pack) => ({
    packageName: pack.name,
    remain: pack.remaining,
    size: pack.total,
    ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
  }));
  return {
    total: usage.remainingAmount,
    packages,
  };
}

/** Read one Qoder account's quota and today's campaign, reduced for the card. */
async function qoderRowProbe(credential, previous) {
  if (sourceCredentialExpired(credential, Date.now())) return previous;
  try {
    const client = new QoderUpstreamClient({ region: credential.region, credential: async () => qoderClientCredential(credential) });
    // Usage is the row the card cannot do without. The campaign only answers
    // the check-in state and how long its reward lives, so a campaign failure
    // costs those two and not the whole read - but it has to be told apart from
    // "this account has no campaign", or a read that failed looks exactly like
    // an account with nothing to collect.
    let campaignsUnavailable = false;
    const [usage, campaigns] = await Promise.all([
      client.fetchUsage(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
      client.fetchCampaigns(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)).catch(() => {
        campaignsUnavailable = true;
        return undefined;
      }),
    ]);
    const state = qoderCheckinStateFrom(campaigns);
    // Both pools are this account's credits, and the check-in lands in the
    // add-on one, so each becomes a row of its own instead of the plan bucket
    // taking the only line. `nameKey` is a locale key rather than a name
    // because the upstream labels neither pool. A pool the route names is a
    // row even at zero: an account on no plan reports 0/0, and that row is
    // where "does not expire" belongs — the plan is the pool that never
    // expires, the check-in credits are the ones that run out.
    //
    // Each row carries its own expiry, because the two pools expire on
    // different terms: the add-on credits are what the daily check-in pays out
    // and are valid for a fixed number of days from each claim, while the
    // plan's date is the account-wide one the usage route sends. The pool is
    // only ever reported as a sum, so the newest claimed round's own deadline
    // is the date it gets; with no round claimed yet the rule is all there is.
    const validDays = qoderRewardValidityDaysOf(campaigns);
    const rewardExpiresAtMs = qoderRewardExpiryMs(campaigns);
    // Named so the row shape stays readable: one expiry field per row, chosen
    // by what the upstream could say about that pool rather than by a chain of
    // fallbacks nobody can read.
    const planExpiry = usage.expiresAtMs !== undefined
      ? { expiresAtMs: usage.expiresAtMs }
      : usage.neverExpires === true ? { neverExpires: true } : {};
    const rewardExpiry = rewardExpiresAtMs !== undefined
      ? { roundExpiresAtMs: rewardExpiresAtMs }
      : validDays === undefined ? {} : { validDays };
    const packages = [
      ...usage.userQuota === undefined ? [] : [{
        nameKey: "credits.planQuota",
        remain: usage.userQuota.remaining,
        size: usage.userQuota.total,
        ...planExpiry,
      }],
      ...usage.addOnQuota === undefined ? [] : [{
        nameKey: "credits.addOnQuota",
        remain: usage.addOnQuota.remaining,
        size: usage.addOnQuota.total,
        ...rewardExpiry,
      }],
      ...usage.dedicatedPackages.slice(0, 3).map((pack) => ({
        packageName: pack.name,
        remain: pack.remaining,
        size: pack.total,
        ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
      })),
    ];
    // No pool at all reports no credits rather than a total of zero, which
    // would read as "spent it all".
    const credits = packages.length === 0 ? undefined : {
      total: packages.reduce((sum, pack) => sum + pack.remain, 0),
      packages,

    };
    return {
      ...(credits === undefined ? {} : { usage: { credits } }),
      // The card shows the hour, not the instant: the panel has no timezone of
      // its own, and the campaign clock is Beijing's.
      checkin: {
        ...state,
        ...campaignsUnavailable ? { campaignsUnavailable: true } : {},
        ...state.opensAt === undefined ? {} : { opensAtHour: zonedDayHour(new Date(state.opensAt)).hour },
      },
    };
  } catch {
    return previous;
  }
}

async function refreshSourceAccounts() {
  const now = Date.now();
  try {
    const regions = activeTraeRegions();
    if (regions.length > 0) {
      const found = await discoverTraeCredentials();
      // These probes are independent, and none of them paces the upstream, so
      // they read at once rather than adding one bound per account: a machine
      // with several Trae sign-ins would otherwise spend the whole panel budget
      // here. `Promise.all` keeps the discovery order.
      const rows = await Promise.all(found.credentials.filter((credential) => regions.includes(traeRegionOfCredential(credential))).map(async (credential) => {
        const label = traeRowLabel(credential);
        const region = traeRegionOfCredential(credential);
        const previous = traeAccountRows.find((row) => row.label === label && row.region === region);
        const probe = await traeRowProbe(credential, previous);
        noteSourceExpiry("trae", region, label, probe?.usage?.credits?.packages);
        return {
          label,
          region,
          app: traeAppLabelOf(credential),
          ...credential.email === undefined || credential.email === label ? {} : { email: credential.email },
          expiresAt: credential.expiresAtMs,
          expired: sourceCredentialExpired(credential, now),
          ...(probe?.checkin ? { checkin: probe.checkin } : {}),
          ...(probe?.usage ? { usage: probe.usage } : {}),
        };
      }));
      traeAccountRows = rows.filter((row) => regionEnabled("trae", row.region));
    } else {
      traeAccountRows = [];
    }
  } catch (error) {
    log("warn", "listing Trae sign-ins failed: " + safeMessage(error));
  }
  try {
    const regions = activeQoderRegions();
    if (regions.length > 0) {
      const found = await discoverQoderCredentials();
      const rows = [];
      // Qoder's probes are paced on purpose, so this one cannot read at once the
      // way Trae's does; it is bounded instead. Past the deadline a row keeps
      // the figures it already has rather than the list being dropped whole.
      const { left } = budget(SOURCE_ACCOUNTS_BUDGET_MS);
      // Counted, not flagged: an account whose region is switched off must not
      // decide whether the next one waits.
      let seen = 0;
      for (const credential of found.credentials) {
        if (!regions.includes(credential.region)) continue;
        if (seen > 0) await delay(QODER_ACCOUNT_DELAY_MS);
        seen += 1;
        const label = qoderRowLabel(credential);
        const previous = qoderAccountRows.find((row) => row.label === label && row.region === credential.region);
        const probe = left() > 0 ? await qoderRowProbe(credential, previous) : previous;
        noteSourceExpiry("qoder", credential.region, label, probe?.usage?.credits?.packages);
        rows.push({
          label,
          region: credential.region,
          expiresAt: credential.expiresAtMs,
          expired: sourceCredentialExpired(credential, now),
          ...(probe?.checkin ? { checkin: probe.checkin } : {}),
          ...(probe?.usage ? { usage: probe.usage } : {}),
        });
      }
      qoderAccountRows = rows.filter((row) => regionEnabled("qoder", row.region));
    } else {
      qoderAccountRows = [];
    }
  } catch (error) {
    log("warn", "listing Qoder sign-ins failed: " + safeMessage(error));
  }
  pruneSourceState();
}

/**
 * Drop the per-sign-in bookkeeping of a sign-in that is no longer there.
 *
 * Both maps are keyed by source and label, and a label is not unique to one
 * sign-in: a departed account's hold was inherited by the next one that happened
 * to carry the same name, which demoted it for the rest of the hold despite
 * never having failed, and its pack expiry corrupted `expiry`-mode ordering and
 * the composer's active row.
 */
function pruneSourceState() {
  const live = new Set();
  for (const row of traeAccountRows) live.add(accountStateKey("trae", row.region, row.label));
  for (const row of qoderAccountRows) live.add(accountStateKey("qoder", row.region, row.label));
  for (const key of [...sourceFailureHold.keys()]) {
    if (!live.has(key)) sourceFailureHold.delete(key);
  }
  for (const key of [...sourceCreditExpiry.keys()]) {
    if (!live.has(key)) sourceCreditExpiry.delete(key);
  }
}

/**
 * Directories the WorkBuddy pool reads, in order.
 *
 * The desktop app's own directories come first, and that is only the walk
 * order: which copy of an account serves is decided by issue time, with the
 * source breaking a tie. The plugin's own directory is appended rather than
 * substituted: an account added from the panel is read on exactly the same
 * terms as a desktop sign-in, and removing it is a file deletion the user can
 * see. A repointed `authFile` narrows the walk to that one directory plus the
 * plugin's own, the way the pool reads whatever it writes.
 */
function poolAuthDirs(authFile: string): string[] {
  if (authFile !== "") return [path.dirname(authFile)];
  const own = ownSignInDir(dataPath);
  const dirs = candidateAuthDirs();
  if (own === "" || dirs.includes(own)) return dirs;
  return [...dirs, own];
}

/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
  const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
  const emptied = core.pool.applyConfig({
    authDirs: poolAuthDirs(authFile),
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    disabledAccountIds: disabledAccountIds(),
    creditReserves: creditReserves(),
  });
  core.pool.applyRemoved(removedAccounts().map((entry) => entry.id));
  for (const region of REGIONS) {
    core.pool.prefer(preferredAccountId(region), region);
    applyEffectiveSelection(region);
  }
  // A repointed auth file empties the pool, and nothing downstream reads the
  // disk on its own: without this the WorkBuddy rows dropped out of the picker
  // and the panel reported "no sign-in found" until a chat request happened to
  // scan, or the user pressed "Detect accounts again".
  if (emptied) poolNeedsScan = true;
  // A source switched off keeps no runtime, no accounts and no probes: the next
  // scan rebuilds from disk when it is switched back on.
  reconcileRuntimes();
  // The daily check-in timer follows the switch, so a settings change takes
  // effect without a reload.
  applyAutoCheckin();
}

/**
 * Retire runtimes whose source is switched off.
 *
 * Called on every settings application, so toggling the source needs no reload:
 * the gateway stops, its accounts leave the pool, and its probes are dropped.
 */
function reconcileRuntimes() {
  const active = new Set(activeRegions());
  for (const [region, runtime] of runtimes) {
    if (!active.has(region)) {
      // The close is recorded rather than awaited: this runs synchronously from
      // settings application, and `startRuntimes` drains the list before it
      // binds, which is where the port the close is releasing gets reused.
      pendingRuntimeStops.push(stopRuntime(runtime));
      runtimes.delete(region);
    }
  }
  if (active.size === 0 && core.pool) {
    core.pool.clear();
    probeCache.clear();
    // `pool.list()` does not read the disk, and nothing on the way back does
    // either - so without this the re-enabled gateways come up signed out and
    // the panel shows an empty strip until the user rescans by hand.
    poolNeedsScan = true;
  }
}

/**
 * True while the pool is empty because its last active region was switched off.
 *
 * A local directory read one pass later is what turns the pool back on; the flag
 * keeps that read to the passes that actually follow a switch-off, rather than
 * re-reading the disk on every pass for a machine with no sign-in at all.
 */
let poolNeedsScan = false;

// ------------------------------------------------------------------- status

/**
 * The errno code of a failure, and nothing else. An fs error quotes the
 * absolute path it hit, which is the install path when the write target is
 * this plugin's own state file; the code is the part a report can act on.
 */
function errorCodeOf(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return typeof code === "string" && code !== "" ? code : "unknown";
}

/**
 * Margin for the whole per-account probe batch inside one panel call.
 *
 * The panel bridge imposes no call-length cap, so this is the plugin's own
 * bound, and a refresh pass spends part of it on the roster: the probes get
 * the rest rather than all of it.
 */
const PROBE_BATCH_BUDGET_MS = 20000;

/** Fold one probe's answer into the row it was read for. */
function applyProbe(row, probe) {
  if (probe.pending === true) {
    row.probePending = true;
    return;
  }
  if (probe.credits !== undefined) row.credits = probe.credits;
  if (probe.creditsError !== undefined) row.creditsError = probe.creditsError;
  if (probe.checkin !== undefined) row.checkin = probe.checkin;
  if (probe.checkinError !== undefined) row.checkinError = probe.checkinError;
}

/**
 * One account's credits and check-in, served from cache while it is fresh.
 *
 * `allowNetwork: false` never waits on the upstream: a cold entry reports
 * `pending` so the panel can say it is still reading, and the caller refreshes
 * behind the first paint.
 */
async function accountProbe(account, allowNetwork, checkinOnly = false) {
  const cached = probeCache.get(account.id);
  if (allowNetwork !== true) {
    return cached === undefined ? { pending: true } : cached.value;
  }
  // A check-in-only read (a cooling account) writes a value without credits.
  // Treating that entry as fresh for the full read that follows kept the
  // balance blank until the next TTL, and `probesStale` stopped asking for it.
  const cachedFresh = cached !== undefined && Date.now() - cached.atMs < PROBE_TTL_MS;
  const cachedHasCredits = cached !== undefined
    && (cached.value.credits !== undefined || cached.value.creditsError !== undefined);
  if (cachedFresh && (checkinOnly
    || (cached.checkinOnly !== true && cachedHasCredits))) return cached.value;
  // A sign-in the upstream refused is held, and the row carries the hold: no
  // read is spent on it, so the panel stops paying two upstream calls every
  // couple of minutes for an answer the account cannot give. The first refusal
  // itself is what placed the hold, through `readAfterRefresh` below.
  //
  // The answer is deliberately not cached. A hold is released by a new sign-in
  // or a refresh that works, and a cached empty row would keep showing a
  // recovered account as blank for as long as the probe entry lives.
  if (signInRefused(account)) return {};
  // A cooling account may not spend a turn, but its check-in state is exactly
  // what the user opens the panel to see, and the daily reward is claimable
  // while it cools. The balance read is the one worth skipping: it costs an
  // upstream call, and the row keeps the figure the last read returned.
  const value = {};
  if (!checkinOnly) {
    try {
      const credits = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchCredits(credential));
      value.credits = {
        ...credits.total === undefined ? {} : { total: credits.total },
        packages: (credits.packages || []).map((pack) => ({
          packageName: pack.packageName,
          ...pack.remain === undefined ? {} : { remain: pack.remain },
          ...pack.size === undefined ? {} : { size: pack.size },
          ...pack.monthly === undefined ? {} : { monthly: pack.monthly },
          ...pack.refreshAtMs === undefined ? {} : { refreshAtMs: pack.refreshAtMs },
          ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
        })),
        ...credits.expiringSoon === undefined ? {} : { expiringSoon: credits.expiringSoon },
        ...credits.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
      };
    } catch (error) {
      value.creditsError = safeMessage(error);
    }
    // A balance read here is what an account's reserve floor is checked against,
    // so it is handed to the pool instead of staying a display-only number.
    if (value.credits !== undefined && typeof value.credits.total === "number") {
      core.pool.setCreditBalance(account.id, value.credits.total, value.credits.nearestExpiryMs);
    }
  }
  const checkinStartedAt = Date.now();
  try {
    const checkin = await core.pool.readAfterRefresh(account.id, (credential) =>
      core.client.fetchCheckinStatus(credential));
    value.checkin = {
      active: checkin.active,
      todayCheckedIn: checkin.todayCheckedIn,
      streakDays: checkin.streakDays,
      dailyCredit: checkin.dailyCredit,
      todayCredit: checkin.todayCredit,
      isStreakDay: checkin.isStreakDay,
      nextStreakDay: checkin.nextStreakDay,
      streakBonusCredit: checkin.streakBonusCredit,
    };
  } catch (error) {
    value.checkinError = safeMessage(error);
  }
  // A newer probe may have landed while this one was reading, or a claim may
  // have deleted the entry as stale. Either way this result predates the change
  // and must not be written back: a full probe that started before a claim would
  // otherwise restore the pre-claim "not checked in" row for a whole TTL, and a
  // check-in-only probe could resurrect the entry the claim just dropped.
  const latest = probeCache.get(account.id);
  if (latest !== cached) {
    if (latest === undefined) return { pending: true };
    // A full read that overlapped a check-in-only write still carries the
    // fresher balance; keeping the newer check-in state and merging the credits
    // into it avoids throwing away the answer the full read was for.
    if (!checkinOnly && latest.checkinOnly === true
      && (value.credits !== undefined || value.creditsError !== undefined)) {
      const merged = { ...latest.value };
      if (value.credits !== undefined) {
        merged.credits = value.credits;
        delete merged.creditsError;
      }
      if (value.creditsError !== undefined) {
        merged.creditsError = value.creditsError;
        delete merged.credits;
      }
      // The newer check-in answer wins: a claim that wrote this entry after the
      // full read started is newer than a read that started before it and only
      // finished later. If the entry predates the read, the full result wins.
      if (latest.atMs <= checkinStartedAt) {
        if (value.checkin !== undefined) {
          merged.checkin = value.checkin;
          delete merged.checkinError;
        }
        if (value.checkinError !== undefined) {
          merged.checkinError = value.checkinError;
          delete merged.checkin;
        }
      }
      probeCache.set(account.id, { atMs: Date.now(), value: merged, checkinOnly: false });
      return merged;
    }
    return latest.value;
  }
  // The check-in-only pass skipped the balance read, so its answer must not
  // replace the credits the previous full read left in the same entry. Return
  // the merged value as well: the caller hands it to the row, and returning the
  // check-in-only copy dropped the balance from that row for the same TTL.
  const stored = checkinOnly && cached !== undefined ? { ...cached.value, ...value } : value;
  // The new check-in answer is the whole truth about that field: spreading the
  // old entry must not keep a stale error beside a successful read (the renderer
  // checks the error first and hides the claim), or a stale state beside a new
  // failure.
  if (value.checkin !== undefined) delete stored.checkinError;
  if (value.checkinError !== undefined) delete stored.checkin;
  probeCache.set(account.id, { atMs: Date.now(), value: stored, checkinOnly });
  // An account that left the pool (sign-in removed, region switched off) keeps
  // its entry otherwise: the map only ever grew, and every stale check walked
  // the dead entries with the live ones.
  if (probeCache.size > core.pool.list().length) {
    const live = new Set(core.pool.list().map((item) => item.id));
    for (const id of Array.from(probeCache.keys())) {
      if (!live.has(id)) probeCache.delete(id);
    }
  }
  return stored;
}

/**
 * Per-gateway roster warnings, for gateways that have one right now.
 *
 * Empty spread when nothing is wrong, so a healthy panel carries no
 * `warnings` key at all rather than an empty object to check.
 */
function catalogWarnings() {
  const warnings = {};
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    // A gateway that could not sign in at all reads as an empty tab with no
    // explanation; a roster that could not be re-read still serves a stale list.
    // Both are per-gateway facts the panel has no other way to learn.
    const message = runtime?.lastError || runtime?.lastWarning;
    if (typeof message === "string" && message !== "") warnings[region] = message;
  }
  return Object.keys(warnings).length === 0 ? {} : { warnings };
}

/**
 * Whether this account's sign-in is one the upstream has refused.
 *
 * The hold is the pool's own record that a refresh could not save the sign-in,
 * so every pass that walks the pool asks before it spends a call: a held
 * account cannot answer, and the panel row already says why.
 */
function signInRefused(account) {
  return core.pool.activeHold(account.id)?.reason === "session";
}

/**
 * The row fields that describe a hold the pool itself decided, if one is in
 * force for this account right now.
 *
 * Empty spread when the account is simply cooling on an upstream window: that
 * state already reads as one on the row, and its remedy is to wait.
 */
function activeHoldOf(accountId, now) {
  const hold = core.pool.activeHold(accountId);
  if (hold === null || hold.untilMs <= now) return {};
  return { hold: hold.reason };
}

async function statusDocument(options) {
  // `allowNetwork: false` answers from the caches only, so a panel open paints
  // immediately; the caller schedules the real refresh behind it.
  const allowNetwork = options?.allowNetwork === true;
  // A caller inside a bounded pass hands over what is left of its deadline, so
  // the probe batch cannot outlast the pass that asked for it.
  const probeBudget = typeof options?.budgetMs === "number"
    ? Math.min(PROBE_BATCH_BUDGET_MS, Math.max(0, options.budgetMs))
    : PROBE_BATCH_BUDGET_MS;
  const now = Date.now();
  // Read once for the whole document: the per-account rows below all read the
  // same dictionary, and it was rebuilt per account until now.
  const reserves = creditReserves();
  // Promotions are announced on the campaign clock, so every model row in this
  // document is judged against one reading of it rather than a per-row clock
  // that could straddle an hour boundary mid-render.
  const campaignClock = zonedDayHour(new Date(now));
  const accounts = [];
  const models = [];
  const selectionByRegion = {};
  const preferredAccountIds = {};
  /** region -> the account `pool.acquire` would pick next, for the "next up" row. */
  const runtimeNextUpId = new Map();
  /** Gateways whose stored selection names models the roster no longer has. */
  const staleSelectionRegions = [];
  /** Row -> the credits/check-in read that row is still waiting on. */
  const pendingProbes = [];

  for (const region of activeRegions()) {
    // Report the selection actually in force, not the raw stored one: if the
    // stored ids no longer exist upstream, the panel would otherwise open with
    // every model shown as disabled while the plugin is really serving all of
    // them.
    preferredAccountIds[region] = preferredAccountId(region) || "";
    selectionByRegion[region] = effectiveSelectionFor(region, runtimes.get(region)?.catalog);
    if (selectionStale(region, runtimes.get(region)?.catalog)) staleSelectionRegions.push(region);
    // Without a target model, only account-wide cooldowns can be previewed.
    // The pool's own eligibility, not a second filter here: it already drops
    // removed, switched-off and reserve-holding accounts, and a copy of that
    // rule in this file once marked a switched-off account as next up.
    const available = core.pool.available(now, undefined, region);
    const preferred = available.find((account) => account.id === preferredAccountIds[region]);
    // Priority and expiry name the account the next request will use. The
    // rotating modes do not, so they mark nothing rather than point at a guess.
      const nextUp = preferred ?? core.pool.preview(available);
    runtimeNextUpId.set(region, nextUp === undefined ? undefined : nextUp.id);

    for (const account of core.pool.list(region)) {
      const cooling = account.cooldownUntilMs > now;
      const modelCooldowns = Object.entries(account.modelCooldowns)
        .filter(([, until]) => until > now)
        .sort((a, b) => a[1] - b[1])
        .map(([modelId, until]) => ({ modelId, until: new Date(until).toISOString() }));
      const row = {
        id: account.id,
        label: account.label,
        region,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling,
        ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
        ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
        rateLimitHits: account.rateLimitHits,
        // The pool's own hold, when one is in force. A `session` hold is the one
        // the user has to act on - the sign-in was refused and only a new one
        // releases it - so the row says so instead of showing the raw upstream
        // sentence on every poll. `spent` needs no field of its own: the row
        // already reads as cooling, and a balance read releases it.
        ...activeHoldOf(account.id, now),
        active: runtimeNextUpId.get(region) === account.id,
        preferred: preferredAccountIds[region] === account.id,
        disabled: core.pool.isDisabled(account.id),
        // Kept only in the pool's archive: its sign-in was overwritten when the
        // app switched accounts, so the row stays visible but is never picked.
        ...account.archived === true ? { archived: true } : {},
        // A sign-in this plugin wrote, so the row may offer to delete the file.
        // A desktop app's own sign-in is never offered that: deleting it would
        // sign the user out of the app.
        ...core.pool.ownsSignIn(account.id) ? { own: true } : {},
        // Hoisted out of the row: the reserves dictionary was rebuilt for every
        // account in the pool, twice per row.
        ...reserves[account.id] === undefined ? {} : { creditReserve: reserves[account.id] },
      };
      // Credits and check-in are read behind the row, not inside it: the batch
      // runs after every row is built, so one account's read cannot hold up the
      // next one's (see below).
      // A switched-off account is never picked, so probing it spent two upstream
      // calls a minute on a row that only exists so the user can switch it back
      // on; and because a stale probe kept `probesStale` true, it held the
      // panel's polling open with it.
      //
      // A cooling account is read for its check-in only. Skipping it entirely
      // left the row with no check-in state, and the panel renders that as "this
      // account has no check-in programme" with no claim button, over an account
      // whose daily reward is still unclaimed and still claimable.
      if (!core.pool.isDisabled(account.id)) {
        const checkinOnly = cooling;
        pendingProbes.push(accountProbe(account, allowNetwork, checkinOnly).then((probe) => {
          applyProbe(row, probe);
        }));
      }
      accounts.push(row);
    }

    const catalog = runtimes.get(region)?.catalog;
    if (catalog) {
      const selection = selectionByRegion[region];
      const enabled = selection.enabledModelIds;
      const overrides = selection.overrides || {};
      for (const model of catalog.current()) {
        const override = overrides[model.id];
        const effective = applyOverride(model, override, catalog.hasLiveRoster());
        const levels = thinkingLevelsFor(effective);
        const promo = promoStatusFor(model, campaignClock, region);
        models.push({
          id: model.id,
          // The catalog name and the user's alias travel separately: the editor
          // shows the alias in its own field and the catalog name as that
          // field's placeholder, so an empty alias must not read as a rename.
          name: model.name,
          ...effective.alias === undefined ? {} : { alias: effective.alias },
          region,
          ...model.multiplier === undefined ? {} : { multiplier: model.multiplier },
          // A time-boxed promotion the catalog does not model. Read on the
          // campaign clock, so a host in another zone cannot open or close the
          // window at the wrong hour.
          ...promo === undefined ? {} : { promo },
          supportsImages: effective.supportsImages,
          contextWindow: effective.contextWindow,
          maxOutputTokens: effective.maxOutputTokens,
          // The catalog's own numbers, so the editor can offer a reset and mark
          // a field the user has changed.
          nativeContextWindow: model.contextWindow,
          nativeMaxOutputTokens: model.maxOutputTokens,
          nativeSupportsImages: model.supportsImages,
          nativeThinkingLevels: model.supportedEfforts === undefined || model.supportedEfforts.length === 0
            ? []
            : [...model.supportedEfforts],
          thinkingLevels: levels,
          ...effective.defaultThinkingLevel === undefined
            ? {}
            : { defaultThinkingLevel: effective.defaultThinkingLevel },
          advanced: hasOverride(override),
          enabled: enabled === undefined || enabled.includes(model.id),
        });
      }
    }
  }

  // Credits and check-in are auxiliary: a failing query degrades to an error
  // field instead of failing the whole document, and a cold cache on the fast
  // path renders as "still reading" rather than a stall.
  //
  // Two things make this safe inside a panel call. The reads run at once, so a
  // machine with several accounts pays the slowest one and not their sum. And
  // they are bounded: the host allows a panel call 30 s, and one account's two
  // reads each have their own bound, so the batch is capped too. A read that
  // outlives the cap still lands in the cache, which is what lets the panel
  // come back with the numbers on its next pass instead of losing them.
  if (pendingProbes.length > 0) {
    await settleWithin(Promise.all(pendingProbes).catch(() => {}), probeBudget);
  }

  // Only active gateways are offered: a source switched off removes its tabs
  // instead of showing an empty tab that can never fill.
  return {
    regions: activeRegions(),
    sources: { workbuddy: sourceEnabled("workbuddy"), trae: sourceEnabled("trae"), qoder: sourceEnabled("qoder") },
    // Which regions the user parked, so the panel can still show them (and let
    // them be switched back on) after they leave `regions` above.
    disabledRegions: disabledRegionKeys(),
    // Trae's gateways report separately: its regions are a different pair, and
    // its accounts are not part of the WorkBuddy pool the tabs above drive.
    trae: {
      regions: activeTraeRegions(),
      distribution: sourceDistribution("trae"),
      accounts: traeAccountRows,
      // One map per source, keyed by region: the panel's "which account serves
      // this region" picker reads it straight back, so a pick survives the next
      // document instead of snapping back to automatic.
      preferred: sourcePreferredMap("trae"),
      gateways: Array.from(traeGateways.values()).map((entry) => ({
        region: entry.region,
        port: entry.gateway.port(),
        models: traeDeclarationModels(entry.region).length,
        portFallback: entry.portFallback,
        preferredPort: entry.preferredPort,
        lastError: entry.lastError,
        // Roster and selection come from one pass, and the selection is the one
        // the gateway really publishes rather than the raw stored value: after a
        // catalog rename the two used to disagree, so the panel showed every
        // model unticked while the gateway served all of them.
        ...sourcePublishedModels("trae:" + entry.region, entry.gateway.models(), traeNativeOf),
      })),
    },
    // Qoder's gateways report beside Trae's on the same terms: its regions are
    // the WorkBuddy pair, and its accounts are not part of the pool either.
    qoder: {
      regions: activeQoderRegions(),
      distribution: sourceDistribution("qoder"),
      accounts: qoderAccountRows,
      preferred: sourcePreferredMap("qoder"),
      gateways: Array.from(qoderGateways.values()).map((entry) => ({
        region: entry.region,
        port: entry.gateway.port(),
        models: qoderDeclarationModels(entry.region).length,
        portFallback: entry.portFallback,
        preferredPort: entry.preferredPort,
        // The panel reads this for Qoder exactly as it does for Trae, so an
        // unreachable directory has to reach the card here too, not only on the
        // other source.
        lastError: entry.lastError,
        ...sourcePublishedModels("qoder:" + entry.region, entry.gateway.models(), qoderNativeOf),
      })),
    },
    enabled: settings.enabled !== false,
    // Declared but not yet registered by the host: the panel says how to make
    // the model groups appear instead of letting them be silently missing.
    unpublishedDeclarations: unpublishedDeclarations(),
    // The panel marks the ticks this run cannot publish, so it reads the same
    // ceiling the declaration applies instead of remembering a number of its own.
    modelCap: MAX_MODELS,
    distribution: distributionSetting(),
    showComposerPoints: settings.showComposerPoints === true,
    autoCheckin: {
      enabled: autoCheckinEnabled(),
      hours: checkinHours(),
      ...autoCheckinLast === null ? {} : { last: autoCheckinLast },
    },
    // The growth card. The scheduled pass records its growth half inside
    // `autoCheckin.last`, so a standalone run is the only thing this adds; the
    // panel prefers it and falls back to that half, which is why both carry the
    // same shape.
    growth: {
      // A check-in pass runs the growth half itself, so from this card's point of
      // view the accounts are busy either way: entering the tab must not fire a
      // second read at the same accounts while that pass is in flight.
      running: growthPassRunning || checkinPassRunning,
      ...growthLast === null ? {} : { last: growthLast },
      // The last read, so the card paints what it had rather than asking for it
      // again; the panel refreshes it when it is old.
      //
      // The key is always present, `null` included: that is how the panel tells
      // "the host dropped this because the pool changed" from "this document is
      // about something else". An omitted key carried both meanings.
      read: growthRead,
    },
    // The last by-hand keep-alive pass. There is no schedule behind it, so
    // this is the only record of when the accounts were last refreshed and
    // what that cost.
    keepAlive: keepAliveLast === null ? null : { ...keepAliveLast },
    preferredAccountIds,
    removedAccounts: removedAccounts().map((entry) => ({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
      region: entry.region,
    })),
    declaration: runtimeState.write,
    addressDrift: addressDrift(),
    shims: { cn: shimInfo("cn"), global: shimInfo("global") },
    // A gateway whose roster could not be re-read keeps serving the previous
    // list on purpose, but that list is then as old as the last success. Saying
    // so is what keeps the panel from presenting it as current.
    ...catalogWarnings(),
    accounts,
    models,
    selectionByRegion,
    staleSelectionRegions,
  };
}


/** The loopback origin of one gateway, or a not-running marker. */
function shimInfo(region) {
  const runtime = runtimes.get(region);
  try {
    if (!runtime || !runtime.shim) return { running: false };
    const port = runtime.shim.port();
    if (port === 0) return { running: false };
    return { running: true, baseUrl: runtime.shim.baseUrl() + "/v1" };
  } catch {
    return { running: false };
  }
}

/** Every provider row this process has published, in declaration order. */
function declaredProviders() {
  return Array.from(declarationIndex.values());
}

function declaredProvider(region) {
  return declaredProviders().find((provider) => provider.id === PROVIDER_ID_BY_REGION[region]);
}

/** The published base URL of one Trae/Qoder gateway, by that source's id map. */
function declaredSourceBaseUrl(entry, idByRegion) {
  const provider = declaredProviders().find((row) => row.id === idByRegion[entry.region]);
  const baseUrl = provider?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}
/**
 * Provider ids this run declares but the host is not serving.
 *
 * Registration is a runtime call, so the only question is whether the LAST
 * attempt succeeded: a registration the host refused leaves its ids out, and
 * naming them is what turns a silently empty model list into the one action
 * that clears it.
 */
function unpublishedDeclarations() {
  return declaredProviders()
    .filter((provider) => !publishedIds.has(provider.id))
    .map((provider) => provider.id);
}

function declaredBaseUrl(region) {
  const baseUrl = declaredProvider(region)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}

/**
 * Two published addresses, compared as origins.
 *
 * The declaration always publishes the `/v1` form, but what a gateway hands
 * back does not: the WorkBuddy shim's baseUrl() carries `/v1` while the Trae
 * and Qoder gateways' is the bare origin kept for their own `/v1/models`
 * warm-up calls. Comparing those shapes verbatim reports drift for a session
 * that bound the right port on every row. Only the suffix differs, so only the
 * suffix is ignored here.
 */
function samePublishedAddress(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const origin = (value) => value.replace(/\/+$/, "").replace(/\/v1$/, "");
  return origin(a) === origin(b);
}
/**
 * True when the address that was published is not the address this run bound.
 *
 * The declaration is republished after a port fallback, so the published address
 * is the test: a row that follows the actual port is healthy, while one that
 * still names the preferred port is drift. Checking `portFallback` itself marked
 * a correctly republished row as broken.
 *
 * A gateway whose start failed counts as drift too, and for the same reason: it
 * has no shim at all, so the address the host registered is refused. Skipping
 * it - which is what the `bound === undefined` case did - reported a healthy
 * panel over a session whose every request failed.
 *
 * Trae and Qoder are read the same way as WorkBuddy: they reserve a preferred
 * port on the same terms, so they drift the same way.
 */
function addressDrift() {
  for (const region of activeRegions()) {
    const published = declaredBaseUrl(region);
    const bound = shimInfo(region).baseUrl;
    if (bound === undefined) {
      // Reported only once the host actually holds a row for it: a fresh install
      // whose very first start failed has nothing registered to drift from yet.
      if (gatewayStartFailures.has(region) && publishedIds.has(PROVIDER_ID_BY_REGION[region])) return true;
      continue;
    }
    if (published !== undefined && published !== bound) return true;
  }
  for (const entry of Array.from(traeGateways.values())) {
    const published = declaredSourceBaseUrl(entry, TRAE_PROVIDER_ID_BY_REGION);
    if (published !== undefined && !samePublishedAddress(published, entry.baseUrl)) return true;
  }
  for (const entry of Array.from(qoderGateways.values())) {
    const published = declaredSourceBaseUrl(entry, QODER_PROVIDER_ID_BY_REGION);
    if (published !== undefined && !samePublishedAddress(published, entry.baseUrl)) return true;
  }
  // A region whose start failed has no entry to compare, so iterating the maps
  // alone found nothing and reported no drift. It is drift all the same, but
  // only once a row for it was ever published: a first start that failed has
  // nothing registered to drift from yet.
  for (const region of activeTraeRegions()) {
    if (!sourceStartFailures.has("trae:" + region)) continue;
    if (declaredSourceBaseUrl({ region }, TRAE_PROVIDER_ID_BY_REGION) !== undefined) return true;
  }
  for (const region of activeQoderRegions()) {
    if (!sourceStartFailures.has("qoder:" + region)) continue;
    if (declaredSourceBaseUrl({ region }, QODER_PROVIDER_ID_BY_REGION) !== undefined) return true;
  }
  return false;
}


/**
 * Trae discovery for the doctor: count only, never token material.
 *
 * Answers `{ok, detail}` so the finding can carry the verdict instead of
 * hard-coding `true`: a source that could not be read, or that holds no
 * sign-in at all, is a failed check, and the report used to pass it.
 */
async function traeDoctorDetail() {
  if (!sourceEnabled("trae")) return { ok: true, detail: "switched off in plugin settings (deliberate; not a failure)" };
  try {
    const found = await discoverTraeCredentials();
    if (found.credentials.length === 0) {
      return { ok: false, detail: "on; no Trae sign-in found (sign in to Trae CN / TRAE SOLO CN, then run the check again)" };
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      const region = traeRegionOfCredential(credential);
      byRegion[region] = (byRegion[region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable file(s)` : "";
    const servedRegions = activeTraeRegions();
    const served = servedRegions
      .map((region) => `${region}: ${traeDeclarationModels(region).length} model(s)`)
      .join(", ");
    const stillReading = [];
    const problems = [];
    for (const region of servedRegions) {
      const entry = traeGateways.get(region);
      if (entry === undefined && !byRegion[region]) {
        problems.push(`${region}: no sign-in for this region`);
      } else if (entry === undefined || entry.warmSettled !== true) {
        stillReading.push(region);
      } else if (traeDeclarationModels(region).length === 0) {
        problems.push(entry.lastError !== ""
          ? `${region}: ${entry.lastError}`
          : `${region}: no models selected`);
      }
    }
    return {
      ok: problems.length === 0,
      detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`
        + (stillReading.length > 0 ? `; still reading models for ${stillReading.join(", ")}` : "")
        + (problems.length > 0 ? `; ${problems.join("; ")}` : ""),
    };
  } catch (error) {
    // Same rule as the declaration write: an fs error quotes the absolute
    // app-data path it hit, and the report is copyable from the panel.
    return { ok: false, detail: `on; discovery failed (${errorCodeOf(error)})` };
  }
}

/** Qoder credentials for the doctor: count only, never token material. */
async function qoderDoctorDetail() {
  if (!sourceEnabled("qoder")) return { ok: true, detail: "switched off in plugin settings (deliberate; not a failure)" };
  try {
    const found = await discoverQoderCredentials();
    if (found.credentials.length === 0) {
      const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
      return { ok: false, detail: `on; no Qoder sign-in found (sign in to Qoder, then run the check again)${failures}` };
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      byRegion[credential.region] = (byRegion[credential.region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
    // Same contract as Trae's: report what is actually served now, not a bare count.
    const servedRegions = activeQoderRegions();
    const served = servedRegions
      .map((region) => `${region}: ${qoderDeclarationModels(region).length} model(s)`)
      .join(", ");
    const stillReading = [];
    const problems = [];
    for (const region of servedRegions) {
      const entry = qoderGateways.get(region);
      if (entry === undefined && !byRegion[region]) {
        problems.push(`${region}: no sign-in for this region`);
      } else if (entry === undefined || entry.warmSettled !== true) {
        stillReading.push(region);
      } else if (qoderDeclarationModels(region).length === 0) {
        problems.push(entry.lastError !== ""
          ? `${region}: ${entry.lastError}`
          : `${region}: no models selected`);
      }
    }
    return {
      ok: problems.length === 0,
      detail: `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`
        + (stillReading.length > 0 ? `; still reading models for ${stillReading.join(", ")}` : "")
        + (problems.length > 0 ? `; ${problems.join("; ")}` : ""),
    };
  } catch (error) {
    return { ok: false, detail: `on; discovery failed (${errorCodeOf(error)})` };
  }
}

/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctorReport() {
  // The check reads both strips' sign-in lists and probes every pool account,
  // so it is capped as a whole like the other wide passes. Findings that did
  // not arrive in time are simply absent from the report rather than making the
  // check itself run past the host's budget.
  const { left, settle } = budget(PANEL_STEP_BUDGET_MS);
  // The fallback reads the caches only, but it is still bounded by what is left
  // of the budget: an unbounded second read after a timeout ran the check to
  // twice its budget, and the host cuts a command that overruns it. Whatever
  // did not arrive is simply absent from the report.
  const status = await settle(statusDocument({ allowNetwork: true, budgetMs: left() }))
    ?? await settle(statusDocument({ allowNetwork: false, budgetMs: left() }))
    ?? { enabled: settings.enabled !== false, sources: {}, accounts: [], models: [] };
  const findings = [];
  const push = (id, ok, detail) => findings.push({ id, ok, detail });

  push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
  push("source-workbuddy", true, status.sources.workbuddy === true ? "on" : "switched off in plugin settings (deliberate; not a failure)");
  // Reading a source's sign-ins is the slow part of the check, and each read
  // carries its own bound; the budget above is what keeps the check whole.
  // The detail functions answer `{ok, detail}`: a source whose sign-ins could
  // not be read is a failed check, not a passed one with a longer sentence.
  const traeDetail = await settle(traeDoctorDetail());
  push("source-trae", traeDetail?.ok ?? false, traeDetail?.detail ?? "on; still reading this source's sign-ins");
  const qoderDetail = await settle(qoderDoctorDetail());
  push("source-qoder", qoderDetail?.ok ?? false, qoderDetail?.detail ?? "on; still reading this source's sign-ins");
  push(
    "accounts",
    status.sources.workbuddy !== true || status.accounts.length > 0,
    status.sources.workbuddy !== true
      ? "WorkBuddy source is switched off; nothing is scanned or served"
      : status.accounts.length === 0
        ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again"
        : status.accounts.length + " account(s)",
  );
  const healthy = status.accounts.filter((account) => !account.cooling).length;
  push("rotation", status.sources.workbuddy !== true || healthy > 0, status.sources.workbuddy !== true ? "switched off; nothing to rotate" : healthy + " of " + status.accounts.length + " account(s) can serve a request now");

  // A 5.6+ sealed sign-in whose at-rest key could not be fetched reads as "no
  // WorkBuddy sign-in found" in the row above, and nothing on this machine
  // explains why: the key is not on disk. This is the only place its absence
  // can surface, so an empty strip stops being undiagnosable.
  const atRestKeyReason = status.sources.workbuddy === true ? atRestKeyFailure() : "";
  push(
    "at-rest-key",
    atRestKeyReason === "",
    // Redacted like every other detail: the reason can quote the desktop app's
    // own stderr, and the report is copyable out of the panel.
    atRestKeyReason === "" ? "no at-rest key failure" : safeMessage(atRestKeyReason),
  );

  // The gateways can all be listening and the plugin can have declared them
  // while the host's own registry predates the declaration, which is what a
  // missing model group looks like from the outside.
  const unpublished = status.unpublishedDeclarations || [];
  push(
    "host-registered-providers",
    unpublished.length === 0,
    unpublished.length === 0
      ? "the host is serving every provider this plugin declares"
      : unpublished.length + " provider(s) failed to register with the host ("
        + unpublished.join(", ") + ") - the next change to the pool retries them",
  );

  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    const label = PROVIDER_NAME_BY_REGION[region];
    const info = shimInfo(region);
    // Confirmation, not intent: the index always holds what this run wants the
    // host to serve, so asking it here would call a refused region registered.
    const declared = declaredProvider(region) !== undefined
      && publishedIds.has(PROVIDER_ID_BY_REGION[region]);
    push(label + ": endpoint", info.running, info.running
      ? "listening on " + info.baseUrl
      : gatewayStartFailures.get(region) ?? "not listening");
    const regionModels = status.models.filter((model) => model.region === region);
    push(label + ": models", regionModels.length > 0, regionModels.length + " model(s) in the catalog");
    push(
      label + ": declared",
      declared,
      declared
        ? "registered with the running host"
        : runtime?.lastError || runtime?.lastWarning || "this gateway is not published yet",
    );
  }

  // A provider row is registered from the declaration this run publishes.
  // A route the host accepted is used until the registration changes - a
  // reload, or the adapter being re-registered - which is exactly what makes
  // requests fail with ERR_CONNECTION_REFUSED when the address that was
  // registered is not the one this run bound. Comparing the two turns that
  // silent failure into a named finding with the one action that clears it.
  //
  // All three sources reserve a preferred port on the same terms, so all three
  // can drift the same way and are read the same way here. Reporting only
  // WorkBuddy left every Trae and Qoder provider row broken while the report
  // said everything passed.
  for (const [gateways, idByRegion, nameByRegion, ports, modelsOf] of [
    [runtimes, PROVIDER_ID_BY_REGION, PROVIDER_NAME_BY_REGION, REGION_PORTS, declarationModels],
    [traeGateways, TRAE_PROVIDER_ID_BY_REGION, TRAE_PROVIDER_NAME_BY_REGION, TRAE_PORTS, traeDeclarationModels],
    [qoderGateways, QODER_PROVIDER_ID_BY_REGION, QODER_PROVIDER_NAME_BY_REGION, QODER_PORTS, qoderDeclarationModels],
  ]) {
    for (const entry of Array.from(gateways.values())) {
      const published = declaredSourceBaseUrl(entry, idByRegion);
      const bound = entry.baseUrl;
      const label = nameByRegion[entry.region];
      if (bound === undefined) continue;
      if (published === undefined) {
        // A source entry knows whether its directory read settled; a WorkBuddy
        // runtime uses the shared warming set.
        const warming = entry.warmSettled !== undefined
          ? entry.warmSettled !== true
          : warmingGatewayIds().has(idByRegion[entry.region]);
        if (warming) {
          push(label + ": published address", true, "still reading its model roster");
          continue;
        }
        if (entry.lastError) {
          push(label + ": published address", false, entry.lastError);
          continue;
        }
        if (modelsOf(entry.region).length === 0) {
          push(label + ": published address", true, "no callable models selected; nothing to publish");
          continue;
        }
        push(label + ": published address", false,
          "this gateway is running but its provider row is not published in this run's declaration - restart the plugin");
        continue;
      }
      const fallback = entry.portFallback === true;
      if (samePublishedAddress(published, bound)) {
        // The fallback is a warning the panel already names, not a broken
        // address: the row the host serves is the port this gateway bound.
        // Failing this check sent the reader to free a port even though the
        // session was routing correctly.
        const detail = fallback
          ? "matches the endpoint this gateway bound (" + bound + "); preferred port "
            + ports[entry.region] + " is held, so this session serves the fallback"
          : "matches the endpoint this gateway bound (" + bound + ")";
        push(label + ": published address", true, detail);
        continue;
      }
      const detail = "the published address is " + published + " but this gateway is on " + bound
        + " - reload the plugin so the host picks the new address up";
      push(label + ": published address", false, detail);
    }
  }

  // A source gateway that never bound has no entry, and iterating the entries
  // alone reported nothing for it: the report said PASS while every request to
  // its published address was refused.
  for (const [source, nameByRegion, regions] of [
    ["trae", TRAE_PROVIDER_NAME_BY_REGION, activeTraeRegions()],
    ["qoder", QODER_PROVIDER_NAME_BY_REGION, activeQoderRegions()],
  ] as Array<[string, Record<string, string>, string[]]>) {
    for (const region of regions) {
      const reason = sourceStartFailures.get(source + ":" + region);
      if (reason === undefined) continue;
      push(nameByRegion[region] + ": endpoint", false, reason);
    }
  }

  push("declaration-written",    runtimeState.write.ok === true,
    // No path in the text: the report is copyable from the panel, and where
    // this plugin is installed is not something a report needs to carry.
    runtimeState.write.ok !== true
      ? safeMessage(runtimeState.write.error)
      : runtimeState.write.changed
        ? "the model list was just updated; the host discovers it from this gateway's /v1/models"
        : String(runtimeState.write.skipped || "up to date"),
  );

  const ok = findings.every((finding) => finding.ok);
  const report = [
    "WTQ Pool doctor",
    new Date().toISOString(),
    "overall: " + (ok ? "PASS" : "FAIL"),
    "",
    ...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
    "",
  ].join("\n");
  if (dataPath !== "") {
    try {
      fs.writeFileSync(path.join(dataPath, "doctor.txt"), report, "utf8");
    } catch {
      // A report that cannot be written to disk is still a report: the panel
      // shows and copies it either way.
    }
  }
  return { ok, findings, report, status };
}

/**
 * Run the connection check, answering with a report even when it fails.
 *
 * A check that threw used to take the whole channel down with it: the panel
 * showed a generic error and there was no report to read, which says "the
 * check is broken" rather than "the check found something it could not read".
 * The failure is now a finding like any other.
 */
async function doctor() {
  try {
    return await doctorReport();
  } catch (error) {
    const detail = safeMessage(error);
    log("warn", "connection check failed: " + detail);
    const findings = [{ id: "status", ok: false, detail }];
    const report = [
      "WTQ Pool doctor",
      new Date().toISOString(),
      "overall: FAIL",
      "",
      ...findings.map((finding) => (finding.ok ? "PASS  " : "FAIL  ") + finding.id + " - " + finding.detail),
      "",
    ].join("\n");
    return { ok: false, findings, report, status: undefined };
  }
}

// -------------------------------------------------------------------- panel

/**
 * Logins the panel has started and not finished, keyed by realm.
 *
 * One per realm on purpose: a second start for the same realm replaces the
 * first, and the replaced state is dead — a browser is sitting on a URL nobody
 * polls. Memory only, so a restart drops them and the panel simply starts over
 * rather than answering a poll for a state this process never issued.
 */
const deviceLogins = new Map<string, { state: string; at: number }>();

function panelError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate an untrusted selection payload.
 *
 * Returns undefined for anything malformed so nothing partial is written. An
 * empty array is meaningful (`enabledModelIds: []` disables every model, which
 * the panel refuses to save) so it is preserved rather than treated as absent.
 */
function parseSelection(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const out = {};
  const enabled = body.enabledModelIds;
  if (enabled !== undefined) {
    if (!Array.isArray(enabled)) return undefined;
    const ids = [];
    for (const entry of enabled) {
      if (typeof entry !== "string" || entry === "") return undefined;
      // The declaration caps an id at 256 characters, so a longer one can only
      // be junk: storing it would write an unroutable name into settings.json.
      if (entry.length > MAX_MODEL_ID_LENGTH) return undefined;
      ids.push(entry);
    }
    // The payload is untrusted and this list is written to settings.json, so it
    // is capped: a gateway publishes at most MAX_MODELS rows, and an id beyond
    // the cap can only be a stale name the roster no longer carries.
    out.enabledModelIds = ids.slice(0, MAX_STORED_MODEL_IDS);
  }
  const overrides = body.overrides;
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return undefined;
    // Null prototype: `map["__proto__"] = …` on a plain object assigns the
    // prototype instead of the entry, so that id reported a successful save and
    // stored nothing.
    const map = Object.create(null);
    let stored = 0;
    for (const [id, raw] of Object.entries(overrides)) {
      if (typeof id !== "string" || id === "") return undefined;
      // The same bounds the id list above takes: this map is written to
      // settings.json too, and neither a long key nor a long list of them can
      // match a model the roster carries. Counted as entries are stored rather
      // than by rebuilding the key list on every iteration.
      if (id.length > MAX_MODEL_ID_LENGTH) return undefined;
      if (stored >= MAX_STORED_MODEL_IDS) return undefined;
      const parsed = parseOverride(raw);
      if (parsed === undefined) return undefined;
      // A field left at its catalog value is stored as absent, so the settings
      // file records only what the user actually changed.
      if (Object.keys(parsed).length > 0) {
        map[id] = parsed;
        stored += 1;
      }
    }
    out.overrides = map;
  }
  return out;
}

/**
 * The model ids one save's page could display, or undefined for an older panel.
 *
 * Only used to tell "the page did not show this id" from "the user removed it",
 * so junk entries are skipped rather than failing the save.
 */
function parseKnownModelIds(value) {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set();
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && entry.length <= MAX_MODEL_ID_LENGTH) ids.add(entry);
  }
  return ids;
}

/**
 * Keep the stored selection of models the saving page could not display.
 *
 * A roster read can be partial: the static fallback stands until the live list
 * arrives, and a source directory can answer with fewer rows than it will carry
 * later. Saving such a page used to replace the whole selection, so every model
 * outside the snapshot lost its tick and its per-model edits. Ids the page did
 * show are authoritative - an absent override there means the user cleared it -
 * while ids it never showed keep what was stored.
 */
function mergeSelectionForPartialRoster(selection, prior, known) {
  if (known === undefined) return selection;
  const priorEnabled = Array.isArray(prior.enabledModelIds) ? prior.enabledModelIds : [];
  const carriedEnabled = priorEnabled.filter((id) => !known.has(id));
  const priorOverrides = prior.overrides !== null && typeof prior.overrides === "object" ? prior.overrides : {};
  const overrides = Object.create(null);
  for (const [id, entry] of Object.entries(priorOverrides)) {
    if (!known.has(id)) overrides[id] = { ...entry };
  }
  const merged = { ...selection };
  if (Array.isArray(selection.enabledModelIds)) {
    merged.enabledModelIds = [...new Set([...selection.enabledModelIds, ...carriedEnabled])]
      .slice(0, MAX_STORED_MODEL_IDS);
  }
  if (selection.overrides !== undefined) {
    for (const [id, entry] of Object.entries(selection.overrides)) overrides[id] = entry;
  }
  if (Object.keys(overrides).length > 0) merged.overrides = overrides;
  else delete merged.overrides;
  return merged;
}

/**
 * Validate one model's override.
 *
 * Every field is optional, and a value that is present must be usable: the host
 * rejects a zero window, and a thinking level outside the host's ladder would be
 * dropped there anyway. Rejecting here means the panel reports a failure instead
 * of a save that quietly did nothing.
 */
function parseOverride(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out = {};
  if (raw.alias !== undefined) {
    if (typeof raw.alias !== "string") return undefined;
    const alias = raw.alias.trim();
    if (alias.length > 120) return undefined;
    out.alias = alias;
  }
  for (const key of ["contextWindow", "maxOutputTokens"]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_TOKEN_BUDGET) return undefined;
    out[key] = value;
  }
  if (raw.supportsImages !== undefined) {
    if (typeof raw.supportsImages !== "boolean") return undefined;
    out.supportsImages = raw.supportsImages;
  }
  if (raw.thinkingLevels !== undefined) {
    if (!Array.isArray(raw.thinkingLevels)) return undefined;
    const levels = [];
    for (const level of raw.thinkingLevels) {
      if (typeof level !== "string" || !HOST_THINKING_LEVELS.includes(level)) return undefined;
      if (!levels.includes(level)) levels.push(level);
    }
    if (levels.length > 0) out.thinkingLevels = levels;
  }
  if (raw.defaultThinkingLevel !== undefined) {
    if (typeof raw.defaultThinkingLevel !== "string") return undefined;
    if (!HOST_THINKING_LEVELS.includes(raw.defaultThinkingLevel)) return undefined;
    out.defaultThinkingLevel = raw.defaultThinkingLevel;
  }
  return out;
}

async function onPanelInvoke(channel, payload) {
  switch (channel) {
    /**
     * Opening the panel.
     *
     * The old implementation ran the whole detection pass inline - a model
     * roster fetch per gateway plus two billing calls per account - before it
     * could answer, so the panel stayed blank for seconds every time it opened.
     * Now the cached document is returned immediately and the detection runs
     * behind it; `refreshing` tells the panel to ask again shortly. `wait: true`
     * (the Refresh button) still resolves on a fully refreshed document.
     */
    case "xd.state": {
      if (payload?.wait === true) {
        const refreshed = await refreshAll("panel", true);
        // A pass retired by a reload answers with `stale`: the click would
        // otherwise clear the busy state and the banner while showing the
        // document from before the reload.
        if (refreshed.stale === true) {
          return { ...await statusDocument({ allowNetwork: false }), refreshing: false, stale: true };
        }
        // A probe invalidated by a concurrent claim can leave a row pending even
        // though this pass finished; the click must keep polling until a fresh
        // read lands instead of stopping on that pending answer.
        const stillNeeded = refreshNeeded();
        if (stillNeeded) scheduleRefresh("panel");
        return { ...refreshed, refreshing: stillNeeded };
      }
      const document = await statusDocument({ allowNetwork: false });
      const refreshing = refreshNeeded();
      if (refreshing) scheduleRefresh("panel");
      return { ...document, refreshing };
    }

    /**
     * Re-read the WorkBuddy rosters for the panel, and nothing else.
     *
     * The panel asks for this as it opens and when its model page is shown. A
     * roster read that timed out while the host was starting leaves the static
     * fallback in force, and the model page then listed the fallback's own
     * models and told the user every model they had chosen was retired - on
     * every start, for as long as the live read kept failing. This forces one
     * read per gateway (the same read `xd.rescan` does for its rosters) without
     * the account scan and gateway reconciliation that make a full rescan too
     * heavy to run on every panel open.
     */
    case "xd.fetchModels": {
      await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
        try {
          await refreshRuntime(runtime, "fetch-models", true);
        } catch (error) {
          runtime.lastError = safeMessage(error);
        }
      })), LOAD_ROSTER_BUDGET_MS);
      syncDeclaration();
      // Carries the real refresh state: the panel adopts this document and stops
      // its polling unless the flag is set, so answering without one ended the
      // background refresh for the rest of the session. The panel then sat on a
      // cache taken before the roster read and stopped following cooldowns,
      // credits and check-in figures until the user pressed refresh by hand.
      return { ...await statusDocument({ allowNetwork: false }), refreshing: refreshNeeded() };
    }

    /**
     * "Detect accounts again": a deliberate, user-invoked re-read, so every
     * gateway's roster is refetched even inside its refresh window.
     */
    case "xd.rescan": {
      // One deadline for the whole re-read, because it is the widest pass the
      // panel can ask for: a scan, both strips' sign-ins, every roster and the
      // document. Each part keeps its own bound; this one keeps their sum
      // inside the host's 30 s and still answers from what has arrived.
      const { left, settle } = budget(RESCAN_BUDGET_MS);
      // The credential readers cache their answer for 30 s, and a deliberate
      // re-scan has to see the machine as it is now - a login made while the
      // panel was open is the whole reason this button exists.
      resetDiscoveryCaches();
      // A rescan can pick up an account nobody had seen, or retire one whose
      // sign-in file is gone, so any held read describes the pool as it was.
      growthRead = null;
      growthReadEpoch += 1;
      // The scan and the gateway starts are inside the same deadline: a scan
      // may refresh tokens over the network, and a gateway's `ready` is
      // unbounded, so without this a slow disk or vendor could spend the whole
      // budget before the first roster read even starts. A scan that outruns
      // the deadline keeps running and lands on a later read; the gateways it
      // would have started come up on the next pass.
      if (activeRegions().length > 0) await settle(core.pool.scan());
      await settle(startRuntimes());
      // Trae/Qoder sign-ins are read from their own app files, not from a pool
      // cache, so a deliberate re-scan has to re-read them as well: a login made
      // while the panel was open must appear on this button too, not only on
      // Refresh or after the next timed pass.
      await settle(refreshSourceAccounts());
      // A sign-in picked up by the re-read has to reach its gateway and its
      // model row now, not on the next timed refresh: a first login made while
      // the panel was open otherwise left the strip populated while its
      // provider was never started or published.
      await settle(reconcileTraeGateways());
      await settle(reconcileQoderGateways());
      await settle(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())]
        .filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0)
        .map((entry) => warmSourceDirectory(entry))));
      // Concurrent, as in the refresh pass: end to end, two rosters read can
      // spend a whole panel call on their own.
      await settle(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, "rescan", true))));
      syncDeclaration();
      const document = await statusDocument({ allowNetwork: true, budgetMs: left() });
      const refreshing = refreshNeeded();
      if (refreshing) scheduleRefresh("panel");
      return { ...document, refreshing };
    }

    case "xd.resetCooldowns":
      core.pool.resetCooldowns();
      // The source holds are cooldowns too, and the button says "all": a Trae
      // or Qoder sign-in the upstream refused stays demoted without this.
      sourceFailureHold.clear();
      return await statusDocument({ allowNetwork: false });

    // The only mutating channel that spends anything. Guarded by an explicit
    // accountId and a pre-claim status re-check, so a double click or a stale
    // panel can never collect a reward twice.
    case "xd.checkin": {
      const accountId = typeof payload?.accountId === "string" ? payload.accountId : "";
      if (accountId === "") throw panelError("accountId is required", "INVALID");
      const account = core.pool.list().find((item) => item.id === accountId);
      if (account === undefined) throw panelError("unknown account", "NOT_FOUND");
      if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) throw panelError("this source region is disabled", "INACTIVE");
      // One pass at a time, the same flag the scheduled pass and the pool's own
      // button use: a click landing beside a running pass claimed an account the
      // pass was about to reach, and the two rounds' results overwrote each
      // other's record of what today collected. A growth run walks the same
      // accounts, so it counts as a pass too.
      if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
      // Taking the flag, not only reading it. Reading it alone guarded a claim that
      // arrives after a pass has started and left the other order open: a scheduled
      // tick or "run now" landing between this claim's status read and its write
      // walked the same account at the same time. Nothing is paid twice, because
      // every claim re-reads today's state first, but the second round then reports
      // a failure for an account that was already collected. A pass that arrives
      // now answers `{ running: true }` and takes its turn on the next tick.
      const token = ++checkinPassToken;
      checkinPassRunning = true;
      // The two reads inside carry their own 30 s bound each, which is a whole
      // panel budget apiece; the step is capped as a whole instead and says so
      // when it runs out rather than leaving the button spinning.
      const work = async () => {
        // Wrapped like the batch pass: a refused sign-in gets its one forced
        // refresh here too, because the claim below is the mutation that would
        // otherwise be lost for the day.
        const before = await core.pool.readAfterRefresh(account.id, (credential) =>
          core.client.fetchCheckinStatus(credential));
        if (before.todayCheckedIn) {
          probeCache.delete(accountId);
          return {
            state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }),
            result: { credit: 0, streakDays: before.streakDays, isStreakDay: before.isStreakDay },
          };
        }
        if (!before.active) throw panelError("check-in is not available for this account", "INACTIVE");
        const claim = await core.client.claimDailyCheckin(account.credential);
        // The claim changed this account's balance, so its cached probe is stale.
        probeCache.delete(accountId);
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), result: claim };
      };
      // The guard is released when the claim itself settles, not when the panel
      // stops waiting for it: a timed-out step kept talking to the upstream, and
      // releasing the flag at the timeout let a second click claim the same
      // account beside it. The same ownership rule the passes use applies.
      const answered = await settleWithin(work().finally(() => {
        if (token === checkinPassToken) checkinPassRunning = false;
      }), PANEL_STEP_BUDGET_MS);
      if (answered === undefined) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
      return answered;
    }

    /**
     * Save the model selection for one gateway.
     *
     * The write result is checked rather than assumed: reporting success while
     * nothing was stored is exactly how "saving does nothing" presents itself.
     * The selection is applied to the catalog and republished before answering,
     * so the panel reflects what will be in force from now on.
     */
    case "xd.saveModels": {
      // Gateway keys: "cn"/"global" are the WorkBuddy pool's two, the rest are
      // one per Trae/Qoder region. The WorkBuddy keys keep their old spelling
      // so a settings file written by an earlier version still resolves.
      const requested = typeof payload?.gateway === "string" ? payload.gateway
        : typeof payload?.region === "string" ? payload.region : "";
      if (!/^(cn|global|trae:cn|trae:ai|qoder:cn|qoder:global)$/.test(requested)) {
        throw panelError("unknown gateway", "INVALID");
      }
      const selection = parseSelection(payload?.selection);
      if (selection === undefined) throw panelError("invalid selection payload", "INVALID");
      const known = parseKnownModelIds(payload?.knownModelIds);
      const stored = await mutateSettings("modelSelection", (current) => {
        const all = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        all[requested] = mergeSelectionForPartialRoster(selection, normalizeSelection(all[requested]), known);
        return all;
      });
      if (stored !== true) {
        throw panelError("the selection could not be written to the plugin settings file", "SAVE_FAILED");
      }
      if (requested === "cn" || requested === "global") applyEffectiveSelection(requested);
      syncDeclaration();
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.preferAccount": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      if (!REGIONS.includes(region) || typeof accountId !== "string") {
        throw panelError("region and accountId are required", "INVALID");
      }
      if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) {
        throw panelError("account does not belong to this region", "NOT_FOUND");
      }
      const stored = await mutateSettings("preferredAccountIds", (current) => {
        const next = {};
        for (const key of REGIONS) {
          const held = current && typeof current === "object" && !Array.isArray(current) ? current[key] : undefined;
          if (typeof held === "string" && held !== "") next[key] = held;
        }
        if (accountId === "") delete next[region];
        else next[region] = accountId;
        return next;
      });
      if (stored !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
      core.pool.prefer(accountId || undefined, region);
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * One channel for the two per-account decisions: "not right now" (switched
     * off, still listed, one click from coming back) and "not mine any more"
     * (removed, and a rescan will not bring it back).
     */
    case "xd.setAccountState": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      const state = payload?.state;
      const states = ["enabled", "disabled", "removed", "restored", "deleted"];
      if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "" || !states.includes(state)) {
        throw panelError("region, accountId and a known state are required", "INVALID");
      }
      const account = core.pool.list(region).find((item) => item.id === accountId);
      const stored = removedAccounts().find((entry) => entry.id === accountId);
      if (state !== "restored" && account === undefined && stored === undefined) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }
      // Deleting is not a settings change: it removes the sign-in file the
      // plugin itself wrote, so there is nothing left to restore and nothing to
      // record. It has to leave the pool here rather than on the next scan, or
      // the document answered below still lists an account that is gone.
      if (state === "deleted") {
        if (!core.pool.ownsSignIn(accountId)) {
          throw panelError("only an account added from this panel can be deleted", "NOT_OWN");
        }
        const deleted = await core.pool.removeOwnSignIn(accountId);
        if (deleted !== true) {
          throw panelError("the sign-in file could not be removed", "DELETE_FAILED");
        }
        await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
        // The account id is a hash of its identity, so signing the same account in
        // again produces the same id. Anything still recorded against it would come
        // back with the new sign-in: a deleted-then-re-added account arrived already
        // switched off, or parked behind an old credit floor, with the panel offering
        // no reason for either.
        const forgotten = await mutateSettings("disabledAccountIds", (current) => {
          const known = Array.isArray(current) ? current.filter((id) => typeof id === "string") : [];
          return known.filter((id) => id !== accountId);
        });
        if (forgotten !== true) log("warn", "could not clear the disabled state for " + accountId);
        const reserveCleared = await mutateSettings("creditReserves", (current) => {
          const known = current && typeof current === "object" && !Array.isArray(current) ? current : {};
          const next = { ...known };
          delete next[accountId];
          return next;
        });
        if (reserveCleared !== true) log("warn", "could not clear the credit reserve for " + accountId);
        // The settings were the durable half; the pool keeps its own copy of both,
        // and a delete that only cleared the file left that copy to re-disable the
        // account the moment it was signed in again.
        core.pool.applyConfig({ disabledAccountIds: disabledAccountIds(), creditReserves: creditReserves() });
        // The delete path returns here rather than falling through to the cleanup
        // below, so the same cleanup has to run on this path too: a removed id
        // left in `preferredAccountIds` kept the panel rendering an "unavailable"
        // choice as the selected account until the user picked Automatic.
        if (preferredAccountId(region) === accountId) {
          const cleared = await mutateSettings("preferredAccountIds", (current) => {
            const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
            delete next[region];
            return next;
          });
          if (cleared !== true) log("warn", "could not clear the preferred account for " + region);
          core.pool.prefer(undefined, region);
        }
        // The read describes the accounts that were collectable when it ran, and
        // a deleted one is no longer part of this pool.
        growthRead = null;
        growthReadEpoch += 1;
        return await statusDocument({ allowNetwork: false });
      }
      const written = await mutateSettings("disabledAccountIds", (current) => {
        const next = Array.isArray(current) ? current.filter((id) => typeof id === "string") : [];
        const kept = next.filter((id) => id !== accountId);
        if (state === "disabled") kept.push(accountId);
        return kept;
      });
      if (written !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
      const recorded = await mutateSettings("removedAccounts", (current) => {
        const next = Array.isArray(current)
          ? current.filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
          : [];
        const kept = next.filter((entry) => entry.id !== accountId);
        if (state === "removed") {
          kept.push({
            id: accountId,
            label: account === undefined ? stored.label : account.label,
            region,
          });
        }
        return kept;
      });
      if (recorded !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
      const disabled = disabledAccountIds();
      const removed = removedAccounts();
      core.pool.applyConfig({ disabledAccountIds: disabled });
      core.pool.applyRemoved(removed.map((entry) => entry.id));
      // An account that is switched off or gone must not stay the preferred
      // one: the pool would keep asking for an id it cannot hand out.
      if (accountId !== "" && preferredAccountId(region) === accountId && state !== "enabled" && state !== "restored") {
        // Inside the queue like the two writes above: a whole-dictionary write
        // computed outside it drops a panel action that landed beside it.
        const cleared = await mutateSettings("preferredAccountIds", (current) => {
          const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
          delete next[region];
          return next;
        });
        if (cleared !== true) log("warn", "could not clear the preferred account for " + region);
        core.pool.prefer(undefined, region);
      }
      // The read describes the accounts that were collectable when it ran. An
      // account switched off or removed since then is not part of the next read,
      // so the rows in hand no longer describe this pool.
      growthRead = null;
      growthReadEpoch += 1;
      return await statusDocument({ allowNetwork: false });
    }

    /** The credits to keep back on one account: 0 clears the floor. */
    case "xd.setCreditReserve": {
      const region = payload?.region;
      const accountId = payload?.accountId;
      const reserve = Number(payload?.reserve);
      if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "") {
        throw panelError("region and accountId are required", "INVALID");
      }
      if (!Number.isFinite(reserve) || reserve < 0 || reserve > MAX_CREDIT_RESERVE) {
        throw panelError("reserve must be a number of credits between 0 and " + MAX_CREDIT_RESERVE, "INVALID");
      }
      if (!core.pool.list(region).some((account) => account.id === accountId)) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }
      const written = await mutateSettings("creditReserves", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        if (reserve === 0) delete next[accountId];
        else next[accountId] = Math.floor(reserve);
        return next;
      });
      if (written !== true) throw panelError("the reserve could not be saved", "SAVE_FAILED");
      core.pool.applyConfig({ creditReserves: creditReserves() });
      // The account may have just become unusable or usable again: say so on the
      // next document instead of leaving a stale "next up".
      return await statusDocument({ allowNetwork: false });
    }

    /** One click for every account's daily reward.
     *  With `source`, only that source's pool runs — each source has its own
     *  check-in pool in the panel, so one button must not sweep the others. */
    case "xd.checkinAll": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      // A name no worker answers would otherwise run a pass that collected
      // nothing and then record it as the last run: the panel would show an
      // all-zero log row for a button nobody pressed.
      if (!["", "workbuddy", "trae", "qoder"].includes(source)) {
        throw panelError("source must be workbuddy, trae or qoder", "INVALID");
      }
      // One pass, one implementation: this channel only narrows it to one source
      // and reshapes the answer. A second copy of the fan-out here had already
      // drifted - it skipped the pause before the growth burst and never recorded
      // itself in `autoCheckinLast`, so the panel's "last run" stayed on the
      // previous pass while the upstream saw two request clusters back to back.
      const finished = runCheckinPass({ manual: true, only: source });
      const counts = await settleWithin(finished, CHECKIN_BUDGET_MS);
      if (counts === undefined) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      if (counts.running === true || counts.stale === true) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      if (counts.error !== undefined) throw panelError(counts.error, "UPSTREAM");
      return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), ...counts };
    }

    /**
     * Claim ONE Trae or Qoder account's daily reward.
     *
     * The label and region are the pair the panel's row was built from, so a
     * stale row cannot claim a different account; the claim itself re-reads
     * status first, which is what keeps a double click from collecting twice.
     */
    case "xd.sourceCheckin": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const label = typeof payload?.label === "string" ? payload.label : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      if (label === "" || region === "") throw panelError("label and region are required", "INVALID");
      if (!regionEnabled(source, region)) throw panelError("this source region is disabled", "INACTIVE");
      // One pass at a time: a single claim landing beside a running pass collects
      // an account that pass is about to reach, and both write today's record.
      // The growth run is a pass over the same accounts.
      if (checkinPassRunning || growthPassRunning) throw panelError("a check-in or growth pass is already running; wait for it to finish", "BUSY");
      // Taken, not only read, for the reason the pool's single claim states.
      const token = ++checkinPassToken;
      checkinPassRunning = true;
      // Capped as a whole, like the pool's own check-in: the claim re-reads the
      // status first and each read carries a 30 s bound of its own. The guard is
      // released when the claim itself settles, not when the panel stops waiting:
      // releasing it at the timeout let a second click claim beside a step that
      // was still talking to the upstream.
      const work = (async () => {
        const outcome = source === "trae" ? await traeClaimOne(label, region) : await qoderClaimOne(label, region);
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), result: outcome };
      })();
      const answered = await settleWithin(work.finally(() => {
        if (token === checkinPassToken) checkinPassRunning = false;
      }), PANEL_STEP_BUDGET_MS);
      if (answered === undefined) throw panelError("the check-in did not finish in time; try again", "TIMEOUT");
      return answered;
    }


    /**
     * Pick which of a source's accounts serves its region.
     *
     * The label is the same one the panel's row was built from, and the
     * gateways re-read their credentials on every request, so this takes effect
     * from the next request on without restarting anything.
     */
    case "xd.preferSourceAccount": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      const label = typeof payload?.label === "string" ? payload.label : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) {
        throw panelError("unknown region for this source", "INVALID");
      }
      if (!sourceAccountMayBePreferred(source, region, label)) {
        throw panelError("that account is not available for this source", "INVALID");
      }
      const stored = await mutateSettings("preferredSourceAccounts", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        if (label === "") delete next[sourceRegionKey(source, region)];
        else next[sourceRegionKey(source, region)] = label;
        return next;
      });
      if (stored !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
      return await statusDocument({ allowNetwork: false });
    }
    case "xd.distribution": {
      const requested = payload?.distribution;
      const next = WORKBUDDY_DISTRIBUTIONS.includes(requested) ? requested : "priority";
      const stored = await saveSettings({ distribution: next });
      if (stored !== true) {
        throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
      }
      core.pool.applyConfig({ distribution: next });
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * The usage mode of one Trae/Qoder source. WorkBuddy's own mode is handled
     * above by the pool; a source gateway has no pool, it reads an ordered
     * credential list per request, so the mode is only a setting here.
     */
    case "xd.sourceDistribution": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      if (source !== "trae" && source !== "qoder") throw panelError("source must be trae or qoder", "INVALID");
      const mode = SOURCE_DISTRIBUTIONS.includes(payload?.distribution) ? payload.distribution : "priority";
      const stored = await mutateSettings("sourceDistributions", (current) => {
        const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
        next[source] = mode;
        return next;
      });
      if (stored !== true) {
        throw panelError("the usage mode could not be written to the plugin settings file", "SAVE_FAILED");
      }
      return await statusDocument({ allowNetwork: false });
    }

    /** Switch the daily automatic check-in on or off, and set its hours. */
    case "xd.setAutoCheckin": {
      const hours = normaliseCheckinHours(Array.isArray(payload?.hours) ? payload.hours : []);
      const stored = await saveSettings({ autoCheckin: { enabled: payload?.enabled === true, hours } });
      if (stored !== true) {
        throw panelError("the automatic check-in setting could not be written to the plugin settings file", "SAVE_FAILED");
      }
      applyAutoCheckin();
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Refresh every eligible account's token, by hand.
     *
     * There is no schedule behind this: the panel's button is the only thing
     * that runs it, which is what the user asked for. The pass itself is the
     * same one the check-in card's other controls use — `ensureFresh` decides
     * per account whether an upstream call is needed — so a token that still
     * has hours on it costs nothing and an international token that lives a
     * year is never touched.
     *
     * Bounded like every other network pass here: Trae alone spaces its
     * accounts, and a pass that outruns the budget records itself in the
     * document instead of leaving the button spinning.
     */
    case "xd.keepAlive": {
      await settleWithin(runKeepAlivePass(), REFRESH_PASS_BUDGET_MS);
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Run the daily pass now, by hand.
     *
     * The scheduled pass is silent by nature: it fires at an hour nobody is
     * watching, so a user who set 11:00 had nothing to look at and no way to
     * check the setting had taken. This runs exactly what the scheduler runs and
     * records it in the same place, so the panel's "last run" line answers for
     * both — and a user can see the result of a manual run immediately.
     *
     * Bounded like every other network pass here: Trae alone spaces its accounts
     * five seconds apart, so ten of them is a minute, and the host cuts a panel
     * call off well before that. So the pass starts now, the call answers with
     * whatever the budget allows, and a pass still running lands in the same
     * `autoCheckinLast` when it finishes — the panel picks it up on its next
     * refresh instead of the result being lost to a truncated call.
     */
    case "xd.runCheckinNow": {
      const pass = runCheckinPass({ manual: true });
      await settleWithin(pass, REFRESH_PASS_BUDGET_MS);
      return await statusDocument({ allowNetwork: false });
    }

    case "xd.setComposerPoints": {
      const stored = await saveSettings({ showComposerPoints: payload?.enabled === true });
      if (stored !== true) {
        throw panelError("the composer credits setting could not be written to the plugin settings file", "SAVE_FAILED");
      }
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Park or unpark one edition of one source (国内版 / 国际版).
     *
     * Same shape as the source switch above: a parked region keeps no gateway,
     * no scan and no provider row, and unparking waits for a real refresh so
     * the panel comes back with that region's accounts and models.
     */
    case "xd.setRegionEnabled": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const region = typeof payload?.region === "string" ? payload.region : "";
      const known = source === "trae" ? TRAE_REGIONS : source === "qoder" ? QODER_REGIONS : source === "workbuddy" ? REGIONS : undefined;
      if (known === undefined || !known.includes(region)) throw panelError("unknown source region", "INVALID");
      const key = sourceRegionKey(source, region);
      const stored = await mutateSettings("disabledRegions", (current) => {
        const known = Array.isArray(current) ? current.filter((entry) => typeof entry === "string") : [];
        const parked = known.filter((entry) => entry !== key);
        if (payload?.enabled !== true) parked.push(key);
        return parked;
      });
      if (stored !== true) {
        throw panelError("the region switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      await applySettingsEverywhere(false);
      if (payload?.enabled === true) await refreshAll("region-on", true);
      else syncDeclaration();
      // The growth rows are per account and a parked region's accounts are not
      // part of the next read, so the held answer no longer describes the pool.
      if (source === "workbuddy") {
        growthRead = null;
        growthReadEpoch += 1;
      }
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Switch one source on or off from the panel.
     *
     * Same settings key the host's own settings dialog writes, so the switch
     * state is shared: whichever surface changes it, the next document says the
     * same thing. Turning a source on waits for a real refresh so the panel
     * comes back with its gateways and accounts, not an empty strip.
     */
    case "xd.setSource": {
      const key = sourceSettingKey(payload?.source);
      if (key === undefined) throw panelError("unknown source", "UNSUPPORTED");
      const stored = await saveSettings({ [key]: payload?.enabled === true });
      if (stored !== true) {
        throw panelError("the source switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      // The sign-in list was read while this source was off; switching it on must
      // not be answered from that read.
      resetDiscoveryCaches();
      // Settings drive everything downstream: reconcile the gateways, re-apply
      // the timers and republish, exactly as a host-driven change would.
      await applySettingsEverywhere(false);
      if (payload?.enabled === true) await refreshAll("source-on", true);
      else syncDeclaration();
      // Same reason as the region switch: the growth card lists WorkBuddy
      // accounts, and this switch decides whether there are any.
      if (payload?.source === "workbuddy") {
        growthRead = null;
        growthReadEpoch += 1;
      }
      return await statusDocument({ allowNetwork: false });
    }

    /**
     * Start a panel login and answer the URL to open.
     *
     * The URL is handed back rather than opened from here: the panel owns the
     * click, and this host's page is a real browser tab, so it opens the link
     * itself the same way its footer links do.
     */
    case "xd.startLogin": {
      const realm = payload?.realm === "global" ? "global" : "cn";
      const start = await startDeviceLogin(realm);
      deviceLogins.set(realm, { state: start.state, at: Date.now() });
      return { realm, authUrl: start.authUrl };
    }

    /**
     * Poll the login the panel started on this realm.
     *
     * A finished login is written as one of the plugin's own `.info` files and
     * the pool is rescanned, so the account appears in the panel and the
     * provider row without a reload. The second sign-in for an account already
     * present lands in a directory the pool already reads, so the directory set
     * does not change and `applyConfig` would not notice it: the scan is
     * explicit for that reason.
     */
    case "xd.pollLogin": {
      const realm = payload?.realm === "global" ? "global" : "cn";
      const pending = deviceLogins.get(realm);
      if (pending === undefined) throw panelError("no login is waiting on this realm", "NO_LOGIN");
      if (Date.now() - pending.at > DEVICE_LOGIN_TTL_MS) {
        deviceLogins.delete(realm);
        throw panelError("the login link has expired; start again", "LOGIN_EXPIRED");
      }
      const answer = await pollDeviceLogin(realm, pending.state);
      if (answer.status !== "ok") return { status: "pending" };
      deviceLogins.delete(realm);
      const directory = ownSignInDir(dataPath);
      if (directory === "") {
        throw panelError("no plugin data directory to write the sign-in into", "NO_DATA_DIR");
      }
      await writeOwnSignIn(directory, answer.signIn);
      // A new account is not in a read taken before it landed.
      growthRead = null;
      growthReadEpoch += 1;
      await settleWithin(core.pool.scan(), POOL_SCAN_BUDGET_MS);
      await refreshAll("panel-login", false);
      // The fresh document rides the answer. The panel adopts whatever a
      // channel hands back, and a login that answered with a name and nothing
      // else left the list painting the pool as it was before the account
      // landed: the user read "added" and saw no new row, which reads as a
      // failed add. The read is local, so it costs no request.
      return {
        status: "ok",
        nickname: answer.signIn.nickname,
        region: answer.signIn.region,
        state: await statusDocument({ allowNetwork: false }),
      };
    }

    /**
     * What the growth centre holds, claiming nothing.
     *
     * Read-only because two of the four steps are not idempotent: a make-up
     * card and a lottery draw are spent by running them. Showing the state
     * first is what lets the panel say "2 cards, yesterday missed" before the
     * user decides, rather than spending one and reporting it afterwards.
     */
    case "xd.growthState": {
      const epoch = growthReadEpoch;
      const answered = await settleWithin(readGrowthState(), PANEL_STEP_BUDGET_MS);
      if (answered === undefined) throw panelError("the growth state did not finish in time; try again", "TIMEOUT");
      // The pool changed while this read ran, so what it answered describes the
      // pool as it was. Answering the panel is fine - the user asked - but storing
      // it would resurrect the rows the change just dropped.
      if (epoch !== growthReadEpoch) return { growth: { ...answered, readAt: Date.now() } };
      // Kept: the next paint shows these rows instead of asking for them again,
      // and the timestamp lets the card tell a fresh result from a stale one.
      growthRead = { ...answered, readAt: Date.now() };
      return { growth: growthRead };
    }

    /**
     * Run the growth centre on its own, without the daily check-in.
     *
     * The scheduled pass runs it as its third stage, so this is the same code
     * with the same pacing and the same abort signal - not a second, smaller
     * copy of it. Refused beside a check-in pass rather than queued: both walk
     * the same accounts, and two unpaced clusters on one account is what the
     * upstream reads as a burst.
     */
    case "xd.growthRun": {
      if (serviceStopped) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      if (growthPassRunning || checkinPassRunning) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      growthPassRunning = true;
      // The run that owns the flag. A reload hands the flag to whatever the new
      // activation starts, and a stale run clearing it here would un-guard that
      // newer run; a stale run with nothing newer behind it still clears it, so a
      // run that outlived its activation cannot lock the card for good.
      const token = ++growthPassToken;
      // A run started after the service stopped gets a fresh signal: the stop
      // retired the run that was in flight then, not the ones still to come.
      // Without this re-arm every account here breaks out of its loop on the
      // inherited signal at once and the empty result is recorded as a finished
      // run - "0 tier(s), +0" for a pass that never asked.
      checkinAbort.abort();
      checkinAbort = new AbortController();
      checkinScope.enterWith(checkinAbort.signal);
      const generation = loadGeneration;
      const finished = (async () => {
        try {
          const counts = await claimAllGrowth();
          // Recorded here, not by the caller: a pass that outran the panel's
          // budget is still running, and its result has to appear in the next
          // document instead of being dropped with the timed-out wait.
          if (stillLoaded(generation)) {
            growthLast = { at: new Date().toISOString(), ...counts };
            scheduleRefresh("growth");
          }
          return counts;
        } finally {
          if (token === growthPassToken) growthPassRunning = false;
        }
      })();
      const counts = await settleWithin(finished, GROWTH_BUDGET_MS);
      if (counts === undefined) {
        return { state: await statusDocument({ allowNetwork: false }), running: true };
      }
      return { state: await statusDocument({ allowNetwork: false }), growth: counts };
    }

    case "xd.doctor":
      return await doctor();

    /**
     * The composer readout.
     *
     * `composerPoints` answers from cache only; a poll may schedule the
     * background refresh that fills a stale cache, but never waits on one.
     * `composerPrefer` is the click behind it and is allowed to write.
     */
    case "xd.composerPoints":
      return composerPoints(payload);

    case "xd.composerPrefer":
      return await composerPrefer(payload);

    /**
     * Re-read the credits behind the composer popup, then answer with them.
     *
     * The popup lists one route's accounts, so the refresh covers exactly those:
     * a WorkBuddy region drops its probe cache and reads it back, a Trae or Qoder
     * region re-probes each of its rows. The polled readout stays cache-only;
     * this channel is the one the click is allowed to wait on, and it waits only
     * as long as the readout's own call deadline leaves room for the answer.
     */
    case "xd.composerRefresh": {
      const hit = matchComposerModel(payload);
      if (hit === undefined) return composerPoints(payload);
      const { left, settle } = budget(COMPOSER_REFRESH_BUDGET_MS);
      if (hit.source === "workbuddy") {
        for (const account of core.pool.list(hit.region)) probeCache.delete(account.id);
        await settle(statusDocument({ allowNetwork: true, budgetMs: COMPOSER_REFRESH_BUDGET_MS }));
      } else {
        const rows = hit.source === "trae" ? traeAccountRows : qoderAccountRows;
        const found = hit.source === "trae" ? await discoverTraeCredentials() : await discoverQoderCredentials();
        // One bounded probe per account, and no shared budget, is minutes on a
        // machine with several sign-ins, so the bound lives here. Past it a row
        // keeps the figures the popup is already showing; the readout polls on,
        // so a late probe still lands on the next poll rather than being lost.
        for (const row of rows) {
          if (row.region !== hit.region) continue;
          if (left() === 0) break;
          const credential = found.credentials.find((item) => {
            const itemLabel = hit.source === "trae" ? traeRowLabel(item) : qoderRowLabel(item);
            const itemRegion = hit.source === "trae" ? traeRegionOfCredential(item) : item.region;
            return itemLabel === row.label && itemRegion === row.region;
          });
          if (credential === undefined) continue;
          // The previous row is the fallback: a failed read keeps the figures the
          // popup is already showing instead of blanking them.
          const probe = hit.source === "trae"
            ? await traeRowProbe(credential, row)
            : await qoderRowProbe(credential, row);
          if (probe?.usage) row.usage = probe.usage;
          if (probe?.checkin) row.checkin = probe.checkin;
        }
      }
      return composerPoints(payload);
    }

    default:
      throw panelError("unsupported panel channel: " + String(channel), "UNSUPPORTED");
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * One check-in worker, isolated from the others in the same fan-out.
 *
 * The fan-out is a `Promise.all`, so a worker that threw took the whole pass
 * with it - the WorkBuddy counts already computed included. Each worker now
 * answers its own empty result and logs, and the pass reports what the rest did.
 */
function isolatedCheckinWorker(work, fallback, name) {
  return work.catch((error) => {
    // The failure is reported, not swallowed: answering the fallback alone read
    // as "nothing was due today", which is the one thing a source that could not
    // be read must never look like.
    log("warn", name + " check-in failed: " + safeMessage(error));
    return { ...fallback, failed: 1, reason: safeMessage(error) };
  });
}

/**
 * Run one check-in pass and record it in `autoCheckinLast`.
 *
 * All three entry points — the scheduled tick, the host command and the panel's
 * "run now" — come through here, so the re-entry guard lives in one place. In
 * the panel channel alone it would miss the tick and the host command, which can
 * start a second pass alongside a manual one: no double claiming, because every
 * step reads `todayCheckedIn` before it writes, but the log would then describe
 * whichever pass finished last rather than what the user asked for.
 *
 * `manual` marks a pass the user started, so the panel's status line can say so.
 */
async function runCheckinPass(options) {
  const manual = options?.manual === true;
  // One source's half of the pass, as the per-source strip in the panel asks for
  // it. An empty string is every source.
  const only = typeof options?.only === "string" ? options.only : "";
  const want = (name) => only === "" || only === name;
  const generation = loadGeneration;
  if (checkinPassRunning) return { running: true };
  // A pass that starts after the service stopped would run its whole fan-out
  // against gateways that are already closed. The stop retires the pass that
  // was in flight; this is the guard for the ones still to come.
  if (serviceStopped) return { stale: true };
  // A growth run owns the abort signal and the accounts; a scheduled or command
  // pass starting now would truncate it mid-account and record the partial counts
  // as a finished run.
  if (growthPassRunning) return { running: true };
  checkinPassRunning = true;
  // The pass that owns the running flag. A newer pass takes it, so an older one
  // finishing afterwards leaves the newer pass guarded; an older one finishing
  // with nothing newer behind it still clears the flag, which is what keeps a
  // pass that outlived its activation from locking every entry for good.
  const token = ++checkinPassToken;
  // A pass that starts after the service stopped runs with a fresh flag: the
  // stop retired the pass that was running then, not the ones still to come.
  checkinAbort.abort();
  checkinAbort = new AbortController();
  checkinScope.enterWith(checkinAbort.signal);
  // A scheduled tick hands in the slot it already decided was due. A hand-started
  // pass must consult the slots already recorded: ignoring them always named the
  // earliest hour of the day, so an evening "run now" re-marked the morning and
  // left the evening slot for the next tick, which ran the whole pass again.
  const zoned = zonedDayHour(new Date());
  const slot = typeof options?.slot === "string" && options.slot !== ""
    ? options.slot
    : dueCheckinSlot(new Date(), checkinHours(), autoCheckinSlots)
      ?? checkinSlotId(zoned.day, zoned.hour);
  const started = { slot, claimed: 0, pending: true, workbuddy: want("workbuddy"), at: new Date().toISOString(), ...manual ? { manual: true } : {} };
  autoCheckinLast = started;
  // Recorded up front, not after the pass: a pass that runs long must not be
  // started again by the next tick. A manual run spends the hour that is due
  // now — pressing "run now" at 09:10 is that morning's pass, and at 21:10 it
  // is the evening's, not another copy of the morning.
  // Only a pass that actually covers WorkBuddy may spend WorkBuddy's slot: the
  // panel puts one button on each source's strip, and Trae's button used to mark
  // the domestic hour as collected, which then skipped that day's check-in,
  // travel and streak bonus entirely.
  const spendsSlot = want("workbuddy");
  if (spendsSlot) autoCheckinSlots.add(slot);
  scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
  try {
    // Concurrent where the sources are independent, which is what the host
    // command has always done: Trae alone paces its accounts five seconds apart,
    // so a serial pass over several sign-ins takes minutes.
    // Growth and travel stay out of that group: both talk to the same domestic
    // accounts as the daily check-in, so running them together stacks requests
    // on one account. A task can also be scored off the check-in, so growth
    // follows it, after a pause so the two bursts are not back to back.
    // Each worker is failure-isolated: one `Promise.all` rejection used to
    // discard the counts the siblings had already produced and leave the pass
    // reporting nothing but an error. A worker that throws now reports itself
    // as failed and the rest of the pass stands.
    const [pool, qoder, trae] = await Promise.all([
      want("workbuddy") ? isolatedCheckinWorker(claimAllCheckins(), { claimed: 0, skipped: 0, failed: 0 }, "workbuddy") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
      want("qoder") ? isolatedCheckinWorker(qoderCheckinAll(), { claimed: 0, skipped: 0, failed: 0 }, "qoder") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
      want("trae") ? isolatedCheckinWorker(traeCheckinAll(), { claimed: 0, skipped: 0, failed: 0 }, "trae") : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
    ]);
    // Travel shares the domestic accounts with the check-in that just ran, so
    // it takes the serial half with growth rather than a second slot in the
    // fan-out: two unpaced request clusters on one account at the same moment
    // is what the upstream reads as a burst.
    const travel = want("workbuddy")
      ? await isolatedCheckinWorker(
        travelAllAccounts(),
        { departed: 0, claimed: 0, adopted: 0 },
        "travel",
      )
      : undefined;
    // Published before the growth pause. "Run now" only waits 18s, and the panel
    // was painting this stub — claimed still 0, no source rows — as a finished pass.
    if (!stillLoaded(generation)) return started;
    // Qoder's round may open after this hour (10:00 Beijing). Its answer carries
    // that opening time, and the tick below re-runs Qoder alone when it comes:
    // without this write-back the opening time is dropped with the pass, the
    // slot counts as spent, and that day's Qoder credits are never collected.
    // A stale generation must not schedule anything either: the retry time it
    // wrote would steer a load that has its own pass bookkeeping.
    //
    // A source-only pass must leave the deferral alone. A Trae or WorkBuddy
    // click with no Qoder round replaced that answer with a placeholder, so the
    // unconditional write cleared a retry the earlier full pass had scheduled.
    // On a Qoder round that did run, a failed discovery or a transient
    // per-account transport failure keeps the retry alive with the same backoff
    // the deferred tick uses; a terminal answer clears it.
    if (want("qoder")) {
      const now = Date.now();
      const opening = typeof qoder?.opensAt === "number" && qoder.opensAt > now ? qoder.opensAt : 0;
      const backoff = Number(qoder?.failed) > 0
        && (typeof qoder?.reason === "string" || qoder?.retry === true)
        ? now + QODER_RETRY_BACKOFF_MS
        : 0;
      // A transient failure on one account must not wait for another account's
      // opening hours away, and an opening must not be discarded by a backoff.
      qoderRetryAt = opening === 0 ? backoff : backoff === 0 ? opening : Math.min(opening, backoff);
    }
    Object.assign(started, {
      claimed: pool.claimed,
      skipped: pool.skipped,
      failed: pool.failed,
      // The worker that threw carries the upstream's own words; the panel shows
      // them beside the failure count.
      ...pool.reason === undefined ? {} : { reason: pool.reason },
      travel,
      // A source-only pass did not run the other strips. Omitting their rows
      // keeps the panel's "last run" from reporting a zero it never attempted;
      // the total already reads each row that is present.
      ...(want("qoder") ? { qoder } : {}),
      ...(want("trae") ? { trae } : {}),
    });
    await checkinDelay(GROWTH_AFTER_CHECKIN_MS);
    if (!stillLoaded(generation)) return started;
    started.growth = want("workbuddy") ? await claimAllGrowth() : undefined;
    log((manual ? "manual" : "automatic") + " check-in collected " + pool.claimed + " account(s) for " + slot);
    // The slot is spent once the pass has ENDED, not when it started: a pass
    // the process died in the middle of leaves no record behind and is
    // attempted again by the next run. See `saveCheckinSlots`. A pass that no
    // longer belongs to this activation writes nothing either, for the same
    // reason: its slots belong to a load that has already reset the book.
    // A Qoder-only pass spends no WorkBuddy slot, but its retry time is
    // bookkeeping that has to survive a reload too.
    if ((spendsSlot || want("qoder")) && stillLoaded(generation)) saveCheckinSlots();
  } catch (error) {
    started.error = safeMessage(error);
    log("warn", (manual ? "manual" : "automatic") + " check-in failed for " + slot + ": " + started.error);
    // A failed pass has spent its slot as well - the upstream is down or the
    // account is rate-limited, and retrying all day only adds noise - so the
    // record is written on this path too.
    if ((spendsSlot || want("qoder")) && stillLoaded(generation)) saveCheckinSlots();
  } finally {
    // On every path, including a pass that threw: without this the guard stays
    // set and no further pass can start for the rest of the process. The pass
    // that owns the flag clears it, and only that one: a reload while this pass
    // runs hands the flag to whatever the new activation starts. A pass that
    // outlived its activation still clears it when nothing newer has taken
    // over, which is what kept every later "run now" answering "already
    // running" until the plugin was reloaded.
    if (token === checkinPassToken) checkinPassRunning = false;
    delete started.pending;
  }
  if (stillLoaded(generation)) {
    autoCheckinLast = started;
    scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
  }
  return started;
}

/**
 * How long a check-in pass may run before it answers what it has and leaves the
 * rest to the background. Inside the host's command budget, with room for the
 * document that answers with it.
 */
const CHECKIN_BUDGET_MS = 15000;
/**
 * The other wide panel passes: a deliberate re-scan, one check-in step, and the
 * connection check. Each is capped as a whole rather than by adding up the
 * bounds of the calls inside it, and each answers from what has arrived.
 */
const RESCAN_BUDGET_MS = 20000;
const PANEL_STEP_BUDGET_MS = 20000;
/**
 * What a pass may spend on the document it answers with. The figures are read
 * from the caches the pass has just filled, so this buys the numbers, not the
 * reads: `allowNetwork: true` still probes inside this share.
 */
const DOCUMENT_BUDGET_MS = 4000;

/**
 * A standalone growth run. Wider than the check-in budget it is carved out of,
 * because growth walks the same accounts with a pause and a report gap between
 * the steps, and several sign-ins make that minutes rather than seconds.
 */
const GROWTH_BUDGET_MS = 90000;

/**
 * What the composer popup's refresh may spend before it answers.
 *
 * The readout's own call deadline is 20 s (`INVOKE_TIMEOUT_MS`), and the route
 * still has to serialize the answer inside it, so this pass stops short of the
 * full figure. Past it the popup keeps the figures it already has and its poll
 * picks up whatever the abandoned probe wrote, which is what keeps a slow
 * credentials read from turning the click into a client-side timeout.
 */
const COMPOSER_REFRESH_BUDGET_MS = 15000;

/**
 * Light one account's growth streak, then redeem every tier it opened.
 *
 * The streak counter only advances on a chat the upstream scores against the
 * account, and a synthetic `chat_request_send` report is enough to move it: the
 * report is what the desktop client itself sends when a conversation is opened,
 * so the growth centre counts the day without a billable turn. Without this
 * report the counter sits where the user last left it, the 7d/14d/28d tiers
 * never unlock, and the pass redeems nothing on a schedule that looks healthy.
 *
 * The report is sent before the read rather than after it, and the read waits
 * out {@link STREAK_REPORT_READ_GAP_MS}, because the upstream scores it
 * asynchronously. A report that fails is not fatal: the tier state is still
 * read and whatever is already unlocked is still redeemed.
 *
 * A locked tier is the normal state until enough days accumulate, and a claimed
 * one needs no action, so neither is a failure. Returns how many tiers were
 * redeemed and what they paid, so the panel can say so.
 */
async function redeemAccountStreak(account) {
  // Per-step counts. The four things this pass does are separate features with
  // separate endpoints, and one merged number could not tell the user which of
  // them actually did something.
  const detail = { makeup: 0, gift: 0, compensation: 0, activity: 0, streak: 0, lottery: 0, failed: 0 };
  const conversationId = "wb2api-streak-" + Date.now();
  // Repair first: a missed yesterday breaks the run, and the run is what unlocks
  // the tiers this function is about to redeem. A card is only spent when one is
  // actually held, so a pool with none never pays for the two reads.
  try {
    const cards = await core.client.makeupCards(account.credential);
    if (cards > 0 && await core.client.missedYesterday(account.credential)) {
      const yesterday = zonedDay(-1);
      await core.client.useMakeupCard(account.credential, yesterday);
      detail.makeup += 1;
      log("info", "streak " + account.label + ": make-up card spent on " + yesterday);
    }
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": make-up: " + safeMessage(error));
  }
  // One-off collections that pay credits and then never appear again. A refusal
  // here is the normal "already collected" answer, so it is not a failure.
  for (const [label, collect] of [
    ["gift", () => core.client.claimGift(account.credential)],
    ["compensation", () => core.client.claimCompensation(account.credential)],
  ]) {
    try {
      const paid = await collect();
      if (paid > 0) {
        detail[label] += paid;
        log("info", "streak " + account.label + ": " + label + " +" + paid + "c");
      }
    } catch {
      // Nothing waiting: the endpoints answer a business error for that.
    }
  }
  try {
    await core.client.reportChatActivity(account.credential, conversationId);
    detail.activity += 1;
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": activity report failed: " + safeMessage(error));
  }
  await checkinDelay(STREAK_REPORT_READ_GAP_MS);
  const status = await core.client.growthStreakFull(account.credential);
  let claimed = 0;
  let credit = 0;
  let energy = 0;
  // A tier that fails is logged and left there. The upstream scheduler does not
  // count that as a failed account: locked and already-claimed tiers are normal,
  // and one redeem error must not paint the whole check-in as a failure.
  for (const tier of status.tiers) {
    if (tier.status !== "unlocked") continue;
    try {
      await core.client.redeemStreakTier(account.credential, tier.tier);
      claimed += 1;
      credit += tier.credit;
      energy += tier.energy;
      detail.streak += 1;
      log("info", "streak " + account.label + ": redeemed " + tier.tier + " (+" + tier.credit + "c +" + tier.energy + "e)");
    } catch (error) {
      detail.failed += 1;
      log("warn", "streak " + account.label + ": redeem " + tier.tier + " failed: " + safeMessage(error));
    }
  }
  // Draws come only from the tiers just redeemed, so this runs after them and
  // pays only when a tier actually opened a chance. The prize payload is passed
  // through as-is and logged: its shape is the campaign's, not the API's, so
  // there is no field to read a credit out of.
  try {
    const chances = await core.client.lotteryChances(account.credential);
    for (let draw = 0; draw < chances; draw += 1) {
      const prize = await core.client.drawLottery(account.credential);
      detail.lottery += 1;
      log("info", "streak " + account.label + ": draw " + (draw + 1) + "/" + chances + " " + JSON.stringify(prize).slice(0, 160));
    }
  } catch (error) {
    detail.failed += 1;
    log("warn", "streak " + account.label + ": lottery: " + safeMessage(error));
  }
  return { claimed, credit, energy, detail };
}

/**
 * Collect the streak bonus of every account.
 *
 * Idempotent, so a pass that finds nothing to collect costs the reads and no
 * mutation, and running it on the daily schedule cannot double-pay. One account
 * failing never stops the rest.
 */
async function claimAllGrowth() {
  const counts = { streak: 0, credit: 0, failed: 0, detail: emptyGrowthDetail() };
  // Counted, not flagged: the accounts this pass skips (disabled, the other
  // region) must not decide whether the second account waits. A `first` flag
  // turned the skip into a burst the moment the first account was off.
  let seen = 0;
  for (const account of core.pool.list()) {
    // The plugin is going away: the accounts left in the list are not worth an
    // upstream call each, because nothing will read the result.
    if (currentCheckinSignal().aborted) break;
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // A sign-in the upstream refused answers every step below with the same
    // 401, and the hold that says so is only released by a new sign-in.
    if (signInRefused(account)) continue;
    // Both regions: the growth centre exists on the international host too, and
    // its streak only advances on a reported activity, so leaving those accounts
    // out kept their tiers locked for good.
    if (seen > 0) await checkinDelay(GROWTH_ACCOUNT_DELAY_MS);
    seen += 1;
    counts.detail.accounts += 1;
    let collected = false;
    try {
      const streak = await redeemAccountStreak(account);
      counts.streak += streak.claimed;
      counts.credit += streak.credit;
      if (streak.claimed > 0) collected = true;
      mergeGrowthDetail(counts.detail, streak.detail);
    } catch (error) {
      counts.failed += 1;
      counts.detail.failed += 1;
      log("warn", "streak failed for " + account.label + ": " + safeMessage(error));
    }
    // A claim changed this account's balance, so its cached probe is stale.
    if (collected) probeCache.delete(account.id);
  }
  return counts;
}

/** A growth breakdown with everything at zero, for a pass that found nothing. */
function emptyGrowthDetail() {
  return {
    accounts: 0, makeup: 0, gift: 0, compensation: 0, activity: 0,
    streak: 0, lottery: 0, failed: 0,
  };
}

/** Add one account's step counts into the pass total. */
function mergeGrowthDetail(total, part) {
  for (const key of Object.keys(total)) {
    if (typeof part[key] === "number") total[key] += part[key];
  }
}

/**
 * What the growth centre holds right now, without claiming anything.
 *
 * Read-only, so the panel can show the state before the user decides to spend
 * a make-up card or a draw: those two are the only steps of the pass that are
 * not idempotent, and a blind \"run\" would spend them without saying so.
 *
 * One row per account rather than one merged total. The streak, the tier it is
 * walking towards and the cards it holds are facts about one account, and a
 * total across them names no account: with two sign-ins the old merged line
 * showed whichever account was read last. The panel expands a row for the
 * tier detail behind it.
 *
 * One account's two reads run together and the accounts run together too,
 * like the credit probe: this is on demand, one button, and a serial pass over
 * several sign-ins would make the panel feel broken.
 */
async function readGrowthState() {
  const rows = [];
  let failed = 0;
  const wanted = core.pool.list().filter((account) =>
    !core.pool.isDisabled(account.id) && regionEnabled("workbuddy", regionOf(account.credential.domain))
    && !signInRefused(account));
  const reads = await Promise.all(wanted.map(async (account) => {
    try {
      const [streak, chances] = await Promise.all([
        core.client.growthStreakFull(account.credential),
        core.client.lotteryChances(account.credential),
      ]);
      return { account, streak, chances };
    } catch (error) {
      log("warn", "growth state failed for " + account.label + ": " + safeMessage(error));
      return { account, error };
    }
  }));
  for (const read of reads) {
    const region = regionOf(read.account.credential.domain);
    if (read.error !== undefined) {
      failed += 1;
      rows.push({ id: read.account.id, label: read.account.label, region, failed: true });
      continue;
    }
    const streak = read.streak;
    rows.push({
      id: read.account.id,
      label: read.account.label,
      region,
      days: streak.days,
      nextTier: streak.nextTier,
      nextTierRemaining: streak.nextTierRemaining,
      tiers: streak.tiers.filter((tier) => tier.status === "unlocked").length,
      tierList: streak.tiers,
      makeupCards: streak.makeupCards,
      lottery: read.chances,
    });
  }
  return { accounts: rows.length, failed, rows };
}

/**
 * Whether an upstream refusal means "the day was already collected".
 *
 * Matched on the whole sentence, not on the bare word: a token or account
 * refusal often merely contains "already", and counting that as a benign skip
 * hides a real breakage from the last-run line and from the check-in summary
 * the user reads.
 */
function isAlreadyCheckin(error) {
  const message = safeMessage(error).toLowerCase();
  return message.includes("已签到") || message.includes("已经签到")
    || message.includes("already checked in") || message.includes("already signed in")
    || message.includes("already claimed") || message.includes("already received");
}

async function claimAllCheckins() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  // Counted, not flagged, for the reason `claimAllGrowth` documents: a skipped
  // first account must not turn the second one into a burst.
  let seen = 0;
  for (const account of core.pool.list()) {
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // The check-in is the pass that meets a refused sign-in first: the read
    // below is wrapped, so the account is held here and the growth and travel
    // passes that follow skip it without spending a call.
    if (signInRefused(account)) continue;
    // Between accounts, so a stopped service ends the pass rather than walking
    // the rest of the pool into a host that is no longer there.
    if (currentCheckinSignal().aborted) break;
    if (seen > 0) await checkinDelay(CHECKIN_ACCOUNT_DELAY_MS);
    seen += 1;
    try {
      const before = await core.pool.readAfterRefresh(account.id, (credential) =>
        core.client.fetchCheckinStatus(credential));
      if (!before.active) {
        counts.skipped += 1;
        continue;
      }
      if (before.todayCheckedIn) {
        counts.skipped += 1;
        continue;
      }
      await core.client.claimDailyCheckin(account.credential);
      probeCache.delete(account.id);
      counts.claimed += 1;
    } catch (error) {
      if (isAlreadyCheckin(error)) {
        counts.skipped += 1;
        continue;
      }
      counts.failed += 1;
      log("warn", "check-in failed for " + account.label + ": " + safeMessage(error));
    }
  }
  return counts;
}

/**
 * Today's campaign day (CST), for the adopt-threshold memory. Reuses the
 * check-in zone reader: the upstream resets its daily quota at 00:00 CST.
 */
function travelDay() {
  return zonedDayHour(new Date()).day;
}

/**
 * Adopt the first buddy: report (unlocks the task) -> agree -> first.
 *
 * The report failure does not block the chain — the upstream answers 200 yet
 * silently drops a bad report, so buddy/first stays the real gate. A
 * threshold refusal is recorded for the day and retried tomorrow instead of
 * hammering the upstream.
 */
async function travelAdopt(account) {
  const day = travelDay();
  if (travelAdoptTried.get(account.id) === day) return "skipped";
  const conversationId = "wb2api-adopt-" + Date.now();
  try {
    await core.client.reportChatActivity(account.credential, conversationId);
  } catch (error) {
    log("warn", "travel " + account.label + ": adopt preflight report: " + safeMessage(error));
  }
  // The abortable sleep, like every other pacing inside a pass: a service that
  // stops mid-adopt should not sit out the full gap first.
  await checkinDelay(TRAVEL_ADOPT_GAP_MS);
  try {
    await core.client.agreeBuddy(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": agreement: " + safeMessage(error));
    return "failed";
  }
  try {
    await core.client.adoptBuddy(account.credential);
  } catch (error) {
    if (isBuddyThresholdIncomplete(safeMessage(error))) {
      travelAdoptTried.set(account.id, day);
      log("info", "travel " + account.label + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
      return "skipped";
    }
    log("warn", "travel " + account.label + ": adopt: " + safeMessage(error));
    return "failed";
  }
  log("info", "travel " + account.label + ": adopt ok");
  return "adopted";
}

/**
 * One account, one trip: at most one mutating call, no polling, no waiting.
 *
 * Returns what happened so the caller can count it; every failure path logs
 * and returns instead of throwing, so one bad account never stops the rest.
 */
async function travelOne(account) {
  let buddy = null;
  try {
    buddy = await core.client.fetchBuddyInfo(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": buddy-info: " + safeMessage(error));
    return "failed";
  }
  if (buddy === null) return await travelAdopt(account);
  let status = null;
  try {
    status = await core.client.fetchTravelStatus(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": status: " + safeMessage(error));
    return "failed";
  }
  if (status.state === "arrived") {
    if (status.recordId === 0) {
      log("info", "travel " + account.label + ": claim skipped (arrived but no record_id)");
      return "skipped";
    }
    try {
      const reward = await core.client.claimTravelReward(account.credential, status.recordId);
      log("info", "travel " + account.label + ": claim ok record=" + status.recordId + " reward=" + reward);
      return "claimed";
    } catch (error) {
      log("warn", "travel " + account.label + ": claim record=" + status.recordId + ": " + safeMessage(error));
      return "failed";
    }
  }
  if (status.state === "idle") {
    if (status.dailyLimitReached) {
      log("info", "travel " + account.label + ": skip (daily limit reached)");
      return "skipped";
    }
    try {
      await core.client.departTravel(account.credential, 4);
      log("info", "travel " + account.label + ": depart ok location=4");
      return "departed";
    } catch (error) {
      log("warn", "travel " + account.label + ": depart: " + safeMessage(error));
      return "failed";
    }
  }
  if (status.state === "traveling") {
    log("info", "travel " + account.label + ": skip (traveling record=" + status.recordId + ")");
    return "skipped";
  }
  log("info", "travel " + account.label + ": skip (unknown state " + JSON.stringify(status.state) + ")");
  return "skipped";
}

/**
 * Walk every eligible account once. Disabled / removed accounts stay out
 * (removal is already filtered by `list()`); international accounts have no
 * CN task system upstream, so they are skipped without a single call.
 */
async function travelAllAccounts() {
  const counts = { departed: 0, claimed: 0, adopted: 0, failed: 0 };
  // Counted, not flagged: a skipped first account (disabled, the other region,
  // no refresh token) must not decide whether the second one waits.
  let seen = 0;
  for (const account of core.pool.list()) {
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    if (regionOf(account.credential.domain) !== "cn") continue;
    if (!account.credential.refreshToken) continue;
    // Every step of the travel chain reads and mutates on the same credential:
    // a refused sign-in fails the first one and would fail the rest.
    if (signInRefused(account)) continue;
    if (currentCheckinSignal().aborted) break;
    if (seen > 0) await checkinDelay(TRAVEL_ACCOUNT_DELAY_MS);
    seen += 1;
    try {
      const outcome = await travelOne(account);
      if (outcome === "departed" || outcome === "claimed" || outcome === "adopted") {
        counts[outcome === "departed" ? "departed" : outcome === "claimed" ? "claimed" : "adopted"] += 1;
        // The pass changed this account's balance, so its cached probe is stale.
        probeCache.delete(account.id);
      } else if (outcome === "failed") {
        // `travelOne` reports every failure as an outcome rather than throwing,
        // so counting only in the catch below made a round where every request
        // failed read exactly like a round with nothing to do.
        counts.failed += 1;
      }
    } catch (error) {
      // Counted like the other outcomes: logged but left out of the counts, a
      // failed travel round makes the summary say the pass found nothing to do
      // on an account it failed on.
      counts.failed += 1;
      log("warn", "travel failed for " + account.label + ": " + safeMessage(error));
    }
  }
  return counts;
}

/**
 * Claim today's Qoder round for every signed-in Qoder account whose region is
 * switched on. Each account is read first: one that already collected, or that
 * has no claimable round (international without the app's machine identity),
 * costs one GET and no mutation. One account failing never stops the rest.
 */
async function qoderCheckinAll() {
  const counts = { claimed: 0, skipped: 0, failed: 0, retry: false };
  const regions = activeQoderRegions();
  if (regions.length === 0) return counts;
  let found;
  try {
    found = await discoverQoderCredentials();
  } catch (error) {
    // An app directory that cannot be read is this source's failure, not the
    // whole pass's: the other sources' rounds are unaffected by it, and the
    // caller's fan-out used to reject on the throw and lose their counts.
    const reason = safeMessage(error);
    log("warn", "[qoder] check-in could not read its sign-ins: " + reason);
    return { ...counts, failed: 1, reason };
  }
  // An unreadable app directory does not throw; it comes back in `failures`.
  // Counting it keeps the deferred round alive instead of reading the empty
  // credential list as a finished day.
  if (found.failures.length > 0) {
    counts.failed += 1;
    counts.retry = true;
  }
  // Counted, not flagged: an account whose region is switched off must not
  // decide whether the next one waits.
  let seen = 0;
  for (const credential of found.credentials) {
    if (!regions.includes(credential.region)) continue;
    if (currentCheckinSignal().aborted) break;
    if (seen > 0) await checkinDelay(QODER_ACCOUNT_DELAY_MS);
    seen += 1;
    const result = await qoderClaimFor(credential);
    counts[result.outcome] += 1;
    if (result.retry === true) counts.retry = true;
    if (result.opensAt !== undefined && (counts.opensAt === undefined || result.opensAt < counts.opensAt)) {
      counts.opensAt = result.opensAt;
    }
  }
  return counts;
}

/**
 * One Qoder account's daily round: `{outcome, reason?}`.
 *
 * The campaigns read comes first, so an account with nothing claimable (or one
 * that already collected) costs a single GET and no mutation.
 */
async function qoderClaimFor(credential) {
  const client = new QoderUpstreamClient({ region: credential.region, credential: async () => qoderClientCredential(credential) });
  try {
    const campaigns = await client.fetchCampaigns();
    const id = qoderClaimableCampaignIdOf(campaigns);
    if (id === undefined) {
      // Nothing to claim right now. When the next round opens (Qoder issues it
      // at 10:00 Beijing) say so: the automatic pass comes back at that moment
      // instead of leaving the day unclaimed.
      const state = qoderCheckinStateFrom(campaigns);
      return { outcome: "skipped", ...state.opensAt === undefined ? {} : { opensAt: state.opensAt } };
    }
    const result = qoderNormalizeClaimResult(await client.claimCampaign(id));
    if (result.reason !== undefined) {
      // 200 with a business error: a refusal the user has to see, not a
      // "nothing to collect" the panel can report as already done. It is a
      // verdict for this round, not a transient transport failure.
      log("warn", "[qoder:" + credential.region + "] check-in refused for " + qoderRowLabel(credential) + ": " + result.reason);
      return { outcome: "failed", reason: result.reason, retry: false };
    }
    return { outcome: result.claimed && !result.replayed ? "claimed" : "skipped" };
  } catch (error) {
    const reason = safeMessage(error);
    log("warn", "[qoder:" + credential.region + "] check-in failed for " + qoderRowLabel(credential) + ": " + reason);
    return { outcome: "failed", reason, retry: qoderFailureRetryable(error) };
  }
}

/** A transport/5xx failure is worth another tick; a 4xx verdict is not. */
function qoderFailureRetryable(error) {
  const status = Number(/\bHTTP\s+(\d{3})\b/iu.exec(safeMessage(error))?.[1] ?? 0);
  if (status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Claim today's Trae credits for every signed-in CN Trae account. Each account
 * is read first: one already checked in costs a single status call and no
 * mutation. International accounts have no check-in and are never contacted.
 * An expired token is skipped (the desktop app refreshes it while it runs).
 * Accounts are spaced 5 s ± 2 s apart, the pace the endpoint is proven with.
 */
async function traeCheckinAll() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  if (!activeTraeRegions().includes("cn")) return counts;
  const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
  let found;
  try {
    found = await discoverTraeCredentials();
  } catch (error) {
    // Same rule as Qoder's: an unreadable app directory is this source's
    // failure, and a throw here used to take the whole pass - and the other
    // sources' counts - down with it.
    const reason = safeMessage(error);
    log("warn", "[trae:cn] check-in could not read its sign-ins: " + reason);
    return { ...counts, failed: 1, reason };
  }
  const cnCredentials = found.credentials.filter((credential) => traeRegionOfCredential(credential) === "cn");
  let index = 0;
  for (; index < cnCredentials.length; index += 1) {
    if (currentCheckinSignal().aborted) break;
    if (index > 0) await checkinDelay(Math.max(1000, TRAE_ACCOUNT_DELAY_MS + Math.round((Math.random() * 2 - 1) * TRAE_ACCOUNT_JITTER_MS)));
    const result = await traeClaimFor(cnCredentials[index], desktopCandidates);
    counts[result.outcome] += 1;
    // Upstream allows one check-in per device per day, keyed on the x-device-id
    // that every account on this machine shares. Once one account holds it, each
    // remaining account can only be refused 9095, so the batch stops instead of
    // walking the rest into a refusal it already knows the answer to. They are
    // skipped rather than failed: nothing went wrong, the day is simply spent.
    if (result.deviceCheckedIn === true) {
      counts.skipped += cnCredentials.length - index - 1;
      break;
    }
  }
  return counts;
}

/**
 * Why this machine's Trae identity cannot pass the check-in endpoint, probed
 * once per edition.
 *
 * Two shapes are refused. A CLI-derived identity is synthesised from a hash
 * when no desktop storage can be read. And an install holding two
 * device-center ids - two Trae accounts signed in to the same edition - has no
 * persisted device number to send, so the fallback is a hash too. Both arrive
 * as a bare 9074, which told the user nothing they could act on; the suffix
 * names the one thing that fixes each. The desktop read is the same one the
 * client performs a moment later, so on a path that runs once a day per
 * account this costs one file read. Any other failure - a storage file that
 * exists but will not parse - is neither, and surfaces as its own error from
 * the client.
 */
const traeIdentityBlockers = new Map();

async function traeIdentityBlocker(desktopCandidates, edition) {
  if (traeIdentityBlockers.has(edition)) return traeIdentityBlockers.get(edition);
  let blocker = "";
  try {
    const identity = await pickTraeStorageIdentity(desktopCandidates, edition);
    if (identity.deviceIdIsFallback === true) {
      blocker = "this install holds more than one Trae sign-in, so no persisted device id could be sent; sign out of the extra account in the Trae desktop app";
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(TRAE_STORAGE_MISSING_PREFIX)) {
      blocker = "the identity came from the Trae CLI fallback; sign in to the Trae desktop app so a real device id is used";
    }
  }
  traeIdentityBlockers.set(edition, blocker);
  return blocker;
}

/**
 * One Trae check-in refusal as the panel should read it.
 *
 * A refused identity is answered with a bare code, which told the user nothing
 * they could act on. The suffix names the one thing that fixes it: a CLI-only
 * machine's device id is a hash rather than one the Trae apps persisted, and the
 * endpoint answers that with 9074. Asked from both paths that answer a failed
 * check-in — the refusal and the catch — because the read it needs is the same
 * one the client performs a moment later.
 */
async function traeCheckinReason(base, credential, desktopCandidates) {
  // A classification that cannot be made is not worth losing the refusal over.
  const blocker = await traeIdentityBlocker(desktopCandidates, credential.edition).catch(() => "");
  return blocker === "" ? base : base + " - " + blocker;
}

/**
 * One Trae account's daily credits: `{outcome, reason?}`.
 *
 * The status read comes first, so an account that already checked in costs one
 * GET and no mutation. An expired token never reaches the network (the desktop
 * app refreshes it while it runs); international accounts have no check-in and
 * are filtered out by the caller.
 */
async function traeClaimFor(credential, desktopCandidates) {
  const label = traeRowLabel(credential);
  if (sourceCredentialExpired(credential, Date.now())) {
    const reason = "token expired (open Trae to refresh it)";
    log("warn", "[trae:cn] check-in skipped for " + label + ": " + reason);
    return { outcome: "skipped", reason };
  }
  const client = new TraeSoloUpstreamClient({
    credential: async () => credential,
    identity: () => resolveTraeIdentity(desktopCandidates, credential.edition),
  });
  try {
    const status = await client.fetchCheckinStatus();
    // An account whose check-in program is off has nothing to claim. The panel
    // reads the same flag to disable its button, and the WorkBuddy batch gates
    // on `active` too; without this the batch would send a pointless mutation
    // and count a refusal against an account that is simply not enrolled.
    if (status.code === 0 && status.enable === false) return { outcome: "skipped" };
    // The account's own reward for today already exists: nothing to do.
    if (status.code === 0 && status.checkedIn) return { outcome: "skipped" };
    // One check-in per device per day: when this machine already claimed for
    // another account, a claim for this one can only be refused (9095), so it
    // is not sent at all and the card says whose day is spent.
    if (status.code === 0 && status.didCheckedIn) return { outcome: "skipped", deviceCheckedIn: true };
    const claim = status.code === 0 ? await client.claimCheckin() : status;
    if (claim.code === 0) return { outcome: "claimed" };
    // 9095 here is the same device rule, raced: another window (or the Trae app
    // itself) claimed between the read and the write. A benign refusal about
    // the device, not a broken account.
    if (claim.code === TRAE_CHECKIN_DEVICE_CLAIMED) {
      log("info", "[trae:cn] check-in already used by this device for " + label + ": " + safeMessage(claim.message ?? ""));
      return { outcome: "skipped", deviceCheckedIn: true };
    }
    const reason = await traeCheckinReason(
      "code " + claim.code + (claim.message === undefined ? "" : " " + safeMessage(claim.message)),
      credential,
      desktopCandidates,
    );
    log("warn", "[trae:cn] check-in refused for " + label + ": " + reason);
    return { outcome: "failed", reason };
  } catch (error) {
    // The blocker rides along on this path too: a throw is usually the identity
    // read itself failing, which is exactly what the hint explains.
    const reason = await traeCheckinReason(safeMessage(error), credential, desktopCandidates);
    log("warn", "[trae:cn] check-in failed for " + label + ": " + reason);
    return { outcome: "failed", reason };
  }
}

/** The one Trae account a panel row names, or a refusal that says why. */
async function traeClaimOne(label, region) {
  if (region !== "cn") throw panelError("Trae check-in is CN-only", "INVALID");
  const found = await discoverTraeCredentials();
  const credential = found.credentials.find(
    (entry) => traeRowLabel(entry) === label && traeRegionOfCredential(entry) === region,
  );
  if (credential === undefined) throw panelError("unknown Trae account: " + label, "NOT_FOUND");
  const desktopCandidates = traeStorageCandidates().filter((entry) => entry.source === "desktop");
  const result = await traeClaimFor(credential, desktopCandidates);
  if (result.outcome === "failed") throw panelError(result.reason ?? "Trae refused the check-in", "UPSTREAM");
  return result;
}

/** The one Qoder account a panel row names, or a refusal that says why. */
async function qoderClaimOne(label, region) {
  const found = await discoverQoderCredentials();
  const credential = found.credentials.find(
    (entry) => qoderRowLabel(entry) === label && entry.region === region,
  );
  if (credential === undefined) throw panelError("unknown Qoder account: " + label, "NOT_FOUND");
  const result = await qoderClaimFor(credential);
  if (result.outcome === "failed") throw panelError(result.reason ?? "Qoder refused the claim", "UPSTREAM");
  return result;
}

/**
 * One look at the schedule: collect the daily reward when a slot is due.
 *
 * The slot is recorded BEFORE the claim, so a failed pass is not retried all
 * day — the upstream is down or the account is rate-limited, and hammering it
 * would only add noise. Tomorrow's slot is a fresh chance either way.
 */
async function autoCheckinTick(now) {
  if (!autoCheckinEnabled()) return undefined;
  const when = now === undefined ? new Date() : now;
  // A source whose round opens later than the configured hour (Qoder opens at
  // 10:00 Beijing) is collected here, by the same timer, at its opening time.
  if (qoderRetryAt !== 0 && when.getTime() >= qoderRetryAt && activeQoderRegions().length > 0) {
    // Guarded like the slot path below, for the same reason: this branch also
    // fans out over every Qoder account and writes `autoCheckinLast`, so a pass
    // the user started by hand must not run beside it. A growth run is one of
    // those passes, and the abort re-arm below would cut its pacing short. The
    // retry time is left set rather than cleared, so the next tick collects it.
    if (checkinPassRunning || growthPassRunning) {
      log("info", "deferred Qoder check-in deferred: a pass is already running");
      return autoCheckinLast;
    }
    const retryGeneration = loadGeneration;
    checkinPassRunning = true;
    // The same ownership token `runCheckinPass` uses, so a round that outlived
    // its activation still releases the flag when nothing newer has taken it.
    const token = ++checkinPassToken;
    checkinAbort.abort();
    checkinAbort = new AbortController();
    checkinScope.enterWith(checkinAbort.signal);
    // A reload between the pass that scheduled this round and the round itself
    // leaves `autoCheckinLast` empty. The panel still needs a slot to name;
    // the hour the deferred round runs in is the honest one.
    const retrySlot = autoCheckinLast?.slot
      ?? checkinSlotId(zonedDayHour(new Date()).day, zonedDayHour(new Date()).hour);
    try {
      qoderRetryAt = 0;
      const retry = await qoderCheckinAll();
      // A reload during the read leaves this activation without a pass of its
      // own: writing its result back would put a history the new activation
      // never ran into the panel, and steer its timer at a round already tried.
      if (!stillLoaded(retryGeneration)) return autoCheckinLast;
      const now = Date.now();
      const opening = typeof retry.opensAt === "number" && retry.opensAt > now ? retry.opensAt : 0;
      // A round that answered with a failure rather than an opening time is not
      // a round that ran: discovery or a transient per-account failure leaves
      // `failed: 1` and no claim, and clearing the retry time there lost the
      // day's Qoder credits outright. A terminal answer clears it.
      const backoff = Number(retry.failed) > 0
        && (typeof retry.reason === "string" || retry.retry === true)
        ? now + QODER_RETRY_BACKOFF_MS
        : 0;
      qoderRetryAt = opening === 0 ? backoff : backoff === 0 ? opening : Math.min(opening, backoff);
      // A late round adds to the day's earlier claim; replacing the row would
      // drop the morning's count from the panel's total.
      const claimedBefore = Number(autoCheckinLast?.qoder?.claimed) || 0
      autoCheckinLast = {
        ...autoCheckinLast,
        slot: retrySlot,
        ...autoCheckinLast === null ? { workbuddy: false } : {},
        qoder: { ...retry, claimed: claimedBefore + (Number(retry.claimed) || 0) },
        at: new Date().toISOString(),
      };
      // The deferral can outlive this process. Persisting the new retry (or its
      // clearing) is what keeps a reload from either forgetting the round or
      // running one that just finished.
      saveCheckinSlots();
      log("info", "deferred Qoder check-in: " + JSON.stringify(retry));
    } catch (error) {
      // Clearing the retry time before the call is what stops one tick from
      // running the round twice; a throw must not leave it cleared for the rest
      // of the day either, or the round this deferral was owed is never
      // collected. It comes back after a pause rather than at once, so a read
      // that fails every time is not retried every minute, and the reason lands
      // in the log the panel reads instead of vanishing with the throw. A stale
      // activation writes none of it: its book belongs to a load that has
      // already reset.
      if (stillLoaded(retryGeneration)) {
        qoderRetryAt = Date.now() + QODER_RETRY_BACKOFF_MS;
        // The failed retry is this round's outcome only; the day's earlier claim
        // stays in the row the panel totals.
        const claimedBefore = Number(autoCheckinLast?.qoder?.claimed) || 0
        autoCheckinLast = {
          ...autoCheckinLast,
          slot: retrySlot,
          qoder: { claimed: claimedBefore, skipped: 0, failed: 1, reason: safeMessage(error) },
          at: new Date().toISOString(),
        };
        saveCheckinSlots();
        log("warn", "deferred Qoder check-in failed: " + safeMessage(error));
      }
    } finally {
      if (token === checkinPassToken) checkinPassRunning = false;
    }
    if (serviceStopped === false) scheduleRefresh("auto-checkin");
    return autoCheckinLast;
  }
  if (activeRegions().length === 0 && activeQoderRegions().length === 0 && activeTraeRegions().length === 0) return undefined;
  const slot = dueCheckinSlot(when, checkinHours(), autoCheckinSlots);
  if (slot === undefined) return undefined;
  // A pass the user started by hand is already running. The slot stays unclaimed
  // rather than being marked done, so the next tick collects it — the alternative
  // is two passes at once, and the log describing whichever finished last.
  if (checkinPassRunning) {
    log("info", "scheduled check-in deferred: a pass is already running");
    return autoCheckinLast;
  }
  // The same pass "run now" runs, which is what collects
  // the streak bonus. It records the slot and the log, and
  // it owns the re-entry guard, so this tick must not keep a second copy of either.
  return await runCheckinPass({ slot });
}

function startAutoCheckin() {
  if (autoCheckinTimer !== null) return;
  // Double insurance beside onLoad's own checks: a timer armed here after the
  // teardown stopped the previous one would outlive the activation and keep
  // firing passes nothing is serving any more.
  if (serviceStopped) return;
  autoCheckinTimer = setInterval(() => {
    autoCheckinTick().catch((error) => log("warn", "scheduled check-in failed: " + safeMessage(error)));
  }, CHECKIN_POLL_MS);
  // Background duty, so it must never hold the process open.
  if (typeof autoCheckinTimer.unref === "function") autoCheckinTimer.unref();
}

function stopAutoCheckin() {
  if (autoCheckinTimer === null) return;
  clearInterval(autoCheckinTimer);
  autoCheckinTimer = null;
}

/** Follow the switch: one timer exists exactly while automatic check-in is on. */
function applyAutoCheckin() {
  if (autoCheckinEnabled()) startAutoCheckin();
  else stopAutoCheckin();
}

/**
 * Refresh every eligible account's token, by hand.
 *
 * `ensureFresh` decides per account whether an upstream call is needed, so an
 * account whose token still has hours on it costs nothing and an international
 * token that lives a year is never touched. What the pass buys is the account
 * nobody has used since its token expired: without it that account is refreshed
 * by the first request that arrives, which pays the round trip on the user's
 * own turn and, when the refresh token is dead too, fails that turn instead of
 * this one.
 *
 * Disabled and switched-off-region accounts stay out, matching every other
 * pass: a parked account is parked on purpose.
 */
async function keepAliveTokens() {
  const counts = { refreshed: 0, fresh: 0, failed: 0, noToken: 0 };
  for (const account of core.pool.list()) {
    // The service is going away: nothing will read the tokens this refreshes.
    if (serviceStopped) break;
    if (core.pool.isDisabled(account.id)) continue;
    if (!regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    // A sign-in the upstream refused cannot be refreshed: the hold says so, and
    // spending the sweep's one call per account on it would report a failure for
    // a condition the panel already explains.
    if (signInRefused(account)) continue;
    const outcome = await core.pool.ensureFresh(account);
    // The panel has no separate bucket for a refusal: it is a failed refresh
    // just like a timeout, and the sign-in hold explains the difference.
    const bucket = outcome === "refused" ? "failed" : outcome;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

/** Run one keep-alive pass and record it for the panel. */
async function runKeepAlivePass() {
  if (serviceStopped) return null;
  const generation = loadGeneration;
  const counts = await keepAliveTokens();
  // A reload while the pass runs must leave it writing nothing: the flag and the
  // pool it would describe belong to the load that just took over.
  if (stillLoaded(generation)) {
    keepAliveLast = { at: new Date().toISOString(), ...counts };
    scheduleRefresh("keep-alive");
  }
  return counts;
}

/**
 * Re-read the sign-ins on a timer while the service runs.
 *
 * The pool scans at load, when the panel opens and when it runs dry. None of
 * those happens between two account switches in the desktop client, and the
 * global client keeps one live file: the sign-in that was overwritten in that
 * gap was never read, so it could not be archived either. A read this often is
 * what turns "the account I had before" into one the pool still holds.
 *
 * Chained rather than an interval, so a slow walk is followed by one pause
 * instead of a queue of walks on top of each other.
 */
function startAccountWatch() {
  if (accountWatchTimer !== null || serviceStopped) return;
  const read = () => {
    accountWatchTimer = null;
    if (serviceStopped) return;
    if (activeRegions().length > 0) {
      core.pool.scan().catch((error) => log("warn", "account re-read failed: " + safeMessage(error)));
    }
    startAccountWatch();
  };
  accountWatchTimer = setTimeout(read, ACCOUNT_WATCH_MS);
  // Background duty, so it must never hold the process open.
  if (typeof accountWatchTimer.unref === "function") accountWatchTimer.unref();
}

function stopAccountWatch() {
  if (accountWatchTimer === null) return;
  clearTimeout(accountWatchTimer);
  accountWatchTimer = null;
}

/**
 * Bring the declaration up to date BEFORE the host can act on it.
 *
 * Registration is a runtime call and the host serves whatever the last
 * registration said, so publishing at the earliest point the plugin runs means
 * the routes exist before anything can route to them, and the panel says so
 * when the declaration could not be registered.
 *
 * Note this is the only place the roster is fetched during load: opening the
 * panel no longer triggers detection of its own.
 */
async function publishDeclarationEarly() {
  await adoptHostSettings();
  // Disabled is a declaration state too: the host serves whatever the last
  // registration said, so a run that opens no gateway must still erase the rows
  // a previous run left registered - otherwise the picker keeps offering
  // providers whose endpoints this run never bound. With the switch off no
  // region is active, so this is the clearing write.
  if (settings.enabled === false) {
    const cleared = syncDeclaration();
    if (cleared.ok !== true) log("warn", "declaration not cleared: " + String(cleared.error));
    return;
  }
  applySettingsToCore();
  reconcileRuntimes();
  // The other two sources must join the same run's publish: without this their
  // gateways are only reconciled by a background refresh, so a fresh load
  // would declare the WorkBuddy pair alone and the host - which serves the
  // last registration it was given - would never see the other four rows.
  // Bounded like the roster read below: this function exists to publish the
  // declaration early, and a reconciler that stalls must not be what keeps it
  // unpublished. A step that outruns the budget keeps running behind the
  // answer; the refresh after the service start publishes whatever it finished.
  const { left: bootstrapLeft } = budget(LOAD_BOOTSTRAP_BUDGET_MS);
  await settleWithin(reconcileTraeGateways(), bootstrapLeft());
  await settleWithin(reconcileQoderGateways(), bootstrapLeft());
  if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
  await settleWithin(startRuntimes(), bootstrapLeft());
  // Bounded like every other read: a roster that does not answer inside the
  // budget still leaves a declaration to publish - the fallback roster plus
  // the saved selection - while the read it cut short finishes behind the
  // answer and the refresh after the service start repeats it.
  await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
    try {
      await connect(runtime, true);
    } catch (error) {
      runtime.lastError = safeMessage(error);
      log("warn", runtime.region + " failed to start during load: " + runtime.lastError);
    }
  })), LOAD_ROSTER_BUDGET_MS);
  const written = syncDeclaration();
  if (written.ok !== true) log("warn", "declaration not written: " + String(written.error));
  // The count, not the path: the panel footer is the place that says where the
  // plugin lives, and a log line that read "undefined" looked like a broken path.
  else if (written.changed === true) log("info", "declaration updated at load time; " + written.providerCount + " provider(s)");
}

async function onServiceStart() {
  // A stop can land while any await below is open. Everything this hook starts
  // belongs to the activation that asked for it, so every step past an await
  // checks that the activation is still the current one.
  const generation = loadGeneration;
  serviceStopped = false;
  if (warmAbort.signal.aborted) warmAbort = new AbortController();
  await adoptHostSettings();
  if (!stillLoaded(generation)) return;
  if (settings.enabled === false) {
    // Published anyway: a manifest left carrying provider rows would keep the
    // host offering a gateway this run will never start.
    syncDeclaration();
    log("info", "plugin disabled in settings; the provider host stays down");
    return;
  }
  applySettingsToCore();
  reconcileRuntimes();
  // A switch in the client is not a request, so nothing else would re-read the
  // sign-ins before the next one overwrites it.
  startAccountWatch();
  // Bounded like the load path above: this hook finishes what onLoad left
  // behind, and the reconcilers must not be the unbounded part of it.
  const { left: bootstrapLeft } = budget(SERVICE_BOOTSTRAP_BUDGET_MS);
  await settleWithin(reconcileTraeGateways(), bootstrapLeft());
  if (!stillLoaded(generation)) return;
  await settleWithin(reconcileQoderGateways(), bootstrapLeft());
  if (!stillLoaded(generation)) return;
  // The pool scan belongs on this path as well as onLoad's: without it the
  // first chat request pays the whole scan itself, at-rest key fetch included,
  // which is the slowest read this plugin makes. The scan's own in-flight
  // guard collapses this with the one onLoad already started.
  if (activeRegions().length > 0) await settleWithin(core.pool.scan(), bootstrapLeft());
  if (!stillLoaded(generation)) return;
  await settleWithin(startRuntimes(), bootstrapLeft());
  if (!stillLoaded(generation)) return;
  // Concurrent and bounded: the host allows this hook 5 s, and it is the path
  // that finishes what `onLoad` left behind. A gateway whose read is cut short
  // is marked stale by `connect` itself, so the refresh below repeats it.
  await settleWithin(Promise.all(Array.from(runtimes.values()).map(async (runtime) => {
    try {
      // Skip the fetch when onLoad already seeded a fresh roster.
      await connect(runtime, !catalogFresh(runtime));
    } catch (error) {
      runtime.lastError = safeMessage(error);
      log("warn", runtime.region + " failed to start: " + runtime.lastError);
    }
  })), SERVICE_ROSTER_BUDGET_MS);
  if (!stillLoaded(generation)) return;
  syncDeclaration();
  // Warm the auxiliary per-account caches now, so the first panel open can
  // answer from cache instead of waiting on billing detection.
  scheduleRefresh("service-start");
}

async function onServiceStop() {
  serviceStopped = true;
  loadGeneration += 1;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  // The slot is released here as well as by the pass that holds it: a pass
  // suspended in a network await keeps it for up to the remainder of its budget,
  // and the freshly loaded plugin's first background pass was dropped for that
  // whole window while the panel polled for something that was never coming.
  refreshInflight = null;
  stopAutoCheckin();
  stopAccountWatch();
  abortWarmups();
  // A retry that outlived this stop would fire into the activation that follows
  // it and trigger a full refresh pass nobody asked for.
  clearModelRetries();
  // A check-in pass paces its accounts seconds apart and walks a whole pool,
  // so it outlives this teardown: the pacing sleeps wake on the abort and the
  // per-account loops check it, instead of the pass keeping talking to a host
  // that is no longer there. A pass that starts later re-arms the flag.
  checkinAbort.abort();
  const closing = Array.from(runtimes.values()).map(stopRuntime);
  runtimes.clear();
  // A bind still in flight belongs to this activation; its owner releases it
  // through the post-await check in `startRuntimes` or the refresh pass.
  runtimeStarts.clear();
  for (const entry of [...traeGateways.values(), ...qoderGateways.values()]) {
    closing.push(entry.gateway.close().catch((error) => {
      log("warn", "[" + entry.source + ":" + entry.region + "] gateway did not close cleanly: " + safeMessage(error));
    }));
  }
  traeGateways.clear();
  qoderGateways.clear();
  // The failures belong to the activation that produced them: a source reloaded
  // into a working state must not keep reading as failed, and a region whose
  // close above was deliberate is not a drift.
  gatewayStartFailures.clear();
  sourceStartFailures.clear();
  sourceGatewayStarts.clear();
  await Promise.all(closing);
}

async function onLoad() {
  serviceStopped = false;
  // Every pass this activation starts carries this number: bumping it here
  // retires the previous load's in-flight passes, and the teardown paths bump it
  // again so nothing of theirs survives into this one.
  loadGeneration += 1;
  // A reload can arrive without the previous activation's stop. Abort the
  // pass it still has, and close the gateways still bound to its pool.
  // `startRuntimes` waits out these closes before it binds.
  abortWarmups();
  warmAbort = new AbortController();
  checkinAbort.abort();
  checkinAbort = new AbortController();
  stopAutoCheckin();
  stopAccountWatch();
  clearModelRetries();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshInflight = null;
  for (const runtime of runtimes.values()) pendingRuntimeStops.push(stopRuntime(runtime));
  runtimes.clear();
  // Same reason as `onServiceStop`: an in-flight bind belongs to the activation
  // being torn down, and leaving it here would hand the next activation a
  // gateway whose owner is about to close it.
  runtimeStarts.clear();
  sourceGatewayStarts.clear();
  // The Trae and Qoder gateways are deliberately left alone: their options are
  // closures over module-level functions, and closing them here also dropped
  // directories the next warm-up had not yet read back, taking their provider
  // rows out until a later refresh. `onUnload` closes them.
  // A reload is this plugin's restart, so the check-in bookkeeping starts
  // clean: a pass lost to a crash or reload must be re-attempted on the next
  // tick, and every claim re-reads today's state first, so re-running a slot
  // collects only what was never collected. The slots a pass that RAN TO ITS
  // END collected are the exception - they are re-read from disk below, so a
  // restart after the morning hour no longer runs the whole pass again. A
  // stale pass from the previous activation is still running in the
  // background; the generation guards keep its finally from touching these
  // reset values.
  checkinPassRunning = false;
  autoCheckinSlots.clear();
  autoCheckinLast = null;
  // The growth card's own bookkeeping starts clean with the rest: a run lost to
  // the reload is still in flight, and its `finally` clears the flag it took.
  growthPassRunning = false;
  growthLast = null;
  keepAliveLast = null;
  qoderRetryAt = 0;
  // Built before the first await, so the panel routes `apply` registers ahead
  // of this call never see a half-loaded engine: a request that lands between
  // route registration and the settings adoption would otherwise meet a pool
  // that is still undefined. The settings-dependent fields are provisional
  // until then; `adoptHostSettings` re-applies them through
  // `applySettingsToCore` before anything serves.
  // The client is built first because the pool refreshes tokens through it.
  core.client = new WorkBuddyUpstreamClient({});
  core.pool = new WorkBuddyAccountPool({
    client: core.client,
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    // Asked lazily: the host hands out the data path below, after this pool
    // exists, and the archive is only needed once a scan runs.
    dataPath: () => dataPath,
    logger: {
      info: (...args) => log("info", gatewayLogLine("", args)),
      warn: (...args) => log("warn", gatewayLogLine("", args)),
      error: (...args) => log("error", gatewayLogLine("", args)),
    },
  });
  await adoptHostSettings();
  // The teardown can run while this load is still between its awaits. An
  // activation disabled a moment after it started would otherwise register its
  // service and its check-in timer into a load that is already
  // gone, and nothing would ever stop them. Every step past this point is
  // re-checked the same way.
  if (serviceStopped) return;
  // The entry re-publishes the declaration as soon as the gateways come up.
  // `declarationIndex` survives the load so a gateway still warming keeps the
  // roster it last published; the next `syncDeclaration` replaces or filters it.
  publishedIds = new Set();
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch (error) {
    dataPath = "";
    log("warn", "no plugin data path: " + safeMessage(error));
  }
  // Now that the data root is known: the durable record of what today's pass
  // already collected, so a restart does not run it twice. See
  // `loadCheckinSlots`.
  loadCheckinSlots();
  if (serviceStopped) return;
  pi.services.register({ id: SERVICE_ID, start: onServiceStart, stop: onServiceStop });
  // The host pushes a settings document whenever the user edits this plugin in
  // its own settings UI. Without this listener those edits only took effect
  // after a full plugin reload.
  subscribeToHostSettings();
  await publishDeclarationEarly();
}

async function onUnload() {
  // First thing, so any pass already suspended in a network await gives up at
  // its next check instead of re-opening what this teardown is about to close.
  loadGeneration += 1;
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  stopAutoCheckin();
  stopAccountWatch();
  clearModelRetries();
  // Before the gateways close, so a warm-up still in flight stops on the signal
  // rather than on the connection error it would raise from a closed socket.
  abortWarmups();
  // No declaration is written here: the teardown in the entry has already
  // stopped the loader, so a registration from an unloading plugin is refused,
  // and the next load resets the declaration index and republishes anyway.
  await onServiceStop();
  probeCache.clear();
  // The module-level state a load builds is per-load state: a hold, an expiry
  // note or a rotation cursor left behind outlives the sign-ins it was keyed
  // by, and the next load inherits accounts that are not there any more.
  sourceFailureHold.clear();
  sourceCreditExpiry.clear();
  sourceRotation.clear();
  travelAdoptTried.clear();
  traeIdentityBlockers.clear();
  gatewayStartFailures.clear();
  sourceStartFailures.clear();
  sourceGatewayStarts.clear();
  // A sign-in the panel started is process state: a poll arriving after the
  // reload would otherwise be answered with a state this activation never issued.
  deviceLogins.clear();
  unsubscribeFromHostSettings();
}

function composerPointsEnabled() {
  return settings.showComposerPoints === true;
}

/**
 * The source and region one selected provider route belongs to.
 *
 * The composer readout is handed the session's selection straight from the
 * host's `modelSelection` projection, which carries the provider route id and
 * the model id and nothing else - no display name. So the route id is what
 * identifies the source: it is the id this plugin registered the provider under,
 * and the two cannot drift apart the way a printed label can. A route that is
 * not one of ours resolves to nothing and the readout stays hidden.
 */
function composerRoute(provider) {
  const wanted = typeof provider === "string" ? provider.trim() : "";
  if (wanted === "") return undefined;
  for (const region of activeRegions()) {
    if (PROVIDER_ID_BY_REGION[region] === wanted) return { source: "workbuddy", region };
  }
  for (const region of activeTraeRegions()) {
    if (TRAE_PROVIDER_ID_BY_REGION[region] === wanted) return { source: "trae", region };
  }
  for (const region of activeQoderRegions()) {
    if (QODER_PROVIDER_ID_BY_REGION[region] === wanted) return { source: "qoder", region };
  }
  return undefined;
}

/**
 * The row one selected model belongs to.
 *
 * The model id has to be one this plugin actually publishes for that route: the
 * picker keeps offering a model the user has disabled until its discovery cache
 * expires, and reporting an account balance against a model this pool does not
 * serve would be a number with nothing behind it.
 */
function matchComposerModel(args) {
  const route = composerRoute(args?.provider);
  if (route === undefined) return undefined;
  const wanted = typeof args?.model === "string" ? args.model.trim() : "";
  if (wanted === "") return undefined;
  const models = route.source === "workbuddy" ? declarationModels(route.region)
    : route.source === "trae" ? traeDeclarationModels(route.region)
      : qoderDeclarationModels(route.region);
  const hit = models.find((model) => String(model.id || "").trim() === wanted);
  if (hit === undefined) return undefined;
  return { source: route.source, region: route.region, id: wanted };
}

/**
 * The packages the composer chip renders, bounded.
 *
 * The answer crosses the panel relay, which caps one message at 64 KB: an
 * account carrying a dozen expiring packs used to blow past that and the
 * readout answered nothing at all. The chip shows one line per pack - name,
 * remaining, expiry - and nothing else, so the list is capped and only the
 * fields it renders are kept; the rest of a pack is the panel's business, not
 * the popup's.
 *
 * The fields the chip reads through a type check are guarded the same way here,
 * so a pack an upstream spelled wrong arrives without the field rather than with
 * a value the chip would print verbatim.
 */
const COMPOSER_PACKAGE_LIMIT = 8;

function composerPackages(packages) {
  return packages.slice(0, COMPOSER_PACKAGE_LIMIT).map((pack) => ({
    ...pack.packageName === undefined ? {} : { packageName: pack.packageName },
    ...pack.nameKey === undefined ? {} : { nameKey: pack.nameKey },
    ...typeof pack.remain === "number" ? { remain: pack.remain } : {},
    ...pack.monthly === true ? { monthly: true } : {},
    ...pack.neverExpires === true ? { neverExpires: true } : {},
    ...typeof pack.validDays === "number" ? { validDays: pack.validDays } : {},
    ...pack.roundExpiresAtMs === undefined ? {} : { roundExpiresAtMs: pack.roundExpiresAtMs },
    ...pack.expiresAtMs === undefined ? {} : { expiresAtMs: pack.expiresAtMs },
  }));
}

function workbuddyComposerAccounts(region, modelId) {
  const now = Date.now();
  const list = core.pool.list(region);
  const available = core.pool.available(now, modelId, region);
  const preferredId = preferredAccountId(region);
  const preferred = available.find((account) => account.id === preferredId);
  const next = preferred ?? core.pool.preview(available);
  return list.map((account) => {
    const cached = probeCache.get(account.id)?.value?.credits;
    return {
      id: account.id,
      label: account.label,
      active: next !== undefined && next.id === account.id,
      ...typeof cached?.total === "number" ? { total: cached.total } : {},
      ...Array.isArray(cached?.packages) && cached.packages.length > 0 ? { packages: composerPackages(cached.packages) } : {},
    };
  });
}

function sourceComposerAccounts(source, region) {
  const rows = (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region);
  // The account that serves this region is the gateway's own answer, not a second
  // copy of the rule: that order demotes a sign-in the upstream just refused, and
  // a readout built from a different rule named an account the requests were
  // never going to use. Only the sign-ins that can still answer are handed in,
  // because the gateway leads with a live token and an expired one never serves.
  const live = rows.filter((row) => row.expired !== true);
  // "peek" names the account the next chat would use, including the current
  // round-robin position, without advancing it: a panel read must not decide
  // where the next request goes.
  const active = orderSourceCredentials(source, region, live, (row) => row.label, "peek")[0];
  return rows.map((row) => {
    const credits = row.usage?.credits;
    // The label is this source's identity - the preference is stored by label -
    // so the popup's row marking keys on the same value. Without it the client
    // reads an empty id and can never tell which row a notice is about.
    return {
      id: row.label,
      label: row.label,
      active: active !== undefined && active.label === row.label,
      ...typeof credits?.total === "number" ? { total: credits.total } : {},
      ...Array.isArray(credits?.packages) && credits.packages.length > 0 ? { packages: composerPackages(credits.packages) } : {},
      ...row.usage?.plan?.name ? { plan: row.usage.plan.name } : {},
    };
  });
}

/**
 * Cached credits for the model the composer is showing.
 *
 * The answer itself is cache-only, so a poll is cheap. One exception: a stale
 * WorkBuddy probe schedules the background refresh that fills the cache, so
 * the first poll after a load may be what starts the read the later polls
 * answer from.
 *
 * `ours` separates the two reasons there is nothing to show: the selected route
 * is not this plugin's (nothing will ever arrive, so there is nothing to wait
 * for) from the route being ours while a runtime has not declared its roster
 * yet - the balance is still coming. The readout cannot tell them apart from
 * `show` alone, so it is told here rather than left to infer it.
 */
function composerPoints(args) {
  // `enabled` is what lets the readout tell a switched-off feature from another
  // plugin's model: `show: false` alone is indistinguishable from a balance
  // that is still coming.
  if (!composerPointsEnabled()) return { show: false, ours: false, enabled: false };
  const hit = matchComposerModel(args);
  if (hit === undefined) return { show: false, ours: composerRoute(args?.provider) !== undefined, enabled: true };
  if (hit.source === "workbuddy" && probesStale()) scheduleRefresh("composer");
  const accounts = hit.source === "workbuddy"
    ? workbuddyComposerAccounts(hit.region, hit.id)
    : sourceComposerAccounts(hit.source, hit.region);
  const active = accounts.find((account) => account.active === true);
  return {
    show: true,
    ours: true,
    enabled: true,
    source: hit.source,
    region: hit.region,
    label: active?.label || "",
    total: typeof active?.total === "number" ? active.total : null,
    accounts,
  };
}

async function composerPrefer(args) {
  const source = args?.source;
  const region = args?.region;
  const hit = matchComposerModel(args);
  if (hit === undefined || hit.source !== source || hit.region !== region) return { show: false };
  if (source === "workbuddy") {
    const accountId = typeof args?.accountId === "string" ? args.accountId : "";
    if (!REGIONS.includes(region)) return { show: false };
    // A sign-in that is gone is a refusal, exactly as the Trae/Qoder branch below
    // treats it: answering with the current snapshot (`show: true`) made the chip
    // close as though the switch had landed.
    if (accountId !== "" && !core.pool.list(region).some((account) => account.id === accountId)) {
      return { show: false };
    }
    // Inside the write queue, like the panel's own channel: this dictionary is
    // read and written whole, and a composer switch landing beside a panel one
    // used to overwrite it from a snapshot read before the other had saved.
    const written = await mutateSettings("preferredAccountIds", (current) => {
      const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
      if (accountId === "") delete next[region];
      else next[region] = accountId;
      return next;
    });
    if (written !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
    core.pool.prefer(accountId || undefined, region);
    // Listed is not the same as usable. A cooling, switched-off or reserve-held
    // account is still on the card and still clickable, but the pool skips it, so
    // storing the preference changes nothing this session. The choice is still
    // worth storing - it applies the moment the account recovers - and reporting
    // that back is what stops the popup from closing on a click that did not
    // switch anything.
    // Judged against the same question the popup marked the rows with - the
    // roster of this model - so a model-level cooldown reads the same in both
    // places. `undefined` here would call an account servable that the popup
    // has just left unmarked.
    const servable = accountId === ""
      || core.pool.available(Date.now(), hit.id, region).some((account) => account.id === accountId);
    // `saved` separates "the choice is stored and already in force" from
    // "nothing was stored": every refusal returned above, so everything past
    // `saveSettings` succeeded. It is reported separately because the snapshot
    // can be missing for reasons that have nothing to do with the click - the
    // credits chip can be switched off in the panel between the popup's read
    // and this call, leaving an answer with no rows - which a reader would
    // otherwise take for a refusal even though the save landed.
    const answer = composerPoints(args);
    return { ...answer, saved: true, ...(servable ? {} : { unavailable: true }) };
  }
  if (source !== "trae" && source !== "qoder") return { show: false };
  if (!(source === "trae" ? TRAE_REGIONS : QODER_REGIONS).includes(region)) return { show: false };
  const accountLabel = typeof args?.accountLabel === "string" ? args.accountLabel : "";
  if (!sourceAccountMayBePreferred(source, region, accountLabel)) return { show: false };
  // Inside the write queue, for the reason the WorkBuddy branch above documents.
  const written = await mutateSettings("preferredSourceAccounts", (current) => {
    const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
    if (accountLabel === "") delete next[sourceRegionKey(source, region)];
    else next[sourceRegionKey(source, region)] = accountLabel;
    return next;
  });
  if (written !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
  // Same contract as the WorkBuddy branch: past the save the choice is in
  // force, so it is reported as stored. Compare it with the account the
  // gateway would actually pick: a held sign-in still leads when it is the
  // only live one, so being held alone is not unavailable.
  const activeLabel = sourceComposerAccounts(source, region)
    .find((row) => row.active === true)?.label ?? "";
  const servable = accountLabel === "" || activeLabel === accountLabel;
  return { ...composerPoints(args), saved: true, ...(servable ? {} : { unavailable: true }) };
}

export { onLoad, onUnload, onPanelInvoke }

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

import pkg from '../package.json'
import { WorkBuddyAccountPool, candidateAuthDirs } from './accounts'
import {
  WorkBuddyCatalog,
  applyOverride,
  hasOverride,
} from './catalog'
import { createWorkBuddyShim } from './shim'
import { WorkBuddyUpstreamClient, regionOf, isBuddyThresholdIncomplete } from './upstream'
import { promoStatusFor } from './promo'
import { discoverTraeCredentials, traeRegionOfCredential, traeStorageCandidates, traeWindowsAppNames } from './trae-discovery'
import { createTraeGateway } from './trae-gateway'
import { resolveTraeIdentity } from './trae-identity'
import { TraeSoloUpstreamClient, TRAE_CHECKIN_DEVICE_CLAIMED } from './trae-upstream'
import { discoverQoderCredentials } from './qoder-credentials'
import { createQoderGateway } from './qoder-gateway'
import { QoderUpstreamClient, qoderClaimableCampaignIdOf, qoderCheckinStateFrom, qoderNormalizeClaimResult, qoderRewardExpiryMs, qoderRewardValidityDaysOf } from './qoder-client'
import { redactSecrets } from './loopback'
import { pi } from './pi-compat'

/** Read from the package, so this can never drift behind the version it reports. */
const PLUGIN_VERSION = pkg.version as string

/** The one background service this plugin registers. */
const SERVICE_ID = "provider-host";

const COMMAND_OPEN = "xdpool.open";
const COMMAND_RESCAN = "xdpool.rescan";
const COMMAND_RESET = "xdpool.resetCooldowns";
const COMMAND_DOCTOR = "xdpool.doctor";
const COMMAND_CHECKIN = "xdpool.checkin";

/** The two gateways, matching the provider ids this plugin registers. */
const REGIONS = ["cn", "global"];
const PROVIDER_ID_BY_REGION = { cn: "xdpool-cn", global: "xdpool-global" };
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
/** Whether one source is switched on in settings. Unknown sources stay off, so a typo can never enable a gateway. */
function sourceEnabled(source) {
  const key = SOURCE_SETTING_KEYS[source];
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
const TRAE_PROVIDER_ID_BY_REGION = { cn: "xdpool-trae-cn", ai: "xdpool-trae-ai" };
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
const QODER_PROVIDER_ID_BY_REGION = { cn: "xdpool-qoder-cn", global: "xdpool-qoder-global" };
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
const MAX_TOKEN_BUDGET = 0xffffffff;
const CONSERVATIVE_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32000;
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** Used until a shim binds, so a descriptor never carries an empty base URL. */
const PLACEHOLDER_BASE_URL = "http://127.0.0.1:1/v1";

/**
 * How long one account's billing answers (credits, check-in) are reused.
 *
 * The panel renders from these cached answers and they refresh behind the first
 * paint, so opening it never waits on a billing call per account.
 */
const PROBE_TTL_MS = 60000;
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
const REFRESH_HANDOVER_MS = 2000;

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
let dataPath = "";
/** One runtime per gateway: its shim and catalog. */
const runtimes = new Map();
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
 * True while a check-in pass is running, whichever entry point started it.
 *
 * One flag for all three — the scheduled tick, the host command and the panel's
 * "run now" — because two passes writing `autoCheckinLast` would leave the log
 * describing whichever finished last rather than what the user asked for.
 */
let checkinPassRunning = false;
/** Slots this process has collected, as `YYYY-MM-DDTHH` in the campaign's zone. */
const autoCheckinSlots = new Set();
/** The last automatic pass, for the panel's status line. */
let autoCheckinLast = null;
/**
 * When a deferred pass is owed, in ms; 0 = nothing pending.
 *
 * Qoder's daily round only exists from 10:00 Beijing, so an automatic pass at
 * 09:00 cannot collect it. Rather than adding a second timer, this remembers
 * the opening time and the same timer comes back for it then.
 */
let qoderRetryAt = 0;
/**
 * Cat-travel pacing: one pass per account, same throttle as the upstream's own
 * scheduler. A single `travelOne` already fans out to several RPCs, so a tight
 * loop would look like a burst to the upstream.
 */
const TRAVEL_ACCOUNT_DELAY_MS = 800;
/** Pause between two Qoder accounts' check-ins, so a batch does not read as a burst. */
const QODER_ACCOUNT_DELAY_MS = 1000;
/** Trae's check-in pace: 5 s between accounts, ±2 s jitter (the spacing its endpoint is proven with). */
const TRAE_ACCOUNT_DELAY_MS = 5000;
const TRAE_ACCOUNT_JITTER_MS = 2000;
/** Wait after the adopt preflight report before calling buddy/first. */
const TRAVEL_ADOPT_GAP_MS = 1050;
/** Between the check-in burst and the growth burst on the same accounts. */
const GROWTH_AFTER_CHECKIN_MS = 1500;
/** Between one domestic account and the next inside the growth pass. */
const GROWTH_ACCOUNT_DELAY_MS = 400;
/** Account ids that hit the adopt conversation threshold today (CST day). */
const travelAdoptTried = new Map();

/**
 * An error's text with token-shaped content already redacted.
 *
 * Every caller gets this form — log lines, the panel and the doctor report all
 * read the same string — so a credential that reaches an error message cannot
 * end up somewhere it should not, whichever call site forgot to ask for the
 * panel's stricter copy.
 */
function messageOf(error) {
  return redactSecrets(error && error.message ? String(error.message) : String(error));
}

function log(level, message) {
  try {
    console.log("[xdpool] " + level + ": " + message);
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
  return prefix + args.map(messageOf).join(" ");
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
 */
async function saveSettings(patch) {
  try {
    await pi.plugin.setSettings(patch);
    settings = { ...settings, ...patch };
    settingsRevision += 1;
    return true;
  } catch (error) {
    log("warn", "could not save settings: " + messageOf(error));
    return false;
  }
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
  if (serviceStopped) return;
  if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
  settings = { ...settings, ...next };
  settingsRevision += 1;
  applySettingsToCore();
  traeAccountRows = traeAccountRows.filter((row) => regionEnabled("trae", row.region));
  qoderAccountRows = qoderAccountRows.filter((row) => regionEnabled("qoder", row.region));
  // A parked region must lose its gateway now, not at the next refresh: its
  // port would otherwise stay bound and its endpoint would keep serving.
  await reconcileTraeGateways();
  await reconcileQoderGateways();
  syncDeclaration();
  probeCache.clear();
  scheduleRefresh("settings");
  return true;
}

/** Subscribe to the host's settings event, tolerating a host without it. */
function subscribeToHostSettings() {
  settingsChangedHandler = (next) => {
    // Reconciling the gateways awaits, so the promise is handled here rather
    // than returning anything meaningful to the event source.
    onHostSettingsChanged(next)
      .then((applied) => { if (applied) log("info", "settings changed in the host UI; selection re-applied") })
      .catch((error) => log("warn", "applying host settings failed: " + messageOf(error)));
  };
  try {
    if (pi.events && typeof pi.events.on === "function") {
      pi.events.on("plugin:settingsChanged", settingsChangedHandler);
      return true;
    }
  } catch (error) {
    log("warn", "could not subscribe to settings changes: " + messageOf(error));
  }
  settingsChangedHandler = null;
  return false;
}


function cooldownMs() {
  const value = Number(settings.cooldownSeconds);
  if (!Number.isFinite(value) || value <= 0) return 60000;
  return Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.round(value * 1000)));
}

/** `priority` drains one account. An old `balanced` value reads as priority. */
const WORKBUDDY_DISTRIBUTIONS = ["round-robin", "expiry", "sticky"];

function distributionSetting() {
  const value = settings.distribution;
  return WORKBUDDY_DISTRIBUTIONS.includes(value) ? value : "priority";
}

/**
 * The zone the daily check-in hours are read in.
 *
 * The reward windows are defined in Beijing time, so an hour has to mean the
 * same instant on every machine: reading the host's local hour would make "9
 * o'clock" slip by a day on a laptop set to another zone.
 */
const CHECKIN_TIME_ZONE = "Asia/Shanghai";
/** Collected at 09:00 local campaign time unless the user says otherwise. */
const DEFAULT_CHECKIN_HOURS = [9];
/** How often the timer looks for a due slot. A minute is far below one hour. */
const CHECKIN_POLL_MS = 60000;

/** Calendar day and hour of `date` in the check-in zone, as zero-padded strings. */
function zonedDayHour(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHECKIN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? "00" : found.value;
  };
  return { day: pick("year") + "-" + pick("month") + "-" + pick("day"), hour: Number(pick("hour")) };
}

/**
 * Whole hours only, in order. Anything unreadable is dropped rather than
 * guessed at, and an empty list falls back to the default hour: a switch that
 * is on but never fires would be worse than one that picks a sane time.
 */
function normaliseCheckinHours(raw) {
  const hours = [...new Set(raw.map((value) => Math.floor(Number(value))))]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);
  return hours.length === 0 ? [...DEFAULT_CHECKIN_HOURS] : hours;
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
 * The slot to collect right now, or undefined when nothing is due.
 *
 * A slot is `YYYY-MM-DDTHH` in the check-in zone, and an hour is due once its
 * time has passed — catch-up, deliberately: a machine that slept through 09:00
 * still collects when it wakes instead of waiting for tomorrow. The earliest
 * unconsumed hour wins, so two configured hours still give two passes a day.
 */
function checkinSlotId(day, hour) {
  return day + "T" + String(hour).padStart(2, "0");
}

function dueCheckinSlot(now, hours, fired) {
  const { day, hour } = zonedDayHour(now);
  for (const candidate of [...hours].sort((a, b) => a - b)) {
    if (candidate > hour) continue;
    const slot = checkinSlotId(day, candidate);
    if (!fired.has(slot)) return slot;
  }
  return undefined;
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

const sourceCreditExpiry = new Map();

function noteSourceExpiry(source, label, packages) {
  const at = nearestPackExpiry(packages);
  const key = source + "\n" + label;
  if (at === undefined) sourceCreditExpiry.delete(key);
  else sourceCreditExpiry.set(key, at);
}

/** Unknown expiry sorts last, so it never beats a real deadline. */
function packUrgency(source, label, now) {
  const at = sourceCreditExpiry.get(source + "\n" + label);
  return typeof at === "number" && at > now ? at : Infinity;
}

/** Where each source region's rotation stands, advanced once per request. */
const sourceRotation = new Map();

/**
 * A sign-in with no expiry is still usable. Only a timestamp that has passed is dead.
 */
function sourceCredentialExpired(credential, now) {
  return typeof credential.expiresAtMs === "number" && credential.expiresAtMs > 0 && credential.expiresAtMs <= now;
}

/**
 * One source region's credentials, in the order its gateway should try them:
 * the picked account first, then tokens that still work before expired ones.
 *
 * The gateways take the first usable entry and re-read this list per request,
 * so this order is the whole of "which account serves this region" — and
 * putting a live token ahead of a dead one is what keeps a stale sign-in from
 * being the one that answers.
 *
 * A picked account is what the user asked to spend, so it leads in every mode;
 * only "automatic" leaves the choice to the usage mode. Round-robin then walks
 * the list one account per request instead of draining the first one.
 */
function orderSourceCredentials(source, region, credentials, labelOf, rotate) {
  const now = Date.now();
  const stored = preferredSourceAccount(source, region);
  // A stored label only counts while some credential still carries it. The
  // label is the account's own name (`accountName ?? email ?? userId`), so
  // renaming or re-signing in retires it; treating the retired label as a live
  // preference returned here before rotation and the expiry sort could run, and
  // the panel went on showing round-robin while one account served every chat.
  const preferred = stored !== "" && credentials.some((credential) => labelOf(credential) === stored)
    ? stored
    : "";
  const rank = (credential) => {
    const wanted = preferred !== "" && labelOf(credential) === preferred ? 0 : 1;
    const expired = sourceCredentialExpired(credential, now) ? 1 : 0;
    return wanted * 2 + expired;
  };
  const ordered = credentials.slice().sort((left, right) => rank(left) - rank(right));
  if (preferred === "" && sourceDistribution(source) === "expiry") {
    const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
    const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
    live.sort((left, right) => packUrgency(source, labelOf(left), now) - packUrgency(source, labelOf(right), now));
    return live.concat(rest);
  }
  // Rotation may only shuffle the accounts that can still answer: leading with
  // an expired token would spend the request on a failure first.
  const live = ordered.filter((credential) => !sourceCredentialExpired(credential, now));
  if (rotate !== true || preferred !== "" || live.length < 2 || sourceDistribution(source) !== "round-robin") return ordered;
  const key = sourceRegionKey(source, region);
  const step = (sourceRotation.get(key) ?? 0) % live.length;
  sourceRotation.set(key, step + 1);
  const rest = ordered.filter((credential) => sourceCredentialExpired(credential, now));
  return live.slice(step).concat(live.slice(0, step), rest);
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
    if (id !== "" && Number.isFinite(floor) && floor > 0) clean[id] = Math.floor(floor);
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
 * A selection naming no live model is treated as unset, mirroring
 * savedSelectionMatches, so a renamed catalog never empties the group.
 */
function gatewayEnabledIds(key, catalogIds) {
  const enabled = gatewaySelectionFor(key).enabledModelIds;
  if (!Array.isArray(enabled) || enabled.length === 0) return null;
  const known = new Set(catalogIds);
  const kept = enabled.filter((id) => known.has(id));
  return kept.length > 0 ? new Set(kept) : null;
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
  // Field names are the pool's, not the gateways': one model shape means the
  // panel's editor reads a Trae row exactly as it reads a WorkBuddy one.
  return {
    id,
    name: alias ?? nativeName,
    ...alias === undefined ? {} : { alias },
    nativeName,
    contextWindow: Number.isFinite(override.contextWindow) ? override.contextWindow : native.contextWindow,
    maxOutputTokens: Number.isFinite(override.maxOutputTokens) ? override.maxOutputTokens : native.maxTokens,
    nativeContextWindow: native.contextWindow,
    nativeMaxOutputTokens: native.maxTokens,
    supportsImages: typeof override.supportsImages === "boolean" ? override.supportsImages : native.supportsImages,
    nativeSupportsImages: native.supportsImages,
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
 * Trae's internal slots, by the names the IDE gives them.
 *
 * They are the IDE's own, stable across versions, and are what distinguishes a
 * helper slot from a model — a helper sometimes carries a borrowed display name,
 * so the name alone cannot answer it.
 */
const TRAE_INTERNAL_MODEL_IDS = new Set([
  "summary",
  "fast_apply",
  "title_generation",
  "input_optimization",
  "laziness_detection",
]);
/** The same slots, by shape: the placeholders Trae binds at runtime, the helpers it drives, the entries it routes on its own. */
const TRAE_INTERNAL_MODEL_ID_RE = /^(custom_model|search_agent)_|_(subagent|agent)(_|$)|-(for-)?auto$/;

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
  const name = typeof view.name === "string" ? view.name.trim() : "";
  if (name === "" || !/[\p{L}\p{N}]/u.test(name)) return false;
  if (source !== "trae") return true;
  const id = view.id;
  return !TRAE_INTERNAL_MODEL_IDS.has(id) && !TRAE_INTERNAL_MODEL_ID_RE.test(id);
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
  return savedSelectionMatches(region, catalog) ? selectionFor(region) : {};
}

/** True when a gateway's stored selection no longer matches its live roster. */
function selectionStale(region, catalog) {
  return !savedSelectionMatches(region, catalog);
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
 * Wait for `work`, but no longer than `budgetMs`.
 *
 * Resolves to the value when the work finishes in time and `undefined` when the
 * budget runs out. The work is never cancelled - a plugin pass must finish what
 * it started - so the caller's job is to answer on time and let the late result
 * land in whatever cache the panel reads next.
 */
async function settleWithin(work, budgetMs) {
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
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
 * for this session, and the declaration still names the preferred port.
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
  return Math.round(number);
}

/** The models one gateway publishes, after the user's selection is applied. */
function declarationModels(region) {
  const catalog = runtimes.get(region)?.catalog;
  if (!catalog) return [];
  const models = [];
  const seen = new Set();
  for (const model of catalog.visible()) {
    const id = String(model.id || "").trim();
    if (id === "" || id.length > 256 || seen.has(id)) continue;
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
  // One warming or unreachable gateway must not lose its saved roster when a sibling connects.
  const retained = declaredProviders().filter((provider) => activeIds.has(provider.id) && !currentIds.has(provider.id));
  const result = writeDeclaration([...current, ...retained]);
  runtimeState.write = result;
  return result;
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
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[trae:" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[trae:" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[trae:" + region + "] ", args)),
    },
  });
  await gateway.ready;
  const entry = { region, gateway, baseUrl: gateway.baseUrl(), portFallback: bound !== preferred, lastError: "", source: "trae" };
  // Never let the directory read hold up init: the host gives the plugin only
  // seconds to answer it, and a slow or failing directory must not spend that
  // budget. The gateway is listening by now, so the roster lands behind the
  // answer - the message above reports a failure while one lasts, and every
  // refresh asks again.
  // A rejection here would be an unhandled one in the plugin's own process,
  // which is how a plugin dies; the warm-up itself never throws, and this keeps
  // a future edit from turning it into one.
  warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[trae:" + region + "] directory warm-up failed: " + messageOf(error)));
  return entry;
}

/** Start and stop Trae gateways so the map matches the source switch exactly. */
async function reconcileTraeGateways() {
  const generation = loadGeneration;
  if (!stillLoaded(generation)) return;
  const active = activeTraeRegions();
  for (const [region, entry] of Array.from(traeGateways)) {
    if (active.includes(region)) continue;
    traeGateways.delete(region);
    try {
      await entry.gateway.close();
    } catch (error) {
      log("warn", "[trae:" + region + "] gateway did not close cleanly: " + messageOf(error));
    }
  }
  for (const region of active) {
    if (traeGateways.has(region)) continue;
    try {
      const entry = await createTraeRuntime(region);
      if (!stillLoaded(generation) || !activeTraeRegions().includes(region) || traeGateways.has(region)) {
        await entry.gateway.close();
      } else {
        traeGateways.set(region, entry);
      }
    } catch (error) {
      log("warn", "[trae:" + region + "] gateway could not start: " + messageOf(error));
    }
  }
}

/** What a Trae gateway itself reported for one model. */
function traeNativeOf(model) {
  return {
    contextWindow: positiveInteger(model.contextWindow, CONSERVATIVE_CONTEXT_WINDOW),
    maxTokens: positiveInteger(model.maxTokens, DEFAULT_MAX_TOKENS),
    // The directory's own vision flag. An OpenAI image content block goes
    // through this gateway untouched (`prepareSoloBody` keeps the message list,
    // only turning a string into a text block), and a live request with a solid
    // red PNG came back naming the colour - so the flag is published as the
    // directory states it rather than guessed from a model name. A row that
    // states nothing stays false.
    supportsImages: model.supportsImages === true,
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
    if (id === "" || id.length > 256 || seen.has(id)) continue;
    if (enabled !== null && !enabled.has(id)) continue;
    seen.add(id);
    // The stored per-model edits apply here, exactly as they do for WorkBuddy:
    // the panel edits a model and this is what the provider row then declares.
    const view = sourceModelView("trae:" + region, model, traeNativeOf(model));
    // The directory is the IDE's slot table, so it is filtered on the same term
    // the panel's roster is — see `isSelectableSourceModel`.
    if (!isSelectableSourceModel("trae", view)) continue;
    // The levels this model actually advertises. Without them the host opens
    // its whole ladder - including `max`, which Trae has no word for - and the
    // picker would offer choices SOLO ignores.
    const advertised = (model.reasoning ? model.reasoning.supported : [])
      .filter((level) => HOST_THINKING_LEVELS.includes(level));
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
      thinkingLevels: offersThinking(advertised) ? advertised : ["off"],
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
    port: bound,
    logger: {
      info: (...args) => log("info", gatewayLogLine("[qoder:" + region + "] ", args)),
      warn: (...args) => log("warn", gatewayLogLine("[qoder:" + region + "] ", args)),
      error: (...args) => log("error", gatewayLogLine("[qoder:" + region + "] ", args)),
    },
  });
  await gateway.ready;
  const entry = { region, gateway, baseUrl: gateway.baseUrl(), portFallback: bound !== preferred, lastError: "", source: "qoder" };
  // Off the init path for the same reason as Trae's: the directory read must
  // never hold the plugin's answer to the host.
  warmSourceDirectoryAtStartup(entry, warmAbort.signal).catch((error) => log("warn", "[qoder:" + region + "] directory warm-up failed: " + messageOf(error)));
  return entry;
}

/** Start and stop Qoder gateways so the map matches the source switch exactly. */
async function reconcileQoderGateways() {
  const generation = loadGeneration;
  if (!stillLoaded(generation)) return;
  const active = activeQoderRegions();
  for (const [region, entry] of Array.from(qoderGateways)) {
    if (active.includes(region)) continue;
    qoderGateways.delete(region);
    try {
      await entry.gateway.close();
    } catch (error) {
      log("warn", "[qoder:" + region + "] gateway did not close cleanly: " + messageOf(error));
    }
  }
  for (const region of active) {
    if (qoderGateways.has(region)) continue;
    try {
      const entry = await createQoderRuntime(region);
      if (!stillLoaded(generation) || !activeQoderRegions().includes(region) || qoderGateways.has(region)) {
        await entry.gateway.close();
      } else {
        qoderGateways.set(region, entry);
      }
    } catch (error) {
      log("warn", "[qoder:" + region + "] gateway could not start: " + messageOf(error));
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
  };
}

/**
 * Thinking levels one Qoder model may offer, in host order.
 *
 * Qoder's ladder spells "off" as "none", which the host does not use, so the
 * table is filtered to the host's own names first. A row whose catalog entry
 * carries no level table only takes thinking on or off: nothing is declared
 * for it, because inventing a level would promise a control the upstream
 * ignores.
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
    if (id === "" || id.length > 256 || seen.has(id)) continue;
    if (enabled !== null && !enabled.has(id)) continue;
    seen.add(id);
    // The stored per-model edits apply here exactly as they do for WorkBuddy.
    const view = sourceModelView("qoder:" + region, model, qoderNativeOf(model));
    // Same term as the panel's roster, so the two lists cannot drift apart.
    if (!isSelectableSourceModel("qoder", view)) continue;
    const levels = qoderThinkingLevelsFor(model);
    models.push({
      id: view.id,
      name: view.name,
      contextWindow: view.contextWindow,
      maxTokens: view.maxOutputTokens,
      supportsImages: view.supportsImages,
      ...offersThinking(levels) ? { thinkingLevels: levels } : {},
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
      const runtime = await createRuntime(region);
      if (!stillLoaded(generation) || !activeRegions().includes(region) || runtimes.has(region)) {
        await stopRuntime(runtime);
      } else {
        runtimes.set(region, runtime);
      }
    } catch (error) {
      log("warn", "[workbuddy:" + region + "] gateway could not start: " + messageOf(error));
    }
  }));
}

async function stopRuntime(runtime) {
  runtime.retired = true;
  runtime.signedIn = false;
  if (runtime.shim) await runtime.shim.close().catch((error) => {
    log("warn", "[workbuddy:" + runtime.region + "] gateway did not close cleanly: " + messageOf(error));
  });
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
  const account = core.pool.list(runtime.region)[0];
  if (account === undefined) {
    runtime.signedIn = false;
    runtime.lastError = "no " + runtime.region + " WorkBuddy sign-in found";
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
      const models = await core.client.fetchModels(
        account.credential,
        AbortSignal.timeout(MODELS_TIMEOUT_MS),
      );
      if (runtime.retired) return false;
      runtime.catalog.updateFromUpstream(models);
      runtime.catalogFetchedAtMs = Date.now();
    } catch (error) {
      runtime.lastWarning = "model list failed: " + safeMessage(error);
      // Keep the previous roster (or the static fallback) but still honour the
      // saved selection, so this gateway's endpoint keeps publishing exactly
      // the models the user chose even while the upstream is unreachable.
      runtime.catalogFetchedAtMs = Date.now();
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
 * anything it would fill in is missing or stale: a stale model roster, or
 * billing probes that are cold or past their TTL. Scheduling is de-duplicated
 * separately in `scheduleRefresh`, so reporting an in-flight pass here is safe
 * and is what keeps the poll alive until the numbers actually land.
 */
function refreshNeeded() {
  if (serviceStopped) return false;
  if (refreshInflight !== null) return true;
  for (const runtime of runtimes.values()) {
    if (runtime.connecting) return true;
    if (!catalogFresh(runtime)) return true;
  }
  return probesStale();
}

/** True while any pool account's cached billing answers are missing or old. */
function probesStale() {
  const now = Date.now();
  for (const account of core.pool.list()) {
    // A cooling account is never probed (see statusDocument), so it can never
    // have a cache entry: counting it would keep every state call reporting a
    // detection pass in progress while the cooling lasts.
    if (account.cooldownUntilMs > now || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    const cached = probeCache.get(account.id);
    if (cached === undefined || now - cached.atMs >= PROBE_TTL_MS) return true;
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
    refreshAll(reason, false).catch((error) => log("warn", "background refresh failed: " + messageOf(error)));
  }, 0);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();
}

async function refreshRuntime(runtime, reason, force) {
  if (runtime.connecting) return runtime.connecting;
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
 * duplicate the work of the pass a Refresh click just started.
 */
async function refreshAll(reason, force) {
  if (serviceStopped) return await statusDocument({ allowNetwork: false });
  const wantForce = force === true;
  // Collapse onto an in-flight pass, but never let a background pass satisfy a
  // forced one: a Refresh click must still refetch the rosters. The wait is
  // bounded as well - two passes end to end would spend twice the panel budget
  // on one click, and the pass it waits for keeps its own deadline anyway.
  if (refreshInflight !== null) {
    const current = refreshInflight;
    if (!wantForce || current.force) return await current.promise;
    await settleWithin(current.promise.catch(() => {}), REFRESH_HANDOVER_MS);
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
    const deadline = Date.now() + REFRESH_PASS_BUDGET_MS;
    const left = () => Math.max(0, deadline - Date.now());
    await adoptHostSettings();
    if (!stillLoaded(generation)) return stalePass();
    applySettingsToCore();
    // The pool was emptied by a switch-off, so the regions coming back have no
    // accounts to sign their gateways in with. `pool.acquire` scans lazily, but
    // only once a chat request arrives through a gateway - too late to publish a
    // model list, which is what the panel and the picker read.
    if (poolNeedsScan) {
      poolNeedsScan = false;
      await settleWithin(core.pool.scan(), left());
      if (!stillLoaded(generation)) return stalePass();
    }
    for (const region of activeRegions()) {
      if (runtimes.has(region)) continue;
      // Wrapped exactly like `startRuntimes`: `createRuntime` rejects when the
      // shim loses the port race its own reservation opened, and one region
      // losing that race must not skip the other rows of this pass.
      const starting = createRuntime(region);
      let runtime;
      try {
        runtime = await settleWithin(starting, left());
      } catch (error) {
        log("warn", "[" + region + "] gateway could not start: " + messageOf(error));
        continue;
      }
      // A start that outran the budget is not abandoned: its shim binds the
      // port regardless, so leaving it unowned would make every later pass find
      // its own orphan holding the preferred port and report address drift.
      if (runtime === undefined) {
        starting.then((late) => stopRuntime(late)).catch(() => {});
        continue;
      }
      if (!stillLoaded(generation)) {
        stopRuntime(runtime);
        return stalePass();
      }
      // A concurrent creator (a rescan, or the pass this one handed over to),
      // or the region being switched off while `createRuntime` was awaited, may
      // have claimed this region by now. Ours then holds a bound shim that no
      // map or teardown will ever close, so it is stopped here; the map keeps
      // the run that won, exactly as `startRuntimes` resolves the same race,
      // and the rest of this pass goes on with the rows it did win.
      if (!stillLoaded(generation) || !activeRegions().includes(region) || runtimes.has(region)) {
        await stopRuntime(runtime);
        continue;
      }
      runtimes.set(region, runtime);
    }
    // Trae gateways follow the same switch, and are reconciled before the
    // declaration is written so their rows can join this run's publish.
    await settleWithin(reconcileTraeGateways(), left());
    if (!stillLoaded(generation)) return stalePass();
    // Qoder gateways follow the same switch on the same terms.
    await settleWithin(reconcileQoderGateways(), left());
    if (!stillLoaded(generation)) return stalePass();
    // The Trae and Qoder strips list their own local sign-ins, which no pool
    // cache holds; read them here so the panel can show who is found. A failed
    // read leaves the previous list rather than claiming "no sign-in".
    await settleWithin(refreshSourceAccounts(), left());
    if (!stillLoaded(generation)) return stalePass();
    // A gateway whose directory never answered - it failed, or the read that
    // runs behind init is still in flight - is asked again here, so a cold or
    // failing directory recovers on its own instead of being reported for the
    // rest of the process. Gateways that already hold a roster are left
    // alone, and the batch is concurrent, so the cost is one read.
    await settleWithin(Promise.all([...Array.from(traeGateways.values()), ...Array.from(qoderGateways.values())]
      .filter((entry) => entry.lastError !== "" || entry.gateway.models().length === 0)
      .map((entry) => warmSourceDirectory(entry))), left());
    if (!stillLoaded(generation)) return stalePass();
    // Concurrent, not one after the other: two rosters read end to end can
    // spend a whole panel call on their own.
    await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, reason, wantForce))), left());
    if (!stillLoaded(generation)) return stalePass();
    syncDeclaration();
    return await statusDocument({ allowNetwork: true, budgetMs: left() });
  };
  const entry = { force: wantForce, promise: null };
  entry.promise = run();
  refreshInflight = entry;
  try {
    return await entry.promise;
  } finally {
    if (refreshInflight === entry) refreshInflight = null;
  }
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
 * A Trae-generated `username` can read as a stranger (`zhi c cheng`), so the
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
        active: status.enable === true,
        todayCheckedIn: status.checkedIn === true,
        deviceCheckedIn: status.didCheckedIn === true,
        credits: status.credits,
        extraCredits: status.extraCredits,
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
  const nearestExpiryMs = nearestPackExpiry(packages);
  return {
    total: usage.remainingAmount,
    packages,
    ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
  };
}

/** Read one Qoder account's quota and today's campaign, reduced for the card. */
async function qoderRowProbe(credential, previous) {
  if (sourceCredentialExpired(credential, Date.now())) return previous;
  try {
    const client = new QoderUpstreamClient({ region: credential.region, credential: async () => qoderClientCredential(credential) });
    // Usage is the row the card cannot do without. The campaign only answers
    // the check-in state and how long its reward lives, so a campaign failure
    // costs those two and not the whole read.
    const [usage, campaigns] = await Promise.all([
      client.fetchUsage(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)),
      client.fetchCampaigns(AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)).catch(() => undefined),
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
      ...nearestPackExpiry(packages) === undefined ? {} : { nearestExpiryMs: nearestPackExpiry(packages) },
    };
    return {
      ...(credits === undefined ? {} : { usage: { credits } }),
      // The card shows the hour, not the instant: the panel has no timezone of
      // its own, and the campaign clock is Beijing's.
      checkin: {
        ...state,
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
        noteSourceExpiry("trae", label, probe?.usage?.credits?.packages);
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
    log("warn", "listing Trae sign-ins failed: " + messageOf(error));
  }
  try {
    const regions = activeQoderRegions();
    if (regions.length > 0) {
      const found = await discoverQoderCredentials();
      const rows = [];
      // Qoder's probes are paced on purpose, so this one cannot read at once the
      // way Trae's does; it is bounded instead. Past the deadline a row keeps
      // the figures it already has rather than the list being dropped whole.
      const deadline = Date.now() + SOURCE_ACCOUNTS_BUDGET_MS;
      let first = true;
      for (const credential of found.credentials) {
        if (!regions.includes(credential.region)) continue;
        if (!first) await delay(QODER_ACCOUNT_DELAY_MS);
        first = false;
        const label = qoderRowLabel(credential);
        const previous = qoderAccountRows.find((row) => row.label === label && row.region === credential.region);
        const probe = Date.now() < deadline ? await qoderRowProbe(credential, previous) : previous;
        noteSourceExpiry("qoder", label, probe?.usage?.credits?.packages);
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
    log("warn", "listing Qoder sign-ins failed: " + messageOf(error));
  }
}

/** Push the settings that affect discovery, cooldown and the picker. */
function applySettingsToCore() {
  const authFile = typeof settings.authFile === "string" ? settings.authFile.trim() : "";
  core.pool.applyConfig({
    authDirs: authFile === "" ? candidateAuthDirs() : [path.dirname(authFile)],
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

/** The message as the panel and the report show it: redacted and bounded. */
function safeMessage(error) {
  return messageOf(error).slice(0, 500);
}

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
async function accountProbe(account, allowNetwork) {
  const cached = probeCache.get(account.id);
  if (allowNetwork !== true) {
    return cached === undefined ? { pending: true } : cached.value;
  }
  if (cached !== undefined && Date.now() - cached.atMs < PROBE_TTL_MS) return cached.value;
  const value = {};
  try {
    const credits = await core.client.fetchCredits(account.credential);
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
  try {
    const checkin = await core.client.fetchCheckinStatus(account.credential);
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
  probeCache.set(account.id, { atMs: Date.now(), value });
  return value;
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
    const namesNext = distributionSetting() === "priority" || distributionSetting() === "expiry";
    const nextUp = preferred ?? (namesNext ? core.pool.preview(available) : undefined);
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
        ...account.credential.nickname === undefined ? {} : { nickname: account.credential.nickname },
        region,
        domain: account.credential.domain,
        ...account.credential.expiresAtMs === 0
          ? {}
          : { expiresAt: new Date(account.credential.expiresAtMs).toISOString() },
        cooling,
        ...cooling ? { cooldownUntil: new Date(account.cooldownUntilMs).toISOString() } : {},
        ...modelCooldowns.length === 0 ? {} : { modelCooldowns },
        rateLimitHits: account.rateLimitHits,
        active: runtimeNextUpId.get(region) === account.id,
        preferred: preferredAccountIds[region] === account.id,
        disabled: core.pool.isDisabled(account.id),
        ...creditReserves()[account.id] === undefined ? {} : { creditReserve: creditReserves()[account.id] },
      };
      // Credits and check-in are read behind the row, not inside it: the batch
      // runs after every row is built, so one account's read cannot hold up the
      // next one's (see below).
      if (!cooling) {
        pendingProbes.push(accountProbe(account, allowNetwork).then((probe) => {
          applyProbe(row, probe);
        }));
      }
      accounts.push(row);
    }

    const catalog = runtimes.get(region)?.catalog;
    if (catalog) {
      const selection = effectiveSelectionFor(region, catalog);
      const enabled = selection.enabledModelIds;
      const overrides = selection.overrides || {};
      for (const model of catalog.current()) {
        const override = overrides[model.id];
        const effective = applyOverride(model, override);
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
  // they are bounded: the panel bridge imposes no call-length cap, so the batch
  // carries the plugin's own cap, and one account's two reads each have their
  // own bound. A read that outlives the cap still lands in the cache, which is
  // what lets the panel come back with the numbers on its next pass instead of
  // losing them.
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
        lastError: entry.lastError,
        roster: sourceRosterFor("trae:" + entry.region, entry.gateway.models(), traeNativeOf),
        selection: gatewaySelectionFor("trae:" + entry.region),
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
        // The panel reads this for Qoder exactly as it does for Trae, so an
        // unreachable directory has to reach the card here too, not only on the
        // other source.
        lastError: entry.lastError,
        roster: sourceRosterFor("qoder:" + entry.region, entry.gateway.models(), qoderNativeOf),
        selection: gatewaySelectionFor("qoder:" + entry.region),
      })),
    },
    enabled: settings.enabled !== false,
    pluginVersion: pluginVersion(),
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

function pluginVersion() {
  return PLUGIN_VERSION;
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
 * A run that fell back to an ephemeral port counts as drift even though the
 * declaration still names the preferred port, because until the plugin is
 * reloaded nothing answers on the published address.
 *
 * Trae and Qoder are read the same way as WorkBuddy: they reserve a preferred
 * port on the same terms, so they drift the same way.
 */
function addressDrift() {
  for (const region of activeRegions()) {
    if (runtimes.get(region)?.portFallback === true) return true;
    const published = declaredBaseUrl(region);
    const bound = shimInfo(region).baseUrl;
    if (published === undefined || bound === undefined) continue;
    if (published !== bound) return true;
  }
  for (const entry of Array.from(traeGateways.values())) {
    if (entry.portFallback === true) return true;
    const published = declaredSourceBaseUrl(entry, TRAE_PROVIDER_ID_BY_REGION);
    if (published !== undefined && !samePublishedAddress(published, entry.baseUrl)) return true;
  }
  for (const entry of Array.from(qoderGateways.values())) {
    if (entry.portFallback === true) return true;
    const published = declaredSourceBaseUrl(entry, QODER_PROVIDER_ID_BY_REGION);
    if (published !== undefined && !samePublishedAddress(published, entry.baseUrl)) return true;
  }
  return false;
}


/** Trae discovery for the doctor: count only, never token material. */
async function traeDoctorDetail() {
  if (!sourceEnabled("trae")) return "switched off in plugin settings (deliberate; not a failure)";
  try {
    const found = await discoverTraeCredentials();
    if (found.credentials.length === 0) {
      return "on; no Trae sign-in found (sign in to Trae CN / TRAE SOLO CN, then run the check again)";
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      const region = traeRegionOfCredential(credential);
      byRegion[region] = (byRegion[region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable file(s)` : "";
    const served = activeTraeRegions()
      .map((region) => `${region}: ${traeDeclarationModels(region).length} model(s)`)
      .join(", ");
    return `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`;
  } catch (error) {
    // Same rule as the declaration write: an fs error quotes the absolute
    // app-data path it hit, and the report is copyable from the panel.
    return `on; discovery failed (${errorCodeOf(error)})`;
  }
}

/** Qoder credentials for the doctor: count only, never token material. */
async function qoderDoctorDetail() {
  if (!sourceEnabled("qoder")) return "switched off in plugin settings (deliberate; not a failure)";
  try {
    const found = await discoverQoderCredentials();
    if (found.credentials.length === 0) {
      const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
      return `on; no Qoder sign-in found (sign in to Qoder, then run the check again)${failures}`;
    }
    const byRegion = {};
    for (const credential of found.credentials) {
      byRegion[credential.region] = (byRegion[credential.region] || 0) + 1;
    }
    const parts = Object.entries(byRegion).map(([region, count]) => `${region} x${count}`).join(", ");
    const failures = found.failures.length > 0 ? `; ${found.failures.length} unreadable app dir(s)` : "";
    // Same contract as Trae's: report what is actually served now, not a bare count.
    const served = activeQoderRegions()
      .map((region) => `${region}: ${qoderDeclarationModels(region).length} model(s)`)
      .join(", ");
    return `on; ${found.credentials.length} account(s) (${parts})${failures}; serving ${served}`;
  } catch (error) {
    return `on; discovery failed (${errorCodeOf(error)})`;
  }
}

/** A readable report of everything that has to hold for a chat to reach upstream. */
async function doctor() {
  // The check reads both strips' sign-in lists and probes every pool account,
  // so it is capped as a whole like the other wide passes. Findings that did
  // not arrive in time are simply absent from the report rather than making the
  // check itself run past the host's budget.
  const deadline = Date.now() + PANEL_STEP_BUDGET_MS;
  const left = () => Math.max(0, deadline - Date.now());
  const status = await settleWithin(statusDocument({ allowNetwork: true, budgetMs: left() }), left())
    ?? await statusDocument({ allowNetwork: false });
  const findings = [];
  const push = (id, ok, detail) => findings.push({ id, ok, detail });

  push("plugin-enabled", status.enabled, status.enabled ? "enabled" : "disabled in plugin settings");
  push("source-workbuddy", true, status.sources.workbuddy === true ? "on" : "switched off in plugin settings (deliberate; not a failure)");
  // Reading a source's sign-ins is the slow part of the check, and each read
  // carries its own bound; the deadline above is what keeps the check whole.
  push("source-trae", true, await settleWithin(traeDoctorDetail(), left()) ?? "on; still reading this source's sign-ins");
  push("source-qoder", true, await settleWithin(qoderDoctorDetail(), left()) ?? "on; still reading this source's sign-ins");
  push(
    "accounts",
    status.sources.workbuddy !== true || status.accounts.length > 0,
    status.sources.workbuddy !== true
      ? "WorkBuddy source is switched off; nothing is scanned or served"
      : status.accounts.length === 0
        ? "no WorkBuddy sign-in found; sign in to the desktop app, then detect accounts again"
        : status.accounts.length + " account(s): " + status.accounts.map((account) => account.label).join(", "),
  );
  const healthy = status.accounts.filter((account) => !account.cooling).length;
  push("rotation", status.sources.workbuddy !== true || healthy > 0, status.sources.workbuddy !== true ? "switched off; nothing to rotate" : healthy + " of " + status.accounts.length + " account(s) can serve a request now");

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
    push(label + ": endpoint", info.running, info.running ? "listening on " + info.baseUrl : "not listening");
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
  for (const region of activeRegions()) {
    const runtime = runtimes.get(region);
    const published = declaredBaseUrl(region);
    const bound = runtime?.baseUrl;
    if (published === undefined || bound === undefined) continue;
    const fallback = runtime?.portFallback === true;
    if (published === bound && !fallback) {
      push(
        PROVIDER_NAME_BY_REGION[region] + ": published address",
        true,
        "matches the endpoint this gateway bound (" + bound + ")",
      );
      continue;
    }
    const detail = fallback
      ? "port " + preferredPort(region) + " is held by another process, so this session serves " +
        bound + " - free that port (usually a leftover plugin process), then reload the plugin"
      : "the published address is " + published + " but this gateway is on " + bound
        + " - reload the plugin so the host picks the new address up";
    push(PROVIDER_NAME_BY_REGION[region] + ": published address", false, detail);
  }

  // Trae and Qoder reserve a preferred port on the same terms, so they can drift
  // the same way. Reporting only WorkBuddy left every Trae and Qoder provider
  // row broken while the report said everything passed.
  for (const [gateways, idByRegion, nameByRegion, ports] of [
    [traeGateways, TRAE_PROVIDER_ID_BY_REGION, TRAE_PROVIDER_NAME_BY_REGION, TRAE_PORTS],
    [qoderGateways, QODER_PROVIDER_ID_BY_REGION, QODER_PROVIDER_NAME_BY_REGION, QODER_PORTS],
  ]) {
    for (const entry of Array.from(gateways.values())) {
      const published = declaredSourceBaseUrl(entry, idByRegion);
      const bound = entry.baseUrl;
      const label = nameByRegion[entry.region];
      if (published === undefined || bound === undefined) continue;
      const fallback = entry.portFallback === true;
      if (samePublishedAddress(published, bound) && !fallback) {
        push(label + ": published address", true, "matches the endpoint this gateway bound (" + bound + ")");
        continue;
      }
      const detail = fallback
        ? "port " + ports[entry.region] + " is held by another process, so this session serves " +
          bound + " - free that port (usually a leftover plugin process), then reload the plugin"
        : "the published address is " + published + " but this gateway is on " + bound
          + " - reload the plugin so the host picks the new address up";
      push(label + ": published address", false, detail);
    }
  }

  push(
    "declaration-written",
    runtimeState.write.ok === true,
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

// -------------------------------------------------------------------- panel

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
      ids.push(entry);
    }
    out.enabledModelIds = ids;
  }
  const overrides = body.overrides;
  if (overrides !== undefined) {
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return undefined;
    // Null prototype: `map["__proto__"] = …` on a plain object assigns the
    // prototype instead of the entry, so that id reported a successful save and
    // stored nothing.
    const map = Object.create(null);
    for (const [id, raw] of Object.entries(overrides)) {
      if (typeof id !== "string" || id === "") return undefined;
      const parsed = parseOverride(raw);
      if (parsed === undefined) return undefined;
      // A field left at its catalog value is stored as absent, so the settings
      // file records only what the user actually changed.
      if (Object.keys(parsed).length > 0) map[id] = parsed;
    }
    out.overrides = map;
  }
  return out;
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
        return { ...refreshed, refreshing: false };
      }
      const document = await statusDocument({ allowNetwork: false });
      const refreshing = refreshNeeded();
      if (refreshing) scheduleRefresh("panel");
      return { ...document, refreshing };
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
      const deadline = Date.now() + RESCAN_BUDGET_MS;
      const left = () => Math.max(0, deadline - Date.now());
      // The scan and the gateway starts are inside the same deadline: a scan
      // may refresh tokens over the network, and a gateway's `ready` is
      // unbounded, so without this a slow disk or vendor could spend the whole
      // budget before the first roster read even starts. A scan that outruns
      // the deadline keeps running and lands on a later read; the gateways it
      // would have started come up on the next pass.
      if (activeRegions().length > 0) await settleWithin(core.pool.scan(), left());
      await settleWithin(startRuntimes(), left());
      // Trae/Qoder sign-ins are read from their own app files, not from a pool
      // cache, so a deliberate re-scan has to re-read them as well: a login made
      // while the panel was open must appear on this button too, not only on
      // Refresh or after the next timed pass.
      await settleWithin(refreshSourceAccounts(), left());
      // Concurrent, as in the refresh pass: end to end, two rosters read can
      // spend a whole panel call on their own.
      await settleWithin(Promise.all(Array.from(runtimes.values()).map((runtime) => refreshRuntime(runtime, "rescan", true))), left());
      syncDeclaration();
      return await statusDocument({ allowNetwork: true, budgetMs: left() });
    }

    case "xd.resetCooldowns":
      core.pool.resetCooldowns();
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
      // The two reads inside carry their own 30 s bound each, which is a whole
      // panel budget apiece; the step is capped as a whole instead and says so
      // when it runs out rather than leaving the button spinning.
      const work = async () => {
        const before = await core.client.fetchCheckinStatus(account.credential);
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
      const answered = await settleWithin(work(), PANEL_STEP_BUDGET_MS);
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
      const all = { ...(settings.modelSelection || {}) };
      all[requested] = selection;
      const stored = await saveSettings({ modelSelection: all });
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
      const preferredAccountIds = {};
      for (const key of REGIONS) {
        const current = preferredAccountId(key);
        if (current !== undefined) preferredAccountIds[key] = current;
      }
      if (accountId === "") delete preferredAccountIds[region];
      else preferredAccountIds[region] = accountId;
      const stored = await saveSettings({ preferredAccountIds });
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
      const states = ["enabled", "disabled", "removed", "restored"];
      if (!REGIONS.includes(region) || typeof accountId !== "string" || accountId === "" || !states.includes(state)) {
        throw panelError("region, accountId and a known state are required", "INVALID");
      }
      const account = core.pool.list(region).find((item) => item.id === accountId);
      const stored = removedAccounts().find((entry) => entry.id === accountId);
      if (state !== "restored" && account === undefined && stored === undefined) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }

      const disabled = disabledAccountIds().filter((id) => id !== accountId);
      if (state === "disabled") disabled.push(accountId);
      const removed = removedAccounts().filter((entry) => entry.id !== accountId);
      if (state === "removed") {
        removed.push({
          id: accountId,
          label: account === undefined ? stored.label : account.label,
          region,
        });
      }

      const written = await saveSettings({ disabledAccountIds: disabled, removedAccounts: removed });
      if (written !== true) throw panelError("the account setting could not be saved", "SAVE_FAILED");
      core.pool.applyConfig({ disabledAccountIds: disabled });
      core.pool.applyRemoved(removed.map((entry) => entry.id));
      // An account that is switched off or gone must not stay the preferred
      // one: the pool would keep asking for an id it cannot hand out.
      if (accountId !== "" && preferredAccountId(region) === accountId && state !== "enabled" && state !== "restored") {
        const nextPreferred = {};
        for (const key of REGIONS) {
          const current = preferredAccountId(key);
          if (current !== undefined && !(key === region && current === accountId)) nextPreferred[key] = current;
        }
        await saveSettings({ preferredAccountIds: nextPreferred });
        core.pool.prefer(undefined, region);
      }
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
      if (!Number.isFinite(reserve) || reserve < 0) {
        throw panelError("reserve must be a number of credits, 0 or more", "INVALID");
      }
      if (!core.pool.list(region).some((account) => account.id === accountId)) {
        throw panelError("account does not belong to this gateway", "NOT_FOUND");
      }
      const next = { ...creditReserves() };
      if (reserve === 0) delete next[accountId];
      else next[accountId] = Math.floor(reserve);
      const written = await saveSettings({ creditReserves: next });
      if (written !== true) throw panelError("the reserve could not be saved", "SAVE_FAILED");
      core.pool.applyConfig({ creditReserves: next });
      // The account may have just become unusable or usable again: say so on the
      // next document instead of leaving a stale "next up".
      return await statusDocument({ allowNetwork: false });
    }

    /** One click for every account's daily reward, as the command palette does.
     *  With `source`, only that source's pool runs — each source has its own
     *  check-in pool in the panel, so one button must not sweep the others. */
    case "xd.checkinAll": {
      const source = typeof payload?.source === "string" ? payload.source : "";
      const want = (name) => source === "" || source === name;
      // The same flag the scheduled pass and the host command use. Without it a
      // click here runs a second pass beside the one already going - over the
      // same accounts, both writing `autoCheckinLast` - which is the symptom
      // `runCheckinPass` documents as fixed. The answer is the same shape a
      // truncated pass gets, so the panel says one is running rather than
      // reading the missing counts as "everything was already collected".
      if (checkinPassRunning) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      const passGeneration = loadGeneration;
      checkinPassRunning = true;
      // Concurrent where the sources are independent, and bounded like every
      // other network pass here: a pass that outruns the budget keeps going and
      // says so, rather than the host cutting the call off mid-flight.
      // A failure and a timeout are different answers: the panel waits for a
      // background pass to finish, but nothing is running after a failure, so
      // the two must not collapse into the same "no result".
      const failed = { failed: true }
      const finished = (async () => {
        try {
          const [pool, travel, qoder, trae] = await Promise.all([
            want("workbuddy") ? claimAllCheckins() : Promise.resolve({ claimed: 0, skipped: 0, failed: 0 }),
            want("workbuddy") ? travelAllAccounts() : Promise.resolve(undefined),
            want("qoder") ? qoderCheckinAll() : Promise.resolve(undefined),
            want("trae") ? traeCheckinAll() : Promise.resolve(undefined),
          ]);
          return { ...pool, travel, qoder, trae };
        } finally {
          // Released when the fan-out itself settles, not when this call
          // answers: a pass that outran the budget is still running, and the
          // flag has to cover it for as long as that is true. A reload in
          // between hands the flag to the new activation's onLoad, so this
          // pass may only clear what is still its own.
          if (stillLoaded(passGeneration)) checkinPassRunning = false;
        }
      })().catch((error) => {
        log("warn", "check-in pass failed: " + messageOf(error));
        return failed;
      });
      const counts = await settleWithin(finished, CHECKIN_BUDGET_MS);
      if (counts === undefined) {
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), running: true };
      }
      if (counts === failed) throw panelError("the check-in pass failed; the reason is in the plugin log", "UPSTREAM");
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
      // Capped as a whole, like the pool's own check-in: the claim re-reads the
      // status first and each read carries a 30 s bound of its own.
      const answered = await settleWithin((async () => {
        const outcome = source === "trae" ? await traeClaimOne(label, region) : await qoderClaimOne(label, region);
        return { state: await statusDocument({ allowNetwork: true, budgetMs: DOCUMENT_BUDGET_MS }), result: outcome };
      })(), PANEL_STEP_BUDGET_MS);
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
      const next = { ...(settings.preferredSourceAccounts ?? {}) };
      if (label === "") delete next[sourceRegionKey(source, region)];
      else next[sourceRegionKey(source, region)] = label;
      const stored = await saveSettings({ preferredSourceAccounts: next });
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
      const requested = payload?.distribution;
      const next = SOURCE_DISTRIBUTIONS.includes(requested) ? requested : "priority";
      const stored = await saveSettings({ sourceDistributions: { ...(settings.sourceDistributions ?? {}), [source]: next } });
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
      const parked = disabledRegionKeys().filter((entry) => entry !== key);
      if (payload?.enabled !== true) parked.push(key);
      const stored = await saveSettings({ disabledRegions: parked });
      if (stored !== true) {
        throw panelError("the region switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      await onHostSettingsChanged({});
      if (payload?.enabled === true) await refreshAll("region-on", true);
      else syncDeclaration();
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
      const key = typeof payload?.source === "string" ? SOURCE_SETTING_KEYS[payload.source] : undefined;
      if (key === undefined) throw panelError("unknown source", "UNSUPPORTED");
      const stored = await saveSettings({ [key]: payload?.enabled === true });
      if (stored !== true) {
        throw panelError("the source switch could not be written to the plugin settings file", "SAVE_FAILED");
      }
      // Settings drive everything downstream: reconcile the gateways, re-apply
      // the timers and republish, exactly as a host-driven change would.
      await onHostSettingsChanged({});
      if (payload?.enabled === true) await refreshAll("source-on", true);
      else syncDeclaration();
      return await statusDocument({ allowNetwork: false });
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
     * this channel is the one the click is allowed to wait on.
     */
    case "xd.composerRefresh": {
      const hit = matchComposerModel(payload);
      if (hit === undefined) return composerPoints(payload);
      if (hit.source === "workbuddy") {
        for (const account of core.pool.list(hit.region)) probeCache.delete(account.id);
        await settleWithin(statusDocument({ allowNetwork: true, budgetMs: PANEL_STEP_BUDGET_MS }), PANEL_STEP_BUDGET_MS);
      } else {
        const rows = hit.source === "trae" ? traeAccountRows : qoderAccountRows;
        const found = hit.source === "trae" ? await discoverTraeCredentials() : await discoverQoderCredentials();
        // One bounded probe per account, and no shared budget, is minutes on a
        // machine with several sign-ins - and nothing in DSH caps a panel call,
        // so the bound has to live here. Past it a row keeps the figures the
        // popup is already showing; the readout polls on, so a late probe still
        // lands on the next poll rather than being lost.
        const deadline = Date.now() + SOURCE_ACCOUNTS_BUDGET_MS;
        for (const row of rows) {
          if (row.region !== hit.region) continue;
          if (Date.now() >= deadline) break;
          const credential = found.credentials.find((item) => {
            const itemLabel = hit.source === "trae" ? traeRowLabel(item) : qoderRowLabel(item);
            const itemRegion = hit.source === "trae" ? traeRegionOfCredential(item) : item.region;
            return itemLabel === row.label && itemRegion === row.region;
          });
          if (credential === undefined) continue;
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

async function registerCommands() {
  const register = async (id, title, keywords, run) => {
    try {
      await pi.commands.register({ id, title, category: "Productivity", keywords, run });
    } catch (error) {
      log("warn", "could not register command " + id + ": " + messageOf(error));
    }
  };
  await register(COMMAND_OPEN, "WTQ Pool: Open Panel", ["workbuddy", "pool", "池", "模型"], async () => {
    await pi.ui.openPanel();
  });
  await register(COMMAND_RESCAN, "WTQ Pool: Detect Accounts Again", ["workbuddy", "rescan", "重新检测"], async () => {
    const state = await onPanelInvoke("xd.rescan", {});
    await pi.ui.showToast("WTQ Pool - " + state.accounts.length + " account(s) in the pool", "info");
  });
  await register(COMMAND_RESET, "WTQ Pool: Clear All Cooldowns", ["workbuddy", "cooldown", "清除冷却"], async () => {
    core.pool.resetCooldowns();
    await pi.ui.showToast("WTQ Pool - all cooldowns cleared", "info");
  });
  await register(COMMAND_DOCTOR, "WTQ Pool: Run Connection Check", ["workbuddy", "doctor", "诊断"], async () => {
    const result = await doctor();
    await pi.ui.showToast(
      result.ok ? "WTQ Pool check passed" : "WTQ Pool check found problems - see the panel",
      result.ok ? "info" : "warn",
    );
  });
  await register(COMMAND_CHECKIN, "WTQ Pool: Daily Check-in (All Accounts)", ["workbuddy", "trae", "qoder", "checkin", "签到"], async () => {
    // One pass over every source's accounts is minutes on a machine with several
    // sign-ins, and a command answers on a budget. So the pass starts now, the
    // command answers as soon as the numbers exist or the budget ends, and a pass
    // still running reports itself when it finishes - the numbers are the only
    // reason the user asked for it. The same pass the scheduler and the panel run,
    // so a second entry point cannot start a parallel one.
    const finished = runCheckinPass().then((result) => checkinSummaryText(result));
    const summary = await settleWithin(finished, CHECKIN_BUDGET_MS);
    if (summary !== undefined) {
      await pi.ui.showToast(summary, "info");
      return;
    }
    await pi.ui.showToast("dsh-wtq-pool - check-in running in the background", "info");
    finished
      .then((late) => pi.ui.showToast(late, "info"))
      .catch((error) => log("warn", "background check-in failed: " + messageOf(error)));
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
  const generation = loadGeneration;
  if (checkinPassRunning) return { running: true };
  checkinPassRunning = true;
  // A scheduled tick hands in the slot it already decided was due. A hand-started
  // pass must consult the slots already recorded: ignoring them always named the
  // earliest hour of the day, so an evening "run now" re-marked the morning and
  // left the evening slot for the next tick, which ran the whole pass again.
  const zoned = zonedDayHour(new Date());
  const slot = typeof options?.slot === "string" && options.slot !== ""
    ? options.slot
    : dueCheckinSlot(new Date(), checkinHours(), autoCheckinSlots)
      ?? checkinSlotId(zoned.day, zoned.hour);
  const started = { slot, claimed: 0, pending: true, at: new Date().toISOString(), ...manual ? { manual: true } : {} };
  autoCheckinLast = started;
  // Recorded up front, not after the pass: a pass that runs long must not be
  // started again by the next tick. A manual run spends the hour that is due
  // now — pressing "run now" at 09:10 is that morning's pass, and at 21:10 it
  // is the evening's, not another copy of the morning.
  autoCheckinSlots.add(slot);
  scheduleRefresh(manual ? "manual-checkin" : "auto-checkin");
  try {
    // Concurrent where the sources are independent, which is what the host
    // command has always done: Trae alone paces its accounts five seconds apart,
    // so a serial pass over several sign-ins takes minutes.
    // Growth stays out of that group: it and the daily check-in both talk to the
    // same domestic accounts, so running them together stacks requests on one
    // account. A task can also be scored off the check-in, so growth follows it,
    // after a pause so the two bursts are not back to back.
    const [pool, travel, qoder, trae] = await Promise.all([
      claimAllCheckins(),
      travelAllAccounts(),
      qoderCheckinAll(),
      traeCheckinAll(),
    ]);
    // Published before the growth pause. "Run now" only waits 18s, and the panel
    // was painting this stub — claimed still 0, no source rows — as a finished pass.
    if (!stillLoaded(generation)) return started;
    // Qoder's round may open after this hour (10:00 Beijing). Its answer carries
    // that opening time, and the tick below re-runs Qoder alone when it comes:
    // without this write-back the opening time is dropped with the pass, the
    // slot counts as spent, and that day's Qoder credits are never collected.
    // A stale generation must not schedule anything either: the retry time it
    // wrote would steer a load that has its own pass bookkeeping.
    qoderRetryAt = typeof qoder.opensAt === "number" && qoder.opensAt > Date.now() ? qoder.opensAt : 0;
    Object.assign(started, {
      claimed: pool.claimed,
      skipped: pool.skipped,
      failed: pool.failed,
      travel,
      qoder,
      trae,
    });
    await delay(GROWTH_AFTER_CHECKIN_MS);
    if (!stillLoaded(generation)) return started;
    started.growth = await claimAllGrowth();
    log((manual ? "manual" : "automatic") + " check-in collected " + pool.claimed + " account(s) for " + slot);
  } catch (error) {
    started.error = safeMessage(error);
    log("warn", (manual ? "manual" : "automatic") + " check-in failed for " + slot + ": " + started.error);
  } finally {
    // On every path, including a pass that threw: without this the guard stays
    // set and no further pass can start for the rest of the process. Only a
    // pass that still belongs to this activation may clear it: a reload while
    // the pass runs resets the flag in onLoad, and this finally clearing it
    // afterwards would un-guard the activation that owns it now.
    if (stillLoaded(generation)) checkinPassRunning = false;
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

/** The one line a check-in pass reports, whichever way it finished. */
function checkinSummaryText(result) {
  if (result == null || result.running === true) {
    return "WTQ Pool - a check-in pass is already running";
  }
  const growth = result.growth;
  const growthText = growth === undefined ? ""
    : ", streak " + (Number(growth.streak) || 0) + " tier(s), tasks " + (Number(growth.tasks) || 0)
      + " (+" + (Number(growth.credit) || 0) + " credits)";
  return "WTQ Pool - checked in " + result.claimed + " account(s), travel " + JSON.stringify(result.travel)
    + growthText + ", Qoder " + JSON.stringify(result.qoder) + ", Trae " + JSON.stringify(result.trae);
}

/**
 * Redeem every unlocked streak tier of one account.
 *
 * A locked tier is the normal state until enough days accumulate, and a claimed
 * one needs no action, so neither is a failure. Returns how many tiers were
 * redeemed and what they paid, so the panel can say so.
 */
async function redeemAccountStreak(account) {
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
      log("info", "streak " + account.label + ": redeemed " + tier.tier + " (+" + tier.credit + "c +" + tier.energy + "e)");
    } catch (error) {
      log("warn", "streak " + account.label + ": redeem " + tier.tier + " failed: " + messageOf(error));
    }
  }
  return { claimed, credit, energy };
}

/**
 * Collect every claimable task reward of one account.
 *
 * Enrolment comes first: a task that was never accepted cannot be claimed, and
 * accepting an already-accepted task succeeds, so replaying the pass is safe.
 * The list is read again afterwards, because accepting can change what is
 * claimable. A repeat claim answers `already_claimed` and pays nothing.
 */
async function claimAccountTasks(account) {
  const credential = account.credential;
  const first = await core.client.listTasks(credential);
  const open = first.filter((task) => task.acceptStatus === "not_accepted" && !task.locked).map((task) => task.taskCode);
  if (open.length > 0) await core.client.acceptTasks(credential, open);
  const tasks = await core.client.listTasks(credential);
  let claimed = 0;
  let credit = 0;
  let energy = 0;
  // One task failing keeps the rewards already collected, and only a pass that
  // collected nothing reports the failure.
  let failed = 0;
  for (const task of tasks) {
    if (!task.claimable || task.locked) continue;
    try {
      const reward = await core.client.claimTaskReward(credential, task.taskCode);
      if (reward.credit > 0 || reward.energy > 0) {
        claimed += 1;
        credit += reward.credit;
        energy += reward.energy;
        log("info", "task " + account.label + ": " + task.title + " +" + reward.credit + "c +" + reward.energy + "e");
      }
    } catch (error) {
      failed += 1;
      log("warn", "task " + account.label + ": " + task.taskCode + " failed: " + messageOf(error));
    }
  }
  if (claimed === 0 && failed > 0) throw panelError("the task rewards could not be claimed", "UPSTREAM");
  return { claimed, credit, energy };
}

/**
 * Collect the streak bonus and the task rewards of every domestic account.
 *
 * Both are idempotent, so a pass that finds nothing to collect costs the reads
 * and no mutation, and running it on the daily schedule cannot double-pay. One
 * account failing never stops the rest. International accounts have no growth
 * centre, so they are skipped without a call.
 */
async function claimAllGrowth() {
  const counts = { streak: 0, tasks: 0, credit: 0, failed: 0 };
  let first = true;
  for (const account of core.pool.list()) {
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    if (regionOf(account.credential.domain) !== "cn") continue;
    if (!first) await delay(GROWTH_ACCOUNT_DELAY_MS);
    first = false;
    let collected = false;
    try {
      const streak = await redeemAccountStreak(account);
      counts.streak += streak.claimed;
      counts.credit += streak.credit;
      if (streak.claimed > 0) collected = true;
    } catch (error) {
      counts.failed += 1;
      log("warn", "streak failed for " + account.label + ": " + messageOf(error));
    }
    try {
      const tasks = await claimAccountTasks(account);
      counts.tasks += tasks.claimed;
      counts.credit += tasks.credit;
      if (tasks.claimed > 0) collected = true;
    } catch (error) {
      counts.failed += 1;
      log("warn", "tasks failed for " + account.label + ": " + messageOf(error));
    }
    // Either claim changed this account's balance, so its cached probe is stale.
    if (collected) probeCache.delete(account.id);
  }
  return counts;
}

function isAlreadyCheckin(error) {
  const message = messageOf(error);
  return message.includes("已签到") || message.toLowerCase().includes("already");
}

async function claimAllCheckins() {
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  for (const account of core.pool.list()) {
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    try {
      const before = await core.client.fetchCheckinStatus(account.credential);
      if (!before.active) continue;
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
      log("warn", "check-in failed for " + account.label + ": " + messageOf(error));
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
    log("warn", "travel " + account.label + ": adopt preflight report: " + messageOf(error));
  }
  await delay(TRAVEL_ADOPT_GAP_MS);
  try {
    await core.client.agreeBuddy(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": agreement: " + messageOf(error));
    return "failed";
  }
  try {
    await core.client.adoptBuddy(account.credential);
  } catch (error) {
    if (isBuddyThresholdIncomplete(messageOf(error))) {
      travelAdoptTried.set(account.id, day);
      log("info", "travel " + account.label + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
      return "skipped";
    }
    log("warn", "travel " + account.label + ": adopt: " + messageOf(error));
    return "failed";
  }
  log("info", "travel " + account.label + ": adopt ok (+300 credits)");
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
    log("warn", "travel " + account.label + ": buddy-info: " + messageOf(error));
    return "failed";
  }
  if (buddy === null) return await travelAdopt(account);
  let status = null;
  try {
    status = await core.client.fetchTravelStatus(account.credential);
  } catch (error) {
    log("warn", "travel " + account.label + ": status: " + messageOf(error));
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
      log("warn", "travel " + account.label + ": claim record=" + status.recordId + ": " + messageOf(error));
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
      log("warn", "travel " + account.label + ": depart: " + messageOf(error));
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
  const counts = { departed: 0, claimed: 0, adopted: 0 };
  let first = true;
  for (const account of core.pool.list()) {
    if (core.pool.isDisabled(account.id) || !regionEnabled("workbuddy", regionOf(account.credential.domain))) continue;
    if (regionOf(account.credential.domain) !== "cn") continue;
    if (!account.credential.refreshToken) continue;
    if (!first) await delay(TRAVEL_ACCOUNT_DELAY_MS);
    first = false;
    try {
      const outcome = await travelOne(account);
      if (outcome === "departed" || outcome === "claimed" || outcome === "adopted") {
        counts[outcome === "departed" ? "departed" : outcome === "claimed" ? "claimed" : "adopted"] += 1;
        // The pass changed this account's balance, so its cached probe is stale.
        probeCache.delete(account.id);
      }
    } catch (error) {
      log("warn", "travel failed for " + account.label + ": " + messageOf(error));
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
  const counts = { claimed: 0, skipped: 0, failed: 0 };
  const regions = activeQoderRegions();
  if (regions.length === 0) return counts;
  const found = await discoverQoderCredentials();
  let first = true;
  for (const credential of found.credentials) {
    if (!regions.includes(credential.region)) continue;
    if (!first) await delay(QODER_ACCOUNT_DELAY_MS);
    first = false;
    const result = await qoderClaimFor(credential);
    counts[result.outcome] += 1;
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
    return { outcome: result.claimed && !result.replayed ? "claimed" : "skipped" };
  } catch (error) {
    const reason = safeMessage(error);
    log("warn", "[qoder:" + credential.region + "] check-in failed for " + qoderRowLabel(credential) + ": " + reason);
    return { outcome: "failed", reason };
  }
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
  const found = await discoverTraeCredentials();
  const cnCredentials = found.credentials.filter((credential) => traeRegionOfCredential(credential) === "cn");
  let index = 0;
  for (; index < cnCredentials.length; index += 1) {
    if (index > 0) await delay(Math.max(1000, TRAE_ACCOUNT_DELAY_MS + Math.round((Math.random() * 2 - 1) * TRAE_ACCOUNT_JITTER_MS)));
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
    if (status.code === 0 && status.enable !== true) return { outcome: "skipped" };
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
      log("info", "[trae:cn] check-in already used by this device for " + label + ": " + (claim.message ?? ""));
      return { outcome: "skipped", deviceCheckedIn: true };
    }
    const reason = "code " + claim.code + (claim.message === undefined ? "" : " " + safeMessage(claim.message));
    log("warn", "[trae:cn] check-in refused for " + label + ": " + reason);
    return { outcome: "failed", reason };
  } catch (error) {
    const reason = safeMessage(error);
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
    // the user started by hand must not run beside it. The retry time is left
    // set rather than cleared, so the next tick collects it.
    if (checkinPassRunning) {
      log("info", "deferred Qoder check-in deferred: a pass is already running");
      return autoCheckinLast;
    }
    const retryGeneration = loadGeneration;
    checkinPassRunning = true;
    try {
      qoderRetryAt = 0;
      const retry = await qoderCheckinAll();
      qoderRetryAt = typeof retry.opensAt === "number" && retry.opensAt > Date.now() ? retry.opensAt : 0;
      autoCheckinLast = { ...autoCheckinLast, qoder: retry, at: new Date().toISOString() };
      log("info", "deferred Qoder check-in: " + JSON.stringify(retry));
    } finally {
      if (stillLoaded(retryGeneration)) checkinPassRunning = false;
    }
    scheduleRefresh("auto-checkin");
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
  // The same pass "run now" and the command palette run, which is what collects
  // the streak bonus and the task rewards. It records the slot and the log, and
  // it owns the re-entry guard, so this tick must not keep a second copy of either.
  return await runCheckinPass({ slot });
}

function startAutoCheckin() {
  if (autoCheckinTimer !== null) return;
  autoCheckinTimer = setInterval(() => {
    autoCheckinTick().catch((error) => log("warn", "scheduled check-in failed: " + messageOf(error)));
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
  if (settings.enabled === false) return;
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
  const bootstrapDeadline = Date.now() + LOAD_BOOTSTRAP_BUDGET_MS;
  const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
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
  serviceStopped = false;
  if (warmAbort.signal.aborted) warmAbort = new AbortController();
  await adoptHostSettings();
  if (settings.enabled === false) {
    log("info", "plugin disabled in settings; the provider host stays down");
    return;
  }
  applySettingsToCore();
  reconcileRuntimes();
  // Bounded like the load path above: this hook finishes what onLoad left
  // behind, and the reconcilers must not be the unbounded part of it.
  const bootstrapDeadline = Date.now() + SERVICE_BOOTSTRAP_BUDGET_MS;
  const bootstrapLeft = () => Math.max(0, bootstrapDeadline - Date.now());
  await settleWithin(reconcileTraeGateways(), bootstrapLeft());
  await settleWithin(reconcileQoderGateways(), bootstrapLeft());
  await settleWithin(startRuntimes(), bootstrapLeft());
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
  stopAutoCheckin();
  abortWarmups();
  const closing = Array.from(runtimes.values()).map(stopRuntime);
  runtimes.clear();
  for (const entry of [...traeGateways.values(), ...qoderGateways.values()]) {
    closing.push(entry.gateway.close().catch((error) => {
      log("warn", "[" + entry.source + ":" + entry.region + "] gateway did not close cleanly: " + messageOf(error));
    }));
  }
  traeGateways.clear();
  qoderGateways.clear();
  await Promise.all(closing);
}

async function onLoad() {
  serviceStopped = false;
  // Every pass this activation starts carries this number: bumping it here
  // retires the previous load's in-flight passes, and the teardown paths bump it
  // again so nothing of theirs survives into this one.
  loadGeneration += 1;
  // A previous load's warm-ups were aborted on the way out; this one gets a
  // controller of its own so its warm-ups can be stopped the same way.
  warmAbort = new AbortController();
  // A reload is this plugin's restart, so the check-in bookkeeping starts
  // clean. Slots the previous activation recorded are forgotten rather than
  // kept: a pass lost to a crash or reload must be re-attempted on the next
  // tick, and every claim re-reads today's state first, so re-running a slot
  // collects only what was never collected. A stale pass from the previous
  // activation is still running in the background; the generation guards keep
  // its finally from touching these reset values.
  checkinPassRunning = false;
  autoCheckinSlots.clear();
  autoCheckinLast = null;
  qoderRetryAt = 0;
  // Built before the first await, so the panel routes `apply` registers ahead
  // of this call never see a half-loaded engine: a request that lands between
  // route registration and the settings adoption would otherwise meet a pool
  // that is still undefined. The settings-dependent fields are provisional
  // until then; `adoptHostSettings` re-applies them through
  // `applySettingsToCore` before anything serves.
  // The client is built first because the pool refreshes tokens through it.
  core.client = new WorkBuddyUpstreamClient();
  core.pool = new WorkBuddyAccountPool({
    client: core.client,
    cooldownMs: cooldownMs(),
    distribution: distributionSetting(),
    logger: {
      info: (...args) => log("info", gatewayLogLine("", args)),
      warn: (...args) => log("warn", gatewayLogLine("", args)),
      error: (...args) => log("error", gatewayLogLine("", args)),
    },
  });
  await adoptHostSettings();
  // A fresh load starts with nothing published: the entry re-publishes the
  // declaration as soon as the gateways come up.
  declarationIndex = new Map();
  publishedIds = new Set();
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch (error) {
    dataPath = "";
    log("warn", "no plugin data path: " + messageOf(error));
  }
  await registerCommands();
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
  // Before the gateways close, so a warm-up still in flight stops on the signal
  // rather than on the connection error it would raise from a closed socket.
  abortWarmups();
  // No declaration is written here: the teardown in the entry has already
  // stopped the loader, so a registration from an unloading plugin is refused,
  // and the next load resets the declaration index and republishes anyway.
  await onServiceStop();
  probeCache.clear();
  try {
    if (pi.events && typeof pi.events.off === "function" && settingsChangedHandler !== null) {
      pi.events.off("plugin:settingsChanged", settingsChangedHandler);
    }
  } catch (error) {
    log("warn", "could not unsubscribe from settings changes: " + messageOf(error));
  }
  settingsChangedHandler = null;
  try {
    await pi.commands.unregister(COMMAND_OPEN);
    await pi.commands.unregister(COMMAND_RESCAN);
    await pi.commands.unregister(COMMAND_RESET);
    await pi.commands.unregister(COMMAND_DOCTOR);
    await pi.commands.unregister(COMMAND_CHECKIN);
  } catch (error) {
    log("warn", "unregistering commands failed: " + messageOf(error));
  }
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

function workbuddyComposerAccounts(region, modelId) {
  const now = Date.now();
  const list = core.pool.list(region);
  const available = core.pool.available(now, modelId, region);
  const preferredId = preferredAccountId(region);
  const preferred = available.find((account) => account.id === preferredId);
  const namesNext = distributionSetting() === "priority" || distributionSetting() === "expiry";
  const next = preferred ?? (namesNext ? core.pool.preview(available) : undefined);
  return list.map((account) => {
    const cached = probeCache.get(account.id)?.value?.credits;
    return {
      id: account.id,
      label: account.label,
      active: next !== undefined && next.id === account.id,
      ...typeof cached?.total === "number" ? { total: cached.total } : {},
      ...Array.isArray(cached?.packages) && cached.packages.length > 0 ? { packages: cached.packages } : {},
    };
  });
}

function sourceComposerAccounts(source, region) {
  const rows = (source === "trae" ? traeAccountRows : qoderAccountRows).filter((row) => row.region === region);
  const live = rows.filter((row) => row.expired !== true);
  const preferred = preferredSourceAccount(source, region);
  let active = preferred === "" ? undefined : live.find((row) => row.label === preferred);
  if (active === undefined) {
    const mode = sourceDistribution(source);
    if (mode === "expiry") {
      const now = Date.now();
      active = live.slice().sort((left, right) => packUrgency(source, left.label, now) - packUrgency(source, right.label, now))[0];
    } else if (mode !== "round-robin") {
      active = live[0];
    }
  }
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
      ...Array.isArray(credits?.packages) && credits.packages.length > 0 ? { packages: credits.packages } : {},
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
  if (!composerPointsEnabled()) return { show: false, ours: false };
  const hit = matchComposerModel(args);
  if (hit === undefined) return { show: false, ours: composerRoute(args?.provider) !== undefined };
  if (hit.source === "workbuddy" && probesStale()) scheduleRefresh("composer");
  const accounts = hit.source === "workbuddy"
    ? workbuddyComposerAccounts(hit.region, hit.id)
    : sourceComposerAccounts(hit.source, hit.region);
  const active = accounts.find((account) => account.active === true);
  return {
    show: true,
    ours: true,
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
    const preferredAccountIds = {};
    for (const key of REGIONS) {
      const current = preferredAccountId(key);
      if (current !== undefined) preferredAccountIds[key] = current;
    }
    if (accountId === "") delete preferredAccountIds[region];
    else preferredAccountIds[region] = accountId;
    if (await saveSettings({ preferredAccountIds }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
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
  const next = { ...(settings.preferredSourceAccounts ?? {}) };
  if (accountLabel === "") delete next[sourceRegionKey(source, region)];
  else next[sourceRegionKey(source, region)] = accountLabel;
  if (await saveSettings({ preferredSourceAccounts: next }) !== true) throw panelError("the account choice could not be saved", "SAVE_FAILED");
  // Same contract as the WorkBuddy branch: past the save the choice is in
  // force, so it is reported as stored even if the snapshot is unavailable.
  return { ...composerPoints(args), saved: true };
}

export { onLoad, onUnload, onPanelInvoke }

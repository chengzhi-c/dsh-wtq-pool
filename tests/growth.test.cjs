'use strict'

/**
 * The growth centre: the four things the scheduled check-in runs as its third
 * stage, and the panel card that shows and runs them on their own.
 *
 * Two properties carry the weight. The state read must claim nothing — two of
 * the four steps spend something, and a "read" that spent it would make the
 * card a trap. And the run must report each step separately, because one merged
 * number cannot tell the user which of the four did anything.
 */

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire, registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

// The host imports its siblings without an extension, so the loader needs the
// same `.ts` resolution the DSH entry builds against.
registerHooks({
  resolve(specifier, context, next) {
    const ownSource = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL).startsWith(path.join(root, 'src') + path.sep)
    return next(ownSource && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs', shortCircuit: true, source: transpile(fs.readFileSync(fileURLToPath(url), 'utf8')),
    }
    return next(url, context)
  },
})

const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')

const CN = {
  region: 'cn', accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
  expiresAtMs: 0, uid: 'fixture-uid', uin: 'fixture-uin',
  domain: 'www.codebuddy.cn', sourcePath: '',
}

/**
 * Load the entry with one WorkBuddy sign-in and every growth endpoint stubbed.
 *
 * The stubs are prototype methods rather than an injected client: the entry
 * builds its own client, and mocking the class it builds it from is what keeps
 * the wiring under test real. `spent` records the calls that are not reads.
 */
async function loadPlugin(t, temporary, growth) {
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth, { recursive: true })
  const { installPi } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000 },
    account: { uin: 'fixture-uin', nickname: 'Fixture' },
  }))

  const spent = []
  const record = (name, answer) => t.mock.method(WorkBuddyUpstreamClient.prototype, name, async (...args) => {
    spent.push([name, ...args.map((arg) => (typeof arg === 'object' ? '[credential]' : arg))])
    return typeof answer === 'function' ? answer(...args) : answer
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
  record('makeupCards', growth.makeupCards ?? 0)
  record('missedYesterday', growth.missedYesterday ?? false)
  record('useMakeupCard')
  record('claimGift', growth.gift ?? 0)
  record('claimCompensation', growth.compensation ?? 0)
  record('reportChatActivity')
  record('growthStreakFull', async () => growth.streak)
  record('redeemStreakTier')
  record('lotteryChances', growth.chances ?? 0)
  record('drawLottery', { prize: 'fixture' })
  let activate
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')),
    module: { exports: {} }, exports: {}, __dirname: temporary,
    console: { log() {}, warn() {}, error() {} }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  await plugin.onLoad()
  return { plugin, spent, settings }
}

const STREAK = {
  days: 12, nextTier: '14d', nextTierRemaining: 2, makeupCards: 2,
  tiers: [
    { tier: '7d', days: 7, credit: 100, energy: 5, status: 'claimed' },
    { tier: '14d', days: 14, credit: 200, energy: 10, status: 'unlocked' },
  ],
}

/** The five steps, and the ones among them that spend something. */
const MUTATING = ['useMakeupCard', 'claimGift', 'claimCompensation', 'reportChatActivity', 'redeemStreakTier', 'drawLottery']

test('the streak read carries the make-up card balance with it', async () => {
  let asked = 0
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async () => {
      asked += 1
      return new Response(JSON.stringify({ code: 0, data: {
        streak: { days: 12, next_tier: '14d', next_tier_remaining: 2 },
        makeup_cards: { balance: 3 },
        redemption_status: {
          tiers: [{ tier: '7d', days: 7, credit: 100, energy: 5 }, { tier: '14d', days: 14, credit: 200, energy: 10 }],
          tier_7d_status: 'claimed', tier_14d_status: 'unlocked',
        },
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const status = await client.growthStreakFull(CN)
  assert.equal(status.days, 12)
  assert.equal(status.nextTier, '14d')
  assert.equal(status.nextTierRemaining, 2)
  assert.equal(status.makeupCards, 3,
    'the balance rides the same response, so a reader of the state does not pay a second request for it')
  assert.equal(status.tiers.length, 2)
  assert.equal(status.tiers[0].status, 'claimed', 'the flat status field is the unlock state')
  assert.equal(status.tiers[1].status, 'unlocked')
  assert.equal(asked, 1)
})

test('reading the growth state spends nothing', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin, spent } = await loadPlugin(t, temporary, {
    streak: STREAK, chances: 2, gift: 50, compensation: 10,
  })
  try {
    const answer = await plugin.onPanelInvoke('xd.growthState')
    assert.deepEqual(spent.map(([name]) => name).filter((name) => MUTATING.includes(name)), [],
      'a read must not spend a card, a draw, a gift or a reward')
    // The answer carries when it was read, so the card can tell a fresh result
    // from one a run has since outdated; the rows themselves are compared below.
    assert.equal(typeof answer.growth.readAt, 'number', 'a read is stamped with its own time')
    assert.deepEqual(JSON.parse(JSON.stringify({ ...answer.growth, readAt: undefined })), {
      accounts: 1, failed: 0,
      rows: [{
        id: answer.growth.rows[0].id,
        label: 'Fixture',
        region: 'cn',
        days: 12, nextTier: '14d', nextTierRemaining: 2,
        tiers: 1, tierList: STREAK.tiers, makeupCards: 2, lottery: 2,
      }],
    }, 'the card reads one row per account: the streak, the cards and the draws')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A read is held, published, and dropped when the accounts change.
 *
 * The card used to hold its read in the renderer only, so a repaint turned a
 * refresh into "go press Read state". The host now keeps the answer and publishes
 * it in the status document - which is what the card paints on entry - and it has
 * to forget it when a switch changes which accounts a read would return, or the
 * cache would show an account the user just switched off.
 */
test('a growth read is published, and dropped when the region is switched off', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin } = await loadPlugin(t, temporary, {
    streak: STREAK, chances: 2, gift: 50, compensation: 10,
  })
  try {
    const before = await plugin.onPanelInvoke('xd.state')
    // The key is always published; `null` is "this process has not read yet", which
    // is what lets the panel tell it apart from a document that says nothing.
    assert.equal(before.growth.read, null, 'a process that has not read yet publishes no read')

    const answer = await plugin.onPanelInvoke('xd.growthState')
    assert.equal(answer.growth.rows.length, 1, 'the read answers with its rows')
    const after = await plugin.onPanelInvoke('xd.state')
    assert.equal(typeof after.growth.read, 'object', 'and the next document carries them')
    assert.equal(after.growth.read.rows.length, 1)
    assert.equal(after.growth.read.readAt, answer.growth.readAt, 'stamped with when it was read')

    // Switching the region off changes which accounts a read returns, so the held
    // answer no longer describes the pool.
    await plugin.onPanelInvoke('xd.setRegionEnabled', { source: 'workbuddy', region: 'cn', enabled: false })
    const parked = await plugin.onPanelInvoke('xd.state')
    assert.equal(parked.growth.read, null,
      'the rows of a switched-off region are not painted as current')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a growth run reports each of the four steps on its own', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin, spent } = await loadPlugin(t, temporary, {
    streak: STREAK, chances: 2, makeupCards: 2, missedYesterday: true,
    gift: 50, compensation: 10,
  })
  try {
    const answer = await plugin.onPanelInvoke('xd.growthRun')
    const detail = answer.growth.detail
    assert.equal(detail.makeup, 1, 'the make-up card is spent on the missed day')
    assert.equal(detail.gift, 50, 'the gift pack pays on its own line')
    assert.equal(detail.compensation, 10, 'and so does the compensation')
    assert.equal(detail.activity, 1, 'the activity report is what advances the streak')
    assert.equal(detail.streak, 1, 'one unlocked tier is redeemed')
    assert.equal(detail.lottery, 2, 'and both draws are spent')
    assert.equal(detail.accounts, 1)
    assert.equal(detail.failed, 0)
    // The top-level counts are the ones the check-in log has always shown, so a
    // breakdown that disagreed with them would be a second source of truth.
    assert.equal(answer.growth.streak, 1)
    assert.equal(answer.growth.credit, 200, 'the redeemed tier\'s credits')
    assert.ok(spent.some(([name]) => name === 'useMakeupCard'), 'the card was actually spent')
    assert.ok(spent.some(([name]) => name === 'drawLottery'), 'and the draws were actually taken')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a locked tier is not a failure', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin } = await loadPlugin(t, temporary, {
    streak: { days: 3, nextTier: '7d', nextTierRemaining: 4, makeupCards: 0, tiers: [{ tier: '7d', days: 7, credit: 100, energy: 5, status: 'locked' }] },
    chances: 0,
  })
  try {
    const answer = await plugin.onPanelInvoke('xd.growthRun')
    assert.deepEqual({ ...answer.growth.detail }, {
      accounts: 1, makeup: 0, gift: 0, compensation: 0, activity: 1,
      streak: 0, lottery: 0, failed: 0,
    }, 'a day with nothing to collect is a clean pass, not a failed one')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('a step that throws is counted, and the rest of the pass still lands', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin, spent } = await loadPlugin(t, temporary, {
    streak: STREAK, chances: 1, gift: 0, compensation: 0,
  })
  // The gift endpoint answers a business error for an account with nothing
  // waiting, which is the normal answer rather than a breakage.
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'claimGift', async () => { throw new Error('nothing waiting') })
  try {
    const answer = await plugin.onPanelInvoke('xd.growthRun')
    assert.equal(answer.growth.detail.failed, 0,
      'a refused one-off collection is the upstream saying there is nothing there')
    // The claim in the title is that the pass keeps going: a refused gift must
    // not cost the account its activity report, its tier or its draw.
    assert.equal(answer.growth.detail.activity, 1, 'the activity report still runs after the refused gift')
    assert.equal(answer.growth.detail.streak, 1, 'and the unlocked tier is still redeemed')
    assert.equal(answer.growth.detail.lottery, 1, 'and the draw is still taken')
    assert.equal(answer.growth.credit, 200, 'the redeemed tier\'s credits still land')
    assert.ok(spent.some(([name]) => name === 'redeemStreakTier'), 'the tier was actually redeemed')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
/**
 * A growth run started after a service stop still collects.
 *
 * The stop aborts the pass that was in flight. The run that starts afterwards is
 * a different pass and used to inherit that dead signal: every account broke out
 * of its loop on the first check, and the empty result was recorded as a
 * finished run, so the card reported "0 tier(s), +0" for a pass that never
 * asked the upstream anything.
 */
test('a growth run started after a service stop still collects', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin, spent } = await loadPlugin(t, temporary, {
    streak: STREAK, chances: 1, gift: 50, compensation: 10,
  })
  const { startRegisteredService, stopRegisteredService } = require('../src/pi-compat.ts')
  try {
    await stopRegisteredService()
    await startRegisteredService()
    const answer = await plugin.onPanelInvoke('xd.growthRun')
    assert.equal(answer.growth.detail.accounts, 1, 'the run still reached its account')
    assert.equal(answer.growth.detail.streak, 1, 'and redeemed the unlocked tier')
    assert.equal(answer.growth.credit, 200, 'with the credits the tier pays')
    assert.ok(spent.some(([name]) => name === 'redeemStreakTier'), 'the upstream was actually asked')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
/**
 * A single claim is refused while a growth run is walking the same accounts.
 *
 * The guard used to name only the check-in pass, so one claim could land in the
 * middle of a growth run: two request clusters on one account, and both write
 * today's record.
 */
test('a single claim is refused while a growth run walks the accounts', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin } = await loadPlugin(t, temporary, { streak: STREAK, chances: 0, gift: 0, compensation: 0 })
  const gates = []
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'claimGift', async () => {
    await new Promise((resolve) => { gates.push(resolve) })
    return 0
  })
  const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i += 1) await new Promise((r) => setImmediate(r)) }
  try {
    const id = (await plugin.onPanelInvoke('xd.growthState')).growth.rows[0].id
    const run = plugin.onPanelInvoke('xd.growthRun')
    await until(() => gates.length === 1)
    assert.equal(gates.length, 1, 'the growth run is mid-account')
    await assert.rejects(plugin.onPanelInvoke('xd.checkin', { accountId: id }),
      /a check-in or growth pass is already running/,
      'the claim is refused instead of landing beside the run')
    for (const open of gates) open()
    await run
  } finally {
    for (const open of gates) open()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
/**
 * A single claim holds the guard for as long as it runs.
 *
 * Reading the flag guarded a claim that arrived after a pass had started and left
 * the other order open: a scheduled tick or one "run now" landing between the
 * claim's status read and its write walked the same account at the same time. No
 * credit is paid twice, because every claim re-reads today's state, but the second
 * round then reported a failure for an account that had just been collected.
 */
test('a pass that starts during a single claim waits for it', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-claim-guard-'))
  const { plugin } = await loadPlugin(t, temporary, { streak: STREAK, chances: 0, gift: 0, compensation: 0 })
  let openClaim
  const claimed = new Promise((resolve) => { openClaim = resolve })
  let entered
  const reached = new Promise((resolve) => { entered = resolve })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'claimDailyCheckin', async () => {
    entered()
    await claimed
    return { credit: 100, streakDays: 1, isStreakDay: true }
  })
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: true, todayCheckedIn: false }))
  const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i += 1) await new Promise((r) => setImmediate(r)) }
  try {
    const id = (await plugin.onPanelInvoke('xd.state')).accounts[0].id
    const claim = plugin.onPanelInvoke('xd.checkin', { accountId: id })
    await until(() => true)
    // The claim is inside its write now. A pass arriving here must not start.
    const pass = await plugin.onPanelInvoke('xd.checkinAll', { source: 'workbuddy' })
    assert.equal(pass.running, true, 'the pass waits rather than walking the same account')
    openClaim()
    const answered = await claim
    assert.equal(answered.result.credit, 100, 'and the claim itself still completes')

    // The control: once it is done the pass runs.
    openClaim()
    t.mock.restoreAll()
    t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchModels', async () => [])
    t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCredits', async () => ({ total: 0, packages: [] }))
    t.mock.method(WorkBuddyUpstreamClient.prototype, 'fetchCheckinStatus', async () => ({ active: false }))
    t.mock.method(WorkBuddyUpstreamClient.prototype, 'claimDailyCheckin', async () => ({ credit: 0, streakDays: 1, isStreakDay: false }))
    const after = await plugin.onPanelInvoke('xd.checkinAll', { source: 'workbuddy' })
    assert.notEqual(after.running, true, 'the guard is released when the claim finishes')
  } finally {
    openClaim()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A check-in narrowed to a source nobody serves is refused, not recorded.
 *
 * An unrecognised name made every worker skip, so the pass collected nothing and
 * still wrote itself as the last run: the panel showed an all-zero log row for a
 * request that never meant anything.
 */
test('a check-in aimed at an unknown source is refused', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-checkin-source-'))
  const { plugin } = await loadPlugin(t, temporary, { streak: STREAK, chances: 0, gift: 0, compensation: 0 })
  try {
    await assert.rejects(plugin.onPanelInvoke('xd.checkinAll', { source: 'nobody' }),
      /source must be workbuddy, trae or qoder/,
      'a name no worker answers is an invalid request, not an empty pass')
    const state = await plugin.onPanelInvoke('xd.state')
    assert.equal(state.autoCheckin.last ?? null, null,
      'and nothing is recorded as the last run')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A run that outlived its activation cannot un-guard the one that replaced it.
 *
 * The reload resets the flag so the new activation can start a pass. The stale
 * run is still walking its accounts and only stops at its next await, so its
 * `finally` used to clear the flag the NEW run was holding - and a third click
 * then started a second unpaced pass over the same accounts, which is what the
 * upstream reads as a burst.
 */
test('a stale run does not clear the guard of the run that replaced it', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-growth-'))
  const { plugin } = await loadPlugin(t, temporary, { streak: STREAK, chances: 0, gift: 0, compensation: 0 })
  // One gate per pass, opened by the test: the pass blocks on its first spending
  // step, which is what lets two of them be in flight at once.
  const gates = []
  t.mock.method(WorkBuddyUpstreamClient.prototype, 'claimGift', async () => {
    await new Promise((resolve) => { gates.push(resolve) })
    return 0
  })
  const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i += 1) await new Promise((r) => setImmediate(r)) }
  try {
    const stale = plugin.onPanelInvoke('xd.growthRun')
    await until(() => gates.length === 1)
    assert.equal(gates.length, 1, 'the first pass reached its account')
    // A reload while that pass is still walking: the flag is handed over.
    await plugin.onLoad()
    const current = plugin.onPanelInvoke('xd.growthRun')
    await until(() => gates.length === 2)
    assert.equal(gates.length, 2, 'the second pass started after the handover')
    // The stale pass finishes first, exactly as it would after a reload.
    gates[0]()
    await stale
    // The click that lands while the newer run is still walking is refused, not
    // started: a second unpaced pass over the same accounts is what the upstream
    // reads as a burst. A refusal answers at once - there is nothing to wait for -
    // while a pass that started blocks until it is done, so the race is the
    // signal.
    const third = plugin.onPanelInvoke('xd.growthRun')
    let refused = false
    try {
      const verdict = await Promise.race([
        third.then(() => 'answered'),
        new Promise((resolve) => setTimeout(() => resolve('started a pass'), 200)),
      ])
      refused = verdict === 'answered'
    } finally {
      for (const open of gates) open()
      await Promise.allSettled([current, third])
    }
    assert.ok(refused, 'the click was refused instead of starting a second pass')
    assert.equal(await third.then((answer) => answer.running), true,
      'and it said so, instead of failing')
  } finally {
    for (const open of gates) open()
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * Lift named functions out of the panel and run them against a fake DOM.
 *
 * The panel boots on load, so it cannot be evaluated whole. Lifting is what
 * lets a case drive the real control: a field the painter never reads, or a
 * row it drops, then fails here instead of passing on a source match.
 */
function panelGrowth(names) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  // Every lifted function that judges freshness needs the two helpers behind it.
  const stale = source.match(/var GROWTH_STALE_MS = [^\n]+/)
  assert.ok(stale, 'the throttle must be a named constant')
  const parts = [stale[0]]
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(from, index + 1))
  }
  for (const dependency of ['growthLastRun', 'growthStale']) {
    if (names.includes(dependency) || parts.some((part) => part.includes('function ' + dependency + '('))) continue
    if (!parts.some((part) => part.includes(dependency + '('))) continue
    const at = source.indexOf('function ' + dependency + '(')
    assert.notEqual(at, -1, dependency + ' must exist in the panel')
    let depth = 0
    let index = source.indexOf('{', at)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(at, index + 1))
  }
  const seen = []
  const context = vm.createContext({
    state: null,
    growthState: null,
    activeSource: 'workbuddy',
    // The lifted functions read the panel's module state, which the lift cannot
    // carry: it is declared here so a row's expansion survives a re-render.
    openGrowth: {},
    // The realm order the page groups by, mirroring the panel's own
    // declaration so a split test drives the real order rather than a copy.
    SOURCE_REGIONS: { workbuddy: ['cn', 'global'], trae: ['cn', 'ai'], qoder: ['cn', 'global'] },
    STATUS_KEY: { unlocked: 'growth.tierUnlocked', claimed: 'growth.tierClaimed', locked: 'growth.tierLocked' },
    t: (key, params) => { seen.push([key, params]); return key },
    num: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    formatStamp: (iso) => String(iso || ''),
    regionLabel: (region) => String(region || ''),
    el: (tag, className, text) => ({
      tag, className, text: text === undefined ? '' : text, children: [], attrs: {}, hidden: false, title: '', disabled: false,
      appendChild(child) { this.children.push(child) },
      setAttribute(name, value) { this.attrs[name] = String(value) },
      getAttribute(name) { return name in this.attrs ? this.attrs[name] : null },
      addEventListener() {},
    }),
    clear: (node) => { node.children.length = 0 },
    console,
  })
  vm.runInContext(parts.join('\n'), context)
  return { context, seen }
}

/** A log box the painter writes into, with the geometry it reads. */
function fakeLogBox() {
  return { scrollTop: 0, clientHeight: 40, scrollHeight: 40, children: [], appendChild(line) { this.children.push(line) } }
}

test('the growth card reads the state it is handed', () => {
  const { context } = panelGrowth(['growthStale', 'growthStateText'])
  context.growthState = null
  assert.equal(context.growthStateText(), 'growth.stateNone',
    'a card with no read behind it says so rather than showing zeros')
  context.state = { growth: { last: { at: '2026-10-19T12:00:00.000Z' } } }
  assert.equal(context.growthStateText(), 'growth.stateStale',
    'a card whose figures predate the last run says to read again, not that nothing was read')
  context.state = null
  context.growthState = {
    accounts: 3, failed: 1,
    rows: [
      { id: 'a1', label: 'One', region: 'cn', days: 12, nextTier: '14d', nextTierRemaining: 2, tiers: 1, tierList: [], makeupCards: 2, lottery: 3 },
      { id: 'a2', label: 'Two', region: 'global', days: 5, nextTier: '7d', nextTierRemaining: 2, tiers: 0, tierList: [], makeupCards: 0, lottery: 0 },
      { id: 'a3', label: 'Three', region: 'cn', failed: true },
    ],
  }
  const line = context.growthStateText()
  assert.ok(line.includes('growth.stateSummary'), 'the totals line sums the rows rather than naming one account')
  assert.ok(line.includes('growth.stateFailed'), 'an account that could not be read is reported')
})

test('the growth page lists one expandable row per account', () => {
  const { context, seen } = panelGrowth(['growthRow', 'growthRowTone', 'paintGrowthAccounts'])
  context.activeSource = 'workbuddy'
  context.growthState = {
    accounts: 2, failed: 0,
    rows: [
      { id: 'a1', label: 'One', region: 'cn', days: 12, nextTier: '14d', nextTierRemaining: 2, tiers: 1, makeupCards: 2, lottery: 3,
        tierList: [{ tier: '7d', days: 7, credit: 100, energy: 5, status: 'claimed' }, { tier: '14d', days: 14, credit: 200, energy: 10, status: 'unlocked' }] },
      { id: 'a2', label: 'Two', region: 'global', days: 3, nextTier: '7d', nextTierRemaining: 4, tiers: 0, makeupCards: 0, lottery: 0, tierList: [] },
    ],
  }
  const host = { children: [], appendChild(node) { this.children.push(node) } }
  context.clear = (node) => { node.children.length = 0 }
  context.paintGrowthAccounts(host)
  assert.equal(host.children.length, 4, 'a realm heading each, then one row per account')
  assert.equal(host.children[0].className, 'growth-group', 'the rows are grouped under a realm heading')
  assert.equal(host.children[2].className, 'growth-group', 'and the second realm gets one of its own')

  const row = host.children[1]
  const head = row.children[0]
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'a row starts collapsed')
  assert.equal(row.children[1].hidden, true, 'and its body is hidden with it')
  assert.equal(head.children[0].className, 'growth-dot ok', 'the head opens with the account state')
  assert.equal(head.children[1].text, 'One', 'the row is named after its account')
  const asked = seen.map(([key]) => key)
  assert.ok(asked.includes('growth.rowHold'), 'the head carries what the account holds')
  assert.ok(asked.includes('growth.rowSummary'), 'and the body names the streak behind it')
  assert.ok(asked.includes('growth.rowTier'), 'each unlocked tier is listed on its own line')
  assert.ok(asked.includes('growth.tierClaimed'), 'and a claimed one says so')

  context.openGrowth['growth:a1'] = true
  const opened = context.growthRow(context.growthState.rows[0])
  assert.equal(opened.children[0].getAttribute('aria-expanded'), 'true', 'an expanded row reports it')
  assert.equal(opened.children[1].hidden, false, 'and shows its body')
})

test('the growth page splits its rows by realm and dots each row state', () => {
  const { context, seen } = panelGrowth(['growthRow', 'growthRowTone', 'paintGrowthAccounts'])
  context.activeSource = 'workbuddy'
  context.growthState = {
    accounts: 3, failed: 1,
    rows: [
      { id: 'a1', label: 'Holds something', region: 'cn', tiers: 1, tierList: [], makeupCards: 0, lottery: 0 },
      { id: 'a2', label: 'Holds nothing', region: 'global', tiers: 0, tierList: [], makeupCards: 0, lottery: 0 },
      { id: 'a3', label: 'Unreadable', region: 'cn', failed: true },
    ],
  }
  const host = { children: [], appendChild(node) { this.children.push(node) } }
  context.clear = (node) => { node.children.length = 0 }
  context.paintGrowthAccounts(host)
  // Both realms hold accounts, so both get a heading, in the order the source
  // declares them rather than the order the rows happened to arrive in.
  assert.deepEqual(host.children.filter((node) => node.className === 'growth-group').map((node) => node.text),
    ['cn', 'global'], 'a heading per realm, in the realm order the source declares')
  assert.deepEqual(host.children
    .filter((node) => node.className === 'credits')
    .map((node) => node.children[0].children[0].className),
    ['growth-dot ok', 'growth-dot fail', 'growth-dot'],
    'a row dots green when a run would collect, red when the read failed, muted when nothing is left')
  assert.ok(seen.some(([key]) => key === 'growth.groupCount'), 'and each heading counts its accounts')
})

test('the growth page says so when the source is not WorkBuddy', () => {
  const { context, seen } = panelGrowth(['paintGrowthAccounts'])
  context.activeSource = 'trae'
  context.growthState = { accounts: 1, failed: 0, rows: [{ id: 'a1', label: 'One', region: 'cn' }] }
  const host = { children: [], appendChild(node) { this.children.push(node) } }
  context.clear = (node) => { node.children.length = 0 }
  context.paintGrowthAccounts(host)
  assert.equal(host.children.length, 1)
  assert.equal(host.children[0].text, 'growth.onlyWorkbuddy',
    'a source with no growth centre says so instead of listing another source\'s accounts')
  assert.ok(seen.some(([key]) => key === 'growth.onlyWorkbuddy'))
})

test('the growth log names every step of the last run', () => {
  const { context, seen } = panelGrowth(['growthLastRun', 'paintGrowthNote'])
  context.state = { growth: { last: {
    at: '2026-10-19T12:00:00.000Z', credit: 270, failed: 0,
    detail: { accounts: 2, makeup: 1, gift: 50, compensation: 10, activity: 2, streak: 1, lottery: 3, failed: 0 },
  } } }
  const box = fakeLogBox()
  context.paintGrowthNote(box)
  assert.equal(box.children.length, 1, 'one line for a clean pass')
  // The translator is stubbed, so what is checked is that every step's number
  // reaches the string: a step the painter dropped is invisible either way.
  const asked = seen.find(([key]) => key === 'growth.runLine')
  assert.ok(asked !== undefined, 'the run line must be the one painted')
  assert.deepEqual({ ...asked[1] }, {
    when: '2026-10-19T12:00:00.000Z',
    makeup: 1, gift: 50, compensation: 10, activity: 2, streak: 1, lottery: 3, credit: 270,
  }, 'each of the five steps carries its own count into the line')

  // A pass that failed a step says so on its own line: the breakdown above
  // still reads as a normal pass otherwise.
  context.state.growth.last.detail.failed = 2
  context.paintGrowthNote(box)
  assert.equal(box.children.length, 2, 'a failure gets a line of its own')
  assert.equal(box.children[1].children[1].text, 'growth.runFailed')
})

test('the growth card falls back to the scheduled pass it belongs to', () => {
  const { context } = panelGrowth(['growthLastRun', 'paintGrowthNote'])
  // The scheduled pass records its growth half inside the pass itself, and that
  // is where a user who never pressed the card's own button still sees it.
  context.state = { autoCheckin: { last: { at: '2026-10-19T09:00:00.000Z', growth: {
    credit: 200, failed: 0,
    detail: { accounts: 1, makeup: 0, gift: 0, compensation: 0, activity: 1, streak: 1, lottery: 0, failed: 0 },
  } } } }
  const box = fakeLogBox()
  context.paintGrowthNote(box)
  assert.equal(box.children.length, 1)
  assert.equal(box.children[0].children[1].text, 'growth.runLine',
    'the scheduled pass is the one shown when the card has no run of its own')
})

/**
 * Lift the growth page's run path and drive it against a fake bridge.
 *
 * `runBusy` comes along rather than being stubbed: the defect these cases guard
 * against was its own decision to adopt only a bare status document, and a
 * stand-in would have passed either way.
 */
function panelGrowthRun(answers) {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const parts = []
  for (const name of ['runBusy', 'runGrowth', 'readGrowth', 'adopt']) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(from, index + 1))
  }
  const calls = []
  const said = []
  const context = vm.createContext({
    busy: null,
    state: null,
    growthState: null,
    growthReading: false,
    // The panel counts the host's drops so a read in flight can discard its own
    // answer; the lifted functions read it from here.
    growthDropped: 0,
    // `adopt` bumps the revision the refresh poll watches, so the counter it
    // writes has to exist here as well.
    stateRevision: 0,
    activeSource: 'workbuddy',
    openGrowth: {},
    console,
    document: { activeElement: null },
    t: (key) => key,
    // `runBusy` clears the banner with a null of its own, so only a real
    // message counts as something reported.
    note: (message) => { if (message !== null) said.push(['note', message]) },
    announce: (message) => said.push(['announce', message]),
    notePress: () => {},
    render: () => {},
    pollCheckinLog: () => {},
    invoke: (channel) => {
      calls.push(channel)
      // An unexpected channel is a failure, not a silence: the caller's own
      // catch would otherwise swallow it and the case would pass on nothing.
      if (!(channel in answers)) return Promise.reject(new Error('unexpected channel ' + channel))
      return Promise.resolve(answers[channel])
    },
  })
  vm.runInContext(parts.join('\n'), context)
  return { context, calls, said }
}

const ROW = {
  id: 'a1', label: 'One', region: 'cn', days: 12, nextTier: '14d', nextTierRemaining: 2,
  tiers: 1, makeupCards: 0, lottery: 0, tierList: [],
}

test('a finished growth run leaves the page holding the new rows', async () => {
  const document = { accounts: [{ id: 'a1' }], growth: { last: { at: '2026-10-19T12:00:00.000Z' } } }
  const { context, calls, said } = panelGrowthRun({
    'xd.growthRun': { state: document, growth: { accounts: 1, failed: 0, rows: [] } },
    'xd.growthState': { growth: { accounts: 1, failed: 0, rows: [ROW] } },
  })
  await context.runGrowth()
  assert.deepEqual(calls, ['xd.growthRun', 'xd.growthState'],
    'the run is followed by a read, so the rows describe what is left to collect')
  assert.equal(context.state, document,
    'and the document the run answered with is adopted, not dropped on the floor')
  assert.deepEqual(context.growthState.rows, [ROW], 'so the account rows survive the run')
  assert.equal(context.busy, null, 'and the panel is free again')
  assert.deepEqual(said, [], 'nothing was reported as an error')
})

test('a growth run that outran its answer waits for the pass instead', async () => {
  const document = { accounts: [], growth: { last: { at: '2026-10-19T12:00:00.000Z' } } }
  const held = { accounts: 1, failed: 0, rows: [ROW] }
  const { context, calls, said } = panelGrowthRun({
    'xd.growthRun': { state: document, running: true },
  })
  context.growthState = held
  await context.runGrowth()
  assert.deepEqual(calls, ['xd.growthRun'],
    'a pass still running is not followed by a read of a state it has not reached')
  assert.equal(context.state, document, 'the document still lands, so the card keeps its figures')
  assert.equal(context.growthState, held, 'and the rows already on screen are left alone')
  assert.ok(said.some(([kind, message]) => kind === 'announce' && message === 'growth.running'),
    'the card says the pass is still going rather than sitting silent')
  assert.equal(context.busy, null, 'and the panel is free again')
})
/**
 * The keep-alive record is on screen even when the pass log is empty.
 *
 * "Refresh now" is a duty with no schedule, so its record is the only proof the
 * button did anything. The log belongs to the check-in pass, which a restart
 * clears while this record survives - and the whole note used to be replaced by
 * "never run" in that state, so a by-hand refresh reported nothing at all.
 */
test('the keep-alive line reports on its own, whatever the pass log says', () => {
  const { context, seen } = panelGrowth(['autoNoteRows', 'keepAliveNoteRow'])
  const record = { at: '2026-10-21T11:02:22.459Z', refreshed: 0, fresh: 6, failed: 0, noToken: 0 }
  // The pass log says nothing at all in this state, and the keep-alive still
  // reports - its record is the only proof the button did anything, and a
  // restart clears the pass log without touching it.
  assert.equal(context.autoNoteRows({ last: null }).map((row) => row.text).join(','), 'auto.neverRun',
    'the check-in log carries nothing but its own line')
  assert.equal(context.keepAliveNoteRow(record).text, 'auto.rowKeepAlive',
    'and the keep-alive reports from its own card')
  // The row's own words: the counts are read out of the record rather than
  // copied into the sentence, so a missing `fresh` shows up as `undefined`.
  const said = seen.find(([key]) => key === 'auto.rowKeepAlive')[1]
  assert.equal(JSON.stringify(said), JSON.stringify({ when: record.at, refreshed: 0, fresh: 6, failed: 0, noToken: 0 }),
    'the row carries every count the host reports, the fresh ones included')

  assert.equal(context.keepAliveNoteRow({ ...record, failed: 2 }).tone, 'fail', 'a failure colours the line')
  assert.equal(context.keepAliveNoteRow(record).tone, '', 'a pass that refreshed nothing is not a success')
  assert.equal(context.keepAliveNoteRow(null), null, 'a card with no run yet draws no line')
})

/**
 * The growth card's freshness rule.
 *
 * The card used to hold its read in the renderer only, so a repaint or a reload
 * turned a refresh into "go press Read state". These cases pin the rule that
 * replaced it: a read is stamped, a stored one is painted, and a run since the
 * read makes it stale.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

/** Lift the panel's growth freshness helpers, as the other panel cases do. */
function loadFreshness() {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const lift = (name) => {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    return source.slice(from, index + 1)
  }
  const stale = source.match(/var GROWTH_STALE_MS = [^\n]+/)
  assert.ok(stale, 'the throttle must be a named constant')
  const context = vm.createContext({
    state: null,
    growthState: null,
    Date,
    Number,
    Boolean,
    t: (key) => key,
    num: (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
    console,
  })
  vm.runInContext(stale[0], context)
  vm.runInContext(lift('growthLastRun'), context)
  vm.runInContext(lift('growthStale'), context)
  vm.runInContext(lift('growthStateText'), context)
  return context
}

const ROWS = { accounts: 1, failed: 0, rows: [{ id: 'a1', label: 'One', region: 'cn', days: 12, tiers: 1, makeupCards: 2, lottery: 0, tierList: [] }] }

test('no read at all is stale', () => {
  const context = loadFreshness()
  assert.equal(context.growthStale(), true)
  assert.equal(context.growthStateText(), 'growth.stateNone')
})

test('a read with no timestamp is treated as stale, not as current', () => {
  const context = loadFreshness()
  // The card cannot tell how old it is, so it refreshes rather than trusting it.
  context.growthState = { ...ROWS }
  assert.equal(context.growthStale(), true)
})

test('a fresh read is painted and not refreshed', () => {
  const context = loadFreshness()
  context.growthState = { ...ROWS, readAt: Date.now() }
  assert.equal(context.growthStale(), false, 'a read taken now is current')
  assert.match(context.growthStateText(), /growth\.stateSummary/,
    'the card shows its figures instead of asking for a read')
})

test('a read older than the throttle is refreshed', () => {
  const context = loadFreshness()
  context.growthState = { ...ROWS, readAt: Date.now() - context.GROWTH_STALE_MS - 1000 }
  assert.equal(context.growthStale(), true)
})

test('a run since the read makes it stale even when it is new', () => {
  const context = loadFreshness()
  const readAt = Date.now()
  context.growthState = { ...ROWS, readAt }
  // The run spent what the rows describe, so the figures no longer hold.
  context.state = { growth: { last: { at: new Date(readAt + 1000).toISOString() } } }
  assert.equal(context.growthStale(), true)
  assert.equal(context.growthStateText(), 'growth.stateStale')
})

test('a run from before the read leaves it current', () => {
  const context = loadFreshness()
  const readAt = Date.now()
  context.growthState = { ...ROWS, readAt }
  context.state = { growth: { last: { at: new Date(readAt - 60_000).toISOString() } } }
  assert.equal(context.growthStale(), false)
})

test('the later of a manual run and a scheduled pass is the one shown', () => {
  const context = loadFreshness()
  const manualAt = Date.parse('2026-10-30T18:33:00.000Z')
  const scheduledAt = Date.parse('2026-10-30T19:00:00.000Z')
  context.state = {
    growth: { last: { at: new Date(manualAt).toISOString(), detail: { gift: 1 } } },
    autoCheckin: { last: { at: new Date(scheduledAt).toISOString(), growth: { detail: { makeup: 2 } } } },
  }
  assert.equal(context.growthLastRun().detail.makeup, 2,
    'a scheduled pass that finished later must not be hidden behind an older manual run')
  context.state.autoCheckin.last.at = new Date(manualAt - 1000).toISOString()
  assert.equal(context.growthLastRun().detail.gift, 1,
    'and the manual run still wins when it is the later one')
})

/**
 * The scheduled check-in's growth half counts as a run.
 *
 * The timer records what it did under `autoCheckin.last.growth`, not under
 * `growth.last`, so reading only the latter kept the figures from before the
 * pass that had just spent them - and the card said so with a straight face for
 * the whole throttle window.
 */
test('a scheduled pass that ran growth makes the read stale', () => {
  const context = loadFreshness()
  const readAt = Date.now()
  context.growthState = { ...ROWS, readAt }
  context.state = {
    autoCheckin: { last: { at: new Date(readAt + 1000).toISOString(), growth: { claimed: 1, note: [] } } },
  }
  assert.equal(context.growthStale(), true, 'the pass spent the cards the rows still show')
})

/**
 * A timestamp in the future is a clock that moved, not a fresh read.
 *
 * `Date.now() - readAt` is negative for any future stamp, so it never crossed
 * the throttle and a stale figure stayed "current" forever.
 */
test('a read stamped in the future is treated as stale', () => {
  const context = loadFreshness()
  context.growthState = { ...ROWS, readAt: Date.now() + 60 * 60 * 1000 }
  assert.equal(context.growthStale(), true)
})

test('entering the growth tab re-reads a stale read, and waits out a running pass', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const at = source.indexOf('function selectTab(')
  assert.notEqual(at, -1, 'the tab switch must exist')
  const body = source.slice(at, source.indexOf('\n}', at))
  assert.match(body, /name === "growth"[\s\S]{0,240}?growthStale\(\)[\s\S]{0,120}?readGrowth\(\)/,
    'selecting the growth tab must read a stale state instead of waiting to be asked')
  assert.match(body, /state\.growth\.running/,
    'and must not fire beside a pass that is already walking the same accounts')
})

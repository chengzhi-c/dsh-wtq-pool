const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const file = ts.createSourceFile('panel.js', fs.readFileSync(path.join(__dirname, '../renderer/panel.js'), 'utf8'), ts.ScriptTarget.Latest, true)
const helpers = file.statements.filter(node =>
  ts.isFunctionDeclaration(node) && ['growthLastRun', 'growthStale', 'growthStateText', 'selectTab'].includes(node.name.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(file) === 'GROWTH_STALE_MS'))
  .map(node => node.getText(file)).join('\n')
function loadFreshness() {
  const context = vm.createContext({ activeTab: 'pool', state: null, growthState: null, Date, t: key => key,
    num: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback })
  vm.runInContext(helpers, context)
  return context
}
const ROWS = { accounts: 1, failed: 0, rows: [{ id: 'a1', tiers: 1, makeupCards: 2, lottery: 0 }] }

test('growth freshness follows its timestamp and the latest manual or scheduled mutation', () => {
  const context = loadFreshness(), now = Date.now(), at = delta => new Date(now + delta).toISOString()
  const fresh = { ...ROWS, readAt: now }
  for (const [name, read, state, stale, text] of [
    ['missing', null, null, true, 'growth.stateNone'],
    ['undated', ROWS, null, true, 'growth.stateSummary'],
    ['fresh', fresh, null, false, 'growth.stateSummary'],
    ['expired', { ...fresh, readAt: now - context.GROWTH_STALE_MS - 1000 }, null, true, 'growth.stateSummary'],
    ['new manual run', fresh, { growth: { last: { at: at(1000) } } }, true, 'growth.stateStale'],
    ['old manual run', fresh, { growth: { last: { at: at(-60000) } } }, false, 'growth.stateSummary'],
    ['new scheduled run', fresh, { autoCheckin: { last: { at: at(1000), growth: { claimed: 1 } } } }, true, 'growth.stateStale'],
    ['future timestamp', { ...fresh, readAt: now + 3600000 }, null, true, 'growth.stateSummary'],
  ]) {
    Object.assign(context, { growthState: read, state })
    assert.equal(context.growthStale(), stale, name)
    assert.equal(context.growthStateText(), text, name)
  }
})

test('the later of a manual run and a scheduled pass is shown', () => {
  const context = loadFreshness()
  context.state = {
    growth: { last: { at: '2026-10-30T18:33:00Z', detail: { streak: 1 } } },
    autoCheckin: { last: { at: '2026-10-30T19:00:00Z', growth: { detail: { makeup: 2 } } } },
  }
  assert.equal(context.growthLastRun().detail.makeup, 2)
  context.state.autoCheckin.last.at = '2026-10-30T18:32:00Z'
  assert.equal(context.growthLastRun().detail.streak, 1)
})

test('only navigating to a different view resets the scroll position', () => {
  const context = loadFreshness()
  let offset = 45
  Object.assign(context, { $: id => id, show() {}, document: { querySelectorAll: () => [] },
    pageScrollTo: top => { offset = top }, requestModelRoster() {} })

  context.selectTab('pool')
  assert.equal(offset, 45)
  context.selectTab('models')
  assert.equal(offset, 0)
})

test('entering the growth tab refreshes a stale read and waits for running work', () => {
  const context = loadFreshness()
  let reads = 0
  Object.assign(context, { $: id => id, show() {}, document: { querySelectorAll: () => [] },
    pageScrollTo() {}, readGrowth: () => { reads += 1 } })
  for (const { label, tab = 'growth', want, ...state } of [
    { label: 'stale read', want: 1 },
    { label: 'fresh read', growthState: { ...ROWS, readAt: Date.now() }, want: 0 },
    { label: 'running pass', state: { growth: { running: true } }, want: 0 },
    { label: 'busy action', busy: 'checkin', want: 0 },
    { label: 'pending read', growthReading: true, want: 0 },
    { label: 'another tab', tab: 'pool', want: 0 },
  ]) {
    reads = 0
    Object.assign(context, { state: null, growthState: null, busy: null, growthReading: false }, state)
    context.selectTab(tab)
    assert.equal(reads, want, label)
  }
})

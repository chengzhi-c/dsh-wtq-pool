const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.createSourceFile('panel.js', fs.readFileSync(path.join(__dirname, '../renderer/panel.js'), 'utf8'), ts.ScriptTarget.Latest, true)
const names = new Set(['adopt', 'stopPolling', 'adoptAndMaybePoll', 'stopGrowthPoll', 'pollGrowthRun', 'stopCheckinPoll', 'pollCheckinLog'])
const polling = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name.text))
  .map(node => node.getText(source)).join('\n')

function fixture(kind = 'refresh') {
  const timers = new Set()
  let reject
  const response = new Promise((_, fail) => { reject = fail })
  const context = vm.createContext({
    state: null, stateRevision: 0, refreshPoll: null, REFRESH_POLL_MS: 1200,
    busy: null, growthReadEpoch: 0, growthPoll: null, growthPollFailures: 0,
    GROWTH_POLL_MS: 2000, GROWTH_POLL_MAX_FAILURES: 3,
    checkinPoll: null, checkinPollFailures: 0, checkinPollAt: null, checkinBusyNote: false,
    CHECKIN_POLL_MS: 2000, CHECKIN_POLL_SLOW_MS: 10000, CHECKIN_POLL_LIMIT: 90, CHECKIN_POLL_MAX_FAILURES: 3,
    render() {}, pageIsVisible: () => true, invoke: () => response,
    window: { setTimeout(callback) { timers.add(callback); return callback }, clearTimeout: timer => timers.delete(timer) },
  })
  vm.runInContext(polling, context)
  const snapshot = kind === 'refresh' ? { refreshing: true, accounts: [] }
    : kind === 'growth' ? { growth: { running: true } }
      : { autoCheckin: { last: { pending: true, at: 'old-run' } } }
  const poll = kind === 'refresh' ? () => context.adoptAndMaybePoll(snapshot, 0)
    : kind === 'growth' ? () => context.pollGrowthRun() : () => context.pollCheckinLog(0)
  context.adopt(snapshot)
  poll()
  const callback = context[kind === 'refresh' ? 'refreshPoll' : kind === 'growth' ? 'growthPoll' : 'checkinPoll']
  timers.delete(callback)
  callback()
  return { context, timers, reject }
}

test('an older failed panel poll cannot stop a newer refresh', async () => {
  const { context, timers, reject } = fixture()
  const latest = { refreshing: true, accounts: [{ id: 'new-account' }] }
  context.adoptAndMaybePoll(latest, 0)
  const nextPoll = context.refreshPoll
  reject(new Error('old request failed'))
  await new Promise(setImmediate)
  assert.equal(context.state, latest, 'the newer refresh must remain in progress')
  assert.equal(context.refreshPoll, nextPoll)
  assert.ok(timers.has(nextPoll), 'the newer refresh must still be polled')
})

test('a failed current panel poll stops its refresh', async () => {
  const { context, timers, reject } = fixture()
  reject(new Error('current request failed'))
  await new Promise(setImmediate)
  assert.equal(context.state.refreshing, false)
  assert.equal(context.refreshPoll, null)
  assert.equal(timers.size, 0)
})

for (const kind of ['growth', 'checkin']) {
  test(`an old ${kind} poll failure does not count against the newer state`, async () => {
    const { context, reject } = fixture(kind)
    const latest = kind === 'growth' ? { growth: { running: true } }
      : { autoCheckin: { last: { pending: true, at: 'new-run' } } }
    context.adopt(latest)
    if (kind === 'growth') context.pollGrowthRun()
    else context.pollCheckinLog(0)
    reject(new Error('old request failed'))
    await new Promise(setImmediate)
    assert.equal(context[`${kind}PollFailures`], 0)
    assert.equal(context.state, latest)
  })
}

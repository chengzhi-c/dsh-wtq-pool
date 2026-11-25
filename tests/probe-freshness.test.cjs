const { transpile } = require('./ts-loader.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { WorkBuddyAccountPool } = require('../src/accounts.ts')

async function fixture(t, client) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-probe-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  fs.writeFileSync(path.join(temporary, 'login.info'), JSON.stringify({
    auth: { accessToken: 'fixture', expiresAt: Date.now() + 3600000 }, account: { uin: 'fixture' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [temporary], client })
  await pool.scan()
  const entry = path.resolve(__dirname, '../src/host.ts')
  const context = vm.createContext({
    require: createRequire(entry), module: { exports: {} }, __dirname: temporary,
    console: { log() {} }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
    testPool: pool, testClient: client,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(entry, 'utf8')), context)
  vm.runInContext('core.pool = testPool; core.client = testClient; serviceStopped = false; scheduleRefresh = () => {}', context)
  return { pool, context, account: pool.list()[0] }
}

test('the newer balance determines reserve eligibility in either completion order', async t => {
  for (const order of [[0, 1], [1, 0]]) {
    const release = []
    const balances = [10, 100].map(total => new Promise(resolve => release.push(() => resolve({ total }))))
    const { pool, context, account } = await fixture(t, {
      fetchCredits: () => balances.shift(),
      fetchCheckinStatus: async () => ({ active: true }),
    })
    pool.applyConfig({ creditReserves: { [account.id]: 50 } })
    const probes = [context.accountProbe(account, true), context.accountProbe(account, true)]
    release[order[0]]()
    await probes[order[0]]
    release[order[1]]()
    assert.equal((await probes[order[1]]).credits.total, 100)
    assert.equal(pool.available(Date.now()).length, 1, 'the pool must use the same fresh balance as the panel')
  }
})

test('the newest growth read owns the cache when an older read finishes later', async t => {
  const { context } = await fixture(t, {})
  const releases = []
  context.readGrowthState = () => new Promise(resolve => releases.push(resolve))
  const older = context.onPanelInvoke('xd.growthState')
  const newer = context.onPanelInvoke('xd.growthState')
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve))
  releases[1]({ accounts: 1, failed: 0, rows: [{ id: 'newer' }] })
  await newer
  releases[0]({ accounts: 1, failed: 0, rows: [{ id: 'older' }] })
  await older
  assert.equal(vm.runInContext('growthRead.rows[0].id', context), 'newer')
})

for (const invalidate of ['claim', 'service stop']) test(`a cold probe cannot restore stale check-in state after ${invalidate}`, async t => {
  let release, started
  const reading = new Promise(resolve => { started = resolve })
  const { context, account } = await fixture(t, {
    fetchCheckinStatus: () => { started(); return new Promise(resolve => { release = resolve }) },
    growthAccountAction: async () => ({ credit: 20 }),
  })
  const old = context.accountProbe(account, true, true)
  await reading
  if (invalidate === 'claim') await context.onPanelInvoke('xd.growthAction', { id: account.id, action: 'travelClaim' })
  else await context.onServiceStop()
  release({ active: true, todayCheckedIn: false })
  assert.equal((await old).pending, true)
  assert.equal(vm.runInContext('probeCache.size', context), 0)
  if (invalidate === 'claim') {
    context.testClient.fetchCheckinStatus = async () => ({ active: true, todayCheckedIn: true })
    const fresh = await context.accountProbe(account, true, true)
    assert.equal(fresh.pending, undefined)
    assert.equal(fresh.checkin.todayCheckedIn, true)
  }
})

for (const source of ['workbuddy', 'workbuddy batch', 'trae', 'qoder']) test(`${source} stops claiming when disabled during its status read`, async t => {
  for (const interruption of ['service stop', 'source off', 'region off', ...(source.startsWith('workbuddy') ? ['account off', 'account removed'] : [])]) {
    let release, started
    const reading = new Promise(resolve => { started = resolve })
    const read = () => { started(); return new Promise(resolve => { release = resolve }) }
    let claims = 0
    const { context, account } = await fixture(t, {
      fetchCheckinStatus: read, claimDailyCheckin: async () => { claims++; return { credit: 20 } },
    })
    let work, status = { active: true, todayCheckedIn: false }
    if (source === 'workbuddy') work = context.onPanelInvoke('xd.checkin', { accountId: account.id })
    else if (source === 'workbuddy batch') work = context.claimAllCheckins()
    else if (source === 'trae') {
      const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
      t.mock.method(TraeSoloUpstreamClient.prototype, 'fetchCheckinStatus', read)
      t.mock.method(TraeSoloUpstreamClient.prototype, 'claimCheckin', async () => { claims++; return { code: 0 } })
      work = context.traeClaimFor({ edition: 'cn', userId: 'fixture' }, [])
      status = { code: 0, enable: true, checkedIn: false }
    } else {
      const { QoderUpstreamClient } = require('../src/qoder-client.ts')
      t.mock.method(QoderUpstreamClient.prototype, 'fetchCampaigns', read)
      t.mock.method(QoderUpstreamClient.prototype, 'claimCampaign', async () => { claims++; return { status: 'CLAIMED' } })
      work = context.qoderClaimFor({ region: 'cn', userID: 'fixture', name: '', token: 'fixture' })
      status = { campaigns: [{ campaignId: 'today', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 20 } }] }
    }
    const settled = work.catch(error => error)
    await reading
    if (interruption === 'service stop') await context.onServiceStop()
    else if (interruption === 'account off') context.testPool.applyConfig({ disabledAccountIds: [account.id] })
    else if (interruption === 'account removed') context.testPool.applyRemoved([account.id])
    else if (interruption === 'region off') vm.runInContext(`settings.disabledRegions = ['${source.split(' ')[0]}:cn']`, context)
    else vm.runInContext(`settings[SOURCE_SETTING_KEYS['${source.split(' ')[0]}']] = false`, context)
    release(status)
    await settled
    assert.equal(claims, 0, interruption)
  }
})

test('travel skips accounts without a buddy', async t => {
  let mutations = 0
  const { context, account } = await fixture(t, {
    fetchBuddyInfo: async () => null,
    reportChatActivity: async () => { mutations++ },
    agreeBuddy: async () => { mutations++ }, adoptBuddy: async () => { mutations++ },
  })
  context.checkinPause = async () => {}
  assert.equal((await context.travelOne(account)).outcome, 'skipped')
  assert.equal(mutations, 0)
})

for (const stage of ['idle', 'arrived']) test(`travel ${stage} stops mutations when disabled during its status read`, async t => {
  for (const interruption of ['service stop', 'source off', 'region off']) {
    let release, started, mutations = 0
    const reading = new Promise(resolve => { started = resolve })
    const read = () => { started(); return new Promise(resolve => { release = resolve }) }
    const mutate = async () => { mutations++ }
    const { context, account } = await fixture(t, {
      fetchBuddyInfo: async () => ({}), fetchTravelStatus: read,
      departTravel: mutate, claimTravelReward: mutate,
    })
    context.checkinDelay = async () => {}
    const work = context.travelOne(account)
    await reading
    if (interruption === 'service stop') await context.onServiceStop()
    else if (interruption === 'source off') vm.runInContext('settings.sourceWorkbuddy = false', context)
    else vm.runInContext("settings.disabledRegions = ['workbuddy:cn']", context)
    release({ state: stage })
    await work
    assert.equal(mutations, 0, interruption)
  }
})

for (const source of ['growth', 'travel']) test(`a retired ${source} batch keeps the replacement activation's balance cache`, async t => {
  const { context, account } = await fixture(t, {})
  let release, started
  const reading = new Promise(resolve => { started = resolve })
  context[source === 'growth' ? 'redeemAccountStreak' : 'travelOne'] = () => {
    started(); return new Promise(resolve => { release = resolve })
  }
  const work = source === 'growth' ? context.claimAllGrowth() : context.travelAllAccounts()
  await reading
  await context.onServiceStop()
  context.accountId = account.id
  vm.runInContext('loadGeneration++; serviceStopped = false; probeCache.set(accountId, { value: { credits: { total: 99 } } })', context)
  release(source === 'growth' ? { claimed: 1, credit: 20, detail: { lottery: 0 } } : { outcome: 'claimed', credit: 20 })
  await work
  assert.equal(vm.runInContext('probeCache.get(accountId)?.value.credits.total', context), 99)
})

test('a retired keep-alive pass cannot refresh the remaining old accounts after restart', async t => {
  let release, started, calls = 0
  const reading = new Promise(resolve => { started = resolve })
  const { context, pool, account } = await fixture(t, {
    refreshToken: async () => {
      if (++calls === 1) { started(); await new Promise(resolve => { release = resolve }) }
      return { accessToken: 'renewed', expiresInSec: 3600 }
    },
  })
  fs.writeFileSync(path.join(path.dirname(account.credential.sourcePath), 'second.info'), JSON.stringify({
    auth: { accessToken: 'second', expiresAt: Date.now() + 3600000 }, account: { uin: 'second' },
  }))
  await pool.scan()
  for (const row of pool.list()) Object.assign(row.credential, { refreshToken: 'fixture', expiresAtMs: 0 })
  const work = context.keepAliveTokens()
  await reading
  await context.onServiceStop()
  vm.runInContext('loadGeneration++; serviceStopped = false', context)
  release()
  await work
  assert.equal(calls, 1)
})

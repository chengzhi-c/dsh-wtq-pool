const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./ts-loader.cjs')
const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')

const credential = { region: 'cn', accessToken: 'fixture', domain: 'www.codebuddy.cn' }
function fixture(data) {
  const calls = []
  const client = new WorkBuddyUpstreamClient({ fetchImpl: async (url, init) => {
    const pathname = new URL(url).pathname
    calls.push({ path: pathname, method: init.method || 'GET', body: init.body && JSON.parse(init.body) })
    const value = typeof data === 'function' ? data(pathname) : data
    return new Response(JSON.stringify({ code: 0, data: value }), { status: 200 })
  } })
  return { client, calls }
}

test('streak redemption reports the receipt instead of the advertised reward', async () => {
  const { client, calls } = fixture({ credit_granted: '50', energy_granted: 3, cards_granted: 1, chances_granted: 1 })
  assert.deepEqual(await client.redeemStreakTier(credential, '14d'), { credit: 50, energy: 3, cards: 1, chances: 1 })
  assert.equal(calls[0].body.tier, '14d')
  assert.equal(typeof calls[0].body.client_token, 'string')
})

test('the live available tier status enables redemption', async () => {
  const { client } = fixture({ streak: { days: 23 }, redemption_status: {
    tiers: [{ tier: '14d', days: 14, credit: 50 }], tier_14d_status: 'available',
  } })
  assert.equal((await client.growthStreakFull(credential)).tiers[0].status, 'unlocked')
})

test('growth details preserve available sections when one module is unavailable', async () => {
  const { client, calls } = fixture(path => {
    if (path.endsWith('/buddy/info')) return { buddy: { id: 1, name: 'Mochi' } }
    if (path.endsWith('/travel/config')) return { locations: [{ id: 9, name: 'Forest' }] }
    if (path.endsWith('/travel/status')) return { state: 'traveling', location: { id: 9, name: 'Forest' }, arrive_at: 1800000000 }
    if (path.endsWith('/heatmap')) throw new Error('heatmap unavailable')
    if (path.endsWith('/lottery/summary')) return { chances: 2, module: { enabled: true } }
    throw new Error('unexpected ' + path)
  })
  const result = await client.growthAccountDetails(credential)
  assert.equal(result.buddy.name, 'Mochi')
  assert.equal(result.travel.locations[0].id, 9)
  assert.equal(result.travel.status.arrive_at, 1800000000)
  assert.match(result.errors.heatmap, /heatmap unavailable/)
  assert.ok(calls.every(call => call.method === 'GET'))
})

test('global growth details do not read the disabled lottery', async () => {
  const { client, calls } = fixture(() => ({}))
  const result = await client.growthAccountDetails({ ...credential, domain: 'www.workbuddy.ai' })
  assert.equal(result.lottery, undefined)
  assert.deepEqual(calls.map(call => call.path), ['/activity/growth/heatmap'])
})

test('growth actions match official travel and makeup request contracts', async () => {
  const { client, calls } = fixture(path => path.endsWith('/buddy/info')
    ? { buddy: { id: 1, name: 'Mochi' } }
    : { reward_credit: '28' })
  const active = () => {}
  for (const [action, value, path, body] of [
    ['makeup', '2026-11-22', '/activity/growth/makeup-cards/use', { target_date: '2026-11-22' }],
    ['travelDepart', 9, '/activity/growth/buddy/travel/depart', { location_id: 9 }],
  ]) {
    await client.growthAccountAction(credential, action, value, active)
    assert.deepEqual(calls.at(-1), { path, method: 'POST', body })
  }
  assert.deepEqual(await client.growthAccountAction(credential, 'travelClaim', undefined, active), { credit: 28 })
  assert.deepEqual(calls.at(-1), { path: '/activity/growth/buddy/travel/claim', method: 'POST', body: {} })
  const count = calls.length
  for (const [action, value] of [['bad', 'x'], ['travelDepart', 0], ['makeup', 'bad']]) {
    await assert.rejects(client.growthAccountAction(credential, action, value, active), /invalid/i)
  }
  assert.equal(calls.length, count)
})

test('travel departure refuses an account without an adopted cat', async () => {
  const { client } = fixture(() => ({ buddy: null }))
  await assert.rejects(client.growthAccountAction(credential, 'travelDepart', 9, () => {}), /not adopted/i)
})

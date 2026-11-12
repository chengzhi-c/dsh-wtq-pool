/**
 * Qoder's two usage routes, and the fallback between them.
 *
 * The presentation route carries the per-model packages, the older quota route
 * carries the account pool. A 200 that names only `expiresAt` is not a usable
 * usage document: taking it as one skipped the fallback and then threw, so the
 * card said "usage unavailable" while the other route had an answer.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

require('./ts-loader.cjs')

const { QoderUpstreamClient, qoderClaimableCampaignIdOf, qoderCheckinStateFrom } = require('../src/qoder-client.ts')

test('a presentation document with only an expiry falls back to the quota route', async () => {
  const seen = []
  const client = new QoderUpstreamClient({
    region: 'cn',
    credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
    fetchImpl: async (url) => {
      seen.push(String(url))
      if (String(url).includes('/me/usage')) {
        return new Response(JSON.stringify({ expiresAt: Date.now() + 86_400_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ user_quota: { total: 10, remaining: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const usage = await client.fetchUsage()
  assert.equal(seen.length, 2, 'the unusable presentation document must not skip the fallback')
  assert.equal(usage.source, 'quota')
  assert.deepEqual(usage.userQuota, { total: 10, remaining: 5 })
})

/**
 * The daily check-in is served on both of Qoder's sites.
 *
 * The campaigns route and the claim it posts to are the same path on both
 * hosts, so the only thing that makes a site work is which host the client was
 * built for. Nothing in the check-in path is conditional on the region: the
 * card reads the campaign list on either one, and the automatic pass walks
 * every region the source is enabled for. A regression here would be a claim
 * sent to the wrong host, which the upstream answers with a 404 - and the panel
 * would report a failed check-in for an account that was never asked.
 */


const HOSTS = { cn: 'https://openapi.qoder.com.cn', global: 'https://openapi.qoder.sh' }

/** A campaign document shaped like the upstream's, for one claimable round. */
function campaignDocument({ claimStatus = 'CLAIMABLE' } = {}) {
  const now = Date.now()
  return {
    campaigns: [{
      campaignId: 'round-42',
      actionType: 'CLAIM_BENEFIT',
      claimStatus,
      startAt: Math.floor((now - 3_600_000) / 1000),
      endAt: Math.floor((now + 20 * 3_600_000) / 1000),
      benefit: { amount: 100 },
    }],
  }
}

for (const [region, host] of Object.entries(HOSTS)) {
  test(`the ${region} check-in reads and claims on its own host`, async () => {
    const calls = []
    const client = new QoderUpstreamClient({
      region,
      credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
        const body = String(url).endsWith('/claim')
          ? { status: 'CLAIMED', benefit: { amount: 100 } }
          : campaignDocument()
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    const campaigns = await client.fetchCampaigns()
    const id = qoderClaimableCampaignIdOf(campaigns)
    assert.equal(id, 'round-42', 'the card has to see the round as claimable to offer it')
    assert.equal(qoderCheckinStateFrom(campaigns).active, true, 'and the round is open')

    await client.claimCampaign(id)

    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      `GET ${host}/sash/api/v1/me/campaigns`,
      `POST ${host}/sash/api/v1/me/campaigns/round-42/claim`,
    ], 'a claim sent to the other site would be a 404 for an account that is fine')
    assert.equal(calls[1].body, '{}', 'the claim is posted with an empty object, as the route expects')
  })
}

test('a round already collected reads as the day\'s check-in, not as still claimable', () => {
  // The automatic pass decides from this whether there is anything to do; a
  // claimed round read as claimable would have it post a claim on every tick.
  const claimed = campaignDocument({ claimStatus: 'CLAIMED' })
  assert.equal(qoderClaimableCampaignIdOf(claimed), undefined,
    'a collected round is not offered again')
  assert.equal(qoderCheckinStateFrom(claimed).todayCheckedIn, true,
    'and the card says the day is done')
})

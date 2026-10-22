/**
 * A credit pack's expiry, read off the billing document itself.
 *
 * The parser normalises two timestamp shapes - an epoch in milliseconds and one
 * in seconds - because the upstream sends both. Every other test that mentions
 * credits replaces `fetchCredits` with a literal, so neither shape was ever
 * parsed: taking the seconds branch out left the whole suite green, while a pack
 * whose expiry came back as seconds silently lost its deadline and the `expiry`
 * distribution went blind to it.
 *
 * This drives the real client against a fixture document, so the normalisation
 * is observed where it happens.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const fs = require('node:fs')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

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




const credential = {
  accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
  expiresAt: Date.now() + 3_600_000, domain: 'www.workbuddy.cn',
}

/** The billing answer, in the envelope shape the client unwraps. */
function billingDocument(accounts) {
  return JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: accounts } } } })
}

function clientReturning(accounts) {
  const calls = []
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') })
      return new Response(billingDocument(accounts), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  return { client, calls }
}

const IN_THREE_DAYS_MS = Date.now() + 3 * 24 * 60 * 60 * 1000

test('a pack expiry stated in seconds is read as the same instant in milliseconds', async () => {
  const seconds = Math.floor(IN_THREE_DAYS_MS / 1000)
  const { client } = clientReturning([{
    PackageName: 'monthly-refill', CapacityType: 1, CapacitySize: 100, CapacityRemain: 40,
    ExpiredTime: seconds,
  }])

  const credits = await client.fetchCredits(credential)
  assert.equal(credits.packages.length, 1)
  assert.equal(credits.packages[0].expiresAtMs, seconds * 1000,
    'a seconds epoch must be scaled, not taken as a 1970 date')
  assert.equal(credits.total, 40)
  // The consequence, not just the field: the pack lands within the three-day
  // window only if the instant was read correctly.
  assert.equal(credits.expiringSoon, 40,
    'a pack expiring in three days counts toward the near-expiry figure')
  assert.equal(credits.nearestExpiryMs, seconds * 1000,
    'and it is the deadline the expiry distribution will sort on')
})

test('a pack expiry already in milliseconds is left alone', async () => {
  const { client } = clientReturning([{
    PackageName: 'monthly-refill', CapacityType: 1, CapacitySize: 100, CapacityRemain: 40,
    ExpiredTime: Math.floor(IN_THREE_DAYS_MS),
  }])
  const credits = await client.fetchCredits(credential)
  assert.equal(credits.packages[0].expiresAtMs, Math.floor(IN_THREE_DAYS_MS),
    'scaling a millisecond figure would push it thousands of years out')
})

test('a monthly pack carries its cycle end, and no expiry of its own', async () => {
  const { client } = clientReturning([{
    PackageName: 'monthly-cycle', CapacityType: 4,
    CycleCapacitySize: 500, CycleCapacityRemain: 120,
    CycleEndTime: Math.floor(IN_THREE_DAYS_MS),
  }])
  const credits = await client.fetchCredits(credential)
  assert.equal(credits.packages[0].monthly, true)
  assert.equal(credits.packages[0].expiresAtMs, undefined,
    'a monthly pack does not expire; it refreshes')
  assert.equal(credits.packages[0].refreshAtMs, Math.floor(IN_THREE_DAYS_MS) + 1000,
    'the cycle end is when it refreshes')
  assert.equal(credits.total, 120, 'the remain it contributes is the cycle figure')
})

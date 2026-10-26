'use strict'

/**
 * The answer a gateway gives when every account it holds is present but unusable.
 *
 * The status has to follow the reason. Deciding it from the timestamps instead
 * meant a `session` hold - which also writes a cooldown - was answered as a rate
 * limit, so the user was told to wait out a window when the remedy was to sign
 * in again, and every reason that needs a different remedy was unreachable.
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

// The core imports its siblings without an extension, so the loader needs the
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

const { unavailableAnswer } = require('../src/shim.ts')

/** A pool that answers one fixed reason for every account it is asked about. */
const poolSaying = (reason) => ({ unavailableReason: () => reason })

const account = (overrides) => ({ id: 'a', cooldownUntilMs: 0, modelCooldowns: {}, ...overrides })

const NOW = 1_000_000

test('a rate limit is the one reason answered as a retryable 429', () => {
  const answer = unavailableAnswer(
    poolSaying('rate-limited'),
    [
      account({ id: 'a', modelCooldowns: { m: NOW + 60_000 } }),
      account({ id: 'b', modelCooldowns: { m: NOW + 120_000 } }),
    ],
    NOW,
    'm',
  )
  assert.equal(answer.status, 429)
  assert.equal(answer.code, 'soft_rate')
  assert.equal(answer.retryAfterSeconds, 60, 'the soonest window, in seconds')
  assert.match(answer.detail, /rate-limited for model m/)
})

test('a hold is answered as the remedy it needs, never as a rate limit', () => {
  // Both of these also carry a future cooldown, which is exactly what made the
  // old timestamp-based test answer 429 for them.
  const cooling = (id) => account({ id, cooldownUntilMs: NOW + 3_600_000 })

  const refused = unavailableAnswer(poolSaying('sign-in refused'), [cooling('a'), cooling('b')], NOW, 'm')
  assert.equal(refused.status, 503, 'a refused sign-in cannot be retried into working')
  assert.equal(refused.code, 'accounts_unavailable')
  assert.match(refused.detail, /sign in again/)
  assert.equal(refused.retryAfterSeconds, undefined, 'and there is no deadline to wait for')

  const hold = unavailableAnswer(poolSaying('on hold'), [cooling('a')], NOW, 'm')
  assert.equal(hold.status, 503)
  assert.match(hold.detail, /credits/)

  const expired = unavailableAnswer(poolSaying('sign-in expired'), [cooling('a')], NOW, 'm')
  assert.equal(expired.status, 503)
  assert.match(expired.detail, /expired/)
})

test('a mixed pool names no single remedy but still carries the deadline that will pass', () => {
  const reasons = ['sign-in refused', 'rate-limited']
  const mixed = { unavailableReason: () => reasons.shift() ?? 'on hold' }
  const answer = unavailableAnswer(
    mixed,
    [account({ id: 'a', cooldownUntilMs: NOW + 1000 }), account({ id: 'b', modelCooldowns: { m: NOW + 90_000 } })],
    NOW,
    'm',
  )
  assert.equal(answer.status, 503, 'one account needs a sign-in, the other is rate-limited: neither 429 applies')
  assert.match(answer.detail, /no WorkBuddy account is available for model m/)
  // The host honours Retry-After on 5xx, and the limit is the only part of this
  // answer that will clear on its own.
  assert.equal(answer.retryAfterSeconds, 90, 'the wait for the account that will come back')
})

test('a pool with nothing rate-limited carries no deadline', () => {
  const answer = unavailableAnswer(poolSaying('on hold'), [account({ id: 'a', cooldownUntilMs: NOW + 3_600_000 })], NOW, 'm')
  assert.equal(answer.status, 503)
  assert.equal(answer.retryAfterSeconds, undefined, 'waiting out a hold is not the remedy')
})

test('an empty pool cannot claim a rate limit', () => {
  // All-switched-off accounts never reach `unavailableReason`, and must not read
  // as a retryable limit either.
  const answer = unavailableAnswer(poolSaying(null), [], NOW, 'm')
  assert.equal(answer.status, 503)
  assert.equal(answer.retryAfterSeconds, undefined)
})

/**
 * The reason strings above are fed in as literals, so the pool that produces
 * them had no caller in this file: `poolSaying` replaced the very function under
 * test, and changing it to answer 'on hold' for everything left every case green.
 *
 * These two drive the real pool, so the mapping from what the pool decides to
 * what the user is told is observed rather than assumed.
 */
test('the real pool tells a refused sign-in apart from a spent account', () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const now = Date.now()
  const pool = new WorkBuddyAccountPool({ authDirs: [], client: {} })
  pool.accounts = [
    { id: 'refused', label: 'refused', credential: { accessToken: 'a', refreshToken: 'r', expiresAt: now + 3_600_000, domain: 'www.workbuddy.cn' }, cooldownUntilMs: 0, modelCooldowns: {} },
    { id: 'spent', label: 'spent', credential: { accessToken: 'b', refreshToken: 'r', expiresAt: now + 3_600_000, domain: 'www.workbuddy.cn' }, cooldownUntilMs: 0, modelCooldowns: {} },
  ]
  // A session hold and a credit hold both write a cooldown; only the reason
  // recorded beside it says which remedy applies.
  pool.penalize('refused', now + 600_000, undefined, 'session')
  pool.penalize('spent', now + 600_000, undefined, 'spent')

  assert.equal(pool.unavailableReason('refused', now), 'sign-in refused',
    'a session hold must name the sign-in, not a balance')
  assert.equal(pool.unavailableReason('spent', now), 'on hold',
    'and a spent account must not be described as a sign-in problem')

  // And the two reach the user as different advice.
  const refused = unavailableAnswer(pool, [{ id: 'refused', cooldownUntilMs: now + 600_000, modelCooldowns: {} }], now, 'm')
  assert.equal(refused.status, 503)
  assert.match(refused.detail, /sign in again/, 'the remedy is a fresh sign-in')

  const spent = unavailableAnswer(pool, [{ id: 'spent', cooldownUntilMs: now + 600_000, modelCooldowns: {} }], now, 'm')
  assert.equal(spent.status, 503)
  assert.match(spent.detail, /credits/, 'the remedy is the balance, and the two answers must not agree')
  assert.doesNotMatch(spent.detail, /sign in again/)
})

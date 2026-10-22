'use strict'

/**
 * The token keep-alive, which the panel runs by hand.
 *
 * It has no schedule: the button is the only thing that starts a pass, so
 * nothing here arms a timer or reads a switch. What the cases do prove is that
 * the pass refreshes what needs refreshing, spends nothing on what does not,
 * and answers each of `ensureFresh`'s outcomes as its own number rather than
 * folding them together.
 */

const assert = require('node:assert')
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

/**
 * Boot the plugin with one WorkBuddy account whose token the fixture controls.
 *
 * `expiresInMs` is the token's remaining life, so a case can put the account on
 * either side of the refresh margin without touching the clock. `refreshAnswer`
 * is what the upstream's refresh endpoint answers, which is where a dead session
 * shows up.
 */
async function loadPlugin(t, temporary, options = {}) {
  const auth = path.join(temporary, 'auth')
  fs.mkdirSync(auth, { recursive: true })
  const settings = {
    enabled: true, sourceWorkbuddy: true, sourceTrae: false, sourceQoder: false,
    disabledRegions: ['workbuddy:global'], authFile: path.join(auth, 'login.info'),
    autoCheckin: { enabled: false, hours: [9] },
  }
  const { installPi } = require('../src/pi-compat.ts')
  installPi({
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })
  // `in` rather than `??`: a case that wants no refresh token at all passes
  // null, which `??` would read as "not given" and paper over with the default.
  const refreshToken = 'refreshToken' in options ? options.refreshToken : 'fixture-refresh'
  fs.writeFileSync(settings.authFile, JSON.stringify({
    auth: {
      accessToken: 'fixture-token',
      ...refreshToken === null ? {} : { refreshToken },
      expiresAt: Date.now() + (options.expiresInMs ?? 3600000),
    },
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
  record('refreshToken', options.refreshAnswer ?? (async () => ({
    accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresInSec: 3600,
  })))

  // Captured rather than armed: a pass that arms a timer would escape the test,
  // and there is no schedule left for one to serve anyway.
  const timers = new Set()
  let now = Date.now()
  const context = vm.createContext({
    require: createRequire(path.join(root, 'src/host.ts')),
    module: { exports: {} }, exports: {}, __dirname: temporary,
    console: { log() {}, warn() {}, error() {} }, AbortController, AbortSignal, fetch,
    Date: class extends Date { static now() { return now } },
    setTimeout, clearTimeout,
    setInterval: (callback, ms) => {
      const timer = { callback, ms, at: now + ms }
      timers.add(timer)
      return timer
    },
    clearInterval: (timer) => { timers.delete(timer) },
    process,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')), context)
  const plugin = context.module.exports
  await plugin.onLoad()
  return {
    plugin, spent, timers, settings,
    advance: (ms) => { now += ms },
    // Run whatever the armed interval has come due for, on the same clock the
    // entry reads.
    fireDue: () => {
      for (const timer of [...timers]) if (timer.at <= now) timer.callback()
    },
  }
}

test('the keep-alive refreshes a token that is close to expiry', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-keepalive-'))
  const { plugin, spent } = await loadPlugin(t, temporary, { expiresInMs: 60 * 1000 })
  try {
    const answer = await plugin.onPanelInvoke('xd.keepAlive')
    assert.deepEqual(JSON.parse(JSON.stringify(answer.keepAlive)), {
      at: answer.keepAlive.at, refreshed: 1, fresh: 0, failed: 0, noToken: 0,
    }, 'one account inside the margin is refreshed')
    assert.ok(spent.some(([name]) => name === 'refreshToken'), 'and the refresh endpoint was actually called')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('the keep-alive leaves a token that still has time on it alone', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-keepalive-'))
  const { plugin, spent } = await loadPlugin(t, temporary, { expiresInMs: 6 * 60 * 60 * 1000 })
  try {
    const answer = await plugin.onPanelInvoke('xd.keepAlive')
    assert.equal(answer.keepAlive.fresh, 1, 'an account with hours left is reported as fresh')
    assert.equal(answer.keepAlive.refreshed, 0, 'and nothing was refreshed')
    assert.equal(spent.filter(([name]) => name === 'refreshToken').length, 0,
      'so the pass spent no upstream call at all')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('the keep-alive reports an account with no refresh token as dead for good', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-keepalive-'))
  const { plugin } = await loadPlugin(t, temporary, { expiresInMs: 5 * 1000, refreshToken: null })
  try {
    const answer = await plugin.onPanelInvoke('xd.keepAlive')
    assert.equal(answer.keepAlive.noToken, 1, 'an expired token with nothing to refresh it with is its own outcome')
    assert.equal(answer.keepAlive.refreshed, 0)
    assert.equal(answer.keepAlive.failed, 0, 'and it is not counted as a failure the upstream caused')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('the keep-alive counts a refresh the upstream refused', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-keepalive-'))
  const { plugin } = await loadPlugin(t, temporary, {
    expiresInMs: 60 * 1000,
    refreshAnswer: async () => { throw new Error('Offline user session not found') },
  })
  try {
    const answer = await plugin.onPanelInvoke('xd.keepAlive')
    assert.equal(answer.keepAlive.failed, 1, 'a refused refresh is counted rather than swallowed')
    assert.equal(answer.keepAlive.refreshed, 0)
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * The pass runs on the button and nowhere else.
 *
 * A background interval, or a settings key deciding whether one is armed, is
 * what this case rules out: the keep-alive is a control the user presses, not a
 * duty that runs while nobody is watching. A pass armed at load would show up
 * as a timer the entry created, and the key it would follow as a field of the
 * document the panel reads.
 */
test('the keep-alive is run by the button and arms no timer of its own', async (t) => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-keepalive-'))
  const { plugin, timers, settings } = await loadPlugin(t, temporary, { expiresInMs: 60 * 1000 })
  try {
    assert.equal(timers.size, 0, 'no timer is armed while the plugin sits idle')
    const state = await plugin.onPanelInvoke('xd.state')
    assert.ok(!('tokenKeepAlive' in state),
      'and the document carries no switch, because there is nothing to switch on or off')
    assert.ok(!('tokenKeepAlive' in settings), 'and the settings file holds no such key either')

    const answer = await plugin.onPanelInvoke('xd.keepAlive')
    assert.equal(answer.keepAlive.refreshed, 1, 'the pass runs when it is asked to')
    assert.equal(timers.size, 0, 'and it arms nothing on the way out')

    // Nothing has come due, so a pass that left a timer behind would still be
    // waiting on this clock rather than having already spent it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = await plugin.onPanelInvoke('xd.state')
    assert.ok(after.keepAlive !== null, 'the pass records itself for the panel\'s log line')
    assert.equal(timers.size, 0, 'and the plugin is still idle afterwards')
  } finally {
    await plugin.onUnload()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

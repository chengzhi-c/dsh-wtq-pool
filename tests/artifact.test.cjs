'use strict'

/**
 * The published artifact, exercised.
 *
 * Every other file in this suite transpiles `src/*.ts` in memory, so none of
 * them touches `lib/index.js` — the `main` this package actually ships. A build
 * that drops a module, an `exports` map that points at nothing, or a source fix
 * that was never rebuilt all ship green without this file.
 *
 * The case is deliberately about the entry's own contract: activate through
 * `apply(ctx, config)`, read one panel document, publish providers, unload. It
 * never reaches a vendor, because the fixture config switches every source off.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const built = path.join(root, 'lib', 'index.js')

test('the built entry loads and exports the contract the host calls', () => {
  assert.ok(fs.existsSync(built), 'lib/index.js must exist: `npm run build` produces it and `main` points at it')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'lib/index.js', 'package.json main must name the file this case loads')
  assert.equal(pkg.exports['.'].default, './lib/index.js', 'and the default export entry with it')
  const plugin = require(built)
  for (const name of ['apply', 'onLoad', 'onPanelInvoke', 'onUnload', 'name']) {
    assert.ok(plugin[name] !== undefined, `the built entry must export ${name}`)
  }
  assert.equal(plugin.name, 'llm-dsh-xdpool', 'and the Cordis row id it registers under')
})

/** A Cordis context narrow enough for the entry, with real effect disposal. */
function makeContext() {
  const logs = []
  const disposers = []
  const noop = () => () => {}
  const ctx = {
    logger: {
      info: () => {},
      warn: (...args) => logs.push(['warn', args.map(String).join(' ')]),
      error: (...args) => logs.push(['error', args.map(String).join(' ')]),
    },
    llm: {
      registerAdapter: () => noop(),
      registerConfigurableProviders: () => noop(),
      registerModelDiscovery: () => noop(),
    },
    settings: { configure: () => noop(), mutate: async () => {} },
    effect: (fn) => {
      const disposer = fn()
      const release = typeof disposer === 'function' ? disposer : noop()
      disposers.push(release)
      return release
    },
    inject: () => noop(),
    on: () => noop(),
    emit: () => {},
    get: () => undefined,
    fiber: { entry: { id: 'artifact-smoke' } },
  }
  return { ctx, logs, disposers }
}

test('the built entry activates, answers a panel document, and releases everything', async () => {
  const plugin = require(built)
  const { ctx, logs, disposers } = makeContext()
  // Every source off: the document is still built, and no gateway or vendor call
  // is made, so the case is about the artifact rather than about the network.
  plugin.apply(ctx, {
    enabled: true,
    sourceWorkbuddy: false,
    sourceTrae: false,
    sourceQoder: false,
    distribution: 'priority',
    cooldownSeconds: 60,
    authFile: '',
    showComposerPoints: false,
  })
  try {
    // The entry activates asynchronously: `onLoad`, then its registered service.
    // Waiting for a fixed interval made this case fail on a loaded machine, when
    // the suite's other files are still transpiling: the document was read before
    // the fixture's switches had been adopted. Read until they are, with a bound.
    let document
    for (let attempt = 0; attempt < 100; attempt += 1) {
      document = await plugin.onPanelInvoke('xd.state', {})
      if (document.sources.workbuddy === false) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(typeof document, 'object', 'the panel document must be an object')
    assert.equal(document.sources.workbuddy, false, 'the switches the fixture set are the ones the document reports')
    assert.ok(Array.isArray(document.accounts), 'the document carries the account list the panel paints')
    assert.ok(document.shims !== undefined, 'and the gateway rows')
    // A channel the entry does not implement is refused through `panelError`, not
    // thrown as a bare string: the panel reads `code` off the refusal.
    await assert.rejects(() => plugin.onPanelInvoke('xd.not-a-channel', {}), (error) => {
      assert.equal(typeof error.code, 'string', 'a refusal must carry a code')
      return true
    })
  } finally {
    for (const release of disposers.reverse()) await release()
    await plugin.onUnload()
  }
  const failures = logs.filter(([level]) => level !== 'info')
  assert.deepEqual(failures, [], 'activation and teardown must not log a warning or an error')
})

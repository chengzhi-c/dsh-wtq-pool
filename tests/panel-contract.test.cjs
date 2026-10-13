/**
 * Regressions for the panel's client/host contract.
 *
 * The panel is two halves that cannot see each other: the page inside the frame
 * calls `xd.*` channels over HTTP, and the host half answers whichever ones it
 * knows. Nothing checks one half against the other at runtime, so the faults
 * here all shipped as dead controls rather than as errors - a channel the page
 * called that no half accepted, routes left behind in the server table when one
 * of them failed to mount, and rows the popup could not tell apart.
 *
 * Each case is stated as what the user sees, and each is reachable from the
 * shipped panel rather than from a synthetic call.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createRequire, registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const { WebServer } = require('@deepseek-ai/dsh-host-webserver')

const root = path.resolve(__dirname, '..')
const sourceOf = file => fs.readFileSync(path.join(root, file), 'utf8')
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

// The host half imports its siblings without an extension, so the loader needs
// the same `.ts` resolution the DSH entry builds against.
registerHooks({
  resolve(specifier, context, next) {
    const ownSource = context.parentURL?.startsWith('file:')
      && fileURLToPath(context.parentURL).startsWith(path.join(root, 'src') + path.sep)
    return next(ownSource && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs', shortCircuit: true, source: transpile(fs.readFileSync(fileURLToPath(url), 'utf8')),
    }
    return next(url, context)
  },
})

/** Every channel the panel page and the composer component actually call. */
function uiChannels() {
  const channels = new Set()
  for (const file of ['renderer/panel.js', 'src/client/composer.tsx']) {
    for (const match of sourceOf(file).matchAll(/["'](xd\.[A-Za-z]+)["']/g)) channels.add(match[1])
  }
  return channels
}

/** The channels the route admits, read from the shipped allowlists. */
function routeChannels() {
  const channels = new Set()
  for (const block of sourceOf('src/web-panel.ts')
    .matchAll(/const (?:READ_ONLY|MUTATING)_CHANNELS = new Set\(\[([\s\S]*?)\]\)/g)) {
    for (const match of block[1].matchAll(/'(xd\.[A-Za-z]+)'/g)) channels.add(match[1])
  }
  return channels
}

/** The channels the host half answers, read from its own switch. */
function hostChannels() {
  return new Set([...sourceOf('src/host.ts').matchAll(/case "(xd\.[A-Za-z]+)"/g)].map(match => match[1]))
}

test('every channel the panel calls is admitted by the route and answered by the host', () => {
  const ui = [...uiChannels()].sort()
  assert.ok(ui.length > 0, 'the scan must find the panel\'s channels, or it proves nothing')
  assert.deepEqual(ui.filter(channel => !routeChannels().has(channel)), [],
    'a channel the page calls but the route does not admit is refused with 400, so the control is dead')
  assert.deepEqual(ui.filter(channel => !hostChannels().has(channel)), [],
    'a channel the route admits but the host does not answer fails with 500, so the control errors out')
})

test('a panel route that fails to mount releases the routes that already registered', () => {
  const { registerPanelRoutes } = loadSource('src/web-panel.ts')
  // The real server table: a duplicate (kind, path) throws, which is exactly
  // what a half-mounted panel looks like to the next activation.
  const table = { exact: new Map(), prefixes: new Map() }
  let calls = 0
  const failing = {
    register(route) {
      calls += 1
      if (calls === 4) throw new Error('duplicate exact route')
      return WebServer.prototype.register.call(table, route)
    },
  }
  let mounted
  let thrown
  registerPanelRoutes({ webServer: failing }, {
    pluginRoot: root, logger: { warn() {} },
    effect: callback => { try { mounted = callback() } catch (error) { thrown = error } },
    invoke: async () => ({}),
  })
  assert.ok(thrown, 'a mount failure must not be swallowed into a silent half-mounted panel')
  assert.equal(mounted, undefined, 'a failed mount must not hand back a disposer it cannot honour')
  assert.equal(table.exact.size, 0,
    'routes that registered before the failure must be released, or every later activation fails on them')
  assert.equal(table.prefixes.size, 0)
  // Nothing is left claimed, so a retry can take the same paths.
  const retry = { exact: new Map(), prefixes: new Map() }
  registerPanelRoutes({ webServer: { register: route => WebServer.prototype.register.call(retry, route) } }, {
    pluginRoot: root, logger: { warn() {} }, effect: callback => { mounted = callback() },
    invoke: async () => ({}),
  })
  assert.ok(retry.exact.size > 0, 'a retry must be able to mount the panel')
  mounted()
})

function loadSource(file, overrides = {}) {
  const ownRequire = createRequire(path.join(root, file))
  const module = { exports: {} }
  const context = vm.createContext({ module, exports: module.exports, URL, Buffer, console,
    require: name => (Object.hasOwn(overrides, name) ? overrides[name] : ownRequire(name)) })
  vm.runInContext(transpile(sourceOf(file)), context, { filename: file })
  return module.exports
}

/**
 * A Trae or Qoder row as the composer's popup receives it.
 *
 * The popup marks the served row with one value and clears the notice it raised
 * against that same value, so a row without it can hold a notice that never
 * goes away - the state the component's own comment says must not happen.
 */
test('a Trae or Qoder composer row carries the identity the popup marks it by', () => {
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, console,
    require: name => ownRequire(name),
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer, process,
  })
  context.exports = context.module.exports
  vm.runInContext(transpile(sourceOf('src/host.ts'))
    + '\nmodule.exports.__internals = { sourceComposerAccounts }\n'
    + '\nmodule.exports.__setRows = (trae, qoder) => { traeAccountRows = trae; qoderAccountRows = qoder }\n', context)
  const { sourceComposerAccounts } = context.module.exports.__internals
  context.module.exports.__setRows(
    [{ label: 'Trae CN A', region: 'cn', expired: false, usage: { credits: { total: 12 } } },
     { label: 'Trae CN B', region: 'cn', expired: false }],
    [{ label: 'Qoder A', region: 'cn', expired: false }],
  )
  const trae = sourceComposerAccounts('trae', 'cn')
  assert.equal(trae.length, 2)
  assert.deepEqual(trae.map(row => row.id), ['Trae CN A', 'Trae CN B'],
    'each row must name itself, or the popup cannot clear the notice it put on it')
  assert.equal(trae.filter(row => row.active === true).length, 1, 'exactly one row is the served one')
  assert.equal(sourceComposerAccounts('qoder', 'cn')[0].id, 'Qoder A')
})

/**
 * Regressions for the panel's client/host contract.
 *
 * The panel is two halves that cannot see each other: the page inside the frame
 * calls `xd.*` channels over HTTP, and the host half answers whichever ones it
 * knows. Nothing checks one half against the other at runtime, so the faults
 * here would surface as dead controls rather than as errors - a channel the page
 * called that no half accepted, routes left behind in the server table when one
 * of them failed to mount, and rows the popup could not tell apart.
 *
 * Each case is stated as what the user sees, and each is reachable from the
 * shipped panel rather than from a synthetic call.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
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

/** The channels the route admits, read from the shipped allowlist. */
function routeChannels() {
  const channels = new Set()
  for (const block of sourceOf('src/web-panel.ts')
    .matchAll(/const CHANNELS = new Set\(\[([\s\S]*?)\]\)/g)) {
    for (const match of block[1].matchAll(/'(xd\.[A-Za-z]+)'/g)) channels.add(match[1])
  }
  return channels
}

test('every channel the panel calls is admitted by the route and answered by the host', async () => {
  const ui = [...uiChannels()].sort()
  assert.ok(ui.length > 0, 'the scan must find the panel\'s channels, or it proves nothing')
  assert.deepEqual(ui.filter(channel => !routeChannels().has(channel)), [],
    'a channel the page calls but the route does not admit is refused with 400, so the control is dead')

  // Dispatch, not the switch's labels: a `case` whose body throws, or that the
  // switch never reaches, still reads as handled to a text scan. Every channel
  // is invoked and has to reach its own case.
  //
  // A channel that got there either answers, refuses through `panelError` (an
  // empty payload is not always valid), or is still working - the switch's
  // `default` refuses synchronously, so a body still running after a short
  // window has already proven dispatch. Waiting for the slow ones to finish
  // would run a real check-in pass and its pacing delays for no extra proof.
  const host = loadHost()
  await host.plugin.onLoad()
  try {
    for (const channel of ui) {
      const answered = host.plugin.onPanelInvoke(channel, {})
        .then(value => ({ reached: true, value }), error => ({ reached: true, error }))
      const stillRunning = new Promise(resolve => { setTimeout(() => resolve({ reached: false }), 250) })
      const outcome = await Promise.race([answered, stillRunning])
      if (!outcome.reached) continue
      if (outcome.error === undefined) {
        assert.notEqual(outcome.value, undefined,
          `${channel} answered the panel with nothing, so its case body did not do its work`)
        continue
      }
      assert.doesNotMatch(String(outcome.error.message), /unsupported panel channel/,
        `${channel} is called by the panel but reached the switch's default branch instead of its own case`)
      assert.equal(typeof outcome.error.code, 'string',
        `${channel} refused with an unstructured error, so its case body did not run`)
    }
  } finally {
    await host.plugin.onUnload()
    host.cleanup()
  }
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
 * The host half, loaded with a scratch data directory and a stub bridge.
 *
 * Cases that have to dispatch a channel need the real module, not a slice of its
 * text, so this loads `src/host.ts` whole the way the other suites do.
 */
function loadHost() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-panel-'))
  const settings = { enabled: true, sourceWorkbuddy: false, sourceTrae: false, sourceQoder: false }
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  ownRequire('./pi-compat.ts').installPi({
    getSettings: () => ({ ...settings }),
    setSettings: patch => Object.assign(settings, patch),
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  })
  const module = { exports: {} }
  const context = vm.createContext({
    require: ownRequire, module, exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, Buffer, process, TextEncoder, TextDecoder,
  })
  context.exports = module.exports
  vm.runInContext(transpile(sourceOf('src/host.ts')), context, { filename: 'src/host.ts' })
  return { plugin: module.exports, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) }
}

/** The slice of an `<input>` the panel touches, with listeners a case can fire. */
function fakeInput() {
  const listeners = {}
  return {
    type: '', className: '', max: '', min: '', step: '', value: '',
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler) },
    dispatch(type) { for (const handler of listeners[type] || []) handler({ target: this }) },
  }
}

/**
 * Named panel declarations, evaluated together and callable.
 *
 * `renderer/panel.js` boots on load, so it cannot be evaluated whole. Lifting
 * the named functions out with brace matching is what lets a case drive the real
 * control rather than scan its text: a bound the page never wires up, or a guard
 * whose `return` was dropped, then fails the case where a source match would
 * still pass.
 */
function panelFunctions(names, source, extra) {
  const parts = []
  for (const name of names) {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    parts.push(source.slice(from, index + 1))
  }
  const ceiling = /var MAX_TOKEN_BUDGET = 0x[0-9a-f]+;/.exec(source)
  const context = vm.createContext({
    document: { createElement: () => fakeInput() },
    String, Number, Math, console,
    ...extra,
  })
  if (ceiling) parts.unshift(ceiling[0])
  vm.runInContext(parts.join('\n'), context)
  return context
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

/**
 * The popup's height cap and the positioner's reserved height are one number.
 *
 * `positionStyle` decides whether the popup fits above its trigger by comparing
 * the trigger's distance from the top against `PANEL_MAX_HEIGHT`, and the
 * stylesheet caps the box at that same value. Under the default `content-box`
 * sizing the cap bounded only the content, so the painted box added its own
 * padding and border on top and grew past the height the positioner had
 * reserved. The popup was then placed as if it fit and cut off at the window
 * edge. `border-box` makes the cap describe the box that is actually painted,
 * which is what the positioner assumes.
 */
test('the composer popup caps the box it paints, not just its content', () => {
  // Matched per line: the rule is a template literal, so a `[^}]*` capture stops
  // at the closing brace of its first `${...}` interpolation.
  const rule = sourceOf('src/client/composer.tsx')
    .split('\n').find(line => line.startsWith('.xd-points-panel{'))
  assert.ok(rule, 'the popup rule must exist')
  assert.match(rule, /box-sizing:\s*border-box/,
    'without border-box the painted popup is taller than PANEL_MAX_HEIGHT reserves')
  assert.match(rule, /max-height:\$\{PANEL_MAX_HEIGHT\}px/,
    'the cap must stay tied to the figure the positioner reserves')
})

/**
 * The popup's width cap has to count the column the right anchor takes.
 *
 * The box is right-aligned by pinning `right`, so the space still available to
 * its left is the window minus that offset. Capping it at the window minus only
 * the margin ignored the offset, and a wide box (a long account name reaching
 * the cap) then hung past the window's left edge - measured at -21px with the
 * trigger away from the right edge. The cap and the floor are clamped from that
 * same figure, so a narrow window shortens the box instead of overflowing.
 */
test('the popup width cap leaves room for the right anchor it is pinned by', () => {
  const body = sourceOf('src/client/composer.tsx')
  const width = body.split('\n').find(line => line.includes('Math.min(PANEL_MAX_WIDTH,'))
  assert.ok(width, 'the positioner must cap the popup against its own maximum')
  assert.match(width, /window\.innerWidth\s*-\s*right\s*-\s*PANEL_MARGIN/,
    'capping at the window minus only the margin ignores the space the right anchor already took')
  assert.match(body, /Math\.min\(PANEL_MIN_WIDTH,\s*width\)/,
    'the floor must be clamped from the same figure, or a narrow window overflows')
})

/**
 * The two hosts disagree about how a disabled button is dimmed, and the row the
 * popup marks as selected is one; the dot beside that row is one colour, not the
 * host's success token.
 *
 * PI-Desktop's shell stylesheet carries a global `button:disabled` rule that
 * fades it; DeepSeek Harness has no such rule outside its own update dialog, so
 * the same row read at full strength here and dimmed there. The fade is stated
 * in the popup's own rules, which both builds carry, so the selected row reads
 * the same in either host.
 *
 * `--dsw-alias-state-success-primary` resolves to a saturated `#22c55e` in this
 * host, while the same dot in the PI-Desktop build is `#4f9f7c`. Two panels of
 * one product should not carry two greens, so the colour is written out.
 */
test('the row the popup marks as selected states its own dimming and marker colour', () => {
  const source = sourceOf('src/client/composer.tsx')
  const selected = source
    .split('\n').find(line => line.startsWith('.xd-points-table .xd-points-btn:disabled{'))
  assert.ok(selected, 'the selected row must not depend on a host rule for its fade')
  assert.match(selected, /opacity:\s*\.5\b/,
    'the fade is the one PI-Desktop applies; a different value would read as two products')

  const marker = source.split('\n').find(line => line.startsWith('.xd-points-dot{'))
  assert.ok(marker, 'the row marker rule must exist')
  assert.match(marker, /background:\s*#4f9f7c/i, 'the marker is a fixed colour shared with the PI-Desktop build')
  assert.doesNotMatch(marker, /var\(--/, 'a host token here resolves to a different green in this host')
})

/**
 * The frame around the panel follows the panel's own height, up to a cap, and
 * the reading is skipped, not taken, while the panel document has no body.
 *
 * The box was a fixed 72vh viewport, so a short panel sat in a tall empty frame
 * and a long one scrolled inside the frame while the page around it stayed put.
 * The height is now read from the panel document, which the frame can do because
 * it is same-origin, and stops at FRAME_MAX_HEIGHT so an account list cannot
 * stretch the settings page without bound.
 *
 * `contentDocument` is non-null from the moment a navigation commits, but its
 * `body` only exists once content arrives; sampled across one load, three
 * readings out of 636 landed in that window. A guard over the document alone
 * lets those readings dereference a null body: a page error on every load, and
 * the interval's only work that tick lost. The same window is what a fresh mount
 * draws from, so it is reachable without any reload.
 */
test('the frame is sized to the panel, stops at its cap, and skips a bodyless document', () => {
  const body = sourceOf('src/client/index.tsx')
  const cap = body.split('\n').find(line => line.startsWith('const FRAME_MAX_HEIGHT ='))
  assert.ok(cap, 'the frame needs a height it stops growing at')
  assert.match(cap, /=\s*\d{3,}/, 'the cap must be a concrete pixel figure')

  assert.match(body, /Math\.min\(FRAME_MAX_HEIGHT,\s*doc\.body\.scrollHeight/,
    'the height has to come from the panel document and pass through the cap, and from body rather than documentElement')
  assert.match(body, /setMeasured\(\(current\) => \(current === height \? current : height\)\)/,
    'the measured height has to reach the frame, or the panel is sized to nothing')
  const guard = body.split('\n').find(line => line.includes('doc.body === null'))
  assert.ok(guard, 'the probe reads doc.body, so a bodyless document has to bail out before the read')
  // The bail-out is the guard. A line that only names the condition (a no-op
  // statement, or a `return` replaced while debugging) still reads as a guard
  // to a substring match, and the read below then dereferences a null body.
  assert.match(guard, /\breturn\b/,
    'the bodyless check must return before the read below, not merely mention the condition')
})

/**
 * A panel.css that 404s while the host half is still loading is waited out.
 *
 * The card probes `panel.css` to tell a panel the host half is not serving from
 * one whose assets are missing, and the only thing that separates the two is how
 * long the 404s last. A host half that has not registered its routes yet answers
 * 404 for a moment, so the probe retries before it concludes: three 404s in a
 * row are a verdict, and one is a wait.
 *
 * There is no DOM harness in this repo, so the effect is driven through the
 * `React.useEffect` seam the same way the composer cases in the sibling build
 * drive theirs - the shipped effect body, run against a stubbed `fetch` and a
 * `setTimeout` that fires immediately and records the wait it was asked for.
 */
test('a panel.css that 404s twice before it loads is waited out, not reported missing', async () => {
  const source = sourceOf('src/client/index.tsx')
  const anchor = source.indexOf('const probe = (remaining')
  assert.notEqual(anchor, -1, 'the card must probe panel.css, or there is nothing to wait out')
  const open = source.lastIndexOf('React.useEffect(() => {', anchor)
  assert.notEqual(open, -1, 'the probe has to live inside an effect, or it runs on every render')
  const close = '}, [view, generation])'
  const end = source.indexOf(close, anchor)
  assert.notEqual(end, -1, 'the probe effect must be scoped to the frame generation')
  const effect = transpile(source.slice(open, end + close.length))

  /** The effect, run once against the answers `fetch` gives and the waits it asks for. */
  const drive = (answers, view) => {
    const waits = []
    const missing = []
    const failures = []
    let asked = 0
    const context = vm.createContext({
      React: { useEffect: run => run() },
      view, generation: 0,
      setMissing: value => missing.push(value),
      setProbeFailure: value => failures.push(value),
      PANEL_BASE: '/panel-base',
      fetch: async () => {
        const answer = answers[Math.min(asked, answers.length - 1)] ?? new Response('', { status: 404 })
        asked += 1
        return answer
      },
      setTimeout: (callback, ms) => { waits.push(ms); callback(); return 1 },
      clearTimeout: () => {},
    })
    vm.runInContext(effect, context, { filename: 'src/client/index.tsx' })
    return { waits, missing, failures, asked: () => asked }
  }

  const notFound = new Response('', { status: 404 })
  const served = new Response('body', { status: 200 })

  // The case: two 404s and then the stylesheet, which is a host half still
  // loading rather than a panel that is not installed.
  const waited = drive([notFound, notFound, served], 'full')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(waited.asked(), 3, 'the third attempt is the one that has to be made')
  assert.deepEqual(waited.waits, [500, 500], 'the retries wait between attempts rather than hammering the route')
  assert.deepEqual(waited.missing, [false, false],
    'a stylesheet that arrives on the third try must not leave the card saying the assets are missing')

  // The control: three 404s are the verdict, so the retry above is not a probe
  // that never concludes.
  const concluded = drive([notFound, notFound, notFound], 'full')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(concluded.missing, [false, true],
    'three 404s in a row are the missing-assets verdict, and it must still be reachable')

  // A refusal that is not 404 carries the reason: reinstalling cannot fix a
  // browser address or origin the host's loopback guard turned away.
  const forbidden = new Response(JSON.stringify({ error: 'peer-not-loopback' }), {
    status: 403, headers: { 'content-type': 'application/json' },
  })
  const denied = drive([forbidden], 'full')
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(denied.asked(), 3, 'a transient host-half error is still retried before concluding')
  assert.deepEqual(denied.missing, [false, true], 'the error is a verdict after the retries')
  assert.match(denied.failures.at(-1), /HTTP 403: peer-not-loopback/,
    'the card names the status and the host\'s own reason')

  // And the probe costs nothing on the list's inline summary, where there is no
  // frame to tell anything about.
  const summary = drive([notFound], 'summary')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(summary.asked(), 0, 'the summary view has no frame, so it must not probe at all')
})

/**
 * The composer refresh must leave room for its own answer.
 *
 * The readout aborts its call at `INVOKE_TIMEOUT_MS`; a host pass that spends
 * that same figure re-probing accounts (or the wider panel-step budget) finishes
 * after the client has already given up, so the click reports a timeout even
 * though the reads succeeded. The pass is bounded below the call deadline, and
 * the probe it abandons still writes the cache the readout polls.
 */
test('the composer refresh is bounded inside the readout call deadline', () => {
  const client = sourceOf('src/client/composer.tsx')
  const declared = /const INVOKE_TIMEOUT_MS = (\d+)/.exec(client)
  assert.ok(declared, 'the readout must declare the deadline it aborts on')
  const callDeadline = Number(declared[1])

  const host = sourceOf('src/host.ts')
  const budget = /const COMPOSER_REFRESH_BUDGET_MS = (\d+)/.exec(host)
  assert.ok(budget, 'the refresh needs a budget of its own')
  assert.ok(Number(budget[1]) < callDeadline,
    `the refresh budget (${budget[1]}ms) must stay under the call deadline (${callDeadline}ms)`)

  const handler = host.slice(host.indexOf('case "xd.composerRefresh"'))
  const body = handler.slice(0, handler.indexOf('case "', 10))
  assert.match(body, /statusDocument\(\{ allowNetwork: true, budgetMs: COMPOSER_REFRESH_BUDGET_MS \}\)/,
    'the WorkBuddy pass must spend its own budget, not the wider panel step')
  // Both the statement and its use: an unanchored match also accepts a scaled
  // or offset deadline such as `COMPOSER_REFRESH_BUDGET_MS * 1000`, and a
  // deadline nothing consults bounds nothing at all.
  assert.match(body, /budget\(COMPOSER_REFRESH_BUDGET_MS\)/,
    'the Trae and Qoder pass must share that one budget, unscaled')
  assert.match(body, /if \(left\(\) === 0\) break;/,
    'the shared budget has to stop the per-account loop, or the pass runs to its own end')
})

/**
 * The model sheet's numeric fields must refuse a value the host will not store.
 *
 * `parseOverride` rejects the whole selection payload when one window exceeds
 * the host's ceiling, so a single impossible number discarded every other edit
 * in the same save and reported only "invalid selection payload". The browser
 * bound keeps the figure inside the range the host can store, which is the only
 * place the user can be told which field is at fault.
 *
 * The field is driven, not read: a bound the page never wires up, or a ceiling
 * check that accepts everything, fails here even though the source still names
 * both.
 */
test('a token budget past the host ceiling is refused by the field itself', () => {
  const hostCeiling = /const MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(sourceOf('src/host.ts'))
  assert.ok(hostCeiling, 'the host must declare the ceiling it stores against')
  const ceiling = Number(hostCeiling[1])

  const panel = sourceOf('renderer/panel.js')
  const declared = /var MAX_TOKEN_BUDGET = (0x[0-9a-f]+)/.exec(panel)
  assert.ok(declared, 'the panel must carry the same ceiling the host enforces')
  assert.equal(Number(declared[1]), ceiling,
    'a panel ceiling that drifts from the host one rejects a figure the host would store, or offers one it will not')

  // The real field, built and driven the way the sheet builds it.
  const context = panelFunctions(['numberInput'], panel)
  const input = context.numberInput(1000, value => { input.accepted = value })
  assert.equal(input.max, String(ceiling), 'without the attribute the browser offers no bound at all')
  assert.equal(input.value, '1000', 'the field opens on the stored value')

  input.value = String(ceiling + 1)
  input.dispatch('change')
  assert.equal(input.accepted, undefined,
    'a value past the ceiling must not reach the save, or the host discards every other edit with it')
  assert.equal(input.value, '1000', 'a refused value leaves the stored figure in the field')

  input.value = '2000'
  input.dispatch('change')
  assert.equal(input.accepted, 2000, 'a value inside the ceiling must still save')
})

/**
 * A refused number goes back to what is committed, not to what the field showed.
 *
 * The sheet is rebuilt on every repaint, and the field a keypress lands in can be
 * a half-typed number: the row holds the draft's figure, the field holds whatever
 * the user has typed so far. After one accepted edit those two differ, so a
 * refusal that restored the field's own opening text put back a number nobody had
 * finished typing - and one more Enter then saved it.
 */
test('a refused figure goes back to the committed one, not the half-typed text', () => {
  const panel = sourceOf('renderer/panel.js')
  const context = panelFunctions(['numberInput'], panel)
  const input = context.numberInput(
    '50000',                          // what the rebuilt field opened on
    (value) => { input.accepted = value },
    2000000,
    () => {},
    () => {},
    1000,                             // what is actually stored
  )
  input.value = '5000000'
  input.dispatch('change')
  assert.equal(input.accepted, undefined, 'the impossible figure must not be saved')
  assert.equal(input.value, '1000',
    'and the field shows the committed figure, not the half-typed one a repaint left behind')
})

/**
 * Switching the automatic check-in off must not depend on the hours box.
 *
 * The box can hold stale text from an earlier edit. Requiring it to parse before
 * an OFF would report a failure and leave the timer running while the panel went
 * on showing the schedule as off, which is the one state the user cannot see.
 */
test('switching the automatic check-in off survives an unreadable hours box', () => {
  const source = sourceOf('renderer/panel.js')
  const body = source.slice(source.indexOf('function setAutoCheckin('))
  const handler = body.slice(0, body.indexOf('\n}\n') + 3)
  assert.match(handler, /if \(enabled === true\)/,
    'only switching ON may reject an unreadable hours box')
  assert.match(handler, /autoCheckin\.hours|state\.autoCheckin/,
    'switching OFF must fall back to the stored hours rather than give up')
  const refused = handler.indexOf('auto.badHours')
  const allowed = handler.indexOf('runBusy')
  assert.ok(refused !== -1 && allowed !== -1 && refused < allowed,
    'the refusal must be inside the ON branch, before the save it would otherwise skip')
})

/** The promo module reports 24 for "free until midnight". Clamping to 23 ends the window an hour early. */
test('a promo edge of 24 stays 24:00', () => {
  const context = panelFunctions(['clockHour'], sourceOf('renderer/panel.js'))
  assert.equal(context.clockHour(24), '24:00')
  assert.equal(context.clockHour(9), '09:00')
  assert.equal(context.clockHour(23), '23:00')
})

/**
 * Saving the hours box is an explicit write. An unreadable value has to be
 * reported even while the schedule is off; only the switch itself may ignore it.
 */
test('saving check-in hours reports an unreadable box even while the schedule is off', () => {
  const source = sourceOf('renderer/panel.js')
  const at = source.indexOf('$("autoHoursSave").addEventListener')
  assert.notEqual(at, -1, 'the save button must have one listener')
  const save = source.slice(at, at + 700)
  assert.match(save, /hours === null/)
  assert.match(save, /auto\.badHours/)
})

/**
 * An expired account is listed in the preference picker but cannot be chosen.
 *
 * The host refuses an expired account as the preferred one, so offering it turned
 * a click into an error with nothing on screen to explain it. It stays listed
 * rather than dropped: the user needs to see the account is there and why it
 * cannot serve.
 *
 * The picker is built and its options read back, not scanned: a `disabled` write
 * the option never receives leaves the source text unchanged and the control live.
 */
test('an expired account is listed but not selectable as the preferred one', () => {
  const record = (tagName, className, text) => ({
    tagName, className, textContent: text === undefined ? '' : String(text), children: [],
    appendChild(node) { this.children.push(node) },
    setAttribute() {}, addEventListener() {},
  })
  // The reason comes from the panel's own English table rather than a copy here:
  // a case that spells the sentence itself still passes after the entry is gone.
  const source = sourceOf('renderer/panel.js')
  const english = source.slice(source.indexOf('var EN = {'), source.indexOf('\n}', source.indexOf('var EN = {')))
  const reason = /"acct\.expired": "([^"]+)"/.exec(english)?.[1]
  assert.ok(reason, 'the English table has to name why the row cannot be chosen')
  const context = panelFunctions(['sourcePreferredPicker'], source, {
    el: record,
    t: key => key === 'acct.expired' ? reason : key,
    state: {},
    busy: null,
    distributionControl: () => null,
    setPreferredSourceAccount: () => {},
  })
  const card = context.sourcePreferredPicker('workbuddy', 'cn', [
    { label: 'Live', expired: false },
    { label: 'Expired', expired: true },
  ])
  const picker = card.children.find(child => child.tagName === 'select')
  assert.ok(picker, 'the picker has to be in the card it builds')
  const options = picker.children.filter(child => child.tagName === 'option')
  const live = options.find(option => option.textContent === 'Live')
  const expired = options.find(option => option.textContent.startsWith('Expired'))
  assert.ok(live && expired, 'both accounts have to be listed')
  assert.notEqual(live.disabled, true, 'a live account stays selectable')
  assert.equal(expired.disabled, true, 'an expired account must not be selectable')
  assert.equal(expired.textContent, 'Expired · ' + reason, 'and the row has to say why, in the reader\'s language')
})

test('the panel\'s check-in goes through the one pass, not a second copy of it', async () => {
  // The per-source "check in all" button used to run its own fan-out: no pause
  // between the check-in burst and the growth burst, and no record in
  // `autoCheckin.last`, so the panel's "last run" stayed on the previous pass
  // while the upstream saw two request clusters back to back.
  const host = loadHost()
  await host.plugin.onLoad()
  try {
    const before = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(before.autoCheckin.last, undefined, 'no pass has run yet')
    const answer = await host.plugin.onPanelInvoke('xd.checkinAll', { source: 'workbuddy' })
    assert.equal(typeof answer.claimed, 'number', 'the answer still carries the counts the panel reads')
    assert.equal(answer.state.autoCheckin.last.manual, true,
      'a check-in started from the panel has to record itself, or "last run" names an older pass')
    assert.equal(typeof answer.state.autoCheckin.last.at, 'string', 'and it has to carry the time it ran')
    const after = await host.plugin.onPanelInvoke('xd.state', {})
    assert.equal(after.autoCheckin.last.manual, true, 'the record has to survive the next document read too')
  } finally {
    await host.plugin.onUnload()
    host.cleanup()
  }
})

/** DSH publishes the live port, so the notice has to name the preferred port that was taken. */
test('a port fallback notice names the preferred port', () => {
  const panel = sourceOf('renderer/panel.js')
  assert.match(panel, /gateway\.preferredPort/)
  const host = sourceOf('src/host.ts')
  assert.equal((host.match(/preferredPort: preferred/g) || []).length, 2)
})


/**
 * The panel page boots on its own, and its whole script has to stay at the top
 * level for that to mean anything.
 *
 * An unclosed function body swallows every declaration after it: the file still
 * parses, so a syntax check passes, and the page dies on the first call to a
 * name that is now nested inside some other function. That is what happened to
 * `selectTab` and `labelTabs` once, and nothing caught it because every other
 * case here lifts individual functions out of the text.
 */
test('the panel page boots whole, with its controls at the top level', () => {
  const element = () => ({
    childElementCount: 0, children: [], appendChild() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return null }, remove() {},
    querySelector() { return null }, querySelectorAll() { return [] },
    style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {},
    textContent: '', value: '', hidden: false, disabled: false, checked: false,
    scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    tagName: 'DIV', className: '', type: '', title: '', href: '',
  })
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: () => element(), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => element(),
      createRange: () => ({ selectNodeContents() {} }),
      body: element(), documentElement: { dataset: {} },
    },
    window: {
      addEventListener() {},
      getSelection: () => ({ removeAllRanges() {}, addRange() {}, toString: () => '' }),
    },
    navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  })
  assert.doesNotThrow(() => vm.runInContext(sourceOf('renderer/panel.js'), context),
    'the page threw while booting, so the panel never paints')
  for (const name of ['boot', 'selectTab', 'labelTabs', 'renderAutoCheckin', 'autoNoteRows',
    'runKeepAliveNow']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'function',
      `${name} is not at the top level, so an unclosed body above it swallowed the declaration`)
  }
})
/**
 * Every string the panel asks for is in both languages, and every string it
 * defines is asked for.
 *
 * A missing entry is not a visible error: `t()` falls back to the key, so the
 * user reads `pool.noAccounts` in the middle of a Chinese sentence. The reverse
 * is just as invisible: an entry nothing asks for is dead weight that no case can
 * fail on, so it survives every release.
 *
 * A key counts as asked for when it appears in the panel outside the two tables,
 * or when something outside the panel drives it: the four view tabs and the four
 * footer links come from `data-` attributes in the page, and the two pack names
 * come from the host. Those three sources are read here rather than exempted by
 * hand, so the link itself is what the check verifies.
 */
test('every string the panel asks for exists in both languages', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  const tables = ['EN', 'ZH'].map((dictionary) => {
    const from = source.indexOf(`var ${dictionary} = {`)
    assert.notEqual(from, -1, `the ${dictionary} table has to be in the panel`)
    return { dictionary, body: source.slice(from, source.indexOf('\n}', from)) }
  })
  const definedIn = (body) => [...body.matchAll(/^\s*"([a-zA-Z]+\.[a-zA-Z0-9]+)":/gm)].map((match) => match[1])
  const defined = [...new Set(tables.flatMap((table) => definedIn(table.body)))]
  assert.ok(defined.length >= 150, `the panel has its tables (found ${defined.length} keys)`)

  // The keys the page drives, and the two the host names.
  const fromPage = [
    ...[...page.matchAll(/data-tab="([\w-]+)"/g)].map((match) => 'tab.' + match[1]),
    ...[...page.matchAll(/data-foot-label="([\w-]+)"/g)].map((match) => 'foot.' + match[1]),
  ]
  const fromHost = ['credits.planQuota', 'credits.addOnQuota']

  const outside = source.replace(tables[0].body, '').replace(tables[1].body, '')
  const asked = new Set([
    ...defined.filter((key) => outside.includes('"' + key + '"')),
    ...fromPage,
    ...fromHost,
  ])
  assert.ok(asked.size >= 150, `the panel asks for its strings (found ${asked.size})`)

  for (const { dictionary, body } of tables) {
    const missing = [...asked].filter((key) => !body.includes('"' + key + '"'))
    assert.deepEqual(missing, [], `${dictionary} is missing ${missing.join(', ')}`)
    const orphaned = definedIn(body).filter((key) => !asked.has(key))
    assert.deepEqual(orphaned, [], `${dictionary} defines ${orphaned.join(', ')}, which nothing asks for`)
  }
})

/**
 * The four view tabs and the four panels they switch between are wired to each
 * other, in both directions.
 *
 * A tab that names nothing, or a panel nothing names, is not visible as a break:
 * the panel still switches on click, because the switching is done in JavaScript
 * by `data-tab`. What breaks is the accessibility tree, where the four views read
 * as four unrelated regions and a screen reader cannot say which tab is showing.
 */
test('every view tab names the panel it controls, and that panel names it back', () => {
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')
  // The source tabs carry data-source; the four view tabs carry data-tab and
  // switch between the sections below them.
  const tabs = [...page.matchAll(/<button[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes('role="tab"') && tag.includes('data-tab='))
  assert.equal(tabs.length, 4, 'the page has four view tabs')
  for (const tab of tabs) {
    const id = /id="([^"]+)"/.exec(tab)?.[1]
    const controls = /aria-controls="([^"]+)"/.exec(tab)?.[1]
    assert.ok(id !== undefined, `a view tab needs an id so its panel can name it: ${tab}`)
    assert.ok(controls !== undefined, `a view tab has to name the panel it switches to: ${tab}`)
    const panel = new RegExp(`<section[^>]*id="${controls}"[^>]*>`).exec(page)?.[0]
    assert.ok(panel !== undefined, `aria-controls="${controls}" names no section`)
    assert.ok(panel.includes('role="tabpanel"'), `${controls} has to be a tabpanel`)
    assert.ok(panel.includes(`aria-labelledby="${id}"`), `${controls} has to name ${id} back`)
  }
})

/**
 * The ban-risk note sits on the source tabs' line, and follows the locale.
 *
 * It warns about using any of the three sources, so it belongs beside the tab row
 * rather than anywhere the user has to scroll to find it. The markup is static,
 * so its label is written by `labelTabs` beside the footer links: markup left in
 * the page without that write ships as an empty paragraph, and a key removed from
 * a table ships as the raw key name.
 *
 * The expected text is read back out of the panel's own tables and the note is
 * driven through the panel's own `t`, so a copy here cannot drift from the ship.
 */
test('the ban-risk note reaches the panel line', () => {
  const panel = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8')

  // The markup: one row holds the three source tabs and the note after them.
  const row = /<div class="tabs-row">([\s\S]*?)\n    <\/div>/.exec(page)?.[1]
  assert.ok(row !== undefined, 'index.html needs a row that holds the source tabs and the note')
  const tabsAt = row.indexOf('id="sourceTabs"')
  const noteAt = row.indexOf('id="riskNote"')
  assert.ok(tabsAt !== -1, 'the source tabs belong in that row')
  assert.ok(noteAt !== -1, 'and so does the risk note')
  assert.ok(noteAt > tabsAt, 'the note reads after the tabs, i.e. to their right')

  const lift = (source, name) => {
    const from = source.indexOf(`function ${name}(`)
    assert.notEqual(from, -1, `${name} has to be in the panel`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    return source.slice(from, index + 1)
  }
  const tableOf = (name) => {
    const head = panel.indexOf(`var ${name} = {`)
    assert.notEqual(head, -1, `the ${name} table has to be in the panel`)
    return new Function(panel.slice(head, panel.indexOf('\n}', head) + 3) + ` return ${name}`)()
  }
  const EN = tableOf('EN')
  const ZH = tableOf('ZH')
  const note = lift(panel, 'labelTabs')
  assert.ok(note.includes('$("riskNote")'), 'labelTabs has to write the note')

  for (const [name, table] of [['EN', EN], ['ZH', ZH]]) {
    const expected = table['risk.note']
    assert.equal(typeof expected, 'string', `${name} has to define risk.note`)
    assert.ok(expected.trim() !== '', `${name} risk.note must say something`)
    assert.ok(/封号|ban/i.test(expected), `${name} risk.note has to name the risk it warns about`)

    const node = { textContent: '' }
    const context = vm.createContext({
      document: { querySelectorAll: () => [], documentElement: { lang: name === 'ZH' ? 'zh-CN' : 'en' } },
      $: (id) => { assert.equal(id, 'riskNote'); return node },
      TABLE: table,
      EN,
      activeSource: 'workbuddy',
    })
    vm.runInContext(lift(panel, 't'), context)
    vm.runInContext(note, context)
    vm.runInContext('labelTabs()', context)
    assert.equal(node.textContent, expected, `${name} note has to reach the page verbatim`)
  }
})

/**
 * The README screenshots show the panel the repository ships now.
 *
 * `docs/preview-panel.html` mounts `renderer/index.html`, `panel.js` and
 * `panel.css` at runtime, so a capture taken from it cannot disagree with what
 * ships. What it can do is go stale: the pictures in docs/ are committed files,
 * and the panel changed under them while the README kept showing the old one.
 *
 * "Newer than" is a content question, not a file-system one: git does not carry
 * modification times, so a stamp compared against them passes on the machine that
 * took the picture and fails on a fresh clone, in either direction. The capture
 * writes the hashes of the three files it mounted into `docs/preview-capture.json`,
 * and this compares against those.
 */
test('the README screenshots show the panel the repository ships', () => {
  const shots = ['preview-pool.png', 'preview-dark.png', 'preview-models.png', 'preview-growth.png', 'preview-page.png']
  const stampAt = path.join(root, 'docs', 'preview-capture.json')
  assert.ok(fs.existsSync(stampAt), 'docs/preview-capture.json has to exist: the capture writes it')
  const stamp = JSON.parse(fs.readFileSync(stampAt, 'utf8'))
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')

  for (const file of ['renderer/index.html', 'renderer/panel.js', 'renderer/panel.css']) {
    assert.equal(stamp.rendered[file], digest(file),
      `${file} changed since the screenshots were taken: re-capture, then run node docs/stamp.cjs`)
  }
  assert.deepEqual(Object.keys(stamp.shots).sort(), [...shots].sort(),
    'the capture has to list the shots the README embeds')

  for (const shot of shots) {
    const at = path.join(root, 'docs', shot)
    assert.ok(fs.existsSync(at), `docs/${shot} has to exist: the README embeds it`)
    assert.equal(stamp.shots[shot], digest('docs/' + shot),
      `docs/${shot} changed without the stamp that records what it was captured against: run node docs/stamp.cjs after re-capturing`)
  }
})

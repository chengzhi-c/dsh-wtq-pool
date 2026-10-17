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
function panelFunctions(names, source) {
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
    let asked = 0
    const context = vm.createContext({
      React: { useEffect: run => run() },
      view, generation: 0,
      setMissing: value => missing.push(value),
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
    return { waits, missing, asked: () => asked }
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


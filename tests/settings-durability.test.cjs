/**
 * Regressions for the settings-document and credential-expiry defects.
 *
 * The same faults were fixed in the PI-Desktop entry (`pi-desktop-wtq-pool`);
 * this is the DSH port's copy of those cases, so the two engines stay in step.
 * Each case is stated as the observable the user or the panel sees.
 *
 * `src/host.ts` carries no type annotations of its own and is transpiled here
 * the way the other suites do it. The internals the cases need are appended to
 * the transpiled module after its own exports, so nothing about the shipped
 * module surface changes.
 */
const assert = require('node:assert/strict')
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

// `src/host.ts` imports its siblings without an extension, so the loader needs
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

/**
 * Load `src/host.ts` in an isolated context.
 *
 * `settings` is the document the bridge starts with, `readFails` makes every
 * read reject (what a broken host RPC does), and `holdRead` keeps the next read
 * open so a case can land a save inside that window. The bridge is a stub, so
 * nothing here touches a real install.
 */
function loadHost(options = {}) {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-reg-'))
  const logs = []
  let settingsDocument = options.settings ?? {}
  let readFails = false
  let gate = null
  const ownRequire = createRequire(path.join(root, 'src/host.ts'))
  const bridge = {
    getSettings: async () => {
      // Snapshot BEFORE the gate: a read issued before a save must answer with
      // the document as it stood then, which is the whole point of the race
      // case. Reading after the gate would hand back the newer document and make
      // the case pass for the wrong reason.
      const snapshot = { ...settingsDocument }
      if (gate !== null) await gate
      if (readFails) throw new Error('settings service unavailable')
      return snapshot
    },
    setSettings: async (patch) => { settingsDocument = { ...settingsDocument, ...patch } },
    getDataPath: () => temporary,
    declareProviders: () => ({ ok: true, changed: false }),
  }
  const { installPi } = ownRequire('./pi-compat.ts')
  installPi(bridge)
  const context = vm.createContext({
    require: (id) => (options.require && Object.prototype.hasOwnProperty.call(options.require, id) ? options.require[id] : ownRequire(id)),
    module: { exports: {} }, exports: {}, console: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
    AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, URL, Buffer, process,
  })
  context.exports = context.module.exports
  // The internals under test are module-scope bindings, so they are published
  // alongside the module's own exports rather than reached by name.
  const internals = ['loadSettings', 'adoptHostSettings', 'saveSettings', 'normalizeSelection', 'parseSelection',
    'orderSourceCredentials', 'traeClaimFor', 'gatewaySelectionFor', 'sourceDistribution',
    'sourceRosterFor', 'traeNativeOf', 'traeDeclarationModels', 'traeGateways']
  vm.runInContext(transpile(fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8'))
    + `\nmodule.exports.__internals = { ${internals.join(', ')} }\n`
    + '\nmodule.exports.__settings = (next) => { settings = next }\n'
    + '\nmodule.exports.__readSettings = () => settings\n', context)
  const internalsApi = context.module.exports.__internals
  return {
    logs,
    internals: internalsApi,
    setReadFails() { readFails = true },
    setDocument(value) { settingsDocument = value },
    getSettingsDocument: () => settingsDocument,
    /** Keep every later read pending until the returned release is called. */
    holdRead() {
      let release
      gate = new Promise((resolve) => { release = resolve })
      return release
    },
    cleanup() { fs.rmSync(temporary, { recursive: true, force: true }) },
  }
}

/**
 * A failed settings read must not be answered with an empty document.
 *
 * The settings service is a separate part of the host, so it fails for reasons
 * that have nothing to do with the user's file. The old code turned that failure
 * into `{}` and assigned it over this process's copy of the document; the
 * panel's save helpers spread that copy before writing the one key they are
 * responsible for, so the very next click made the loss permanent.
 */
test('a failed settings read keeps the last known document instead of wiping it', async () => {
  const host = loadHost({
    settings: {
      disabledAccountIds: ['account-one'],
      removedAccounts: [{ id: 'account-two', label: 'Two', region: 'cn' }],
      creditReserves: { 'account-three': 25 },
      modelSelection: { cn: { enabledModelIds: ['model-a'] } },
      preferredAccountIds: { cn: 'account-one' },
    },
  })
  try {
    assert.equal(await host.internals.adoptHostSettings(), true, 'the first read must land')
    host.setReadFails()
    assert.equal(await host.internals.adoptHostSettings(), false, 'a failed read must not be adopted')
    assert.match(host.logs.join('\n'), /could not read settings/)

    // What the panel does on one switch-off click: re-derive the list from the
    // document it holds, then write it back.
    await host.internals.saveSettings({ disabledAccountIds: ['account-one', 'account-four'] })
    const stored = host.getSettingsDocument()
    assert.deepEqual(stored.disabledAccountIds, ['account-one', 'account-four'])
    assert.deepEqual(stored.removedAccounts.map((row) => row.id), ['account-two'],
      'a removed account must not come back because a read failed')
    assert.equal(stored.creditReserves['account-three'], 25,
      'a credit floor must not be dropped because a read failed')
    assert.deepEqual(stored.preferredAccountIds, { cn: 'account-one' })
    assert.deepEqual(stored.modelSelection, { cn: { enabledModelIds: ['model-a'] } })
  } finally {
    host.cleanup()
  }
})

/**
 * A settings read that raced a local save is older than that save.
 *
 * A refresh pass reads the document and then awaits for seconds. A save landing
 * inside that window is by definition newer than the document the read returns,
 * so adopting it reverts the switch the user just flipped.
 */
test('a settings read that raced a save does not revert it', async () => {
  const host = loadHost({ settings: { sourceTrae: false } })
  try {
    const release = host.holdRead()
    const adopting = host.internals.adoptHostSettings()
    await host.internals.saveSettings({ sourceTrae: true })
    release()
    assert.equal(await adopting, false, 'an older read must not be adopted')
    assert.equal(host.getSettingsDocument().sourceTrae, true,
      'the switch the user flipped must not be reverted by an older read')

    // Control: a read that raced nothing is still adopted, so the guard above is
    // not simply refusing every read.
    host.setDocument({ sourceTrae: false })
    assert.equal(await host.internals.adoptHostSettings(), true)
    assert.equal(host.getSettingsDocument().sourceTrae, false)
  } finally {
    host.cleanup()
  }
})

/**
 * A model id of `__proto__` is an ordinary key in a JSON document.
 *
 * `JSON.parse` makes it an own property, but assigning it onto a plain object
 * with `map[id] = …` sets the prototype instead. Both the save and the immediate
 * read then reported success while nothing had been stored.
 */
test('a model id of __proto__ is stored and read back like any other', async () => {
  const host = loadHost()
  try {
    const parsed = host.internals.parseSelection(JSON.parse('{"overrides":{"__proto__":{"alias":"picked"},"model-b":{"alias":"b"}}}'))
    assert.notEqual(parsed, undefined)
    assert.equal(parsed.overrides['__proto__'].alias, 'picked')
    assert.equal(parsed.overrides['model-b'].alias, 'b')
    assert.equal(Object.getPrototypeOf(parsed.overrides), null)

    // The read-back path has to agree with the save path, or the override is
    // written and then silently invisible. The document goes through JSON on the
    // way in, exactly as a saved one does.
    host.setDocument({ modelSelection: { cn: JSON.parse(JSON.stringify(parsed)) } })
    await host.internals.adoptHostSettings()
    const normalized = host.internals.gatewaySelectionFor('cn')
    assert.equal(normalized.overrides['__proto__'].alias, 'picked',
      'a stored __proto__ override must read back')
  } finally {
    host.cleanup()
  }
})

/**
 * A stored account name that no sign-in carries any more is not a preference.
 *
 * The label is the account's own name, so renaming or re-signing in retires it.
 * The old code returned a stored label as the chosen account before the rotation
 * and the expiry sort could run, which disabled both.
 */
test('a retired account name no longer disables rotation', async () => {
  const host = loadHost({
    settings: {
      preferredSourceAccounts: { 'trae:cn': 'retired-name' },
      sourceDistributions: { trae: 'round-robin' },
    },
  })
  try {
    await host.internals.adoptHostSettings()
    assert.equal(host.internals.sourceDistribution('trae'), 'round-robin')
    const call = (labelOf) => [1, 2, 3].map(() => host.internals.orderSourceCredentials('trae', 'cn',
      [{ label: 'live-one', expiresAtMs: 0 }, { label: 'live-two', expiresAtMs: 0 }], labelOf, true).map((item) => item.label))
    const [first, second] = call((item) => item.label)
    assert.deepEqual([...first].sort(), ['live-one', 'live-two'])
    assert.notDeepEqual(first, second, 'rotation must advance when the stored account name is retired')

    // Control: a name that is still carried does pin the account.
    host.setDocument({ ...host.getSettingsDocument(), preferredSourceAccounts: { 'trae:cn': 'live-two' } })
    await host.internals.adoptHostSettings()
    assert.equal(call((item) => item.label)[0][0], 'live-two', 'a live account name must still be honoured')
  } finally {
    host.cleanup()
  }
})

/**
 * An expiry past `Date`'s range used to fail the whole panel document.
 *
 * `xd.state` formats each row's expiry with `toISOString()`, which throws for a
 * timestamp outside `Date`'s range. A hand-edited or upstream-garbled sentinel
 * (1e15, 1e16) is exactly that, and one bad row took the entire panel down
 * instead of the one field.
 */
test('an absurd stored expiry cannot fail the panel document', () => {
  // The control first: this is the value that used to throw at the format site.
  assert.throws(() => new Date(1e16).toISOString(), RangeError)
  const { parseWorkBuddyAuth } = require('../src/accounts.ts')
  const absurd = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: 'test-token', expiresAt: 1e16 } }), 'fixture')
  assert.equal(absurd.expiresAtMs, 0, 'an expiry past 2100 must read as "no expiry"')
  const real = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: 'test-token', expiresAt: 1893456000 } }), 'fixture')
  assert.equal(real.expiresAtMs, 1893456000 * 1000, 'a real expiry must still be read')
})

/**
 * A refreshed token's expiry is bounded the same way a stored one is.
 *
 * `expiresIn` comes from the vendor's answer, so it is not trusted input either.
 * A garbled one stored a timestamp past `Date`'s range, which is the same
 * `toISOString()` failure reached by a live refresh rather than a file on disk.
 */
test('a garbled token lifetime from a refresh cannot store an out-of-range expiry', async () => {
  const temporary = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'dsh-refresh-'))
  try {
    const authDir = path.join(temporary, 'auth')
    fs.mkdirSync(authDir)
    // Expired, with a refresh token: that is what makes the pool refresh it.
    fs.writeFileSync(path.join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
      auth: { accessToken: 'old-token', refreshToken: 'refresh-token', expiresAt: 1, domain: '' },
      account: { uin: 'refresh-fixture' },
    }))
    const { WorkBuddyAccountPool } = require('../src/accounts.ts')
    for (const [expiresInSec, label] of [[1e300, 'absurd'], [Infinity, 'infinite'], [3600, 'real']]) {
      const pool = new WorkBuddyAccountPool({
        authDirs: [authDir],
        client: { refreshToken: async () => ({ accessToken: 'new-token', expiresInSec }) },
      })
      await pool.scan()
      const account = pool.list()[0]
      assert.notEqual(account, undefined, `${label}: the fixture sign-in must be picked up`)
      assert.equal(await pool.refreshAccount(account.id), true, `${label}: the token must be refreshed`)
      const at = pool.list()[0].credential.expiresAtMs
      assert.equal(Number.isFinite(at), true, `${label}: a refreshed expiry must be a usable number`)
      assert.equal(at > Date.now(), true, `${label}: a refreshed token must read as fresh`)
      assert.doesNotThrow(() => new Date(at).toISOString(), `${label}: the panel must be able to format it`)
      if (label === 'real') {
        assert.equal(Math.abs(at - (Date.now() + 3600 * 1000)) < 10_000, true)
      } else {
        assert.equal(at <= 4_102_444_800_000, true, `${label}: the expiry must stay inside Date's range`)
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

/**
 * A stopped check-in program is not a check-in to claim.
 *
 * The panel disables its button on the same flag, so the batch has to agree:
 * sending the mutation and counting the refusal against an account that is
 * simply not enrolled reports a failure the user cannot act on.
 */
test('a check-in whose program is off is skipped, not claimed', async () => {
  const calls = []
  const host = loadHost({
    require: {
      './trae-upstream': {
        TRAE_CHECKIN_DEVICE_CLAIMED: 9095,
        TraeSoloUpstreamClient: class {
          async fetchCheckinStatus() { calls.push('status'); return { code: 0, enable: false } }
          async claimCheckin() { calls.push('claim'); return { code: 0 } }
        },
      },
    },
  })
  try {
    const outcome = await host.internals.traeClaimFor(
      { accessToken: 't', userId: 'u', accountName: 'n', edition: 'cn', expiresAtMs: 0 }, [])
    assert.equal(outcome.outcome, 'skipped', 'an account with the program off must be skipped')
    assert.deepEqual(calls, ['status'], 'no claim may be sent for an account that is not enrolled')
  } finally {
    host.cleanup()
  }
})

/**
 * A Trae model's credit rate has to reach the panel, not stop at the parser.
 *
 * The directory states each model's effective (post-discount) rate and the
 * client already parsed it, but the pool's own model view never carried it
 * across - so a Trae row showed no cost while the IDE showed 0.79x for the same
 * model, and comparing cost between the two sources was impossible. The rate is
 * the observable here: what the panel's cost chip reads, and what the
 * declaration names the model by.
 */
test('a Trae model that states a credit rate carries it to the panel', () => {
  const host = loadHost()
  try {
    // The shape the directory reader produces: `creditMultiplier` only when the
    // row stated one, so the second model stands for the rows that state none.
    host.internals.traeGateways.set('cn', {
      gateway: {
        models: () => [
          { id: 'doubao-seed-evolving', name: 'Doubao Seed Evolving', contextWindow: 256000, maxTokens: 32000, creditMultiplier: 0.79 },
          { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 256000, maxTokens: 32000 },
        ],
      },
    })

    const roster = host.internals.sourceRosterFor(
      'trae:cn', host.internals.traeGateways.get('cn').gateway.models(), host.internals.traeNativeOf)
    const rated = [...roster].find((row) => row.id === 'doubao-seed-evolving')
    const unrated = [...roster].find((row) => row.id === 'kimi-k3')
    assert.equal(rated.multiplier, 0.79,
      'a model the directory prices must reach the panel with that price')
    assert.equal(unrated.multiplier, undefined,
      'a model the directory does not price must stay unlabelled, not read as free')

    // The same value on the published declaration, which is the name the host's
    // model picker shows. It has to match what a WorkBuddy row reads as.
    const declared = [...host.internals.traeDeclarationModels('cn')]
    const row = declared.find((model) => model.id === 'doubao-seed-evolving')
    assert.equal(row.name, 'Doubao Seed Evolving · x0.79',
      'the picker must show the same cost suffix for a Trae model as for a WorkBuddy one')
  } finally {
    host.cleanup()
  }
})

/**
 * Which executables the plugin is willing to run, and under what conditions.
 *
 * `at-rest.ts` spawns a WorkBuddy binary to derive the at-rest key, from a
 * process that holds every account's token. Path alone is not a reason to trust
 * it: a same-user process can drop a file into `%LOCALAPPDATA%\Programs`, add a
 * registry key naming an arbitrary path, or replace a signed file between the
 * check and the run. The gate is Authenticode - a valid chain to a trusted root,
 * a signer's key hash pinned to WorkBuddy's two releases, and no elevation.
 *
 * `signatureAccepts` is only the predicate; this file drives the scan that
 * feeds it, because a predicate nothing calls proves nothing. Deleting the
 * signature pass from `signedExecutables` - which turns the whole gate off -
 * left the suite green before this file existed.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { root } = require('./ts-loader.cjs')

const AT_REST_SOURCE = fs.readFileSync(path.join(root, 'src/at-rest.ts'), 'utf8')
const DOMESTIC_KEY = '2F95C8391B09328BC42D131C50CC7B4E06F9E2A7B1E3624E14C9070A1BE9CC97'
const INTERNATIONAL_KEY = '307ECCDC80B73FF1662464E2591BF027124F11175039423BA2FEC1CDE64DB212'
const WINDOWS_ONLY = process.platform !== 'win32'

/**
 * A context running `at-rest.ts` with `execFile` under the test's control.
 *
 * The module imports `node:child_process` by name, so the seam is the `require`
 * the module makes, not a parameter: whatever the test passes here is what the
 * scan sees. Everything else resolves to the real module.
 */
function contextWithSignatureScan(execFile) {
  const compiled = ts.transpileModule(
    `${AT_REST_SOURCE}\nexport { signedExecutables, executableCandidates, signatureAccepts }`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } },
  ).outputText
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    Buffer,
    process,
    console,
    require: (name) => name === 'node:child_process' ? { execFile, execFileSync: () => { throw new Error('no sync spawn') } } : require(name),
  })
  context.exports = context.module.exports
  vm.runInContext(compiled, context)
  return context
}

/** What PowerShell reports for a set of candidate paths. */
function signatureReport(entries, elevated) {
  // A default parameter would turn the explicit `undefined` case into `false`,
  // which is the one value that grants access. The absence of the argument is
  // therefore kept as absence, so the scan's own "elevation unknown" branch is
  // what the test drives.
  const report = arguments.length >= 2 ? { elevated, entries } : { elevated: false, entries }
  return (file, args, options, callback) => {
    callback(null, JSON.stringify(report), '')
  }
}

test('a signed binary from another publisher is not run', { skip: WINDOWS_ONLY }, async () => {
  const untrusted = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe'
  const trusted = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  const calls = []
  const context = contextWithSignatureScan((file, args, options, callback) => {
    calls.push({ file, args, options })
    signatureReport([
      { path: untrusted, status: 'Valid', publicKeyHash: 'a-different-vendor' },
      { path: trusted, status: 'Valid', publicKeyHash: DOMESTIC_KEY },
    ])(file, args, options, callback)
  })
  const accepted = await context.exports.signedExecutables([untrusted, trusted])
  assert.deepEqual([...accepted], [trusted],
    'a trusted root is not a trusted publisher: another vendor also chains to one')
  assert.equal(calls.length, 1, 'one signature pass covers every candidate')
})

test('both of WorkBuddy\'s signing keys are accepted', { skip: WINDOWS_ONLY }, async () => {
  const domestic = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  const international = 'C:\\Program Files\\Trae CN\\WorkBuddy.exe'
  const context = contextWithSignatureScan(signatureReport([
    { path: domestic, status: 'Valid', publicKeyHash: DOMESTIC_KEY },
    { path: international, status: 'Valid', publicKeyHash: INTERNATIONAL_KEY.toLowerCase() },
  ]))
  const accepted = await context.exports.signedExecutables([domestic, international])
  assert.deepEqual([...accepted], [domestic, international],
    'the comparison is case-insensitive, as the hashes are written both ways')
})

test('an unsigned or unreadable signature is not run', { skip: WINDOWS_ONLY }, async () => {
  const candidate = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  for (const status of ['NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', '']) {
    const context = contextWithSignatureScan(signatureReport([
      { path: candidate, status, publicKeyHash: DOMESTIC_KEY },
    ]))
    const accepted = await context.exports.signedExecutables([candidate])
    assert.deepEqual([...accepted], [], `a ${JSON.stringify(status)} signature must not allow an executable`)
  }
})

test('an elevated host runs none of them, whatever the signature says', { skip: WINDOWS_ONLY }, async () => {
  const candidate = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  // Elevated, the plugin could itself be the thing that replaced the file after
  // the check; unknown elevation is refused for the same reason, since the
  // check could not be applied.
  for (const elevated of [true, null, undefined]) {
    const context = contextWithSignatureScan(signatureReport([
      { path: candidate, status: 'Valid', publicKeyHash: DOMESTIC_KEY },
    ], elevated))
    const accepted = await context.exports.signedExecutables([candidate])
    assert.deepEqual([...accepted], [], `an elevated host (${String(elevated)}) must not run any candidate`)
  }
})

test('a scan that fails runs nothing at all', { skip: WINDOWS_ONLY }, async () => {
  const candidate = 'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe'
  const context = contextWithSignatureScan((file, args, options, callback) => {
    callback(new Error('PowerShell is not there'), '', '')
  })
  const accepted = await context.exports.signedExecutables([candidate])
  assert.deepEqual([...accepted], [],
    'a check that could not run is not permission to run the executable anyway')
})

test('an empty candidate list does not start a signature scan', { skip: WINDOWS_ONLY }, async () => {
  let spawned = 0
  const context = contextWithSignatureScan((file, args, options, callback) => {
    spawned += 1
    callback(null, JSON.stringify({ elevated: false, entries: [] }), '')
  })
  const accepted = await context.exports.signedExecutables([])
  assert.deepEqual([...accepted], [])
  assert.equal(spawned, 0, 'nothing to check is not a reason to start a process')
})

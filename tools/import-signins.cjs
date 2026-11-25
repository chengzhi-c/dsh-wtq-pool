#!/usr/bin/env node
/**
 * Bring WorkBuddy sign-ins in from another tool's account files.
 *
 * The panel's "add account" runs the vendor's device flow and writes the result
 * into the plugin's own `signins/` directory; that directory is the import
 * surface, so a sign-in another tool already minted needs nothing but the same
 * file on disk. This reads those files and writes them in exactly the shape a
 * panel login produces, so the pool cannot tell the two apart.
 *
 *   node tools/import-signins.cjs --data <plugin data dir> --from <path...> [--region cn|global|all] [--dry-run] [--force]
 *
 * `--from` takes files or directories (walked for `*.json` and `*.info`). Both
 * shapes the pool reads are accepted: the flat document other tools keep
 * (`{accessToken, refreshToken, expiresAt, domain, uid, nickname}`) and the
 * `{auth, account}` pair the desktop app and this plugin write.
 *
 * An account the pool already knows is left alone unless `--force` asks for it,
 * and that default is the point: a second copy of one identity does not add an
 * account - the pool keeps the fresher of the two - but it does move where that
 * account's sign-in comes from, and the panel's delete button then removes a
 * copy while the original keeps the account alive.
 */
const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module')

// The plugin's own rules live in TypeScript that this build ships from source, so
// the tool loads it the way this repo's tests do: transpile on require.
const ts = require('typescript')
registerHooks({
  resolve(specifier, context, next) {
    const ownSource = context.parentURL?.startsWith('file:')
      && fileURLToPath(context.parentURL).startsWith(path.join(__dirname, '..', 'src') + path.sep)
    return next(ownSource && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs',
      shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
      }).outputText,
    }
    return next(url, context)
  },
})
// The plugin's own rules, not copies of them: this script must file a sign-in
// under the same id, name and region the pool would give it.
const { workbuddyAccountId: accountId, writeOwnSignIn, isFresher } = require('../src/accounts.ts')
const { regionOf } = require('../src/upstream.ts')

const ARCHIVE_FILENAME = 'credentials-archive.json'
const OWN_SIGN_IN_DIRNAME = 'signins'

function usage(why) {
  if (why !== undefined) console.error('error: ' + why)
  console.error('usage: node tools/import-signins.cjs --data <plugin data dir> --from <path...>'
    + ' [--region cn|global|all] [--dry-run] [--force]')
  process.exit(why === undefined ? 0 : 2)
}

function parseArgs(argv) {
  const options = { data: '', from: [], region: 'all', dryRun: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--data') options.data = argv[++index] ?? ''
    else if (arg === '--from') {
      while (index + 1 < argv.length && argv[index + 1].startsWith('-') === false) options.from.push(argv[++index])
    } else if (arg === '--region') options.region = argv[++index] ?? 'all'
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') usage()
    else usage('unknown argument ' + arg)
  }
  if (options.data === '') usage('--data is required')
  if (options.from.length === 0) usage('--from is required')
  if (['cn', 'global', 'all'].includes(options.region) === false) usage('--region must be cn, global or all')
  return options
}

/**
 * The pool's id, over the fields this tool builds as empty strings rather than
 * omitting them: `workbuddyAccountId` reads with `??`, so `uin: ''` would stop
 * it falling through and give every uin-less account one shared id.
 */
function accountIdOf(credential) {
  const identity = {
    uin: credential.uin === '' ? undefined : credential.uin,
    uid: credential.uid === '' ? undefined : credential.uid,
    nickname: credential.nickname === '' ? undefined : credential.nickname,
    sourcePath: credential.sourcePath,
  }
  return accountId(identity)
}

/** `expiresAt` is seconds in some exports and milliseconds in others. */
function expiryToMs(value) {
  if (typeof value !== 'number' || Number.isFinite(value) === false || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** One sign-in, out of either document shape. Returns undefined when there is no token in it. */
function readSignIn(file) {
  let document
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const nested = typeof document.auth === 'object' && document.auth !== null
  const auth = nested ? document.auth : document
  const identity = nested && typeof document.account === 'object' && document.account !== null
    ? document.account
    : document
  const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
  if (accessToken === '') return undefined
  const credential = {
    accessToken,
    refreshToken: stringOr(auth.refreshToken, ''),
    expiresAtMs: expiryToMs(auth.expiresAt ?? auth.expiresAtMs),
    lastRefreshAtMs: expiryToMs(auth.lastRefreshTime ?? auth.lastRefreshAtMs),
    domain: stringOr(auth.domain, ''),
    uid: stringOr(identity.uid, ''),
    uin: stringOr(identity.uin, ''),
    nickname: stringOr(identity.nickname, ''),
    enterpriseId: stringOr(identity.enterpriseId, ''),
    sourcePath: file,
  }
  return credential
}

function collectFiles(from) {
  const files = []
  for (const entry of from) {
    const resolved = path.resolve(entry)
    let stat
    try {
      stat = fs.statSync(resolved)
    } catch {
      throw new Error('no such path: ' + entry)
    }
    if (stat.isFile()) {
      files.push(resolved)
      continue
    }
    for (const name of fs.readdirSync(resolved)) {
      if (name.toLowerCase().endsWith('.json') || name.toLowerCase().endsWith('.info')) {
        files.push(path.join(resolved, name))
      }
    }
  }
  return files
}

function knownSignIns(dataDir) {
  const byUid = { cn: new Map(), global: new Map() }
  const known = new Map()
  const archive = path.join(dataDir, ARCHIVE_FILENAME)
  if (fs.existsSync(archive)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(archive, 'utf8'))
      for (const entry of parsed.entries ?? []) {
        if (typeof entry?.id === 'string') known.set(entry.id, 'the credential archive')
        if (typeof entry?.uid === 'string' && typeof entry.uin === 'string' && entry.uin) {
          byUid[regionOf(entry.domain ?? '')].set(entry.uid, entry.uin)
        }
      }
    } catch { /* an unreadable archive costs the id mapping, not the import */ }
  }
  const signIns = path.join(dataDir, OWN_SIGN_IN_DIRNAME)
  if (fs.existsSync(signIns)) {
    for (const name of fs.readdirSync(signIns)) {
      if (name.toLowerCase().endsWith('.info') === false) continue
      const signIn = readSignIn(path.join(signIns, name))
      if (signIn === undefined) continue
      known.set(accountIdOf(signIn), path.join(OWN_SIGN_IN_DIRNAME, name))
      if (signIn.uid && signIn.uin) byUid[regionOf(signIn.domain)].set(signIn.uid, signIn.uin)
    }
  }
  return { known, byUid }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(options.data)
  if (fs.existsSync(dataDir) === false) {
    console.error('error: the data directory does not exist: ' + dataDir)
    process.exit(2)
  }
  const { known, byUid } = knownSignIns(dataDir)
  const signIns = path.join(dataDir, OWN_SIGN_IN_DIRNAME)

  const rows = []
  const incoming = []
  for (const file of collectFiles(options.from)) {
    const credential = readSignIn(file)
    if (credential === undefined) continue
    const region = regionOf(credential.domain)
    if (options.region !== 'all' && region !== options.region) {
      rows.push({ label: credential.nickname || credential.uid, region, id: accountIdOf(credential), action: 'skipped', why: 'region filter' })
      continue
    }
    if (credential.uid && credential.uin) byUid[region].set(credential.uid, credential.uin)
    incoming.push(credential)
  }
  const candidates = new Map()
  for (const credential of incoming) {
    const uin = credential.uin || byUid[regionOf(credential.domain)].get(credential.uid) || ''
    const resolved = { ...credential, uin }
    const id = accountIdOf(resolved)
    const previous = candidates.get(id)
    if (previous === undefined || isFresher({ ...resolved, sourcePath: previous.sourcePath }, previous, signIns)) {
      candidates.set(id, resolved)
    }
  }
  for (const [id, resolved] of candidates) {
    const { uin } = resolved
    const region = regionOf(resolved.domain)
    const label = resolved.nickname === '' ? resolved.uid : resolved.nickname
    if (uin === '' && resolved.uid === '') {
      rows.push({ label, region, id, action: 'skipped', why: 'no uid or uin' })
      continue
    }
    if (known.has(id) && options.force === false) {
      rows.push({ label, region, id, action: 'skipped', why: 'already known to the pool (' + known.get(id) + ')' })
      continue
    }
    // The copy already in `signins/` for this identity, if any: a re-import must
    // not replace a fresher token with an older one.
    const existingPath = known.get(id)
    if (typeof existingPath === 'string' && existingPath.startsWith(OWN_SIGN_IN_DIRNAME)) {
      const existing = readSignIn(path.join(dataDir, existingPath))
      // Both copies will live in signins/, so compare them at the same source rank.
      if (existing !== undefined && !isFresher({ ...resolved, sourcePath: existing.sourcePath }, existing, signIns)) {
        rows.push({ label, region, id, action: 'skipped', why: 'the copy on disk is at least as fresh' })
        continue
      }
    }
    if (options.dryRun === false) await writeOwnSignIn(signIns, resolved)
    rows.push({
      label,
      region,
      id,
      action: options.dryRun ? 'would import' : 'imported',
      why: uin === '' ? 'no uin known, keyed by uid' : '',
    })
  }

  for (const row of rows) {
    const why = row.why === '' ? '' : '  (' + row.why + ')'
    console.log([row.action.padEnd(12), row.region.padEnd(6), row.label.padEnd(22), row.id, why].join(' '))
  }
  const imported = rows.filter((row) => row.action === 'imported' || row.action === 'would import').length
  console.log('\n' + imported + ' to import, ' + (rows.length - imported) + ' skipped'
    + (options.dryRun ? ' (dry run, nothing written)' : ''))
}

if (require.main === module) main().catch((error) => { console.error('error: ' + (error?.message ?? error)); process.exit(1) })

module.exports = { expiryToMs, readSignIn }

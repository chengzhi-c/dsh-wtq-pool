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
require('./ts-loader.cjs')
const { readArchivedCredentials, parseWorkBuddyAuth, sealedSignInMetadata, workbuddyAccountId: accountId, ownSignInOf, importOwnSignIn, isFresher } = require('../src/accounts.ts')
const { regionOf } = require('../src/upstream.ts')
const { safeMessage } = require('../src/loopback.ts')

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
    } else if (arg === '--region') options.region = argv[++index]
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

function readSignIn(file, existing = false) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const credential = parseWorkBuddyAuth(text, file)
  if (existing) return credential ?? sealedSignInMetadata(text, file)
  if (credential) delete credential.linkedUin // Only this pool can establish a local binding.
  return credential?.refreshTokenUnavailable ? undefined : credential
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
    for (const child of fs.readdirSync(resolved, { withFileTypes: true })) {
      if (child.isFile() && /\.(json|info)$/i.test(child.name)) {
        files.push(path.join(resolved, child.name))
      }
    }
  }
  return files
}

function rememberUin(byUid, { uid, uin, linkedUin, domain }) {
  uin ??= linkedUin
  if (!uid || !uin) return
  const region = byUid[regionOf(domain ?? '')]
  region.set(uid, !region.has(uid) || region.get(uid) === uin ? uin : null)
}

async function knownSignIns(dataDir) {
  const byUid = { cn: new Map(), global: new Map() }
  const known = new Map()
  const linkedOwners = { cn: new Map(), global: new Map() }
  const signIns = path.join(dataDir, OWN_SIGN_IN_DIRNAME)
  function remember(id, entry) {
    const previous = known.get(id)
    if (!previous || isFresher(entry, previous, signIns)) known.set(id, entry)
    rememberUin(byUid, entry)
    if (entry.uid && !entry.uin && entry.linkedUin) {
      linkedOwners[regionOf(entry.domain)].set(entry.linkedUin, entry.uid)
    }
  }
  const { stored } = await readArchivedCredentials(path.join(dataDir, ARCHIVE_FILENAME))
  for (const [id, entry] of stored) remember(id, entry)
  if (fs.existsSync(signIns)) {
    for (const name of fs.readdirSync(signIns)) {
      if (name.toLowerCase().endsWith('.info') === false) continue
      const signIn = readSignIn(path.join(signIns, name), true)
      if (signIn === undefined) continue
      remember(accountId(signIn), signIn)
    }
  }
  return { known, byUid, linkedOwners }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(options.data)
  if (fs.existsSync(dataDir) === false) {
    console.error('error: the data directory does not exist')
    process.exit(2)
  }
  const { known, byUid, linkedOwners } = await knownSignIns(dataDir)
  const signIns = path.join(dataDir, OWN_SIGN_IN_DIRNAME)

  const rows = []
  const incoming = []
  for (const file of collectFiles(options.from)) {
    const credential = readSignIn(file)
    if (credential === undefined) continue
    const region = regionOf(credential.domain)
    if (options.region !== 'all' && region !== options.region) {
      rows.push({ region, action: 'skipped', why: 'region filter' })
      continue
    }
    rememberUin(byUid, credential)
    incoming.push(credential)
  }
  const candidates = new Map()
  for (const credential of incoming) {
    const region = regionOf(credential.domain)
    const alias = byUid[region].get(credential.uid)
    if (alias === null && !credential.uin) {
      rows.push({ region, action: 'skipped', why: 'uid matches multiple accounts' })
      continue
    }
    let uin = credential.uin ?? alias
    let uid = credential.uid
    let linkedUin
    if (uin && !known.has(accountId({ ...credential, uin }))) {
      const linkedUid = linkedOwners[region].get(uin)
      const owner = uid && known.get(accountId({ ...credential, uin: undefined }))
      if (linkedUid && uid && linkedUid !== uid) {
        rows.push({ region, action: 'skipped', why: 'billing identity belongs to another account' })
        continue
      }
      if (linkedUid || (alias === uin && owner && !owner.uin && owner.uid === uid && regionOf(owner.domain) === region)) {
        uid = linkedUid ?? uid
        linkedUin = uin
        uin = undefined
      }
    }
    if (!uin && !uid) {
      rows.push({ region, action: 'skipped', why: 'no uid or uin' })
      continue
    }
    const resolved = { ...credential, uid, uin, linkedUin }
    const id = accountId(resolved)
    const previous = candidates.get(id)
    const owner = known.get(id) ?? previous
    if (owner && regionOf(owner.domain) !== region) {
      rows.push({ region, action: 'skipped', why: 'identity key belongs to another region' })
      continue
    }
    if (previous === undefined || isFresher({ ...resolved, sourcePath: previous.sourcePath }, previous, signIns)) {
      candidates.set(id, resolved)
    }
  }
  for (const [id, resolved] of candidates) {
    const region = regionOf(resolved.domain)
    if (known.has(id) && options.force === false) {
      rows.push({ region, action: 'skipped', why: 'already known to the pool' })
      continue
    }
    const existing = known.get(id)
    // Compare both versions at the destination's source rank.
    if (existing && !isFresher({ ...resolved, sourcePath: existing.sourcePath }, existing, signIns)) {
      rows.push({ region, action: 'skipped', why: 'the copy on disk is at least as fresh' })
      continue
    }
    if (!options.dryRun && !await importOwnSignIn(signIns, { ...ownSignInOf(resolved), lastRefreshAtMs: resolved.lastRefreshAtMs ?? 0 }, options.force)) {
      rows.push({ region, action: 'skipped', why: options.force ? 'the copy on disk is at least as fresh' : 'already known to the pool' })
      continue
    }
    rows.push({
      region,
      action: options.dryRun ? 'would import' : 'imported',
      why: '',
    })
  }

  for (const row of rows) {
    const why = row.why === '' ? '' : '  (' + row.why + ')'
    console.log(row.action.padEnd(12) + ' ' + row.region + why)
  }
  const imported = rows.filter((row) => row.action === 'imported' || row.action === 'would import').length
  console.log('\n' + imported + ' to import, ' + (rows.length - imported) + ' skipped'
    + (options.dryRun ? ' (dry run, nothing written)' : ''))
}

if (require.main === module) main().catch((error) => { console.error('error: ' + safeMessage(error)); process.exit(1) })

module.exports = { readSignIn }

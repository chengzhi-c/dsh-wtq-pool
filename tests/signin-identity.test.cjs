const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
require('./ts-loader.cjs')
const { writeOwnSignIn } = require('../src/accounts.ts')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'signin-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const save = (uid, uin = '', nickname = '') => writeOwnSignIn(dir, {
    uid, uin, nickname, enterpriseId: '', region: 'cn', domain: 'www.codebuddy.cn',
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAtMs: Date.now() + 3600000,
  })
  const accounts = () => fs.readdirSync(dir).map(file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).account)
  return { dir, save, accounts }
}

for (const [label, first, second] of [
  ['punctuation', 'team.one', 'teamone'],
  ['case', 'TeamOne', 'teamone'],
  ['length', 'team'.repeat(8) + '1', 'team'.repeat(8) + '2'],
]) test(`sign-in files retain both identities differing by ${label}`, async t => {
  const { save, accounts } = fixture(t)
  const a = await save(first)
  const b = await save(second)
  assert.deepEqual(accounts().map(account => account.uid).sort(), [first, second].sort())
  assert.notEqual(a.toLowerCase(), b.toLowerCase())
  assert.equal(await save(first, '', 'Updated'), a)
  assert.equal(accounts().find(account => account.uid === first).nickname, 'Updated')
})

test('a numeric sign-in preserves a different account in its 1.4.1 path', async t => {
  const { dir, save, accounts } = fixture(t)
  const old = path.join(dir, 'workbuddy-panel-90000000003.info')
  const seed = await save('9000.0000003')
  if (seed !== old) fs.renameSync(seed, old)
  const numeric = await save('numeric', '90000000003')
  assert.equal(accounts().length, 2)
  assert.equal(await save('9000.0000003', '', 'Updated'), old)
  fs.unlinkSync(old)
  assert.equal(await save('numeric', '90000000003'), numeric)
  assert.deepEqual(accounts().map(account => account.uid), ['numeric'])
})

test('a sign-in reuses a 1.4.1 random path for a non-ASCII uid', async t => {
  const { dir, save, accounts } = fixture(t)
  const uid = '\u7528\u6237'
  const old = path.join(dir, 'workbuddy-panel-74b4002e-e3a8-4adb-89d6-dbeedc9966b0.info')
  fs.renameSync(await save(uid), old)
  assert.equal(await save(uid, '', 'Updated'), old)
  assert.deepEqual(accounts().map(account => account.nickname), ['Updated'])
})

for (const conflict of ['none', 'newer', 'same date', 'undated']) test(`sealed UUID cleanup with ${conflict} competing sign-in`, async t => {
  t.mock.method(require('../src/at-rest.ts'), 'encryptedFieldOpener', async () => undefined)
  const { dir } = fixture(t)
  const { WorkBuddyAccountPool, ownSignInDir } = require('../src/accounts.ts')
  const signins = ownSignInDir(dir)
  fs.mkdirSync(signins)
  const uid = '\u7528\u6237'
  const now = Date.now()
  const seed = (suffix, owner, issued) => {
    const file = path.join(signins, `workbuddy-panel-00000000-0000-4000-8000-00000000000${suffix}.info`)
    const bytes = Buffer.from(JSON.stringify({ account: { uid: owner, nickname: 'Shared' },
      auth: { accessToken: { $wbEncrypted: 1, envelope: 'fixture' }, lastRefreshTime: issued } }))
    fs.writeFileSync(file, bytes)
    return { file, bytes }
  }
  const old = [seed(1, uid, now - 2000), seed(2, uid, now - 1000)]
  const kept = [seed(3, '\u5176\u4ed6', now - 2000), seed(4, undefined, now - 1000)]
  const current = await writeOwnSignIn(signins, { uid, nickname: 'Shared', accessToken: 'fixture',
    refreshToken: '', region: 'cn', domain: 'www.codebuddy.cn', lastRefreshAtMs: now, expiresAtMs: now + 3600000 })
  const currentBytes = fs.readFileSync(current)
  assert.match(path.basename(current), /^workbuddy-panel-[a-f0-9]{64}\.info$/)
  const options = { dataPath: () => dir, authDirs: [signins] }
  const pool = new WorkBuddyAccountPool(options)
  const [target] = await pool.scan()
  assert.equal(target.credential.sourcePath, current)
  assert.equal(target.credential.uid, uid)
  assert.equal(target.credential.lastRefreshAtMs, now)
  if (conflict !== 'none') kept.push(seed(5, uid, { newer: now + 1000, 'same date': now }[conflict]))
  const removed = await pool.removeOwnSignIn(target.id)
  assert.equal(removed, conflict === 'none')
  for (const { file, bytes } of kept) assert.deepEqual(fs.readFileSync(file), bytes)
  if (removed) assert.ok([current, ...old.map(copy => copy.file)].every(file => !fs.existsSync(file)))
  else assert.ok(fs.existsSync(current) && currentBytes.equals(fs.readFileSync(current)), 'refusal preserves the current sign-in')
  assert.equal((await new WorkBuddyAccountPool(options).scan()).some(row => row.id === target.id), !removed)
})

test('direct upgrade deletion removes both historical UUID sign-ins', async t => {
  const { dir } = fixture(t)
  const { WorkBuddyAccountPool, ownSignInDir } = require('../src/accounts.ts')
  const signins = ownSignInDir(dir)
  fs.mkdirSync(signins)
  const now = Date.now()
  const seed = (suffix, uid, age) => {
    const name = `workbuddy-panel-00000000-0000-4000-8000-00000000000${suffix}.info`
    const text = JSON.stringify({
      auth: { accessToken: `fixture-a-${suffix}`, refreshToken: `fixture-r-${suffix}`, expiresAt: now + 3600000, lastRefreshTime: now - age },
      account: { uid, nickname: 'Shared' },
    })
    fs.writeFileSync(path.join(signins, name), text)
    return { name, text }
  }
  const uid = '\u7528\u6237'
  seed(1, uid, 2000)
  seed(2, uid, 1000)
  const other = seed(3, '\u5176\u4ed6', 2000)
  const pool = new WorkBuddyAccountPool({ dataPath: () => dir, authDirs: [signins] })
  const target = (await pool.scan()).find(account => account.credential.uid === uid)
  const removed = await pool.removeOwnSignIn(target.id)
  assert.deepEqual({ removed, files: fs.readdirSync(signins).sort(),
    other: fs.readFileSync(path.join(signins, other.name), 'utf8') === other.text,
    roster: (await pool.rescan()).map(account => account.credential.uid),
  }, { removed: true, files: [other.name], other: true, roster: ['\u5176\u4ed6'] })
})

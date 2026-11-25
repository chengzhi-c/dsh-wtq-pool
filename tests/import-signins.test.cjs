/**
 * `tools/import-signins.cjs` reads the two document shapes the pool reads.
 *
 * The rest of its job - the region rule, the account id, the file it writes - is
 * the plugin's own code (`src/accounts.ts`, `src/upstream.ts`), so there is
 * nothing to pin here: a change there changes both sides at once. What is this
 * tool's own is the parsing, and a shape it misreads either loses an account or
 * files a token that does not work.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
require('./ts-loader.cjs')

const loadTool = () => require('../tools/import-signins.cjs')

function scratch(label) {
  return fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'import-' + label + '-'))
}

test('CLI imports preserve issue times and replace only with a fresher sign-in', () => {
  const directory = scratch('freshness')
  const source = path.join(directory, 'source.json')
  const issued = 1790000000000
  const run = (token, time, expiry) => {
    fs.writeFileSync(source, JSON.stringify({
      auth: { accessToken: token, refreshToken: 'refresh', domain: 'www.codebuddy.cn', expiresAt: expiry, lastRefreshTime: time },
      account: { uin: '90000000091', uid: 'import-fixture' },
    }))
    return execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
      '--data', directory, '--from', source, '--force'], { encoding: 'utf8' })
  }
  const saved = () => JSON.parse(fs.readFileSync(path.join(directory, 'signins/workbuddy-panel-90000000091.info'), 'utf8')).auth
  try {
    assert.match(run('current', issued, issued + 20000), /1 to import/)
    assert.equal(saved().lastRefreshTime, issued)
    assert.match(run('older', issued - 1000, issued + 50000), /0 to import/)
    assert.equal(saved().accessToken, 'current')
    assert.match(run('newer', issued + 1000, issued + 10000), /1 to import/)
    assert.equal(saved().accessToken, 'newer')
    assert.equal(saved().lastRefreshTime, issued + 1000)
    const second = path.join(directory, 'second.json')
    const global = path.join(directory, 'global.json')
    fs.writeFileSync(second, JSON.stringify({ ...saved(), uid: 'import-fixture', accessToken: 'newest-cn', lastRefreshTime: issued + 2000 }))
    fs.writeFileSync(global, JSON.stringify({ ...saved(), uid: 'import-fixture', uin: '90000000091', domain: 'www.workbuddy.ai', lastRefreshTime: issued + 3000 }))
    for (const reverse of [false, true]) {
      const target = path.join(directory, String(reverse))
      fs.mkdirSync(target)
      const args = [path.join(__dirname, '../tools/import-signins.cjs'), '--data', target, '--region', 'cn',
        '--from', ...(reverse ? [second, source, global] : [global, source, second])]
      if (!reverse) {
        assert.match(execFileSync(process.execPath, [...args, '--dry-run'], { encoding: 'utf8' }), /1 to import/)
        assert.equal(fs.existsSync(path.join(target, 'signins')), false)
      }
      assert.match(execFileSync(process.execPath, args, { encoding: 'utf8' }), /1 to import/)
      assert.deepEqual(fs.readdirSync(path.join(target, 'signins')), ['workbuddy-panel-90000000091.info'])
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'signins/workbuddy-panel-90000000091.info'))).auth.accessToken, 'newest-cn')
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('an expiry in seconds is converted, and one in milliseconds is left alone', () => {
  const tool = loadTool()
  assert.equal(tool.expiryToMs(1794642686), 1794642686 * 1000, 'seconds, as the desktop app stores them')
  assert.equal(tool.expiryToMs(1794642686000), 1794642686000, 'already milliseconds')
  assert.equal(tool.expiryToMs(0), 0, 'no expiry known')
  assert.equal(tool.expiryToMs('soon'), 0, 'an unreadable value is no expiry, not an enormous one')
})

test('both document shapes are read, and the identity comes from the right half', () => {
  const tool = loadTool()
  const directory = scratch('shape')
  try {
    const flat = path.join(directory, 'flat.json')
    fs.writeFileSync(flat, JSON.stringify({
      accessToken: 'at-flat', refreshToken: 'rt-flat', expiresAt: 1794642686,
      domain: 'www.codebuddy.cn', uid: 'u-flat', nickname: 'Flat',
    }))
    const nested = path.join(directory, 'nested.info')
    fs.writeFileSync(nested, JSON.stringify({
      auth: { accessToken: 'at-nested', refreshToken: 'rt-nested', expiresAt: Date.now() + 10000, domain: 'www.workbuddy.ai' },
      account: { uin: '90000000094', uid: 'u-nested', nickname: 'Nested' },
    }))

    const readFlat = tool.readSignIn(flat)
    assert.equal(readFlat.accessToken, 'at-flat')
    assert.equal(readFlat.expiresAtMs, 1794642686 * 1000)
    assert.equal(readFlat.uid, 'u-flat', 'the flat document carries its identity at the top level')
    assert.equal(readFlat.uin, '')

    const readNested = tool.readSignIn(nested)
    assert.equal(readNested.accessToken, 'at-nested')
    assert.equal(readNested.uin, '90000000094', 'the nested document keeps it under `account`')
    assert.equal(readNested.nickname, 'Nested')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a document with no token is not an account', () => {
  const tool = loadTool()
  const directory = scratch('empty')
  try {
    const cases = {
      'empty.json': {},
      'sealed.info': { auth: { accessToken: '' }, account: { uid: 'u' } },
      'broken.json': '{not json',
      'list.json': '[1,2,3]',
      'missing.json': undefined,
    }
    for (const [name, document] of Object.entries(cases)) {
      const file = path.join(directory, name)
      if (document !== undefined) fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document))
      assert.equal(tool.readSignIn(file), undefined, name + ' must be skipped, not imported as a tokenless account')
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

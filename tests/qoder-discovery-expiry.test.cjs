const assert = require('node:assert/strict')
const { createCipheriv, pbkdf2Sync } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const { transpile } = require('./ts-loader.cjs')

test('Qoder duplicate discovery keeps an undated live session over an expired copy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wtq-qoder-expiry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const password = 'fixture-keychain-password'
  t.mock.method(require('node:child_process'), 'execFile', (_file, _args, _options, callback) => {
    process.nextTick(callback, null, password + '\n', '')
  })
  const source = join(__dirname, '..', 'src', 'qoder-credentials.ts')
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, require: createRequire(source), Buffer,
    process: { platform: 'darwin', env: {} },
  })
  vm.runInContext(transpile(readFileSync(source, 'utf8')), context)
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const candidates = []
  for (const [name, expiresAt] of [['live', 0], ['expired', Date.now() - 60000]]) {
    const appDir = join(dir, name)
    await mkdir(appDir)
    const file = join(appDir, 'auth.v1.dat')
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
    const text = JSON.stringify({ token: name, user: { id: 'same-account' }, expiresAt })
    await writeFile(file, Buffer.concat([Buffer.from('v10'), cipher.update(text), cipher.final()]))
    candidates.push({ region: 'cn', appName: name, appDir, path: file, kind: 'auth-v1' })
  }
  for (const order of [candidates, [...candidates].reverse()]) {
    const result = await module.exports.discoverQoderCredentials(order)
    assert.equal(result.failures.length, 0)
    assert.equal(result.credentials.length, 1)
    assert.equal(result.credentials[0].token, 'live')
  }
})

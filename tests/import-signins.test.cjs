const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
require('./ts-loader.cjs')

const loadTool = () => require('../tools/import-signins.cjs')
const { WorkBuddyAccountPool, parseWorkBuddyAuth, renewOwnSignInFile } = require('../src/accounts.ts')

function scratch(label) {
  return fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'import-' + label + '-'))
}

test('a region option without a value does not import all accounts', (t) => {
  const directory = scratch('region')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.json')
  fs.writeFileSync(source, JSON.stringify({ accessToken: 'fixture', uid: 'fixture-user' }))
  const { status } = spawnSync(process.execPath, [
    path.join(__dirname, '../tools/import-signins.cjs'), '--data', directory, '--from', source, '--region',
  ], { stdio: 'ignore' })
  assert.equal(status, 2)
  assert.equal(fs.existsSync(path.join(directory, 'signins')), false)
})

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
    const output = run('current', issued, issued + 20000)
    assert.doesNotMatch(output, /import-fixture|90000000091/)
    assert.match(output, /1 to import/)
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

for (const force of [true, false]) {
  test(force
    ? 'a forced CLI import cannot replace a token renewed after its account snapshot'
    : 'a default CLI import keeps a sign-in created after its account snapshot', async (t) => {
    const directory = scratch('renew-race')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const signIns = path.join(directory, 'signins')
    const file = path.join(signIns, 'workbuddy-panel-90000000097.info')
    const source = path.join(directory, 'incoming.json')
    const issued = 1790000000000
    const document = (token, offset) => ({
      auth: { accessToken: token, refreshToken: `refresh-${token}`, lastRefreshTime: issued + offset, expiresAt: issued + 10000 },
      account: { uin: '90000000097' },
    })
    fs.mkdirSync(signIns)
    if (force) fs.writeFileSync(file, JSON.stringify(document('original', 0)))
    fs.writeFileSync(source, JSON.stringify(document('imported', force ? 1000 : 2000)))
    const child = spawn(process.execPath, ['-e', `
      const io = require('node:fs/promises')
      const readDirectory = io.readdir, write = io.writeFile
      const target = ${JSON.stringify(file)}, directory = ${JSON.stringify(signIns)}
      const pause = async () => {
        const resume = new Promise(resolve => process.once('message', resolve))
        process.send('paused')
        await resume
      }
      let readPaused = false, writePaused = false
      io.readdir = async (file, ...args) => {
        if (file === directory && !readPaused) { readPaused = true; await pause() }
        return readDirectory(file, ...args)
      }
      io.writeFile = async (file, ...args) => {
        try {
          const result = await write(file, ...args)
          if (!writePaused && file.startsWith(target + '.') && file.endsWith('.tmp')) {
            writePaused = true
            await pause()
          }
          return result
        } catch (error) {
          if (!writePaused && file === target + '.lock') { writePaused = true; await pause() }
          throw error
        }
      }
      process.argv = [process.execPath, ${JSON.stringify(path.join(__dirname, '../tools/import-signins.cjs'))},
        '--data', ${JSON.stringify(directory)}, '--from', ${JSON.stringify(source)}, ...${JSON.stringify(force ? ['--force'] : [])}]
      require('node:module').runMain()
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const exited = once(child, 'exit')
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    let releaseRenewal, renewalStarted
    const gate = new Promise(resolve => { releaseRenewal = resolve })
    const started = new Promise(resolve => { renewalStarted = resolve })
    let renewal
    try {
      await once(child, 'message')
      const previous = parseWorkBuddyAuth(JSON.stringify(document('original', 0)), file)
      const renewedAt = issued + (force ? 2000 : 1000)
      renewal = renewOwnSignInFile(file, {
        ...previous, accessToken: 'renewed', refreshToken: 'refresh-renewed', lastRefreshAtMs: renewedAt,
      }, previous, !force, async () => { renewalStarted(); await gate; return true })
      await started
      const writing = once(child, 'message')
      child.send('continue')
      await writing
      releaseRenewal()
      assert.equal(await renewal, true)
      child.send('continue')
      const [code] = await exited
      assert.equal(code, 0, output)
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')).auth
      assert.equal(saved.accessToken, 'renewed')
      assert.equal(saved.lastRefreshTime, renewedAt)
      assert.match(output, /0 to import/)
    } finally {
      releaseRenewal()
      child.kill()
      await renewal
      await exited
    }
  })
}

for (const flags of [[], ['--force']]) {
  test(`UID-only disk identity survives a UIN import (${flags[0] ?? 'default'})`, async (t) => {
    const directory = scratch('uid-alias')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const source = path.join(directory, 'incoming.json')
    const signIns = path.join(directory, 'signins')
    const issued = 1790000000000
    const write = (time, uin) => fs.writeFileSync(source, JSON.stringify({
      uid: 'alias-fixture', uin, accessToken: `fixture-${time}`, lastRefreshTime: time,
    }))
    const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
      '--data', directory, '--from', source, ...args], { encoding: 'utf8' })
    const pool = () => new WorkBuddyAccountPool({ authDirs: [signIns], dataPath: () => directory })
    write(issued)
    run()
    const names = fs.readdirSync(signIns)
    const file = path.join(signIns, names[0])
    const before = fs.readFileSync(file)
    const [original] = await pool().scan()
    assert.ok(fs.existsSync(path.join(directory, 'credentials-archive.json')))
    write(issued - 1, '90000000092')
    const older = run(...flags)
    const rows = await pool().scan()
    assert.deepEqual([fs.readdirSync(signIns).length, rows.length, new Set(rows.map(r => r.credential.uid)).size], [1, 1, 1])
    assert.match(older, /0 to import/)
    write(issued + 1, '90000000092')
    assert.match(run(), /0 to import/)
    assert.match(run('--force', '--dry-run'), /1 to import/)
    assert.deepEqual(fs.readdirSync(signIns), names)
    assert.ok(before.equals(fs.readFileSync(file)))
    assert.match(run('--force'), /1 to import/)
    assert.deepEqual(fs.readdirSync(signIns), names)
    const restarted = pool()
    restarted.applyConfig({ disabledAccountIds: [original.id] })
    const after = await restarted.scan()
    assert.deepEqual(after.map(row => row.id), [original.id])
    assert.equal(after[0].credential.lastRefreshAtMs, issued + 1)
    assert.ok(restarted.isDisabled(original.id))
    assert.ok(await restarted.removeOwnSignIn(original.id))
    assert.deepEqual(fs.readdirSync(signIns), [])
    assert.equal((await pool().scan()).length, 0)
  })
}

for (const archiveOnly of [false, true]) {
  test(`successive billing IDs stay distinct (archive only: ${archiveOnly})`, async (t) => {
    const directory = scratch('remember-billing')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const signIns = path.join(directory, 'signins')
    const source = path.join(directory, 'incoming.json')
    const run = (uin, offset, ...flags) => {
      fs.writeFileSync(source, JSON.stringify({ uid: 'billing-fixture', uin, linkedUin: 'untrusted-binding', accessToken: `fixture-${offset}`,
        lastRefreshTime: 1790000000000 + offset }))
      return execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
        '--data', directory, '--from', source, ...flags], { encoding: 'utf8' })
    }
    const scan = () => new WorkBuddyAccountPool({ authDirs: [signIns], dataPath: () => directory }).scan()
    run(undefined, 1)
    const [original] = await scan()
    if (archiveOnly) fs.unlinkSync(path.join(signIns, fs.readdirSync(signIns)[0]))
    const before = fs.readdirSync(signIns)
    for (const flags of [[], ['--force']]) {
      assert.match(run('90000000095', 0, ...flags), /0 to import/)
      assert.deepEqual(fs.readdirSync(signIns), before)
    }
    assert.match(run('90000000095', 2, '--force'), /1 to import/)
    const [first] = await scan()
    assert.equal(first.id, original.id)
    const firstFile = first.credential.sourcePath
    const bytes = fs.readFileSync(firstFile)
    assert.match(run('90000000096', 3, '--force'), /1 to import/)
    assert.ok(bytes.equals(fs.readFileSync(firstFile)), 'a different billing account replaced the original file')
    const two = await scan()
    assert.equal(two.length, 2)
    assert.deepEqual(two.map(r => r.credential.lastRefreshAtMs).sort(), [1790000000002, 1790000000003])
    assert.match(run('90000000095', 4, '--force'), /1 to import/)
    const updated = await scan()
    assert.equal(updated.length, 2)
    assert.equal(updated.find(r => r.id === original.id).credential.lastRefreshAtMs, 1790000000004)
    assert.match(run('90000000096', 6, '--force'), /1 to import/)
    const rotated = await scan()
    const second = rotated.find(r => r.id !== original.id)
    assert.equal(second.credential.lastRefreshAtMs, 1790000000006)
    assert.equal(rotated.find(r => r.id === original.id).credential.lastRefreshAtMs, 1790000000004)

    // Roll the file back behind the real archive, then remove it altogether.
    fs.writeFileSync(firstFile, bytes)
    assert.match(run('90000000095', 3, '--force'), /0 to import/)
    assert.ok(bytes.equals(fs.readFileSync(firstFile)))
    fs.unlinkSync(firstFile)
    assert.match(run('90000000095', 7, '--force'), /1 to import/)
    const restored = await scan()
    assert.equal(restored.length, 2)
    assert.equal(restored.find(r => r.id === original.id).credential.sourcePath, firstFile)
    assert.equal(restored.find(r => r.id === original.id).credential.lastRefreshAtMs, 1790000000007)
    assert.equal(restored.find(r => r.id === second.id).credential.lastRefreshAtMs, 1790000000006)
  })
}

test('UID aliases do not cross regions or overwrite a conflicting UIN', (t) => {
  const directory = scratch('alias-boundary')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'incoming.json')
  const signIns = path.join(directory, 'signins')
  let time = 1790000000000
  const run = (uin, domain) => {
    fs.writeFileSync(source, JSON.stringify({ uid: 'shared-fixture', uin, domain,
      accessToken: 'fixture', lastRefreshTime: ++time }))
    return execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
      '--data', directory, '--from', source, '--force'], { encoding: 'utf8' })
  }
  const cn = 'www.codebuddy.cn', global = 'www.workbuddy.ai'
  run(undefined, cn)
  const [original] = fs.readdirSync(signIns)
  const bytes = fs.readFileSync(path.join(signIns, original))
  assert.match(run(undefined, global), /0 to import/)
  assert.ok(bytes.equals(fs.readFileSync(path.join(signIns, original))))
  assert.match(run('90000000093', global), /1 to import/)
  assert.match(run('90000000094', global), /1 to import/)
  assert.equal(fs.readdirSync(signIns).length, 3)
  assert.ok(bytes.equals(fs.readFileSync(path.join(signIns, original))))
  const snapshot = () => fs.readdirSync(signIns).map(name => fs.readFileSync(path.join(signIns, name)))
  const before = snapshot()
  assert.match(run(undefined, global), /0 to import/)
  assert.ok(snapshot().every((file, i) => file.equals(before[i])))
})

test('forced imports compare against the freshest legacy UUID copy in either order', (t) => {
  const directory = scratch('legacy')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const signIns = path.join(directory, 'signins')
  fs.mkdirSync(signIns)
  const files = [1, 2].map(n => path.join(signIns, `workbuddy-panel-00000000-0000-4000-8000-00000000000${n}.info`))
  const source = path.join(directory, 'incoming.json')
  const issued = 1790000000000
  const write = (file, time) => fs.writeFileSync(file, JSON.stringify({
    auth: { accessToken: `fixture-${time}`, lastRefreshTime: time, expiresAt: issued + 10000 },
    account: { uin: '!!!' },
  }))
  const times = () => files.map(file => JSON.parse(fs.readFileSync(file)).auth.lastRefreshTime)
  const run = (...flags) => execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
    '--data', directory, '--from', source, '--force', ...flags], { encoding: 'utf8' })
  for (const before of [[issued + 2, issued], [issued, issued + 2]]) {
    files.forEach((file, i) => write(file, before[i]))
    write(source, issued + 1)
    const output = run()
    assert.deepEqual(times(), before)
    assert.match(output, /0 to import/)
    write(source, issued + 3)
    assert.match(run('--dry-run'), /1 to import/)
    assert.deepEqual(times(), before)
    assert.match(run(), /1 to import/)
    assert.equal(Math.max(...times()), issued + 3)
  }
})

for (const field of ['refreshToken', 'accessToken']) {
  test(`CLI protects a sealed ${field} on disk without importing sealed inputs`, (t) => {
    const directory = scratch('sealed')
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const signIns = path.join(directory, 'signins')
    fs.mkdirSync(signIns)
    const source = path.join(directory, 'incoming.json')
    const uid = 'sealed-fixture'
    const suffix = require('node:crypto').createHash('sha256').update(uid).digest('hex')
    const file = path.join(signIns, `workbuddy-panel-${suffix}.info`)
    const issued = 1790000000000
    const document = { account: { uid }, auth: { accessToken: 'fixture', lastRefreshTime: issued } }
    document.auth[field] = { $wbEncrypted: 1, envelope: 'fixture' }
    const before = Buffer.from(JSON.stringify(document))
    const run = (...flags) => execFileSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
      '--data', directory, '--from', source, ...flags], { encoding: 'utf8' })
    fs.writeFileSync(source, before)
    assert.match(run('--force'), /0 to import/)
    assert.deepEqual(fs.readdirSync(signIns), [])
    fs.writeFileSync(file, before)
    const incoming = time => fs.writeFileSync(source, JSON.stringify({ uid, accessToken: 'replacement', lastRefreshTime: time }))
    incoming(issued - 1000)
    for (const flags of [[], ['--force']]) {
      const output = run(...flags)
      assert.ok(before.equals(fs.readFileSync(file)), 'older input overwrote the sealed file')
      assert.match(output, /0 to import/)
    }
    incoming(issued + 1000)
    assert.match(run(), /0 to import/)
    assert.ok(before.equals(fs.readFileSync(file)))
    assert.match(run('--force', '--dry-run'), /1 to import/)
    assert.ok(before.equals(fs.readFileSync(file)))
    assert.match(run('--force'), /1 to import/)
    assert.equal(JSON.parse(fs.readFileSync(file)).auth.lastRefreshTime, issued + 1000)
  })
}

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
      auth: { accessToken: 'at-nested', refreshToken: 'rt-nested', refreshExpiresAt: 1, expiresAt: Date.now() + 10000, domain: 'www.workbuddy.ai' },
      account: { uin: '90000000094', uid: 'u-nested', nickname: 'Nested' },
    }))

    const readFlat = tool.readSignIn(flat)
    assert.equal(readFlat.accessToken, 'at-flat')
    assert.equal(readFlat.expiresAtMs, 1794642686 * 1000)
    assert.equal(readFlat.uid, 'u-flat', 'the flat document carries its identity at the top level')
    assert.equal(readFlat.uin, undefined)

    const readNested = tool.readSignIn(nested)
    assert.equal(readNested.accessToken, 'at-nested')
    assert.equal(readNested.refreshToken, '')
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
      'sealed-string.info': { accessToken: JSON.stringify({ $wbEncrypted: 1, envelope: 'fixture' }), uid: 'u' },
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

test('a failed CLI write omits private target paths', t => {
  const directory = scratch('private-write')
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = path.join(directory, 'source.json')
  fs.writeFileSync(source, JSON.stringify({ accessToken: 'fixture', uin: '90000000993' }))
  fs.writeFileSync(path.join(directory, 'signins'), 'existing file')
  const result = spawnSync(process.execPath, [path.join(__dirname, '../tools/import-signins.cjs'),
    '--data', directory, '--from', source], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /EEXIST|ENOTDIR/)
  assert.equal(result.stderr.includes(directory), false)
  assert.doesNotMatch(result.stderr, /90000000993/)
})

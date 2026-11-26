const assert = require('node:assert/strict')
const { test } = require('node:test')
require('./ts-loader.cjs')
const { uniqueSourceLabels } = require('../src/source-pool.ts')

for (const [kind, rows] of [
  ['matching id tails', [{ name: 'Twin', id: '1112345678' }, { name: 'Twin', id: '2212345678' }]],
  ['stripped punctuation', [{ name: 'Twin', id: 'user-1' }, { name: 'Twin', id: 'user1' }]],
  ['an existing suffixed name', [{ name: 'Twin', id: 'user-1' }, { name: 'Twin', id: 'user-2' }, { name: 'Twin#user1', id: 'user-3' }]],
  ['names matching the hash fallback', [{ name: 'Twin', id: '1112345678' }, { name: 'Twin', id: '2212345678' }, { name: 'Twin#00b87203', id: 'third' }, { name: 'Twin#00b87203-2', id: 'fourth' }]],
]) test(`source accounts with ${kind} remain separately selectable`, () => {
  const labels = uniqueSourceLabels(rows, row => row.name, row => row.id)
  assert.equal(new Set(labels).size, rows.length)
  const reversed = [...rows].reverse()
  const reversedLabels = uniqueSourceLabels(reversed, row => row.name, row => row.id)
  assert.deepEqual(reversedLabels.reverse(), labels, 'labels are stable when discovery order changes')
})

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function sourceHost(source, roster, document) {
  const entry = path.resolve(__dirname, '../src/host.ts')
  const ownRequire = createRequire(entry)
  const discover = async () => ({ credentials: roster.value, failures: [] })
  const settingsHost = {
    getSettings: () => document.value,
    setSettings: patch => { document.value = { ...document.value, ...patch } },
  }
  const overrides = {
    './trae-discovery': { ...ownRequire('./trae-discovery.ts'), discoverTraeCredentials: discover },
    './qoder-credentials': { ...ownRequire('./qoder-credentials.ts'), discoverQoderCredentials: discover },
  }
  ownRequire('./pi-compat.ts').installPi(settingsHost)
  const context = vm.createContext({
    require: name => overrides[name] ?? ownRequire(name), module: { exports: {} }, __dirname,
    pi: { plugin: settingsHost }, console: { log() {} }, AbortController, AbortSignal, fetch,
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  context.exports = context.module.exports
  vm.runInContext(require('./ts-loader.cjs').transpile(fs.readFileSync(entry, 'utf8')), context)
  vm.runInContext('serviceStopped = false; loadGeneration = 1', context)
  context.delay = async () => {}
  context.traeRowProbe = context.qoderRowProbe = async credential => ({ usage: { credits: { total: credential.balance } } })
  context.statusDocument = async () => ({})
  return context
}

const credential = (id, name, balance) => ({
  region: 'cn', edition: 'cn', source: 'desktop', userId: id, userID: id,
  accountName: name, name, email: '', balance,
})

test('trae selects and checks in a name-only account matching another user ID', async () => {
  const roster = { value: [credential('900123', 'Alice', 42), credential('', '900123', 7)] }
  const host = sourceHost('trae', roster, { value: { sourceTrae: true } })
  await host.adoptHostSettings()
  await host.refreshSourceAccounts(1)
  const accountId = host.sourceComposerAccounts('trae', 'cn').find(row => row.label === '900123').id
  await host.onPanelInvoke('xd.preferSourceAccount', { source: 'trae', region: 'cn', accountId })
  let claimed
  host.traeClaimFor = async account => { claimed = account; return { outcome: 'claimed' } }
  await host.traeClaimOne(accountId, 'cn')
  assert.equal(claimed, roster.value[1])
  const active = host.sourceComposerAccounts('trae', 'cn').filter(row => row.active)
  assert.equal(active.length, 1)
  assert.equal(active[0].label, '900123')
})

for (const source of ['trae', 'qoder']) {
  test(source + ' updates the active account when a cached sign-in expires', async () => {
    const now = Date.now()
    const roster = { value: [
      { ...credential('soon', 'Soon', 3), expiresAtMs: now + 60_000 },
      { ...credential('later', 'Later', 7), expiresAtMs: now + 3_600_000 },
      { ...credential('unknown', 'Unknown', 9), expiresAtMs: 0 },
    ] }
    const host = sourceHost(source, roster, { value: {
      sourceTrae: source === 'trae', sourceQoder: source === 'qoder',
    } })
    await host.adoptHostSettings()
    await host.refreshSourceAccounts(1)
    const selected = host.sourceComposerAccounts(source, 'cn').find(row => row.active)
    assert.equal(selected.label, 'Soon')
    vm.runInContext(`Date.now = () => ${now + 120_000}`, host)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).label, 'Later')
    await assert.rejects(host.onPanelInvoke('xd.preferSourceAccount', {
      source, region: 'cn', accountId: selected.id,
    }), error => error.code === 'INVALID')
    vm.runInContext(`Date.now = () => ${now + 7_200_000}`, host)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).label, 'Unknown')
  })

  test(source + ' keeps the selected account through roster changes and restart', async () => {
    const selected = credential('fixture-selected', 'Twin', 42)
    const roster = { value: [selected] }
    const document = { value: {
      sourceTrae: source === 'trae', sourceQoder: source === 'qoder',
      preferredSourceAccounts: { [source + ':cn']: 'Twin' },
    } }
    let host = sourceHost(source, roster, document)
    await host.adoptHostSettings()
    await host.refreshSourceAccounts(1)
    roster.value = [credential('fixture-new', 'Twin', 7), selected]
    await host.refreshSourceAccounts(1)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).total, 42)
    host = sourceHost(source, roster, document)
    await host.adoptHostSettings()
    await host.refreshSourceAccounts(1)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).total, 42)
    const accountId = host.sourceComposerAccounts(source, 'cn').find(row => row.total === 42).id
    await host.onPanelInvoke('xd.preferSourceAccount', { source, region: 'cn', accountId })
    roster.value = [credential('fixture-new', 'Other', 7), { ...selected, name: 'Renamed', accountName: 'Renamed' }]
    host = sourceHost(source, roster, document)
    await host.adoptHostSettings()
    await host.refreshSourceAccounts(1)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).total, 42)
    assert.equal(host.sourcePreferredMap(source).cn, accountId)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).label, 'Renamed')
  })

  test(source + ' does not transfer a departed account hold to a same-name replacement', async () => {
    const roster = { value: [credential('fixture-old', 'Twin', 3), credential('fixture-other', 'Other', 7)] }
    const document = { value: {
      sourceTrae: source === 'trae', sourceQoder: source === 'qoder',
      preferredSourceAccounts: { [source + ':cn']: 'Twin' },
    } }
    const host = sourceHost(source, roster, document)
    await host.adoptHostSettings()
    await host.refreshSourceAccounts(1)
    vm.runInContext(`noteSourceFailure('${source}', 'cn', preferredSourceAccount('${source}', 'cn'), '3600')`, host)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).total, 7)
    await host.onPanelInvoke('xd.preferSourceAccount', { source, region: 'cn', accountId: '' })
    roster.value = [credential('fixture-replacement', 'Twin', 42), roster.value[1]]
    await host.refreshSourceAccounts(1)
    assert.equal(host.sourceComposerAccounts(source, 'cn').find(row => row.active).total, 42)
  })
}

for (const source of ['trae', 'qoder']) test(source + ' refuses a stale check-in after a same-name replacement', async () => {
  const roster = { value: [credential('fixture-old', 'Twin', 3)] }
  const document = { value: { sourceTrae: source === 'trae', sourceQoder: source === 'qoder' } }
  const host = sourceHost(source, roster, document)
  await host.adoptHostSettings()
  await host.refreshSourceAccounts(1)
  const id = host.sourceComposerAccounts(source, 'cn')[0].id
  roster.value = [credential('fixture-new', 'Twin', 7)]
  let claims = 0
  host[source + 'ClaimFor'] = async () => { claims++; return { outcome: 'claimed' } }
  await assert.rejects(host[source + 'ClaimOne'](id, 'cn'), error => error.code === 'NOT_FOUND')
  assert.equal(claims, 0)
})

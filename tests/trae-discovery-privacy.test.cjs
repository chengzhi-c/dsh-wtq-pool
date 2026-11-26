const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
require('./ts-loader.cjs')
const { discoverTraeCredentials } = require('../src/trae-discovery.ts')

for (const source of ['storage', 'auth value', 'cli']) {
  test(`Trae ${source} syntax errors omit sign-in contents`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'wtq-trae-privacy-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'fixture.json')
    const marker = 'PRIVATE'
    const broken = `{"token":${marker}_CREDENTIAL}`
    await writeFile(file, source === 'auth value'
      ? JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': broken })
      : broken)
    const result = await discoverTraeCredentials([
      { edition: 'cn', path: file, source: source === 'cli' ? 'cli' : 'desktop' },
    ])
    assert.deepEqual(result.credentials, [])
    assert.equal(result.failures.length, 1)
    assert.equal(JSON.stringify(result.failures).includes(marker), false)
  })
}

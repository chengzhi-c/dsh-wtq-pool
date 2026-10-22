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
const { fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText
// The core imports its siblings without an extension, so the loader needs the
// same `.ts` resolution the DSH entry builds against.
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

const loadTool = () => require('../tools/import-signins.cjs')

function scratch(label) {
  return fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), 'import-' + label + '-'))
}

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

/**
 * Qoder's two usage routes, and the fallback between them.
 *
 * The presentation route carries the per-model packages, the older quota route
 * carries the account pool. A 200 that names only `expiresAt` is not a usable
 * usage document: taking it as one skipped the fallback and then threw, so the
 * card said "usage unavailable" while the other route had an answer.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

registerHooks({
  resolve(specifier, context, next) {
    const ownSource = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL).startsWith(path.join(root, 'src') + path.sep)
    return next(ownSource && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs', shortCircuit: true, source: transpile(fs.readFileSync(fileURLToPath(url), 'utf8')),
    }
    return next(url, context)
  },
})

const { QoderUpstreamClient } = require('../src/qoder-client.ts')

test('a presentation document with only an expiry falls back to the quota route', async () => {
  const seen = []
  const client = new QoderUpstreamClient({
    region: 'cn',
    credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
    fetchImpl: async (url) => {
      seen.push(String(url))
      if (String(url).includes('/me/usage')) {
        return new Response(JSON.stringify({ expiresAt: Date.now() + 86_400_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ user_quota: { total: 10, remaining: 5 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  const usage = await client.fetchUsage()
  assert.equal(seen.length, 2, 'the unusable presentation document must not skip the fallback')
  assert.equal(usage.source, 'quota')
  assert.deepEqual(usage.userQuota, { total: 10, remaining: 5 })
})

'use strict'

/**
 * The model provider ids are part of the host's stored configuration, so a
 * rename must be an explicit, tested contract rather than a value a trimmed
 * declaration or a copied fixture can silently absorb.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

function productionIds(source, name) {
  const match = source.match(new RegExp(`^const ${name} = \\{[^}]+\\};`, 'm'))
  assert.ok(match, `src/host.ts must declare ${name}`)
  const context = vm.createContext({})
  vm.runInContext(match[0].replace(/^const /, 'globalThis.'), context)
  return JSON.parse(JSON.stringify(context[name]))
}

test('the provider ids the host stores are the wtqpool routes', () => {
  const source = fs.readFileSync(path.join(root, 'src/host.ts'), 'utf8')

  assert.deepEqual(productionIds(source, 'PROVIDER_ID_BY_REGION'), {
    cn: 'wtqpool-cn',
    global: 'wtqpool-global',
  })
  assert.deepEqual(productionIds(source, 'TRAE_PROVIDER_ID_BY_REGION'), {
    cn: 'wtqpool-trae-cn',
    ai: 'wtqpool-trae-ai',
  })
  assert.deepEqual(productionIds(source, 'QODER_PROVIDER_ID_BY_REGION'), {
    cn: 'wtqpool-qoder-cn',
    global: 'wtqpool-qoder-global',
  })
})

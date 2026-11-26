const assert = require('node:assert/strict')
const { test } = require('node:test')
require('./ts-loader.cjs')
const { safeMessage, writeOpenAIError } = require('../src/loopback.ts')

test('structured Authorization values are private even without digits', () => {
  for (const name of ['Authorization', 'authorization']) {
    const value = 'syntheticopaquetoken'
    const detail = JSON.stringify({ data: { [name]: value }, code: 6017 })
    for (const text of [detail, JSON.stringify({ message: detail, code: 6017 })]) {
      let wire
      writeOpenAIError({ writeHead() {}, end(body) { wire = body } }, 502, 'upstream_error', text)
      for (const output of [safeMessage(text), JSON.parse(wire).error.message]) {
        assert.equal(output.includes(value), false, 'Authorization value leaked')
        const decoded = JSON.parse(output)
        const error = decoded.message ? JSON.parse(decoded.message) : decoded
        assert.equal(decoded.code, 6017)
        assert.equal(error.code, 6017)
        assert.equal(error.data[name], '[redacted]')
      }
    }
  }
})

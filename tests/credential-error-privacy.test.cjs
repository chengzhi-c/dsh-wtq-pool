const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

require('./ts-loader.cjs')
const { renewOwnSignInFile } = require('../src/accounts.ts')
const { safeMessage, writeOpenAIError } = require('../src/loopback.ts')

test('renewal errors omit damaged sign-in file contents', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'renew-privacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'signin.info')
  const marker = 'Fixture'
  const damaged = `{"auth":{"accessToken":${marker}Only"}}`
  await writeFile(file, damaged)
  await assert.rejects(renewOwnSignInFile(file, {}, {}), error => {
    assert.equal(safeMessage(error).includes(marker), false)
    return /sign-in.*JSON/i.test(error.message)
  })
  assert.equal(await readFile(file, 'utf8'), damaged)
})

test('error messages omit WorkBuddy enterprise and tenant header values', () => {
  for (const header of ['X-Enterprise-Id', 'X-Tenant-Id']) {
    for (const id of ['147', 'fixture-org-1234', 'org/division:west+1', 'north team; east']) {
      assert.equal(safeMessage(`${header}: ${id}\r\nstatus: 403`), `${header}: [redacted]\r\nstatus: 403`)
    }
    for (const value of ['north / "sales, east" + division', ['north/team', 'east:division']]) {
      const fields = JSON.stringify({ [header]: value, status: 403 })
      for (const echo of [fields, JSON.stringify({ message: fields })]) {
        const message = safeMessage(new Error(echo))
        assert.doesNotMatch(message, /north|sales|east|division/)
        assert.match(message, /403/)
      }
    }
  }
})

test('diagnostics redact header lists without changing other fields', () => {
  for (const name of ['X-Enterprise-Id', 'X-Tenant-Id']) {
    const entries = [...new Headers({ [name]: 'fixture/unit:west', 'content-type': 'text/plain' })]
    const named = entries.map(([name, value]) => ({ name, value }))
    for (const fields of [{ headers: named }, { headers: entries }, { rawHeaders: entries.flat() }]) {
      const text = JSON.stringify({ ...fields, status: 403 })
      for (const echo of [text, JSON.stringify({ message: text })]) {
        const message = safeMessage(echo)
        assert.doesNotMatch(message, /fixture|unit|west/)
        assert.match(message, /text\/plain/)
        assert.match(message, /403/)
      }
    }
  }
})

for (const name of ['X-Refresh-Token', 'X-Api-Key']) {
  for (const shape of ['pairs', 'named', 'flat']) {
    for (const exit of ['diagnostic', 'http']) {
      test(`${exit} redacts ${name} in ${shape} header lists and preserves JSON siblings`, () => {
        for (const token of ['SYNTHETIC_PRIVATE_193746', 'prefix X-Refresh-Token suffix']) {
          const headers = [[name, token], ['Content-Type', 'text/plain']]
          const fields = shape === 'pairs' ? { headers }
            : shape === 'named' ? { headers: headers.map(([name, value]) => ({ name, value })) }
              : { rawHeaders: headers.flat() }
          const text = JSON.stringify({ code: 6817, ...fields })
          for (const wrapper of ['plain', 'nested', 'http']) {
            const echo = wrapper === 'nested' ? JSON.stringify({ message: text, code: 6817 })
              : wrapper === 'http' ? `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n${text}` : text
            let output
            if (exit === 'diagnostic') output = safeMessage(new Error(echo))
            else {
              let body
              writeOpenAIError({ writeHead() {}, end(data) { body = data } }, 502, 'upstream_error', echo)
              output = JSON.parse(body).error.message
            }
            assert.equal(output.includes(token), false, 'credential must not reach the error output')
            const decoded = JSON.parse(wrapper === 'http' ? output.split('\r\n\r\n')[1] : output)
            const detail = wrapper === 'nested' ? JSON.parse(decoded.message) : decoded
            assert.equal(decoded.code, 6817)
            assert.equal(detail.code, 6817)
            assert.equal(output.includes('text/plain'), true)
            const redacted = shape === 'pairs' ? detail.headers[0][1]
              : shape === 'named' ? detail.headers[0].value : detail.rawHeaders[1]
            assert.equal(redacted, '[redacted]')
          }
        }
      })
    }
  }
}

test('credential names inside ordinary string values preserve the JSON document', () => {
  const detail = { message: 'upstream mentions X-Refresh-Token and token', code: 6817 }
  assert.deepEqual(JSON.parse(safeMessage(JSON.stringify(detail))), detail)
})

test('a header line in a JSON error leaves its sibling status intact', () => {
  const error = { message: 'X-Tenant-Id: fixture/unit:west', status: 403 }
  assert.deepEqual(JSON.parse(safeMessage(JSON.stringify(error))), {
    message: 'X-Tenant-Id: [redacted]', status: 403,
  })
})

test('an HTTP diagnostic preserves the JSON error code after identity headers', () => {
  for (const newline of ['\n', '\r\n']) {
    const header = 'X-Enterprise-Id: fixture/{"unit":"west"}'
    const body = JSON.stringify({ tenantId: 'fixture/east', code: 6817 })
    const echo = ['HTTP/1.1 403 Forbidden', header, 'Content-Type: application/json', '', body].join(newline)
    let wire
    writeOpenAIError({ writeHead() {}, end(data) { wire = data } }, 502, 'upstream_error', echo)
    for (const output of [safeMessage(echo), JSON.parse(wire).error.message]) {
      assert.doesNotMatch(output, /fixture|west|east/)
      const [headers, json] = output.split(newline + newline)
      assert.match(headers, /HTTP\/1\.1 403 Forbidden/)
      assert.match(headers, /Content-Type: application\/json/)
      assert.deepEqual(JSON.parse(json), { tenantId: '[redacted]', code: 6817 })
    }
  }
})

test('diagnostics and HTTP error bodies omit account fields echoed by the upstream', () => {
  for (const key of ['enterpriseId', 'tenantId', 'enterprise_id', 'tenant_id', 'uid', 'uin', 'userId', 'nickname', 'accountId']) {
    const value = key === 'uin' ? 147 : 'fixture/unit:west'
    const detail = JSON.stringify({ data: { [key]: value }, 'X-No-Enterprise-Id': '1', code: 6017 })
    const message = JSON.stringify({ message: detail })
    let body
    writeOpenAIError({ writeHead() {}, end(data) { body = data } }, 502, 'upstream_error', message)
    for (const output of [safeMessage(new Error(message)), JSON.parse(body).error.message]) {
      const decoded = JSON.parse(JSON.parse(output).message)
      assert.equal(decoded.data[key], '[redacted]', key)
      assert.equal(decoded.code, 6017)
      assert.equal(decoded['X-No-Enterprise-Id'], '1')
    }
  }
})

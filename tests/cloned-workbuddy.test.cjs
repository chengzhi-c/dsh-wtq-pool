const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('./ts-loader.cjs')

const { WorkBuddyAccountPool } = require('../src/accounts.ts')
const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
const { createWorkBuddyShim } = require('../src/shim.ts')

test('a cloned WorkBuddy refusal reaches the caller while host capture is still open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtq-cloned-workbuddy-'))
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'fixture-token', refreshToken: '', expiresAt: Date.now() + 3_600_000, domain: 'www.codebuddy.cn' },
    account: { uin: 'fixture-user', nickname: 'Fixture' },
  }))
  let upstream
  let capture
  let captureEnded = false
  const client = new WorkBuddyUpstreamClient({
    fetchImpl: async () => {
      const response = new Response(new ReadableStream({
        start(controller) {
          upstream = controller
          // A complete envelope at the peek's size bound, on a socket kept open.
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            code: 11128,
            msg: 'Illegal API invocation from an unapproved channel',
            padding: ' '.repeat(32_768),
          })))
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
      capture = response.clone().text().then(() => { captureEnded = true })
      return response
    },
  })
  const pool = new WorkBuddyAccountPool({ authDirs: [dir], client })
  const request = new AbortController()
  let shim
  let turn
  let timer
  try {
    await pool.scan()
    shim = createWorkBuddyShim({
      pool, client, region: 'cn',
      catalog: { current: () => [{ id: 'hy3' }], visible: () => [{ id: 'hy3' }] },
    })
    await shim.ready
    turn = fetch(shim.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'hi' }] }),
      signal: request.signal,
    }).then(async response => ({ status: response.status, body: await response.text() }))
    const answer = await Promise.race([
      turn,
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 500) }),
    ])
    assert.ok(answer, 'the gateway waited for the host capture to end before returning the refusal')
    assert.equal(answer.status, 400)
    assert.match(answer.body, /11128/)
    assert.equal(captureEnded, false, 'the refusal must reach the caller before the capture sees EOF')
  } finally {
    clearTimeout(timer)
    upstream?.close()
    await capture
    request.abort()
    await turn?.catch(() => {})
    await shim?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

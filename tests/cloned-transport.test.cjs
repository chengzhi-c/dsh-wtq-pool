const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

require('./ts-loader.cjs')

const { WorkBuddyUpstreamClient } = require('../src/upstream.ts')
const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
const { QoderUpstreamClient } = require('../src/qoder-client.ts')

const body = JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hi' }] })
const clients = {
  workbuddy(fetchImpl, signal, timeouts) {
    return new WorkBuddyUpstreamClient({ fetchImpl }).chatStream({
      accessToken: 'fixture', refreshToken: '', domain: 'www.workbuddy.cn', expiresAtMs: 0,
    }, body, signal, timeouts)
  },
  trae(fetchImpl, signal, timeouts) {
    return new TraeSoloUpstreamClient({
      fetchImpl,
      credential: async () => ({ accessToken: 'fixture', userId: 'fixture', edition: 'cn', source: 'desktop', expiresAtMs: 0 }),
      identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }),
    }).chatStream(body, signal, undefined, undefined, timeouts)
  },
  qoder(fetchImpl, signal, timeouts) {
    return new QoderUpstreamClient({
      fetchImpl, region: 'cn', credential: async () => ({ userID: 'fixture', token: 'fixture' }),
    }).chatStream(body, 'fixture', { signal, timeouts })
  },
}

// The host captures a clone of fetch responses. Only aborting the transport can
// stop its branch when the plugin cancels the other branch of the live body.
function capturedTransport() {
  let controller, signal, captured, ended = false
  const stop = (reason) => {
    if (ended) return
    ended = true
    controller.error(reason)
  }
  return {
    async fetch(_url, init) {
      signal = init.signal
      const response = new Response(new ReadableStream({
        start(next) {
          controller = next
          next.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
      signal.addEventListener('abort', () => stop(signal.reason), { once: true })
      captured = response.clone().body.getReader()
      await captured.read()
      return response
    },
    capturedRead() { return captured.read() },
    dispose() { stop(new Error('test cleanup')) },
  }
}

async function within(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('captured transport remained open')), 500) }),
    ])
  } finally { clearTimeout(timer) }
}

for (const [name, open] of Object.entries(clients)) {
  for (const action of ['caller abort', 'body cancellation']) {
    test(`${name} ${action} stops a transport with a captured clone`, async () => {
      const transport = capturedTransport()
      const caller = new AbortController()
      let capturedRead
      try {
        const result = await open(transport.fetch, caller.signal)
        assert.equal(result.ok, true)
        capturedRead = transport.capturedRead()
        capturedRead.catch(() => {})
        const reason = new Error(action)
        if (action === 'caller abort') caller.abort(reason)
        else await within(result.response.body.cancel(reason))
        await assert.rejects(within(capturedRead), { message: action })
      } finally {
        transport.dispose()
        await capturedRead?.catch(() => {})
      }
    })
  }
  test(`${name} closes a refused HTTP transport while the host captures a clone`, async () => {
    let captured, onClose
    const closed = new Promise(resolve => { onClose = resolve })
    const server = createServer((_req, res) => {
      res.on('close', onClose)
      res.writeHead(429, { 'content-type': 'text/plain' })
      // Exceed every client's error-body bound, then keep the connection open.
      res.write('rate limited ' + 'x'.repeat(10_000))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const result = await open(async (_url, init) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, init)
        captured = response.clone().text().then(() => {}, () => {})
        return response
      })
      assert.equal(result.ok, false)
      assert.equal(result.status, 429)
      assert.match(result.message, /^rate limited /)
      await within(captured)
      await within(closed)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await captured
    }
  })
}

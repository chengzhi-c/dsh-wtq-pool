const assert = require('node:assert/strict')
const { test } = require('node:test')

require('./ts-loader.cjs')

const SENTINEL = 'UPSTREAM_ECHO_SENTINEL_user prompt excerpt'
const encoder = new TextEncoder()

test('upstream chat failure details reach the client but not the host log', async () => {
  const { createWorkBuddyShim } = require('../src/shim.ts')
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const { createQoderGateway } = require('../src/qoder-gateway.ts')
  const body = { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] }

  const cases = [
    ['workbuddy', async logger => createWorkBuddyShim({
      port: 0,
      pool: {
        acquire: async () => ({ id: 'fixture', label: 'Fixture', credential: { domain: 'codebuddy.cn' } }),
        available: () => [{ id: 'fixture', label: 'Fixture', credential: { domain: 'codebuddy.cn' } }],
        list: () => [],
      },
      catalog: { visible: () => [{ id: 'fixture-model' }], current: () => [{ id: 'fixture-model' }] },
      client: {
        prepareChatBody: raw => raw,
        chatStream: async () => {
          let sent = false
          return { ok: true, response: new Response(new ReadableStream({
            pull(controller) {
              if (sent) controller.error(new Error(SENTINEL))
              else {
                sent = true
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'))
              }
            },
          }, { highWaterMark: 0 })) }
        },
      },
      logger,
    })],
    ['trae', async logger => createTraeGateway({
      port: 0,
      credentials: async () => [{ accessToken: 'fixture-token', userId: 'fixture', host: '', edition: 'cn', source: 'desktop' }],
      identity: async () => ({ machineId: 'fixture-machine', deviceId: 'fixture-device', platform: 'win32' }),
      logger,
      fetchImpl: async url => {
        const target = String(url)
        if (target.includes('get_detail_param')) return new Response(JSON.stringify({ config_info_list: [{
          config_name: 'fixture-model', display_config: { display_name: 'Fixture', multimodal: false },
          context_window_tokens: { dev: 128000 }, model_detail_list: [{ max_tokens: 32000, prompt_max_tokens: 96000 }],
        }] }), { headers: { 'content-type': 'application/json' } })
        if (target.includes('/models?functions=')) return new Response(JSON.stringify({ data: { list: [] } }), { headers: { 'content-type': 'application/json' } })
        return new Response(`event: output\ndata: {"response":"partial"}\n\nevent: error\ndata: {"code":4001,"message":"${SENTINEL}"}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })],
    ['qoder', async logger => createQoderGateway({
      region: 'cn', port: 0,
      credentials: async () => [{ userID: 'fixture', token: 'fixture-token' }],
      logger,
      fetchImpl: async url => {
        if (String(url).includes('/algo/api/v2/model/list')) return new Response(JSON.stringify({ chat: [{
          key: 'fixture-model', display_name: 'Fixture', is_vl: false, context_config: { standard: { token_count: 128000 } },
        }] }), { headers: { 'content-type': 'application/json' } })
        return new Response(`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\ndata: {"code":"1210","message":"${SENTINEL}"}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })],
  ]

  for (const [name, create] of cases) {
    const logs = []
    const logger = { info() {}, warn: (...args) => logs.push(args.map(String).join(' ')), error() {} }
    const gateway = await create(logger)
    try {
      await gateway.ready
      const response = await fetch(`${gateway.baseUrl()}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body),
      })
      const responseText = await response.text()
      assert.equal(response.status, 200, `${name}: the stream already began before the upstream refusal: ${responseText}`)
      assert.ok(responseText.includes(SENTINEL), `${name}: the response still carries the upstream's refusal`)
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(logs.length > 0, `${name}: a mid-stream failure must still be logged`)
      assert.equal(logs.join('\n').includes(SENTINEL), false, `${name}: upstream content must not enter host logs`)
    } finally {
      await gateway.close()
    }
  }
})

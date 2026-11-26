const test = require('node:test')
const assert = require('node:assert/strict')

require('./ts-loader.cjs')
const { createTraeGateway } = require('../src/trae-gateway.ts')

function row(id, window) {
  return {
    config_name: id,
    display_config: { display_name: id },
    context_window_tokens: { dev: window },
    model_detail_list: [{ max_tokens: 16000, prompt_max_tokens: window - 16000 }],
  }
}

test('a partial refresh keeps only the failed functions old directory answers', async () => {
  let refreshed = false
  const gateway = createTraeGateway({
    port: 0,
    credentials: async () => [{ accessToken: 'fixture', edition: 'cn', host: '' }],
    identity: async () => ({ machineId: 'fixture', deviceId: 'fixture', platform: 'win32' }),
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models?')) return Response.json({ data: { list: [] } })
      const name = JSON.parse(init.body).function
      if (name === 'chat_v3') {
        return refreshed
          ? new Response('temporarily unavailable', { status: 503 })
          : Response.json({ config_info_list: [row('preserved', 116000)] })
      }
      const rows = name === 'solo_work_remote'
        ? [row('current', 128000), ...(refreshed ? [] : [row('retired', 128000)])]
        : name === 'solo_agent_remote' && !refreshed ? [row('current', 256000)] : []
      return Response.json({ config_info_list: rows })
    },
  })
  try {
    await gateway.ready
    const first = await fetch(gateway.baseUrl() + '/v1/models')
    assert.equal(first.status, 200)
    assert.deepEqual((await first.json()).data.map(model => model.id).sort(), ['current', 'preserved', 'retired'])
    assert.equal(gateway.models().find(model => model.id === 'current').contextWindow, 256000)

    refreshed = true
    const next = await fetch(gateway.baseUrl() + '/v1/models', { headers: { 'cache-control': 'no-cache' } })
    assert.equal(next.status, 200)
    assert.deepEqual((await next.json()).data.map(model => model.id).sort(), ['current', 'preserved'])
    const model = gateway.models().find(model => model.id === 'current')
    assert.equal(model.contextWindow, 128000)
    assert.deepEqual(model.variants.map(variant => variant.function), ['solo_work_remote'])
  } finally {
    await gateway.close()
  }
})

const assert = require('node:assert/strict')
const { test } = require('node:test')

require('./ts-loader.cjs')

for (const [name, open, frame, status] of [
  ['Qoder', require('../src/qoder-shim.ts').openQoderResponse,
    'data: {"code":110,"message":"daily quota spent","retryAfterSeconds":3600}\n\n', 429],
  ['Trae', require('../src/trae-shim.ts').openTraeResponse,
    'event: error\ndata: {"code":1005,"message":"quota spent"}\n\n', 402],
]) {
  test(`${name} returns a refusal while the host reads a cloned response`, async () => {
    let controller, timer
    const response = new Response(new ReadableStream({
      start(next) { controller = next; next.enqueue(new TextEncoder().encode(frame)) },
    }))
    // DSH captures a clone and keeps reading after the refusal frame.
    const capture = response.clone().body.getReader()
    await capture.read()
    const answer = open(response, 'fixture')
    try {
      const result = await Promise.race([
        answer,
        new Promise(resolve => { timer = setTimeout(() => resolve(null), 250) }),
      ])
      assert.notEqual(result, null, 'the refusal must reach the client before upstream EOF')
      assert.equal(result.status, status)
    } finally {
      clearTimeout(timer)
      controller.close()
      await answer
      await capture.cancel()
    }
  })
}

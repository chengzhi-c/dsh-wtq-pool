const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire, registerHooks } = require('node:module')
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

const encoder = new TextEncoder()

/**
 * Upstream frames with no client-visible output still keep the client's
 * connection alive.
 *
 * Trae's queue and progress events and Qoder's acknowledgements were decoded
 * and dropped. The upstream stayed busy and the watchdog kept the request
 * open, but the downstream socket received no bytes at all until the first
 * token, so a client with an idle read timeout gave up on a healthy turn.
 */
test('queue and progress frames keep the downstream stream alive', async () => {
  const { bridgeTraeStream } = require('../src/trae-shim.ts')
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')
  const cases = [
    ['trae', bridgeTraeStream,
      'event: request_wait_in_queue\ndata: {"position":2}\n\n'
      + 'event: progress_notice\ndata: {"state":"working"}\n\n'
      + 'event: output\ndata: {"response":"ok","finish_reason":"stop"}\n\n'],
    ['qoder', bridgeQoderStream,
      'data: {"foo":"bar"}\n\n'
      + 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'],
  ]
  for (const [name, bridge, wire] of cases) {
    const body = await new Response(bridge(new Response(wire).body, 'fixture-model')).text()
    assert.ok(body.includes(': keepalive'), `${name}: a silent wait must carry a keepalive comment`)
    assert.ok(body.includes('"content":"ok"'), `${name}: the real output still reaches the client`)
  }
})

/**
 * The in-band error frame never carries a credential.
 *
 * A stream that has already sent its 200 cannot change the status, so a failure
 * after the first output is reported as an error frame inside the stream. That
 * frame is the one path a stream error's text takes to the client without
 * passing through `writeOpenAIError`, and an upstream that quotes the request it
 * was sent puts a live token in the text. A caller reading a failed stream is
 * exactly the reader who pastes it into a bug report.
 */
test('an in-band stream error never carries a credential', async () => {
  const { bridgeTraeStream } = require('../src/trae-shim.ts')
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')
  const secret = 'abcDEF123+/=ghiJKL456.mnoPQR789'

  for (const [name, bridge, opening] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'],
  ]) {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(opening))
        // Raised after the first output, so the bridge is past the point where
        // a status could still carry the failure.
        controller.error(new Error(`upstream said: X-Ide-Token ${secret}`))
      },
    })
    const failures = []
    const body = await new Response(
      bridge(source, 'fixture-model', { onFailure: (error) => failures.push(error) }),
    ).text()

    assert.equal(body.includes(secret), false, `${name}: a credential leaked into the in-band error frame`)
    // A missing terminator left the caller with a stream only a timeout could
    // end, which is the whole shape of the bug.
    assert.match(body, /"error":\{"message":/, `${name}: the failure must be reported in-band`)
    assert.match(body, /"finish_reason"/, `${name}: a finish chunk is required`)
    assert.ok(body.includes('data: [DONE]'), `${name}: the terminator is required`)
    assert.equal(failures.length, 1, `${name}: the real failure must reach the caller`)
  }
})

/**
 * A bridge that stops early releases the upstream it was reading.
 *
 * A caller that hangs up, and a decoder that gives up on an unterminated line,
 * both leave the bridge with a reader nobody will drain. Holding it keeps the
 * upstream socket open until its own idle timeout - once per turn, on a pool
 * whose whole purpose is the number of concurrent turns.
 */
test('a bridge that stops early releases its upstream reader', async () => {
  const { bridgeTraeStream } = require('../src/trae-shim.ts')
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')

  for (const [name, bridge, opening] of [
    ['trae', bridgeTraeStream, 'event: output\ndata: {"response":"hello"}\n\n'],
    ['qoder', bridgeQoderStream, 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n'],
  ]) {
    for (const stop of ['hangup', 'oversized line']) {
      let released = false
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(opening))
          if (stop === 'oversized line') {
            // One line with no newline in it: the decoder's own guard throws,
            // which is a bridge failure rather than an upstream one.
            controller.enqueue(encoder.encode('data: ' + 'x'.repeat(65 * 1024 * 1024)))
          }
        },
        pull() { return new Promise(() => {}) },
        cancel() { released = true },
      })
      const reader = bridge(source, 'fixture-model', {}).getReader()
      await reader.read()
      if (stop === 'hangup') await reader.cancel()
      else {
        // Drain until the decoder gives up, so its cleanup path is the one
        // under test rather than the caller's.
        for (let i = 0; i < 8; i++) {
          const next = await reader.read().catch(() => ({ done: true }))
          if (next.done) break
        }
      }
      assert.equal(released, true, `${name}/${stop}: the upstream reader must be released`)
    }
  }
})

/**
 * A peek that fails releases the upstream reader.
 *
 * `openTraeResponse`/`openQoderResponse` read ahead to learn whether the
 * upstream will fail before it starts producing. When that read itself throws -
 * a reset mid-peek, or the decoder's own over-long-line guard - a reader left
 * holding the connection kept the upstream socket open after the caller had
 * already been answered, once per turn, for a pool whose whole purpose is the
 * number of concurrent turns.
 */
test('a peek that fails releases the upstream reader', async () => {
  const { openTraeResponse } = require('../src/trae-shim.ts')
  const { openQoderResponse } = require('../src/qoder-shim.ts')

  for (const [name, open] of [['trae', openTraeResponse], ['qoder', openQoderResponse]]) {
    // A line with no newline in it makes the decoder throw on its own guard.
    // That is the way a peek fails while the stream is still live, and so the
    // one where releasing the reader is the plugin's responsibility: a stream
    // the upstream already errored is destroyed, and cancelling it reaches
    // nothing.
    let closed = false
    const endless = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode('data: ' + 'x'.repeat(65 * 1024 * 1024))) },
      pull() { return new Promise(() => {}) },
      cancel() { closed = true },
    })
    await assert.rejects(
      () => open(new Response(endless, { status: 200 }), 'fixture-model'),
      /without a newline/,
      `${name}: an unterminated line must stop the peek`,
    )
    assert.equal(closed, true, `${name}: a peek the decoder gave up on must release the reader`)
  }
})

/**
 * A non-2xx answer whose body is cut off still carries its real status.
 *
 * Both vendors answer a refusal with a body the connection then drops before
 * finishing. Reading that body to find out what went wrong rejects, and a
 * handler that let the rejection decide the status reported a transport failure
 * instead of the rate limit the upstream had actually named - so a throttled
 * account was never rotated off, and every later turn met the same wall.
 */
test('a truncated refusal body keeps the status the upstream chose', async () => {
  const { openTraeResponse } = require('../src/trae-shim.ts')
  const { openQoderResponse } = require('../src/qoder-shim.ts')

  for (const [name, open, message] of [
    ['trae', openTraeResponse, 'Trae SOLO returned HTTP 429'],
    ['qoder', openQoderResponse, 'Qoder returned HTTP 429'],
  ]) {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":{"message":"rate limited"'))
        controller.error(new Error('socket reset'))
      },
    })
    const relayed = await open(new Response(source, { status: 429 }), 'fixture-model')
    assert.equal(relayed.status, 429, `${name}: the upstream status must survive a truncated body`)
    const body = await relayed.json()
    assert.ok(body.error.message.includes(message), `${name}: the status text must survive too`)
  }
})

/**
 * A login-expired frame buried under a details object still reads as one.
 *
 * Qoder nests the real message below `details`/`error`. Unwrapping walked into
 * that object and replaced the message with a dump of it, so a frame saying
 * `Login expired` described itself as `{"reqId":1}`, the sign-in-expired branch
 * stopped matching, and the turn answered 502 instead of 401 - the client was
 * never told to re-authenticate, and the user re-ran the same request against
 * the same dead sign-in.
 */
test('a Qoder failure nested under details keeps the message a user can act on', () => {
  const { unwrapFailure } = require('../src/qoder-sse.ts')
  const nested = unwrapFailure({ errorCode: '10605', message: 'Login expired', details: { reqId: 1 } })
  assert.equal(nested.code, '10605')
  assert.equal(nested.detail, 'Login expired')
  // With no message anywhere on the way down, the object is still a better
  // description than an empty string.
  assert.equal(unwrapFailure({ code: '1', details: { reqId: 7 } }).detail, '{"reqId":7}')
})

/**
 * A daily-limit frame's retry hint is read from wherever the frame carries it.
 *
 * The quota branch reads the hint, and a frame that reports the wait only
 * inside its message - how Qoder writes a daily-limit refusal - came back with
 * none, so the pool retried at once and collected the same refusal from every
 * account in turn.
 */
test('a Qoder retry hint is read from wherever the frame carries it', () => {
  const { retryAfterSecondsOf } = require('../src/qoder-sse.ts')
  assert.equal(retryAfterSecondsOf({ retryAfterSeconds: 120 }), 120)
  assert.equal(retryAfterSecondsOf({ message: JSON.stringify({ retryAfterSeconds: 45 }) }), 45)
  // A carried zero is the decoder's "no hint" placeholder, not a zero-second
  // wait, so the nested answer must still be consulted.
  assert.equal(retryAfterSecondsOf({
    retryAfterSeconds: 0, message: JSON.stringify({ retryAfterSeconds: 45 }),
  }), 45)
  assert.equal(retryAfterSecondsOf({ message: 'no hint here' }), 0)
})
/**
 * A vendor that finishes the text and keeps the socket open still ends the turn.
 *
 * Qoder sends its finish chunk and then nothing: no `[DONE]`, no close. The
 * relay used to wait for the upstream read to end, which the vendor never does,
 * so the client held a reply that was complete but was never marked finished.
 * The bridge must close itself inside the tail grace.
 */
test('the qoder relay ends a turn whose upstream never closes', async () => {
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()
  let upstreamCancelled = false
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      ))
      // Intentionally never closed: this is the vendor's behaviour.
    },
    cancel() { upstreamCancelled = true },
  })
  const started = Date.now()
  const body = await new Response(bridgeQoderStream(source, 'fixture-model')).text()
  const elapsed = Date.now() - started
  assert.match(body, /"finish_reason":"stop"/)
  assert.match(body, /data: \[DONE\]/)
  assert.ok(elapsed < 5000, `the turn must close on its own, took ${elapsed}ms`)
  assert.ok(upstreamCancelled, 'the upstream socket must be released')
})
/**
 * A turn cut off by the output budget is still reported as truncated.
 *
 * Both bridges answered `tool_calls` whenever the turn had emitted one, so an
 * upstream `length` disappeared: the client read a truncated reply as a finished
 * one and acted on tool arguments that were themselves cut off. Only the verdict
 * that carries nothing of its own may be replaced.
 */
test('a truncated tool-call turn keeps the upstream finish_reason', async () => {
  const { bridgeQoderStream } = require('../src/qoder-shim.ts')
  const { bridgeTraeStream } = require('../src/trae-shim.ts')
  const encoder = new TextEncoder()
  const toolCall = { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }

  const qoderBody = await new Response(bridgeQoderStream(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
      ))
      controller.close()
    },
  }), 'fixture-model')).text()
  assert.match(qoderBody, /"finish_reason":"length"/, 'qoder must not turn a truncated turn into a tool-call turn')
  assert.match(qoderBody, /"tool_calls"/, 'the tool call itself still reaches the client')

  const traeBody = await new Response(bridgeTraeStream(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ response: '', tool_calls: [toolCall], finish_reason: 'length' })}\n\n`,
      ))
      controller.close()
    },
  }), 'fixture-model')).text()
  assert.match(traeBody, /"finish_reason":"length"/, 'trae must not turn a truncated turn into a tool-call turn')
})
/**
 * The rule itself: only `stop` and silence lose to the tool-call verdict.
 */
test('only a stop verdict is replaced by tool_calls', () => {
  const { openAIFinishReason } = require('../src/loopback.ts')
  assert.equal(openAIFinishReason('stop', true), 'tool_calls')
  assert.equal(openAIFinishReason(undefined, true), 'tool_calls')
  assert.equal(openAIFinishReason('', true), 'tool_calls')
  assert.equal(openAIFinishReason('length', true), 'length')
  assert.equal(openAIFinishReason('content_filter', true), 'content_filter')
  assert.equal(openAIFinishReason('stop', false), 'stop')
  assert.equal(openAIFinishReason(undefined, false), 'stop')
})

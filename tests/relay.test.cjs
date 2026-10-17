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
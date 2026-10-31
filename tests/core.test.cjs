/**
 * The shared core's own behaviour, pinned case by case.
 *
 * Each case names the observable it pins, and each is built so it fails if the
 * fix is reverted. Every auth directory is a scratch one and every upstream is
 * a stub, so nothing here reaches the network or a real install.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

// The core imports its siblings without an extension, so the loader needs the
// same `.ts` resolution the DSH entry builds against.
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

const scratch = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-hardening-${label}-`))
const encoder = new TextEncoder()
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** One readable WorkBuddy sign-in file, the shape the desktop app writes. */
function writeSignIn(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: 'original-token', refreshToken: '', expiresAt: Date.now() + 3600000 },
    account: { uin: 'u-1', nickname: 'Fixture' },
  }))
  return dir
}

/** One readable sign-in file with a chosen identity, so a test can swap accounts. */
function writeAccountSignIn(dir, uin, nickname) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
    auth: { accessToken: `token-${uin}`, refreshToken: `refresh-${uin}`, expiresAt: Date.now() + 3600000, lastRefreshTime: Date.now() },
    account: { uin, nickname },
  }))
}

/**
 * Switching accounts in the global client must not lose the previous one.
 *
 * The global client writes one live file and no timestamped snapshot, so the
 * second sign-in overwrites the first and the pool used to see a single
 * account however many had signed in. The archive keeps the overwritten
 * credential, and the account keeps serving: an account switch replaces the
 * file, it does not revoke the token already issued from it.
 */
test('an account overwritten by the next global sign-in is kept and keeps serving', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const root = scratch('global-switch')
  const authDir = path.join(root, 'auth')
  const dataPath = path.join(root, 'data')

  writeAccountSignIn(authDir, 'uin-first', 'First')
  const pool = new WorkBuddyAccountPool({ authDirs: [authDir], dataPath: () => dataPath })
  assert.equal((await pool.scan()).length, 1, 'the first sign-in is discovered')

  // The app signs in elsewhere: same live file, new identity.
  writeAccountSignIn(authDir, 'uin-second', 'Second')
  const accounts = await pool.scan()
  assert.equal(accounts.length, 2, 'the overwritten account is still listed')
  const first = accounts.find(account => account.credential.uin === 'uin-first')
  const second = accounts.find(account => account.credential.uin === 'uin-second')
  // The international client keeps one live file and no snapshots, so nothing on
  // disk holds this account any more: only the archive does. That is what the flag
  // reports now.
  assert.equal(first?.archived, true, 'the overwritten account lives in the archive alone')
  assert.equal(second?.archived, undefined, 'the live account is not archived')
  assert.deepEqual(
    pool.available(Date.now()).map(account => account.credential.uin).sort(),
    ['uin-first', 'uin-second'],
    'the archived account is still handed out: its token has not expired',
  )

  // Signing the first account back in makes it live again.
  writeAccountSignIn(authDir, 'uin-first', 'First')
  const restored = await pool.scan()
  assert.equal(
    restored.find(account => account.credential.uin === 'uin-first')?.archived,
    undefined,
    'a re-signed account leaves the archive',
  )
})

/**
 * The archive writer reads the whole file, merges, and writes it back.
 * A damaged document used to read as empty, so the next scan saved only the
 * live sign-in and dropped every overwritten account the file still held.
 */
test('a damaged credential archive is left untouched', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const root = scratch('damaged-archive')
  const authDir = path.join(root, 'auth')
  const dataPath = path.join(root, 'data')
  writeAccountSignIn(authDir, 'uin-live', 'Live')
  const pool = new WorkBuddyAccountPool({ authDirs: [authDir], dataPath: () => dataPath })
  await pool.scan()
  const archive = path.join(dataPath, 'credentials-archive.json')
  const damaged = '{"version":1,"entries":['
  fs.writeFileSync(archive, damaged)
  writeAccountSignIn(authDir, 'uin-next', 'Next')
  await pool.scan()
  assert.equal(fs.readFileSync(archive, 'utf8'), damaged, 'a parse failure must not be rewritten as a smaller archive')
})

/**
 * The archive is worth exactly as long as the token it holds.
 *
 * An archived credential that has expired must stop being served, and one
 * whose only renewal path is gone with it must not be served either: both would
 * spend a request on a guaranteed 401. Keeping it listed would be reporting an
 * account the user cannot use.
 */
test('an archived account stops serving once its token expires', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const root = scratch('global-switch-expiry')
  const authDir = path.join(root, 'auth')
  const dataPath = path.join(root, 'data')

  fs.mkdirSync(authDir, { recursive: true })
  fs.writeFileSync(path.join(authDir, 'workbuddy-desktop-ai.info'), JSON.stringify({
    auth: { accessToken: 'token-first', refreshToken: '', expiresAt: Date.now() + 60000 },
    account: { uin: 'uin-first', nickname: 'First' },
  }))
  const pool = new WorkBuddyAccountPool({ authDirs: [authDir], dataPath: () => dataPath })
  await pool.scan()

  // The switch, then enough time for the archived token to lapse.
  writeAccountSignIn(authDir, 'uin-second', 'Second')
  await pool.scan()
  const later = Date.now() + 2 * 60000
  assert.deepEqual(
    pool.available(later).map(account => account.credential.uin),
    ['uin-second'],
    'an archived account with an expired token is not handed out',
  )
})

/**
 * A scan in flight when the auth directory is repointed must not put the old
 * directory's accounts back.
 *
 * `applyConfig` empties the pool the moment `authFile` moves, and the caller
 * then scans to refill it. A walk that started before the move used to end by
 * assigning the roster it had read from the previous directory, so the pool
 * kept serving sign-ins the user had pointed the plugin away from.
 */
test('a repointed auth directory is not repopulated by the scan already running', async () => {
  const { WorkBuddyAccountPool } = require('../src/accounts.ts')
  const oldDir = writeSignIn(path.join(scratch('repoint'), 'old'))
  const newDir = path.join(scratch('repoint'), 'new')
  fs.mkdirSync(newDir, { recursive: true })

  const pool = new WorkBuddyAccountPool({ authDirs: [oldDir] })
  const inFlight = pool.scan()
  // The walk is suspended on its first directory read here.
  assert.equal(pool.applyConfig({ authDirs: [newDir] }), true, 'a repoint empties the pool')
  await inFlight
  assert.equal(pool.list().length, 0, 'the superseded walk must not refill the pool from the old directory')

  // The caller's follow-up scan reads the new directory and stays empty.
  await pool.scan()
  assert.equal(pool.list().length, 0, 'the new directory has no sign-in')
})

/**
 * A caller hang-up must tear the upstream body down.
 *
 * The header deadline detaches its own listener once the headers land, so a
 * client that stops waiting would otherwise leave the upstream generation
 * running to completion and spend the account's credits on output nobody reads.
 */
test('a caller hang-up cancels the upstream body', async () => {
  const { withIdleWatchdog } = require('../src/upstream.ts')
  const controller = new AbortController()
  let cancelled = false
  const source = new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('first')) },
    cancel() { cancelled = true },
  })
  const watched = withIdleWatchdog(source, 60_000, controller.signal)
  const reader = watched.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
  controller.abort()
  await tick()
  assert.equal(cancelled, true, 'the upstream read must be cancelled, not left running')
  await assert.rejects(() => reader.read(), 'the relayed stream must fail rather than hang')
})

/**
 * An error body abandoned at the size limit must be cancelled.
 *
 * Only the timeout path used to cancel, so an oversized error page left the
 * upstream response unconsumed and its socket held until undici or the peer
 * gave up.
 */
test('an error body past the size limit is cancelled', async () => {
  const { readErrorBody } = require('../src/upstream.ts')
  let cancelled = false
  const body = new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('x'.repeat(64))) },
    cancel() { cancelled = true },
  })
  const text = await readErrorBody(new Response(body, { status: 429 }), 10)
  assert.equal(text.length, 10, 'the bound is still exact')
  await tick()
  assert.equal(cancelled, true, 'the oversized error body must be released')
})

/**
 * A nested acknowledgement must not blank the envelope's own business code.
 *
 * `{"code":10605,"details":{"code":0}}` is one refusal: the inner `0` is the
 * upstream acknowledging the container, not a new code. Taking it lost the
 * outer 10605, and the unnamed refusal was answered 502 instead of rotating or
 * cooling on the code's own meaning. A code inside a message string is still
 * the refusal the envelope wrapped, so that descent keeps working.
 */
test('a container acknowledgement does not blank an envelope business code', () => {
  const { unwrapFailure } = require('../src/qoder-sse.ts')
  assert.equal(unwrapFailure({ code: 10605, details: { code: 0, reqId: 1 } }).code, '10605',
    'the outer business code survives the nested acknowledgement')
  assert.equal(unwrapFailure({ code: 0, details: { code: 10605 } }).code, '10605',
    'a refusal carried in a container is still read when the envelope only acknowledges')
  assert.equal(unwrapFailure({ code: 0, message: '{"code":10605}' }).code, '10605',
    'a code inside a message string is still read')
})

test('a nested message does not overwrite the envelope\'s actionable sentence', () => {
  const { unwrapFailure } = require('../src/qoder-sse.ts')
  const failure = unwrapFailure({
    code: 105,
    message: 'Login expired',
    details: { message: 'request rejected', reqId: 7 },
  })
  assert.equal(failure.detail, 'Login expired',
    'the sentence the user can act on has to survive the walk into details')
  assert.equal(unwrapFailure({ message: '{"code":10605,"message":"queue full"}' }).detail,
    'queue full', 'a message that is only a JSON wrapper is still replaced by the inner sentence')
})

/**
 * A caller hang-up must release an error body too.
 *
 * The headers deadline detaches its own listener once the headers land, so a
 * cancelled turn used to wait out the whole error-body deadline with the
 * upstream socket still open.
 */
test('a caller hang-up releases an error body', async () => {
  const { readErrorBody } = require('../src/upstream.ts')
  const controller = new AbortController()
  let cancelled = false
  const body = new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode('partial')) },
    cancel() { cancelled = true },
  })
  const reading = readErrorBody(new Response(body, { status: 429 }), 300, controller.signal)
  await tick()
  controller.abort()
  const outcome = await Promise.race([
    reading.then((text) => ({ text })),
    // Wide enough to survive a loaded machine, far below the ten-second
    // deadline the read used to wait out.
    new Promise((resolve) => { setTimeout(() => resolve({ timeout: true }), 2000) }),
  ])
  assert.equal(outcome.timeout, undefined, 'a hang-up must end the read, not wait out the error-body deadline')
  assert.equal(outcome.text, 'partial', 'whatever arrived is still reported')
  await tick()
  assert.equal(cancelled, true, 'the upstream body must be released on a hang-up')
})

/**
 * A slow consumer must not be fed the whole turn.
 *
 * Both vendor bridges ran their read loop inside `start`, which drained the
 * upstream response into the stream's own queue whatever the consumer was
 * doing: a client that paused mid-turn buffered the rest of the reply in the
 * gateway's memory. The read is driven by `pull` now, so the upstream is read
 * only as fast as the client takes it.
 */
for (const source of ['qoder', 'trae']) {
  test(`a paused consumer does not make the ${source} bridge drain the turn`, async () => {
    const { bridgeQoderStream } = require('../src/qoder-shim.ts')
    const { bridgeTraeStream } = require('../src/trae-shim.ts')
    const wire = source === 'qoder'
      ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
      : 'event: output\ndata: {"response":"hello"}\n\n'
    const total = 200
    let produced = 0
    const upstream = new ReadableStream({
      pull(controller) {
        produced += 1
        controller.enqueue(encoder.encode(wire))
        if (produced === total) controller.close()
      },
    })
    const relay = source === 'qoder' ? bridgeQoderStream(upstream, 'model') : bridgeTraeStream(upstream, 'model')
    // Nobody reads the relay yet: it may fill its own queue, but the upstream
    // must not be read to the end on the client's behalf.
    await tick()
    await tick()
    assert.ok(produced <= 2, `the bridge read ${produced} of ${total} chunks with no consumer`)
    const body = await new Response(relay).text()
    assert.equal(produced, total, 'the whole turn is still delivered once the client reads')
    assert.match(body, /\[DONE\]/, 'the turn still ends the way a client can finish on')
  })
}

/**
 * A Qoder turn whose upstream leaves the socket open must still end.
 *
 * Qoder finishes a turn by leaving the connection open: the finish chunk and the
 * usage frame arrive and then nothing, with no `[DONE]` and no close. A relay
 * that waited for the upstream to end left the client on a turn that was already
 * over - measured against the live gateway at seven minutes with no terminal
 * frame. The finish chunk now ends the turn the way Trae's finish frame already
 * did, with a short window for the trailing usage frame.
 */
test('a Qoder turn ends for the client when the upstream holds the socket open', async () => {
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  const { openQoderResponse } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()
  const relay = async (frames) => {
    const upstream = new ReadableStream({
      start(controller) { for (const frame of frames) controller.enqueue(encoder.encode(frame)) },
    })
    const client = new QoderUpstreamClient({
      region: 'cn',
      credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
      fetchImpl: async () => new Response(upstream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const result = await client.chatStream('{"model":"qfmodel","messages":[{"role":"user","content":"hi"}]}', 'qfmodel')
    assert.equal(result.ok, true, 'the fixture turn must be accepted')
    return openQoderResponse(result.response, 'qfmodel')
  }
  const read = async (frames) => {
    const answer = await relay(frames)
    return Promise.race([
      answer.text().then((text) => ({ text })),
      new Promise((resolve) => { setTimeout(() => resolve({ timeout: true }), 5000) }),
    ])
  }

  const complete = await read([
    'data: {"choices":[{"delta":{"role":"assistant","content":"PONG"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"-WTQ-PI"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":42}}\n\n',
  ])
  assert.equal(complete.timeout, undefined, 'the client must not be left waiting on an open upstream')
  assert.match(complete.text, /PONG/, 'the answer reaches the client')
  assert.match(complete.text, /WTQ-PI/, 'the whole answer reaches the client')
  assert.match(complete.text, /"total_tokens":42/, 'the trailing usage frame is relayed, not dropped')
  assert.match(complete.text, /"finish_reason":"stop"/, 'the turn reports its finish reason')
  assert.match(complete.text, /data: \[DONE\]/, 'the turn ends the way a client can finish on')
  assert.doesNotMatch(complete.text, /upstream_error/, 'a completed turn is not reported as a failure')

  // The same turn without a usage frame: the grace window ends it, still cleanly.
  const withoutUsage = await read([
    'data: {"choices":[{"delta":{"role":"assistant","content":"PONG"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"-WTQ-PI"},"finish_reason":"stop"}]}\n\n',
  ])
  assert.equal(withoutUsage.timeout, undefined, 'a turn with nothing trailing still ends')
  assert.match(withoutUsage.text, /data: \[DONE\]/, 'and still ends with the terminal marker')
  assert.doesNotMatch(withoutUsage.text, /upstream_error/, 'and is not reported as a failure either')
})

test('a role-only Qoder frame does not commit a refusal that follows it', async () => {
  // The peek used to treat any non-empty `choices` as output. Qoder sends the
  // role delta first, so a refusal in the very next frame was relayed as a 200
  // stream and the next account was never tried.
  const { openQoderResponse } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"code":110,"message":"daily quota spent","retryAfterSeconds":3600}\n\n'))
      controller.close()
    },
  })
  const answer = await openQoderResponse(new Response(upstream, { status: 200 }), 'qfmodel')
  assert.equal(answer.status, 429, 'the refusal must surface as a real status so failover can run')
  assert.equal(answer.headers.get('retry-after'), '3600', 'and it must keep the upstream wait')
})

test('a role frame does not hide the stream while the first token is slow', async () => {
  // Waiting for output fixed the role-then-refusal case but hid the 200 for the
  // whole thinking phase. A short grace covers a refusal that follows at once;
  // after that the turn commits and a late token still arrives in order.
  const { openQoderResponse } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()
  let control
  const upstream = new ReadableStream({
    start(controller) {
      control = controller
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
    },
  })
  const first = await Promise.race([
    openQoderResponse(new Response(upstream, { status: 200 }), 'qfmodel').then((answer) => ({ answer })),
    new Promise((resolve) => { setTimeout(() => resolve({ timeout: true }), 2500) }),
  ])
  assert.notEqual(first.timeout, true, 'the role frame must not hold the headers for the thinking phase')
  control.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"late token"}}]}\n\ndata: [DONE]\n\n'))
  control.close()
  const text = await first.answer.text()
  assert.equal((text.match(/late token/g) ?? []).length, 1,
    'the token that followed the grace reaches the client once, in order')
})

test('a nested queue wait survives the outer display sentence', () => {
  const { unwrapFailure, retryAfterSecondsOf, decodeQoderFrame } = require('../src/qoder-sse.ts')
  const frame = {
    code: 10605,
    message: 'queue full',
    details: { message: '{"retryAfterSeconds":60,"queueType":"chat"}' },
  }
  const failure = unwrapFailure(frame)
  assert.equal(failure.detail, 'queue full', 'the card keeps the sentence the vendor put on the envelope')
  assert.match(failure.signals, /retryAfterSeconds/, 'the nested descriptor is still available to the classifier')
  assert.equal(retryAfterSecondsOf(frame), 60, 'and its wait is read through the nesting')
  assert.equal(decodeQoderFrame(JSON.stringify(frame)).retryAfterSeconds, 60,
    'the decoder carries the same wait to the gateway')
})

test('a generic outer sentence does not hide a nested sign-in refusal from the classifier', () => {
  const { unwrapFailure } = require('../src/qoder-sse.ts')
  const { classifyQoderFailure } = require('../src/qoder-shim.ts')
  const failure = unwrapFailure({ message: 'Request failed', details: { message: 'Login expired' } })
  const classified = classifyQoderFailure({
    code: failure.code,
    message: failure.detail,
    signals: failure.signals,
  })
  assert.equal(classified.status, 401, 'the nested sentence still says the sign-in is gone')
  assert.equal(classified.kind, 'authentication')
})

test('a finished Qoder turn does not wait for the socket to close', async () => {
  const { openQoderResponse } = require('../src/qoder-shim.ts')
  const encoder = new TextEncoder()
  let cancelled = false
  const upstream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
      controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"total_tokens":7}}\n\n'))
    },
    cancel() { cancelled = true },
  })
  const answer = await Promise.race([
    openQoderResponse(new Response(upstream, { status: 200 }), 'qfmodel'),
    new Promise((resolve) => { setTimeout(() => resolve({ timeout: true }), 1000) }),
  ])
  assert.notEqual(answer.timeout, true, 'a finish frame ends the peek even when the upstream holds the socket')
  assert.equal(answer.status, 200)
  await answer.body.cancel().catch(() => {})
  assert.equal(cancelled, true, 'the upstream stream is released with the relay')
})

/**
 * A Qoder check-in answers with a JSON document, and the whole of it decides
 * whether the claim reads as granted or failed.
 *
 * The success body must not go through the bounded error-body helper, which
 * stops at 300 bytes: a real claim answer is longer than that, so it would
 * arrive truncated, fail to parse, and read as failed while the upstream had
 * already granted the reward - its own `grantId` is in that body.
 */
test('a Qoder claim answer longer than the error-body cap is read whole', async () => {
  const { QoderUpstreamClient } = require('../src/qoder-client.ts')
  const client = (fetchImpl) => new QoderUpstreamClient({
    region: 'cn',
    credential: async () => ({ userID: 'fixture', token: 'fixture-token' }),
    fetchImpl,
  })
  const answer = { grantId: 'grant-1', campaignId: 'daily', reward: { amount: 100, unit: 'credit' }, note: 'x'.repeat(400) }
  const granted = await client(async () => new Response(JSON.stringify(answer), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })).claimCampaign('daily')
  assert.equal(granted.grantId, 'grant-1', 'the answer is not truncated at the error-body cap')
  assert.equal(granted.reward.amount, 100, 'and the granted amount is readable from it')

  await assert.rejects(
    () => client(async () => new Response('not json at all', { status: 200 })).claimCampaign('daily'),
    /not valid JSON/,
    'a success body that is not JSON still says so',
  )
  await assert.rejects(
    () => client(async () => new Response('upstream is down', { status: 503 })).claimCampaign('daily'),
    /HTTP 503/,
    'a failed claim still reports the upstream status',
  )
})

/**
 * The roster's provenance decides what may be said about a saved selection:
 * only a roster the vendor answered with can retire a model id.
 *
 * The static fallback is this plugin's own guess. Judging against it reported
 * every model the vendor had added since the fallback was written as retired,
 * so the panel replaced the user's choice with the fallback's list and said so
 * on every start.
 */
test('the catalog knows whether its roster came from the upstream', () => {
  const { WorkBuddyCatalog } = require('../src/catalog.ts')
  const catalog = new WorkBuddyCatalog()
  assert.equal(catalog.hasLiveRoster(), false, 'the static fallback is not a live roster')
  catalog.update([{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, maxOutputTokens: 128000, supportsImages: true }])
  assert.equal(catalog.hasLiveRoster(), true, 'a roster the upstream answered with is live')
  const empty = new WorkBuddyCatalog()
  empty.update([])
  assert.equal(empty.hasLiveRoster(), false, 'an empty read is not a roster')
})

/**
 * A Trae check-in answer that omits `enable` still means check-in is on.
 *
 * The upstream sends the flag when it is off for an account, so reading it with
 * a strict `=== true` helper turned every ordinary account into "this account
 * has no check-in": the batch skipped it without ever asking, the panel hid the
 * button and said the account had no campaign, and nothing reported a failure.
 */
test('a Trae check-in answer with no `enable` field is read as enabled', async () => {
  const { TraeSoloUpstreamClient } = require('../src/trae-upstream.ts')
  const client = (payload) => new TraeSoloUpstreamClient({
    credential: async () => ({ region: 'cn', accessToken: 'fixture-token', refreshToken: 'fixture-refresh' }),
    identity: async () => ({ deviceId: 'fixture-device' }),
    fetchImpl: async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const on = await client({ code: 0, credits: 300 }).fetchCheckinStatus()
  assert.equal(on.enable, true, 'an answer with no `enable` means check-in is on')
  assert.equal(on.credits, 300, 'and the rest of the answer is read as before')
  const off = await client({ code: 0, enable: false }).fetchCheckinStatus()
  assert.equal(off.enable, false, 'an explicit `false` is still off')
  const numeric = await client({ code: 0, enable: 1 }).fetchCheckinStatus()
  assert.equal(numeric.enable, true, 'a numeric flag is read the same way')
})

/**
 * A granted Qoder claim is reported as granted even when it names no status.
 *
 * The receipt is the proof: a payout answers with a `grantId` and the amount it
 * paid. Reading only a status whitelist reported a claim the upstream had
 * granted as "skipped", and a 200 carrying a business error was reported the
 * same way - the user was told there was nothing to collect in both cases.
 */
test('a Qoder claim answer is read from its receipt, and a refusal is one', () => {
  const { qoderNormalizeClaimResult } = require('../src/qoder-client.ts')
  const granted = qoderNormalizeClaimResult({ grantId: 'grant-1', reward: { amount: 100, unit: 'credit' } })
  assert.equal(granted.claimed, true, 'a receipt with a grantId is a payout')
  assert.equal(granted.amount, 100, 'and the paid amount is read from it')
  const replayed = qoderNormalizeClaimResult({ replayed: true, grantId: 'grant-1' })
  assert.equal(replayed.claimed, true, 'a replay is a success too')
  assert.equal(replayed.amount, undefined, 'a replay paid nothing, so it names no amount')
  const refused = qoderNormalizeClaimResult({ code: 4001, msg: 'the round is closed' })
  assert.equal(refused.claimed, false)
  assert.equal(refused.reason, 'the round is closed', 'a business error is a refusal, not "nothing to collect"')
  const plain = qoderNormalizeClaimResult({ code: 0, status: 'CLAIMED', benefit: { amount: 50 } })
  assert.equal(plain.claimed, true, 'the status whitelist still works')
  assert.equal(plain.reason, undefined, 'a granted claim names no refusal')
})

/**
 * A collected round must not hide a later claimable one.
 *
 * The campaign list can carry a promotion beside the daily round. Reading the
 * first open CLAIM_BENEFIT entry regardless of its status picked the collected
 * promotion, so the card said today was done and no claim id was returned: the
 * click had nothing to send while a claimable round was right there.
 */
test('a collected Qoder round does not hide a later claimable one', () => {
  const { qoderClaimableCampaignIdOf, qoderCheckinStateFrom } = require('../src/qoder-client.ts')
  const now = 1_800_000_000_000
  const at = Math.floor(now / 1000)
  const round = (id, claimStatus) => ({
    campaignId: id,
    actionType: 'CLAIM_BENEFIT',
    claimStatus,
    startAt: at - 60,
    endAt: at + 3600,
    benefit: { kind: 'CREDITS', amount: 100, validity: { mode: 'RELATIVE_DAYS', days: 30 } },
  })
  const mixed = { campaigns: [round('collected', 'CLAIMED'), round('today', 'CLAIMABLE')] }
  assert.equal(qoderClaimableCampaignIdOf(mixed, now), 'today',
    'the claim id is the uncollected round, not the first open one')
  const state = qoderCheckinStateFrom(mixed, now)
  assert.equal(state.active, true, 'the card still offers the claim')
  assert.equal(state.todayCheckedIn, false, 'and does not report the day as already collected')

  const collectedOnly = qoderCheckinStateFrom({ campaigns: [round('collected', 'CLAIMED')] }, now)
  assert.equal(collectedOnly.active, true, 'a day with only a collected round keeps its card')
  assert.equal(collectedOnly.todayCheckedIn, true, 'and still reports it as collected')
})

/** A value that names no hour must not normalise to midnight. */
test('an unreadable check-in hour is dropped, not read as 00:00', () => {
  const { normaliseCheckinHours } = require('../src/checkin-time.ts')
  assert.deepEqual(normaliseCheckinHours(['9']), [9], 'a readable hour is kept')
  assert.deepEqual(normaliseCheckinHours(['', null, false, '9']), [9], 'values that name no hour are dropped')
  assert.deepEqual(normaliseCheckinHours(['', null]), [9], 'nothing readable falls back to the default hour')
})

/** A body that is not JSON is relayed, and redacted like a parsed one. */
test('a plain-text upstream body is redacted before it is relayed', () => {
  const { liftUpstreamMessage } = require('../src/loopback.ts')
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl'
  const plain = liftUpstreamMessage('refused: bad token ' + token)
  assert.doesNotMatch(plain, new RegExp(token), 'a body that is not JSON is redacted too')
  const envelope = liftUpstreamMessage(JSON.stringify({ error: 'bad token ' + token }))
  assert.doesNotMatch(envelope, new RegExp(token), 'a parsed envelope is redacted as before')
})
/**
 * A Qoder signature draws its own request id.
 *
 * The id inside the signed payload and the request-id header are independent
 * draws; collapsing them changes the bytes on every request and no other test
 * would see it.
 */
test('a Qoder signature draws its own request id', () => {
  const { buildCosyAuthHeaders } = require('../src/qoder-upstream.ts')
  const credential = { userID: 'user-1', token: 'token-1', name: 'n', email: 'e@example.com', machineID: 'machine-1' }
  const call = () => buildCosyAuthHeaders(Buffer.from('{}'), 'https://gateway.qoder.com.cn/v1/chat', credential)
  const headers = call()
  const payload = JSON.parse(Buffer.from(headers.Authorization.split('.')[1], 'base64').toString('utf8'))
  assert.match(headers['X-Request-Id'], /^[0-9a-f-]{36}$/u, 'the header carries a uuid')
  assert.notEqual(headers['X-Request-Id'], payload.requestId, 'the header and the signed payload do not share one id')
  assert.notEqual(call()['X-Request-Id'], headers['X-Request-Id'], 'and each request draws a new one')
})

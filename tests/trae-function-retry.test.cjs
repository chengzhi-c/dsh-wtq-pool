/**
 * A model the chosen function no longer knows is tried through its other answers.
 *
 * The directory is read once per `llm_utils_chat` function, and a partial read
 * still carries the answer of a function that just failed - which is what keeps
 * its models callable, but it also means the published choice can be a function
 * the upstream has stopped serving. Trae answers `4001` in its own envelope when
 * that happens, and that verdict is about the function, not about the request, so
 * it is worth one more attempt through a different answer before the turn fails.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')
const fsHook = require('node:fs')

const root = path.resolve(__dirname, '..')
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
}).outputText

registerHooks({
  resolve(specifier, context, next) {
    const own = context.parentURL?.startsWith('file:') && fileURLToPath(context.parentURL).startsWith(path.join(root, 'src') + path.sep)
    return next(own && specifier.startsWith('.') && path.extname(specifier) === '' ? specifier + '.ts' : specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) return {
      format: 'commonjs', shortCircuit: true, source: transpile(fsHook.readFileSync(fileURLToPath(url), 'utf8')),
    }
    return next(url, context)
  },
})

const { createTraeGateway } = require('../src/trae-gateway.ts')

const credential = {
  accessToken: 'fixture-token', userId: 'fixture', host: '', edition: 'cn', source: 'desktop',
  expiresAtMs: Date.now() + 3_600_000,
}

/** One directory row, in the shape the parser reads. */
function row(id, { dev, out = 32000 }) {
  return {
    config_name: id,
    display_config: { display_name: id, multimodal: false },
    context_window_tokens: { dev },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}

/**
 * A gateway whose directory lists one model through two functions, and whose chat
 * path refuses through the one it is told to refuse through.
 */
function harness({ refuse }) {
  const attempts = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('get_detail_param')) {
      const name = JSON.parse(String(init?.body ?? '{}')).function
      if (name === 'solo_work_remote') return new Response(JSON.stringify({ config_info_list: [row('contested', { dev: 128000 })] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (name === 'solo_agent_remote') return new Response(JSON.stringify({ config_info_list: [row('contested', { dev: 256000, out: 16000 })] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ config_info_list: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (target.includes('/model')) return new Response(JSON.stringify({ data: { list: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    const body = JSON.parse(String(init?.body ?? '{}'))
    attempts.push(body.function)
    if (body.function === refuse) {
      return new Response(JSON.stringify({ code: 4001, message: 'config not found' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('event: output\ndata: {"response":"served"}\n\nevent: done\ndata: {}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  const gateway = createTraeGateway({
    port: 0,
    credentials: async () => [credential],
    identity: async () => ({ machineId: 'm', deviceId: 'd', platform: 'win32' }),
    fetchImpl,
    logger: { info() {}, warn() {}, error() {} },
  })
  return { gateway, attempts }
}

async function turn(gateway, model) {
  const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  return { status: answer.status, text: await answer.text() }
}

test('a function that answers 4001 hands the turn to another answer', async () => {
  const { gateway, attempts } = harness({ refuse: 'solo_agent_remote' })
  try {
    await gateway.ready
    // The declared window is the wide one, so the published choice is the function
    // that states it - and that is the one being refused.
    const answer = await turn(gateway, 'contested')
    assert.equal(answer.status, 200, 'the other answer must serve the turn')
    assert.match(answer.text, /served/)
    assert.deepEqual(attempts, ['solo_agent_remote', 'solo_work_remote'],
      'the refused function is followed by the one that can still answer, once each')
  } finally { await gateway.close() }
})

test('a refusal that belongs to the request is not retried elsewhere', async () => {
  const { gateway, attempts } = harness({ refuse: 'no-such-function' })
  try {
    await gateway.ready
    // `max_tokens` is not forwarded, so make the request itself invalid instead:
    // an unlisted model is refused before any function is tried.
    const answer = await turn(gateway, 'not-in-the-directory')
    assert.equal(answer.status, 404)
    assert.deepEqual(attempts, [], 'a model the directory does not list is not sent anywhere')
  } finally { await gateway.close() }
})

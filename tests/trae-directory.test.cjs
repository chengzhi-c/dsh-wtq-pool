/**
 * The Trae directory, driven through the real parser with fixture rows shaped
 * like the live ones. Two facts about it are pinned here because both were
 * published wrong before:
 *
 *   1. one `config_name` is listed by several directory functions that disagree
 *      about its capacity, so the strongest row has to win;
 *   2. the Max tier (`context_window_tokens.max`) is a larger window the same
 *      model accepts, and reading only the default threw it away.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { registerHooks } = require('node:module')
const { fileURLToPath } = require('node:url')
const ts = require('typescript')
const vm = require('node:vm')

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

const { prepareSoloBody, collectTraeSoloModels, traeVariantFor } = require('../src/trae-upstream.ts')

/** A directory row in the shape `get_detail_param` answers with. */
function row(id, { dev, max, out = 32000, name = id } = {}) {
  return {
    config_name: id,
    display_config: { display_name: name, multimodal: false },
    context_window_tokens: { dev, ...max === undefined ? {} : { max } },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}


/** A directory row in the shape `get_detail_param` answers with. */
function row(id, { dev, max, out = 32000, name = id } = {}) {
  return {
    config_name: id,
    display_config: { display_name: name, multimodal: false },
    context_window_tokens: { dev, ...max === undefined ? {} : { max } },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}

/** A directory row in the shape `get_detail_param` answers with. */
function row(id, { dev, max, out = 32000, name = id } = {}) {
  return {
    config_name: id,
    display_config: { display_name: name, multimodal: false },
    context_window_tokens: { dev, ...max === undefined ? {} : { max } },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}

/** A directory row in the shape `get_detail_param` answers with. */
function row(id, { dev, max, out = 32000, name = id } = {}) {
  return {
    config_name: id,
    display_config: { display_name: name, multimodal: false },
    context_window_tokens: { dev, ...max === undefined ? {} : { max } },
    model_detail_list: [{ max_tokens: out, prompt_max_tokens: dev - out }],
  }
}

test('a Max tier above the default window is published beside it', () => {
  const { collectTraeSoloModels } = require('../src/trae-upstream.ts')
  assert.equal(typeof collectTraeSoloModels, 'function',
    'the collector is exported so its merge rule can be driven directly')
  const byId = new Map()
  // solo_work_remote lists the model at its default only.
  collectTraeSoloModels([row('Doubao-Seed-2.1-Pro', { dev: 256000 })], 'solo_work_remote', byId)
  // solo_agent_remote lists the same model with a 1M Max tier.
  collectTraeSoloModels([row('Doubao-Seed-2.1-Pro', { dev: 256000, max: 1000000 })], 'solo_agent_remote', byId)

  const model = byId.get('Doubao-Seed-2.1-Pro')
  assert.equal(model.contextWindow, 256000)
  assert.equal(model.maxContextWindow, 1000000, 'the Max tier survives the merge')
})

test('the strongest row wins regardless of which function answered first', () => {
  const { collectTraeSoloModels } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // The narrow answer arriving first is the regression: "first wins" published
  // chat_v3's 116000 for a model the other groups list at 256000.
  collectTraeSoloModels([row('glm-5.3', { dev: 116000, out: 16000 })], 'chat_v3', byId)
  collectTraeSoloModels([row('glm-5.3', { dev: 200000 })], 'solo_work_remote', byId)
  collectTraeSoloModels([row('glm-5.3', { dev: 200000, max: 1000000 })], 'solo_agent_remote', byId)

  const model = byId.get('glm-5.3')
  assert.equal(model.contextWindow, 200000)
  assert.equal(model.maxContextWindow, 1000000)
})

/**
 * A request at the default window never lands on a Max-only function.
 *
 * The candidate filter used to accept any answer that could *reach* the window,
 * Max tier included, and then pick the largest output budget. One row stating
 * `{dev:128000, max:1000000, out:16000}` beside a row stating
 * `{dev:256000, out:8000}` therefore published 256000 with the Max row's 16000
 * output and its function - so a request at 256000 had to be served by a function
 * whose own tier is 128000, i.e. on Max terms, for a window the user never raised.
 * The published output has to belong to an answer that serves the published
 * window on its own tier.
 */
test('a default-window request is never served by a Max-only row', () => {
  const { collectTraeSoloModels, traeVariantFor } = require('../src/trae-upstream.ts')
  const byId = new Map()
  collectTraeSoloModels([row('MaxOnly', { dev: 128000, max: 1000000, out: 16000 })], 'chat_v3', byId)
  collectTraeSoloModels([row('MaxOnly', { dev: 256000, out: 8000 })], 'solo_coder', byId)
  const model = byId.get('MaxOnly')
  assert.equal(model.contextWindow, 256000, 'the widest default window is what is published')
  assert.equal(model.maxContextWindow, 1000000)
  assert.equal(model.function, 'solo_coder',
    'the answer that serves 256000 on its own tier, not the one that needs Max to reach it')
  assert.equal(model.maxTokens, 8000, "and the published output is that answer's")

  const atDefault = traeVariantFor(model, 256000)
  assert.equal(atDefault.function, 'solo_coder')
  assert.ok(atDefault.contextWindow >= 256000,
    'the row chosen for 256000 can serve 256000 without Max mode')

  // The ceiling still reaches the Max row: a request above every default is a real
  // Max request, and only that row can take it.
  const atCeiling = traeVariantFor(model, 1000000)
  assert.equal(atCeiling.function, 'chat_v3')
})

/**
 * A row that states no window at all is still a candidate.
 *
 * Some directory rows carry only an output budget. Publishing them is fine; what
 * is not fine is treating the missing window as 0 when deciding Max mode - that
 * put the Max flag on every request to such a model.
 */
test('a row with no stated window does not force Max mode', () => {
  const { collectTraeSoloModels, traeVariantFor } = require('../src/trae-upstream.ts')
  const byId = new Map()
  collectTraeSoloModels([{ config_name: 'BudgetOnly', model_detail_list: [{ max_tokens: 16000 }] }], 'chat_v3', byId)
  const model = byId.get('BudgetOnly')
  assert.equal(model.contextWindow, undefined, 'no window is invented for it')
  assert.equal(model.maxTokens, 16000, 'but its output budget is kept')
  const serving = traeVariantFor(model, 128000)
  assert.equal(serving.contextWindow, undefined,
    'and the answer says so, which is what keeps the Max flag off the request')
})

test('a Max tier equal to the default is not published as the tier', () => {
  const { collectTraeSoloModels } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // Measured on most rows: `max` is present and equal to `dev`. It names the same
  // window for the `__max` checkpoint, not a larger tier.
  collectTraeSoloModels([row('glm-5.2', { dev: 200000, max: 200000 })], 'solo_agent_remote', byId)
  const model = byId.get('glm-5.2')
  assert.equal(model.contextWindow, 200000)
  // The tier is the upstream's own ceiling, not the row's repeated figure: the
  // directory states the plan's default (200k) and never the ceiling, which the
  // chat endpoint serves up to 1M.
  assert.equal(model.maxContextWindow, 1000000, 'the published tier is the server ceiling')
  assert.ok(model.maxContextWindow > model.contextWindow)
})

test('a narrow row with a token Max tier does not beat a wider row without one', () => {
  const { collectTraeSoloModels } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // Measured live on Doubao-Seed-2.0-Code: solo_coder states 184000 with a `max`
  // equal to its own default, while solo_work_remote states 232768 and 32768
  // output. Treating that token Max as a tier published 184000 and 16000.
  collectTraeSoloModels([row('Doubao-Seed-2.0-Code', { dev: 232768, out: 32768 })], 'solo_work_remote', byId)
  collectTraeSoloModels([row('Doubao-Seed-2.0-Code', { dev: 184000, max: 184000, out: 16000 })], 'solo_coder', byId)
  const model = byId.get('Doubao-Seed-2.0-Code')
  assert.equal(model.contextWindow, 232768, 'the wider default window wins')
  assert.equal(model.maxTokens, 32768, 'and so does the wider output budget')
  assert.equal(model.function, 'solo_work_remote', 'the request goes through the row that serves it')
})

test('a Max tier keeps its own function and its own output budget', () => {
  const { collectTraeSoloModels, traeVariantFor } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // Measured live on the AI region: solo_work_remote serves 200000 with 32000
  // output, chat_v3 serves 200000 with a 1M Max tier but only 16000 output. One
  // declaration cannot state both, so each window picks the answer that serves it.
  collectTraeSoloModels([row('deepseek-v4.1-flash', { dev: 200000, out: 32000 })], 'solo_work_remote', byId)
  collectTraeSoloModels([row('deepseek-v4.1-flash', { dev: 200000, max: 1000000, out: 16000 })], 'chat_v3', byId)
  const model = byId.get('deepseek-v4.1-flash')
  assert.equal(model.contextWindow, 200000)
  assert.equal(model.maxContextWindow, 1000000)
  assert.equal(model.maxTokens, 32000, 'the default window keeps the wider output budget')

  const atDefault = traeVariantFor(model, 200000)
  assert.equal(atDefault.function, 'solo_work_remote')
  assert.equal(atDefault.maxTokens, 32000)

  const atCeiling = traeVariantFor(model, 1000000)
  assert.equal(atCeiling.function, 'chat_v3', 'only the Max function can serve the Max window')
  assert.equal(atCeiling.maxTokens, 16000, 'and it states its own, smaller budget')
})

test('the Max flag goes on the wire only when it is asked for', () => {
  const plain = JSON.parse(prepareSoloBody(JSON.stringify({ model: 'glm-5.3', messages: [] }), undefined, 'f', undefined, false))
  assert.equal(plain.extra_info, undefined, 'a default-tier request carries no Max flag')
  const max = JSON.parse(prepareSoloBody(JSON.stringify({ model: 'glm-5.3', messages: [] }), undefined, 'f', undefined, true))
  assert.deepEqual(max.extra_info, { v2_max_mode_enabled: true })
  // The rest of the envelope is unchanged by the flag.
  assert.equal(max.config_name, 'glm-5.3')
  assert.equal(max.function, 'f')
})

test('a caller cannot smuggle its own extra_info past the flag', () => {
  const body = JSON.parse(prepareSoloBody(JSON.stringify({
    model: 'glm-5.3',
    messages: [],
    extra_info: { v2_max_mode_enabled: false, something: 'else' },
  }), undefined, 'f', undefined, false))
  // `prepareSoloBody` builds the envelope itself; a client cannot set the flag.
  assert.equal(body.extra_info, undefined)
})

/**
 * The Max flag on the wire follows the window the host holds, not the request.
 *
 * This is the half that had no test at all: `publishedWindowOf` -> `serving` ->
 * `v2_max_mode_enabled`. The gateway is driven through an injected `fetchImpl`,
 * so what is asserted is the JSON the upstream really receives.
 *
 * Max mode is billed on the larger tier's terms, so it must be asked for exactly
 * when the declared window exceeds the tier of the function that serves it - not
 * when the prompt happens to be short, and not when the directory has since
 * narrowed.
 */
test('the Max flag is sent only when the declared window exceeds the serving tier', async () => {
  const { createTraeGateway } = require('../src/trae-gateway.ts')
  const directory = [
    row('cursor-max', { dev: 200000, max: 1000000, out: 16000 }),
    // A row that states only an output budget. The host still declares the
    // conservative 128000 for it, which is a number the directory never stated.
    { config_name: 'budget-only', model_detail_list: [{ max_tokens: 16000 }] },
  ]
  const bodies = []
  const fetchImpl = async (url, init) => {
    if (String(url).includes('get_detail_param')) {
      return new Response(JSON.stringify({ config_info_list: directory }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).includes('/models?functions=')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }
  const credential = { accessToken: 'fixture', userId: 'u', accountName: 'a', host: 'h', edition: 'cn' }
  let declared = 200000
  let budgetOnlyDeclared = 128000
  const gateway = createTraeGateway({
    credentials: async () => [credential],
    identity: async () => ({}),
    fetchImpl,
    port: 0,
    publishedWindowOf: (modelId) => (modelId === 'budget-only' ? budgetOnlyDeclared : declared),
  })
  const ask = async () => {
    const answer = await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'cursor-max', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    })
    await answer.text()
  }
  try {
    await gateway.ready
    // The host holds the model's own default tier: no Max flag, and the turn goes
    // through the function that serves 200000 on its own tier.
    await ask()
    assert.equal(bodies.length, 1, 'one upstream call per turn')
    assert.equal(bodies[0].extra_info, undefined, 'a default-tier turn carries no Max flag')
    assert.equal(bodies[0].config_name, 'cursor-max')

    // The host holds the Max tier - which only happens once it has loaded a
    // declaration stating it. Now the request must ask for Max mode.
    declared = 1000000
    await ask()
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[1].extra_info, { v2_max_mode_enabled: true },
      'a turn above the serving tier asks for the larger one')

    // Back to a window the model serves on its own tier: the flag goes away again.
    declared = 200000
    await ask()
    assert.equal(bodies[2].extra_info, undefined, 'the flag follows the declared window, not history')

    // A row that states no window at all: it has no default tier to exceed, so
    // asking for Max mode on the strength of the host's conservative 128000 would
    // be asking for a tier nobody stated. The flag stays off.
    await fetch(gateway.baseUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'budget-only', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    }).then((answer) => answer.text())
    assert.equal(bodies[3].extra_info, undefined,
      'a row with no stated window is never served on Max terms')
  } finally {
    await gateway.close()
  }
})

/**
 * When no answer can serve the window, the WIDEST answer is chosen, not the
 * narrowest.
 *
 * The fallback pool is only reached for a window above everything the directory
 * now states - the host is still holding a wider one, and a directory function
 * failing is enough to shrink what this process knows. The ordinary ranking
 * prefers the tighter ceiling, which in this pool means handing the request to the
 * smallest function in it, with Max mode on and the request still too big for it.
 */
test('a window nothing reaches falls back to the widest answer, not the tightest', () => {
  const { collectTraeSoloModels, traeVariantFor } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // The measured shape: a narrow function with a big output budget, a wider one
  // with a small budget. Neither reaches 1M.
  collectTraeSoloModels([row('Narrow', { dev: 128000, out: 16000 })], 'chat_v3', byId)
  collectTraeSoloModels([row('Narrow', { dev: 256000, out: 8000 })], 'solo_coder', byId)
  const model = byId.get('Narrow')
  const serving = traeVariantFor(model, 1000000)
  assert.equal(serving.function, 'solo_coder',
    'the widest answer takes the request: it is the closest fit and the only one Max mode can help')
  assert.equal(serving.contextWindow, 256000)

  // The ordinary case is unchanged: at a window an answer serves on its own tier,
  // that answer wins and the larger output budget decides between equals.
  const atDefault = traeVariantFor(model, 200000)
  assert.equal(atDefault.function, 'solo_coder', 'only solo_coder reaches 200000 on its own tier')
  assert.equal(atDefault.maxTokens, 8000)
  const small = traeVariantFor(model, 100000)
  assert.equal(small.function, 'chat_v3', 'at a window both serve, the bigger output budget wins')
  assert.equal(small.maxTokens, 16000)
})

/**
 * The published Max-tier budget is the Max function's own, computed from the
 * variants rather than copied from the default tier.
 *
 * `maxTokensAtCeiling` is what the host is told a model may answer with once its
 * window is raised, and the panel's output ceiling for that window comes from it.
 * Reading the default tier's budget there promised 32k while the only function that
 * serves the raised window grants 16k - the request then fails or stops early.
 * Driven through the real collector, so the variant merge is part of the answer.
 */
/** Lift one entry-point function out of main.js, as the hardening cases do. */
function entryFunctions(names, source) {
  return names.map((name) => {
    const from = source.indexOf(`function ${name}(`)
    if (from < 0) throw new Error(`${name} must exist in the entry`)
    let depth = 0
    let index = source.indexOf('{', from)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
    }
    return source.slice(from, index + 1)
  }).join('\n')
}

test('the Max tier publishes the budget of the function that serves it', () => {
  // B's entry point is the host module, and the function under test lives there.
  const source = fs.readFileSync(path.join(root, 'src', 'host.ts'), 'utf8')
  const constant = (name) => Number(new RegExp(`const ${name} = (0x[0-9a-f]+|\\d+);`).exec(source)[1])
  const byId = new Map()
  collectTraeSoloModels([row('deepseek-v4.1-flash', { dev: 200000, out: 32000 })], 'solo_work_remote', byId)
  collectTraeSoloModels([row('deepseek-v4.1-flash', { dev: 200000, max: 1000000, out: 16000 })], 'chat_v3', byId)
  const model = byId.get('deepseek-v4.1-flash')

  const context = vm.createContext({
    CONSERVATIVE_CONTEXT_WINDOW: constant('CONSERVATIVE_CONTEXT_WINDOW'),
    DEFAULT_MAX_TOKENS: constant('DEFAULT_MAX_TOKENS'),
    positiveInteger: (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback),
    traeVariantFor,
  })
  vm.runInContext(entryFunctions(['traeNativeOf'], source), context)
  context.model = model
  const native = vm.runInContext('traeNativeOf(model)', context)
  assert.equal(native.contextWindow, 200000)
  assert.equal(native.maxTokens, 32000, 'the default tier keeps the wider budget')
  assert.equal(native.maxContextWindow, 1000000)
  assert.equal(native.maxTokensAtCeiling, 16000,
    'and the raised tier states the budget of the function that serves it')
})

/**
 * A Trae row that states only the plan default is published with the measured
 * ceiling beside it, and a request at that ceiling goes out in Max mode.
 *
 * `context_window_tokens.dev` reads 200000 for models that then serve far more.
 * Measured against the live chat endpoint in Max mode, a 1005020-token prompt was
 * answered to `finish_reason: stop` on glm-5.3-flash and on deepseek-v4.1-flash,
 * and a 1350030-token prompt was refused with `4022 prompt tokens have exceeded the
 * maximum limit`. Reading only the default published every one of them at a fifth
 * of the room it has, and the panel's window field could not be raised past it.
 *
 * The claim under test runs through the module the gateway actually uses: the
 * roster carries the ceiling, and `traeVariantFor` answers a request above the
 * default with a variant it serves, which is what puts Max mode on the wire.
 */
test('a directory row that states only the plan default still publishes the server ceiling', () => {
  const { collectTraeSoloModels: collect, traeVariantFor } = require('../src/trae-upstream.ts')
  const byId = new Map()
  // The live shape for deepseek-v4.1-flash: plan default 200k, output 32k, no Max row.
  collect([{
    config_name: 'deepseek-v4.1-flash',
    context_window_tokens: { dev: 200000 },
    model_detail_list: [{ prompt_max_tokens: 168000, max_tokens: 32000 }],
  }], 'solo_work_remote', byId)
  const model = byId.get('deepseek-v4.1-flash')
  assert.equal(model.contextWindow, 200000, 'the plan default stays the default tier')
  assert.equal(model.maxContextWindow, 1000000, 'and the measured ceiling is published beside it')

  // What the gateway asks when the window in force is the ceiling: the answer's own
  // default is what it serves, and the request going above it is what sets Max mode.
  const serving = traeVariantFor(model, 1000000)
  assert.equal(serving.contextWindow, 200000, 'the ceiling is served by the default tier')
  assert.ok(1000000 > serving.contextWindow, 'so a request at the ceiling asks for Max mode')
})

/**
 * A row that states a larger tier of its own keeps that figure.
 *
 * The directory is the upstream speaking about its own model, so it outranks a
 * ceiling measured on other models. Publishing 1M over a stated 400k would hand the
 * host a budget the row never offered.
 */
test('a stated tier above the default outranks the measured ceiling', () => {
  const { collectTraeSoloModels: collect } = require('../src/trae-upstream.ts')
  const byId = new Map()
  collect([row('smaller-tier', { dev: 256000, max: 400000 })], 'solo_work_remote', byId)
  const model = byId.get('smaller-tier')
  assert.equal(model.contextWindow, 256000)
  assert.equal(model.maxContextWindow, 400000, 'the row states its own ceiling')
})

/** A row that states no window at all gets no tier: its reach is simply unknown. */
test('a row with no stated window publishes no tier', () => {
  const { collectTraeSoloModels: collect } = require('../src/trae-upstream.ts')
  const byId = new Map()
  collect([{ config_name: 'budget-only', model_detail_list: [{ max_tokens: 16000 }] }], 'solo_work_remote', byId)
  const model = byId.get('budget-only')
  assert.equal(model.contextWindow, undefined, 'no window is invented for it')
  assert.equal(model.maxContextWindow, undefined, 'and no ceiling is either')
})

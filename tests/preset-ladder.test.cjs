/**
 * The preset rows under the context-window and max-output fields.
 *
 * The panel boots on load, so it cannot be evaluated whole; the two functions
 * the rows are built from are lifted instead and driven against a real DOM.
 * A chip the panel drops fails here rather than passing on a source match.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

/** Lift one top-level function out of the panel by matching its braces. */
function lift(source, name) {
  const from = source.indexOf(`function ${name}(`)
  assert.notEqual(from, -1, `${name} must exist in the panel`)
  let depth = 0
  let index = source.indexOf('{', from)
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
  }
  return source.slice(from, index + 1)
}

/** Just enough DOM for `el` and a click listener. */
function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = tag
      this.children = []
      this.attributes = {}
      this.listeners = {}
      this.textContent = ''
      this.type = ''
    }
    appendChild(child) { this.children.push(child); return child }
    setAttribute(name, value) { this.attributes[name] = value }
    addEventListener(name, fn) { this.listeners[name] = fn }
    click() { if (this.listeners.click) this.listeners.click() }
  }
  return { document: { createElement: (tag) => new Node(tag) }, Node }
}

function loadPanel() {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const { document } = makeDom()
  const context = vm.createContext({
    document,
    Number,
    String,
    Math,
    /** The panel's own element helper, lifted rather than copied. */
    el: null,
    trimFraction: (value) => value,
    // No sheet is open, so the restored-sheet branch in draftFor never runs and
    // currentModelKey is not needed.
    selectedSheet: null,
    draft: {},
  })
  // `el` is the panel's element helper; lift it and the ladder formatter with it.
  const el = vm.runInContext(`(${lift(source, 'el')})`, context)
  context.el = el
  const trimFraction = source.match(/function trimFraction\([^)]*\) \{[\s\S]*?\n\}/)
  assert.ok(trimFraction, 'trimFraction must exist in the panel')
  context.trimFraction = vm.runInContext(`(${trimFraction[0]})`, context)
  const formatTokens = vm.runInContext(`(${lift(source, 'formatTokens')})`, context)
  context.formatTokens = formatTokens
  const presetRow = vm.runInContext(`(${lift(source, 'presetRow')})`, context)
  const withinCeiling = vm.runInContext(`(${lift(source, 'withinCeiling')})`, context)
  context.withinCeiling = withinCeiling
  const windowCeiling = vm.runInContext(`(${lift(source, 'windowCeiling')})`, context)
  context.windowCeiling = windowCeiling
  const outputCeilingFor = vm.runInContext(`(${lift(source, 'outputCeilingFor')})`, context)
  context.outputCeilingFor = outputCeilingFor
  const clampOutput = vm.runInContext(`(${lift(source, 'clampOutput')})`, context)
  context.clampOutput = clampOutput
  const effectiveWindow = vm.runInContext(`(${lift(source, 'effectiveWindow')})`, context)
  context.effectiveWindow = effectiveWindow
  const effectiveOutput = vm.runInContext(`(${lift(source, 'effectiveOutput')})`, context)
  context.effectiveOutput = effectiveOutput
  const reclampEntry = vm.runInContext(`(${lift(source, 'reclampEntry')})`, context)
  const draftFor = vm.runInContext(`(${lift(source, 'draftFor')})`, context)
  const isDirty = vm.runInContext(`(${lift(source, 'isDirty')})`, context)
  const presets = (name) => {
    const head = `var ${name} = [`
    const from = source.indexOf(head)
    assert.notEqual(from, -1, `${name} must exist in the panel`)
    const to = source.indexOf('\n];', from)
    assert.notEqual(to, -1, `${name} must be a top-level array literal`)
    return vm.runInContext(`(${source.slice(from + head.length - 1, to + 2)})`, context)
  }
  return {
    presetRow, presets, formatTokens, withinCeiling, windowCeiling,
    outputCeilingFor, clampOutput, effectiveWindow, effectiveOutput,
    draftFor, isDirty, reclampEntry, setDraft: (value) => { context.draft = value },
  }
}

const { presetRow, presets, withinCeiling, windowCeiling, outputCeilingFor, clampOutput, effectiveWindow, effectiveOutput, draftFor, isDirty, reclampEntry, setDraft } = loadPanel()
const CONTEXT = presets('CONTEXT_WINDOW_PRESETS')
const OUTPUT = presets('MAX_OUTPUT_PRESETS')

/** The chip labels a row offers for one ceiling. */
function labels(presets, ceiling, defaultWindow) {
  const row = presetRow(presets, null, () => {}, ceiling, defaultWindow)
  return row.children.map((chip) => chip.textContent)
}

test('the ladder keeps the rungs a model can take and drops the rest', () => {
  assert.deepEqual(labels(CONTEXT, 128000), ['128k'])
  assert.deepEqual(labels(CONTEXT, 1000000), ['128k', '256k', '312k', '500k', '1M'])
})

test('a ceiling between two rungs is offered as a chip of its own', () => {
  // Trae's roster is full of these: 200000 and 116000 sit under the ladder's
  // 128k/256k rungs, so without the ceiling chip the row read as one lone 128k.
  assert.deepEqual(labels(CONTEXT, 200000), ['128k', '200k'])
  assert.deepEqual(labels(CONTEXT, 116000), ['116k'])
  assert.deepEqual(labels(CONTEXT, 272000), ['128k', '256k', '272k'])
})

test('the output ladder does the same, and keeps an exact rung once', () => {
  assert.deepEqual(labels(OUTPUT, 32000), ['4k', '8k', '16k', '32k'])
  assert.deepEqual(labels(OUTPUT, 32768), ['4k', '8k', '16k', '32k', '32.8k'])
  assert.deepEqual(labels(OUTPUT, 64000), ['4k', '8k', '16k', '32k', '64k'])
  // 128000 is already a rung: adding it again would double the chip.
  assert.deepEqual(labels(OUTPUT, 128000), ['4k', '8k', '16k', '32k', '128k'])
})

test('the ceiling chip is the value the input beside it accepts', () => {
  const picked = []
  const row = presetRow(CONTEXT, null, (tokens) => picked.push(tokens), 200000)
  const ceilingChip = row.children[row.children.length - 1]
  ceilingChip.click()
  assert.deepEqual(picked, [200000], 'the chip must store the ceiling, not a rounded label')
})

test('a model with no stated ceiling still shows the whole ladder', () => {
  assert.deepEqual(labels(CONTEXT, undefined), ['128k', '256k', '312k', '500k', '1M'])
  assert.deepEqual(labels(CONTEXT, 0), ['128k', '256k', '312k', '500k', '1M'])
})

test('a stored figure above the ceiling is shown at the ceiling, not above it', () => {
  // The host clamps an override to the catalog's figure before publishing, so a
  // stored 312k on a 200k model is not what the model runs at. Showing it verbatim
  // put a number in the field that the field's own `max` then refused.
  assert.equal(withinCeiling(312000, 200000), 200000)
  assert.equal(withinCeiling(116000, 200000), 116000, 'a figure under the ceiling is left alone')
  assert.equal(withinCeiling(undefined, 200000), null)
  assert.equal(withinCeiling(200000, undefined), 200000, 'no ceiling means nothing to clamp against')
})

test('that clamp does not read as an unsaved edit', () => {
  const list = [{ id: 'm', nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: false }]
  const selection = {
    enabledModelIds: ['m'],
    overrides: { m: { contextWindow: 312000, maxOutputTokens: 64000 } },
  }
  const draft = draftFor(list, selection)
  assert.equal(draft.m.window, 200000)
  assert.equal(draft.m.output, 32000)
  setDraft(draft)
  assert.equal(isDirty(list, selection), false,
    'opening the sheet must not light the save bar when nothing was touched')
})

test('an edit the user made is still an unsaved edit', () => {
  const list = [{ id: 'm', nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: false }]
  const selection = { enabledModelIds: ['m'], overrides: { m: { contextWindow: 312000 } } }
  const draft = draftFor(list, selection)
  draft.m.window = 128000
  setDraft(draft)
  assert.equal(isDirty(list, selection), true)
})

test('a window above the default lowers the output ceiling', () => {
  // Measured live: chat_v3 serves deepseek-v4.1-flash at 200000 with 32000 output
  // and offers its 1M tier at 16000. Picking the tier has to move the output field
  // with it, or the editor offers a budget that function never grants.
  const model = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000,
  }
  assert.equal(outputCeilingFor(model, 200000), 32000)
  assert.equal(outputCeilingFor(model, 1000000), 16000)
  // A model with no such split keeps one ceiling at every window.
  assert.equal(outputCeilingFor({ nativeContextWindow: 200000, nativeMaxOutputTokens: 32000 }, 1000000), 32000)
})

test('the draft cannot hold an output above the ceiling its window allows', () => {
  const model = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000,
  }
  // A stored 32000 applies at the default window...
  const list = [{ ...model, nativeSupportsImages: false }]
  const atDefault = draftFor(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 200000, maxOutputTokens: 32000 } } })
  assert.equal(atDefault.m.output, 32000)
  // ...and is clamped once the draft reaches for the tier that states 16000.
  const atCeiling = draftFor(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 500000, maxOutputTokens: 32000 } } })
  assert.equal(atCeiling.m.window, 500000)
  assert.equal(atCeiling.m.output, 16000, 'the field must not show a value its own max refuses')
})

test('moving the window clamps an output the new window cannot serve', () => {
  const model = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000,
  }
  const entry = { window: null, output: 32000 }
  assert.equal(effectiveOutput(model, entry), 32000, 'the default window still serves the wider budget')
  entry.window = 1000000
  clampOutput(model, entry)
  assert.equal(entry.output, 16000, 'reaching for the tier clamps what it cannot grant')
  entry.window = null
  assert.equal(effectiveOutput(model, entry), 16000, 'and the clamp stays as an explicit choice')
})

test('a Max tier above the default window is reachable, and is the ceiling', () => {
  // Measured on the live directory: Doubao-Seed-2.1-Pro is listed by
  // solo_work_remote at 256000 with no Max, and by solo_agent_remote at
  // 256000 with a 1000000 Max. The default is not the ceiling.
  const model = { id: 'm', nativeContextWindow: 256000, maxContextWindow: 1000000, nativeMaxOutputTokens: 32000 }
  assert.equal(windowCeiling(model), 1000000, 'the Max tier is the ceiling')
  // Both of the model own windows are reachable: the Max tier is the ceiling, and
  // every ladder rung under it stays a valid choice.
  assert.deepEqual(labels(CONTEXT, 1000000, 256000), ['128k', '256k', '312k', '500k', '1M'])
  // A model with no Max tier keeps its default as the ceiling.
  assert.equal(windowCeiling({ id: 'n', nativeContextWindow: 256000 }), 256000)
})

test('a window above the Max tier is clamped to it, not to the default', () => {
  const model = { id: 'm', nativeContextWindow: 256000, maxContextWindow: 1000000 }
  // The host sizes its budget from the declaration, so the clamp is the Max tier.
  assert.equal(withinCeiling(500000, windowCeiling(model)), 500000, 'a figure between the tiers is allowed')
  assert.equal(withinCeiling(2000000, windowCeiling(model)), 1000000, 'and one above the Max tier is not')
})

/**
 * A draft entry is brought back inside the ceilings the model states NOW.
 *
 * A draft outlives a roster refresh, and a refresh is allowed to lose a Max tier -
 * a directory function failing is normal, and its answer is then simply absent.
 * Carried over untouched, the window field showed a value above its own `max`
 * and the save bar lit up over an edit nobody had made; saving it then published
 * whatever the host clamped it to, silently.
 */
test('a draft carried across a refresh is clamped to the ceiling that is left', () => {
  const raised = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000, nativeSupportsImages: false,
  }
  // The user typed the Max window; the entry is legal against the old ceiling.
  const entry = { window: 1000000, output: 16000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  assert.equal(windowCeiling(raised), 1000000)
  // The roster comes back without the Max tier, and the entry is repaired.
  const narrowed = { ...raised, maxContextWindow: undefined }
  reclampEntry(entry, narrowed)
  assert.equal(entry.window, 200000, 'the window falls back to the ceiling that is left')
  assert.equal(entry.output, 16000,
    'a budget the new window still allows is left alone: only what is over the ceiling moves')

  // The other direction is the one that would have been saved silently: an entry
  // whose output was legal only at the wider window.
  const wide = { window: 200000, output: 64000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  reclampEntry(wide, narrowed)
  assert.equal(wide.output, 32000, 'an output above the ceiling comes down to it')

  // A window of null means "follow the catalog", i.e. the DEFAULT window. Clamping
  // such an entry against the ceiling would hand it the Max tier's smaller budget
  // while the field is still showing the default window.
  const following = { window: null, output: 32000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  reclampEntry(following, raised)
  assert.equal(following.window, null, 'follow-the-catalog stays follow-the-catalog')
  assert.equal(following.output, 32000, 'and its output is measured against the default tier')

  // A selection built from that state is not dirty: nothing the user did is
  // outstanding against what the panel now shows.
  const list = [narrowed]
  assert.equal(isDirty(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 1000000, maxOutputTokens: 16000 } } }),
    true, 'the SAVED figure is what is still out of range, so saving once is the fix')
  const saved = draftFor(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 1000000, maxOutputTokens: 16000 } } })
  assert.equal(saved.m.window, 200000, 'and what the panel shows is already the clamped value')
})

/**
 * The window controls actually clamp the output, not just the helper.
 *
 * The clamp is only worth anything if the two places a user can change the window
 * call it: the number field and the preset chips. Both were covered at the helper
 * level and not at the call site, so removing the call left every test green and
 * put the old behaviour back - a 32k output left standing under a field whose own
 * `max` had become 16k.
 */
test('both window controls take the output ceiling with them', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  // Every place that writes `entry.window` from a user gesture must be followed by
  // the clamp, or the field and its `max` disagree.
  // The two gestures write `entry.window` from a value the user chose; the draft
  // repair writes it from the ceiling, so it is not one of them.
  const writes = [...source.matchAll(/entry\.window = (?:next|tokens)[^;]*;/g)].map((match) => match.index)
  assert.equal(writes.length, 2, 'the window has exactly two input paths: the field and the chips')
  for (const at of writes) {
    const after = source.slice(at, at + 700)
    assert.match(after, /clampOutput\(model, entry\)/,
      'a window change must take the output ceiling with it: ' + source.slice(at, at + 80).replace(/\s+/g, ' '))
  }
  // And the chips are wired to those writes, not to a bare assignment.
  assert.match(source, /CONTEXT_WINDOW_PRESETS,[\s\S]{0,600}?clampOutput\(model, entry\)/,
    'the preset row is wired to the same clamp')
  // A window the user chose also ends any hold an earlier clamp left behind. The
  // hold is replayed the moment the ceiling allows it, so keeping it would replace
  // the user's number with the one a lost Max tier had set aside - on the next
  // roster refresh, with no gesture behind it.
  for (const at of writes) {
    const after = source.slice(at, at + 700)
    assert.match(after, /entry\.windowHeld = null;/,
      'a window change must drop the held figure: ' + source.slice(at, at + 80).replace(/\s+/g, ' '))
  }
})

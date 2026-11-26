const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadPanel() {
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
    insertBefore(child, before) { this.children.splice(this.children.indexOf(before), 0, child) }
    setAttribute(name, value) { this.attributes[name] = value }
    addEventListener(name, fn) { this.listeners[name] = fn }
    click() { this.listeners.click() }
  }
  const source = ts.createSourceFile('panel.js', fs.readFileSync(path.join(__dirname, '../renderer/panel.js'), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set([
    'el', 'trimFraction', 'formatTokens', 'presetRow', 'withinCeiling', 'windowCeiling',
    'outputCeilingFor', 'clampOutput', 'effectiveWindow', 'effectiveOutput', 'reclampEntry',
    'draftFor', 'isDirty', 'iconLabel', 'helpNote', 'modelSheetBody', 'field', 'numberInput',
    'outputCeiling', 'effectiveLevels', 'effectiveImages', 'checkRow',
    'CONTEXT_WINDOW_PRESETS', 'MAX_OUTPUT_PRESETS', 'THINKING_LEVELS', 'MAX_TOKEN_BUDGET',
  ])
  const declarations = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) ? names.has(node.name.text)
      : ts.isVariableStatement(node) && names.has(node.declarationList.declarations[0].name.getText(source)))
  const context = vm.createContext({
    document: { createElement: tag => new Node(tag) },
    selectedSheet: null, draft: {}, t: key => key,
    renderChosen() {}, paintSaveBar() {}, overCeilingNotice: assert.fail,
  })
  vm.runInContext(declarations.map(node => node.getText(source)).join('\n'), context)
  return context
}

const panel = loadPanel()
const { modelSheetBody, presetRow, draftFor, isDirty, reclampEntry } = panel

test('the ceiling chip is the value the input beside it accepts', () => {
  const picked = []
  const row = presetRow(panel.CONTEXT_WINDOW_PRESETS, null, (tokens) => picked.push(tokens), 200000)
  const ceilingChip = row.children[row.children.length - 1]
  ceilingChip.click()
  assert.deepEqual(picked, [200000], 'the chip must store the ceiling, not a rounded label')
})

test('stored limits are clamped without marking the draft dirty until the user edits', () => {
  const list = [{ id: 'm', nativeContextWindow: 200000, nativeMaxOutputTokens: 32000, nativeSupportsImages: false }]
  const selection = {
    enabledModelIds: ['m'],
    overrides: { m: { contextWindow: 312000, maxOutputTokens: 64000 } },
  }
  const draft = draftFor(list, selection)
  assert.equal(draft.m.window, 200000)
  assert.equal(draft.m.output, 32000)
  panel.draft = draft
  assert.equal(isDirty(list, selection), false,
    'opening the sheet must not light the save bar when nothing was touched')
  draft.m.window = 128000
  assert.equal(isDirty(list, selection), true)
})

test('the draft cannot hold an output above the ceiling its window allows', () => {
  const model = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000,
  }
  const list = [{ ...model, nativeSupportsImages: false }]
  const atDefault = draftFor(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 200000, maxOutputTokens: 32000 } } })
  assert.equal(atDefault.m.output, 32000)
  const atCeiling = draftFor(list, { enabledModelIds: ['m'], overrides: { m: { contextWindow: 500000, maxOutputTokens: 32000 } } })
  assert.equal(atCeiling.m.window, 500000)
  assert.equal(atCeiling.m.output, 16000, 'the field must not show a value its own max refuses')
})

test('a draft carried across a refresh is clamped to the ceiling that is left', () => {
  const raised = {
    id: 'm', nativeContextWindow: 200000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 32000, maxOutputAtCeiling: 16000, nativeSupportsImages: false,
  }
  const entry = { window: 1000000, output: 16000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  const narrowed = { ...raised, maxContextWindow: undefined }
  reclampEntry(entry, narrowed)
  assert.equal(entry.window, 200000, 'the window falls back to the ceiling that is left')
  assert.equal(entry.output, 16000,
    'a budget the new window still allows is left alone: only what is over the ceiling moves')

  const wide = { window: 200000, output: 64000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  reclampEntry(wide, narrowed)
  assert.equal(wide.output, 32000, 'an output above the ceiling comes down to it')

  const following = { window: null, output: 32000, enabled: true, alias: '', levels: null, defaultLevel: null, open: false }
  reclampEntry(following, raised)
  assert.equal(following.window, null, 'follow-the-catalog stays follow-the-catalog')
  assert.equal(following.output, 32000, 'and its output is measured against the default tier')

})

test('model controls preserve a valid output budget and editable thinking default', () => {
  const model = { id: 'fixture', nativeContextWindow: 128000, maxContextWindow: 1000000,
    nativeMaxOutputTokens: 64000, maxOutputAtCeiling: 16000, nativeThinkingLevels: ['low', 'high'] }
  const nodes = node => [node, ...node.children.flatMap(nodes)]
  for (const gesture of ['input', 'preset']) {
    const entry = { alias: '', window: null, output: 32000, levels: null, defaultLevel: null,
      images: null, windowHeld: 800000, outputHeld: null }
    const sheet = modelSheetBody(model, entry)
    const controls = nodes(sheet)
    const select = controls.find(node => node.tagName === 'select')
    assert.deepEqual(select.children.map(option => option.value), ['low', 'high'])
    select.value = 'high'
    select.listeners.change()
    assert.equal(entry.defaultLevel, 'high')
    assert.equal(controls.filter(node => node.attributes['aria-label'] === 'models.maxOutput').length, 1)
    if (gesture === 'input') {
      const input = controls.find(node => node.attributes['aria-label'] === 'models.window')
      input.value = '1000000'
      input.listeners.change()
    } else {
      controls.find(node => node.tagName === 'button' && node.textContent === '1M').click()
    }
    assert.equal(entry.window, 1000000)
    assert.equal(entry.windowHeld, null)
    assert.equal(entry.output, 16000)
    const output = nodes(modelSheetBody(model, entry)).find(node => node.attributes['aria-label'] === 'models.maxOutput')
    assert.equal(output.max, '16000')
    assert.equal(output.value, '16000')
    controls.find(node => node.tagName === 'button' && node.textContent === '128k').click()
    assert.equal(entry.output, 32000, 'returning to the default window restores the previous output')
    controls.find(node => node.tagName === 'button' && node.textContent === '1M').click()
    output.value = '8000'
    output.listeners.change()
    controls.find(node => node.tagName === 'button' && node.textContent === '128k').click()
    assert.equal(entry.output, 8000, 'changing the window retains the output the user typed')
  }
})

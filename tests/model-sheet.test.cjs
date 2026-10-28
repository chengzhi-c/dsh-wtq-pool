/**
 * The roster's "being edited" mark, driven through the sheet's own button.
 *
 * The mark is painted by `modelListRow`, which only runs when the roster is
 * rebuilt. The Advanced button lives in the right-hand column and used to call
 * only `renderChosen`, so a sheet opened from there was never marked, and one
 * closed from there stayed marked until something else happened to rebuild the
 * list. Both columns read the same `entry.open`, so they disagreed about which
 * model was being edited.
 *
 * The case presses the button the panel builds rather than scanning for a call:
 * a handler that goes back to `renderChosen` alone leaves the source looking
 * plausible and fails only here.
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

/** Just enough DOM for a roster row, a sheet row and their class lists. */
function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = tag
      this.children = []
      this.attributes = {}
      this.listeners = {}
      this.className = ''
      this.textContent = ''
      this.title = ''
      this.type = ''
      this.checked = false
      this.classes = new Set()
      this.classList = {
        add: (...names) => names.forEach((name) => this.classes.add(name)),
        remove: (...names) => names.forEach((name) => this.classes.delete(name)),
        contains: (name) => this.classes.has(name),
      }
    }
    appendChild(child) { this.children.push(child); return child }
    setAttribute(name, value) {
      this.attributes[name] = value
      if (name === 'class') this.className = String(value)
    }
    getAttribute(name) { return this.attributes[name] ?? null }
    addEventListener(name, fn) { this.listeners[name] = fn }
  }
  return { Node, document: { createElement: (tag) => new Node(tag) } }
}

/** A draft entry with the fields the sheet and the save both read. */
function emptyEntry() {
  return {
    enabled: true, alias: '', window: null, output: null, images: null,
    levels: null, defaultLevel: null, open: false, windowHeld: null, outputHeld: null,
  }
}

/** The panel with its roster and sheet renderers lifted, and one model in a draft. */
function loadPanel() {
  const model = { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 200000, maxOutputTokens: 32000 }
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const { Node, document } = makeDom()
  // The roster element `paintEditingRow` walks. `renderModels` is not run, so the
  // case owns the rows it puts here and can read them back after a press.
  const roster = new Node('ul')
  roster.querySelectorAll = (selector) => selector === '[data-model-id]' ? roster.children : []
  const context = vm.createContext({
    document, Node, Number, String, Math, Object, Array, JSON, console,
    HTMLInputElement: Node,
    busy: null,
    activeSource: 'workbuddy',
    activeRegionOf: () => 'cn',
    t: (key) => key,
    renderModels: () => {},
    renderChosen: () => {},
    $(id) { return id === 'models' ? roster : new Node('div') },
    draft: { [model.id]: emptyEntry() },
    selectedSheet: null,
    roster,
  })
  for (const name of ['el', 'modelDisplay', 'formatTokens', 'withinCeiling', 'windowCeiling',
    'outputCeilingFor', 'effectiveWindow', 'effectiveOutput',
    'tagOf', 'modelListRow', 'modelSheetRow', 'toggleModelSheet', 'paintEditingRow',
    'closeSheetOf', 'openSheetOf', 'sheetIsOpen', 'currentModelKey']) {
    context[name] = vm.runInContext(`(${lift(source, name)})`, context)
  }
  // The row the roster already drew, and the sheet row that carries the button.
  roster.children.push(context.modelListRow(model, { [model.id]: true }))
  const sheet = context.modelSheetRow(model)
  const advanced = sheet.children[0].children.find((child) => child.className.includes('chosen-advanced'))
  assert.ok(advanced, 'the sheet row has to carry its Advanced button')
  return { context, roster, model, advanced, drawn: roster.children[0] }
}

test('opening a model from the sheet buttons marks its roster row', () => {
  const { context, model, advanced, drawn } = loadPanel()
  assert.equal(drawn.classList.contains('is-editing'), false, 'a closed sheet is not marked')

  advanced.listeners.click()

  assert.equal(context.draft[model.id].open, true, 'the button opens the sheet')
  assert.equal(drawn.classList.contains('is-editing'), true, 'and the roster row says which model it is')
})

/**
 * The reported fault: closing the sheet left the row marked, so the roster kept
 * naming a model that was no longer being edited anywhere on screen.
 */
test('closing a model from the sheet buttons clears its roster mark', () => {
  const { context, model, advanced, drawn } = loadPanel()
  advanced.listeners.click()
  assert.equal(drawn.classList.contains('is-editing'), true, 'an open sheet is marked')

  advanced.listeners.click()

  assert.equal(context.draft[model.id].open, false, 'the button closes the sheet')
  assert.equal(drawn.classList.contains('is-editing'), false, 'and the mark goes with it')
  assert.equal(context.selectedSheet, null, 'nothing is left recorded as open')
})

/**
 * The reported fault, second half: unticking a model left its row marked.
 *
 * Only an enabled model has a sheet, so a mark on an unticked row points at
 * nothing - and the recorded open sheet put it back on the next rebuild, which is
 * how a row the user had just taken out of the selection came back marked.
 */
test('unticking a model clears the mark and the sheet it recorded', () => {
  const { context, model, advanced, drawn } = loadPanel()
  advanced.listeners.click()
  assert.equal(drawn.classList.contains('is-editing'), true, 'the sheet starts open and marked')

  const box = drawn.children[0].children.find((child) => child.className === 'row-check')
  assert.ok(box, 'the roster row has to carry its checkbox')
  box.checked = false
  box.listeners.change()

  assert.equal(context.draft[model.id].open, false, 'the open state goes with the tick')
  assert.equal(context.selectedSheet, null, 'and nothing is left recorded to restore it')
  // The mark is read back off a row built from the draft the untick just wrote.
  const after = context.modelListRow(model, {})
  assert.equal(after.classList.contains('is-editing'), false, 'so a rebuild cannot mark it again')
})

/**
 * Opening a second sheet closes the first.
 *
 * The roster's mark means "this is the model whose editor is open", so two marked
 * rows cannot both be that. The case opens the first through the same button the
 * user presses, then the second, and reads the first row back - a build that only
 * sets `open` on the new row leaves two sheets expanded and two rows marked.
 */
test('opening a second sheet closes the first, so one row stays marked', () => {
  const { context, roster, model } = loadPanel()
  const other = { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200000, maxOutputTokens: 32000 }
  context.draft[other.id] = { enabled: true, open: false, window: null, output: null }
  roster.children.push(context.modelListRow(other, { [other.id]: true }))
  const [first, second] = roster.children

  // The first one, opened the way the roster row does it: state, then the mark.
  context.openSheetOf(model.id)
  context.paintEditingRow()
  assert.equal(context.draft[model.id].open, true, 'the first sheet opens')
  assert.equal(first.classList.contains('is-editing'), true)

  context.toggleModelSheet(other.id)

  assert.equal(context.draft[other.id].open, true, 'the second sheet opens')
  assert.equal(context.draft[model.id].open, false, 'and the first closes with it')
  assert.equal(second.classList.contains('is-editing'), true, 'the mark moves to its row')
  assert.equal(first.classList.contains('is-editing'), false, 'and does not stay on the first')
  assert.equal(context.selectedSheet.id, other.id, 'the record follows the sheet that is open')
})

/**
 * The header's select-all is the third way a row loses its tick.
 *
 * It writes the tick itself instead of going through the row's checkbox, so the
 * clearing that the checkbox does had to be repeated there: without it the roster
 * kept marking a model the header had just taken out of the selection, and the
 * rebuilt draft put the sheet back on it.
 */
test('unticking through the header drops the sheet too', () => {
  const { context, model, roster } = loadPanel()
  const other = { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 200000, maxOutputTokens: 32000 }
  context.draft[other.id] = { enabled: true, open: false, window: null, output: null }
  roster.children.push(context.modelListRow(other, { [other.id]: true }))
  context.openSheetOf(model.id)

  // The panel's own header handler, with the boxes it reads.
  const header = { checked: false }
  context.modelSearch = { value: '' }
  context.modelPage = () => ({ source: 'workbuddy', key: 'cn', list: [model, other], selection: null })
  context.$ = (id) => {
    if (id === 'modelSelectAll') return header
    if (id === 'modelSearch') return context.modelSearch
    if (id === 'models') return roster
    return { hidden: true }
  }
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  context.toggleAllVisible = vm.runInContext('(' + lift(source, 'toggleAllVisible') + ')', context)
  context.toggleAllVisible()

  assert.equal(context.draft[model.id].enabled, false, 'the header unticked it')
  assert.equal(context.draft[model.id].open, false, 'and its sheet went with the tick')
  assert.equal(context.selectedSheet, null, 'nothing is left recorded to restore it')
  const after = context.modelListRow(model, {})
  assert.equal(after.classList.contains('is-editing'), false, 'so a rebuild cannot mark it again')
})

/** The panel with its save and discard buttons wired to a stub host. */
function loadPanelWithButtons() {
  const { context, roster, model } = loadPanel()
  const saved = []
  context.invoke = (channel, payload) => {
    saved.push({ channel, payload })
    return Promise.resolve({ gateways: [] })
  }
  context.adopt = () => {}
  context.note = () => {}
  context.announce = () => {}
  context.render = () => {}
  context.drafts = {}
  context.draftSlot = 'workbuddy-cn'
  context.modelPage = () => ({
    source: 'workbuddy', key: 'cn',
    list: [model], selection: { enabledModelIds: [model.id], overrides: {} },
  })
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  for (const name of ['saveModels', 'discardDraft']) {
    context[name] = vm.runInContext('(' + lift(source, name) + ')', context)
  }
  return { context, roster, model, saved }
}

/**
 * The other half of the report: saving or discarding left the sheet open and the
 * row marked, so the roster still said "being edited" after the edit was over.
 *
 * Both buttons end the draft, and a rebuilt draft restores `open` from
 * `selectedSheet`, so the record has to go with the draft.
 */
test('saving a draft ends the session, so the row is not marked afterwards', async () => {
  const { context, model, saved } = loadPanelWithButtons()
  context.draft[model.id] = { ...context.draft[model.id], enabled: true, open: true }
  context.selectedSheet = { key: context.currentModelKey(), id: model.id }

  await context.saveModels()
  assert.equal(saved.length, 1, 'the save reached the host')
  assert.deepEqual(saved[0].payload.knownModelIds, [model.id],
    'the host is told which models this page could show, so its merge keeps the rest')
  assert.equal(context.selectedSheet, null, 'and it drops the record that reopens the sheet')
  assert.equal(context.draft, null, 'the pending draft goes with it')
  // What the panel rebuilds from here: a fresh entry, closed.
  context.draft = { [model.id]: emptyEntry() }
  const after = context.modelListRow(model, { [model.id]: true })
  assert.equal(after.classList.contains('is-editing'), false, 'so the rebuilt row carries no mark')
})

test('discarding a draft ends the session too', () => {
  const { context, model } = loadPanelWithButtons()
  context.draft[model.id] = { ...context.draft[model.id], enabled: true, open: true }
  context.selectedSheet = { key: context.currentModelKey(), id: model.id }

  context.discardDraft()
  assert.equal(context.selectedSheet, null, 'discarding drops the record as well')
  context.draft = { [model.id]: emptyEntry() }
  const after = context.modelListRow(model, { [model.id]: true })
  assert.equal(after.classList.contains('is-editing'), false, 'and the rebuilt row is unmarked')
})

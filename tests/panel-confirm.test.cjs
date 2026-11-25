const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function panel() {
  const file = ts.createSourceFile('panel.js', fs.readFileSync(path.join(__dirname, '../renderer/panel.js'), 'utf8'), ts.ScriptTarget.Latest, true)
  const card = file.statements.filter(node => ts.isFunctionDeclaration(node) && ['accountCard', 'iconLabel'].includes(node.name.text))
  const timers = new Map(), calls = [], rows = new Map()
  const accounts = [{ id: 'one', label: 'One', own: true }, { id: 'two', label: 'Two', own: true }, { id: 'desktop', label: 'Desktop' }]
  let nextTimer = 0
  const el = (tag, className, textContent) => ({
    tag, className, textContent, children: [], attributes: {}, listeners: {},
    appendChild(child) { this.children.push(child) },
    setAttribute(key, value) { this.attributes[key] = value },
    addEventListener(name, listener) { this.listeners[name] = listener },
  })
  const context = vm.createContext({
    el, busy: null, pendingDelete: null, deleteTimer: 0, bannerText: '',
    t: (key, values) => key + (values?.name ? ': ' + values.name : ''),
    regionLabel: value => value, tokenChip: () => el('span'), num: (value, fallback) => value ?? fallback,
    checkinBlock: () => null, setAccountState: (...args) => calls.push(args),
    note: text => { context.bannerText = text },
    renderAccounts: () => accounts.forEach(account => rows.set(account.id, context.accountCard(account))),
    setTimeout: (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer },
    clearTimeout: id => timers.delete(id),
  })
  vm.runInContext(card.map(node => node.getText(file)).join('\n'), context)
  context.renderAccounts()
  const find = (node, id) => node.id === id ? node : node.children.map(child => find(child, id)).find(Boolean)
  return { context, timers, calls, button: (account, control = 'delete') => find(rows.get(account), 'acct-' + account + '-' + control) }
}

test('deletion needs two presses across repaints and identifies the selected account', () => {
  const { context, calls, timers, button } = panel()
  for (const control of ['toggle', 'remove', 'delete']) assert.notEqual(button('one', control).id, button('two', control).id)
  assert.equal(button('desktop'), undefined)
  button('one').listeners.click()
  assert.deepEqual(calls, [])
  assert.equal(button('one').attributes['aria-label'], 'acct.deleteConfirmAgain: One')
  assert.equal(button('one').attributes['aria-pressed'], 'true')
  assert.equal(context.bannerText, 'acct.deleteConfirm: One')
  context.renderAccounts()
  button('two').listeners.click()
  assert.deepEqual(calls, [])
  assert.equal(button('one').attributes['aria-pressed'], 'false')
  assert.equal(button('two').attributes['aria-label'], 'acct.deleteConfirmAgain: Two')
  assert.equal(timers.size, 1)
  button('two').listeners.click()
  assert.deepEqual(calls, [['two', 'deleted']])
  assert.equal(context.pendingDelete, null)
  assert.equal(timers.size, 0)
})

test('a busy race preserves confirmation and rendered account controls are disabled', () => {
  const { context, calls, button } = panel()
  button('one').listeners.click()
  const confirming = button('one')
  context.busy = 'refresh'
  confirming.listeners.click()
  assert.deepEqual(calls, [])
  assert.equal(context.pendingDelete, 'one')
  assert.equal(context.bannerText, 'err.busy')
  context.renderAccounts()
  for (const control of ['toggle', 'remove', 'delete']) assert.equal(button('one', control).disabled, true)
  context.busy = null
  context.renderAccounts()
  button('one').listeners.click()
  assert.deepEqual(calls, [['one', 'deleted']])
})

test('confirmation expires with its prompt and preserves a later notification', () => {
  const { context, calls, timers, button } = panel()
  for (const laterMessage of [undefined, 'another action finished']) {
    button('one').listeners.click()
    if (laterMessage !== undefined) context.note(laterMessage)
    const [id, timer] = [...timers][0]
    assert.equal(timer.ms, 8000)
    timers.delete(id)
    timer.callback()
    assert.equal(context.pendingDelete, null)
    assert.equal(context.bannerText, laterMessage ?? '')
    assert.equal(button('one').attributes['aria-label'], 'acct.delete: One')
    assert.equal(button('one').attributes['aria-pressed'], 'false')
  }
  assert.deepEqual(calls, [])
})

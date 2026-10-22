/**
 * A confirmation the sandboxed panel can actually show.
 *
 * The panel is opened with `sandbox: true`, and Electron answers a script dialog
 * in a sandboxed page by returning false without showing anything. The delete
 * button used `window.confirm`, so it looked live and deleted nothing - every
 * press, on the one action whose whole point is being irreversible.
 *
 * The rule this pins: the panel never asks through a dialog, and the delete
 * button needs two presses with the second one labelled as the confirmation.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const source = () => fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')

/** The delete button, from its armed flag to the end of its click handler. */
function deleteControl() {
  const text = source()
  const start = text.indexOf('var armed = pendingDelete === account.id;')
  assert.notEqual(start, -1, 'the delete control must exist')
  const end = text.indexOf('controls.appendChild(deleteBtn);', start)
  assert.notEqual(end, -1, 'the delete control must be appended to the row')
  return text.slice(start, end)
}

/** Just the branch that arms the button, i.e. the first press. */
function armBranch() {
  const body = deleteControl()
  const start = body.indexOf('pendingDelete = account.id;')
  assert.notEqual(start, -1, 'the first press has to arm the button')
  // Ends at the `return;` that closes the arming branch, timer body included.
  const end = body.indexOf('        return;', start)
  assert.notEqual(end, -1, 'the arming branch has to return instead of deleting')
  return body.slice(start, end)
}

/** The code that runs when the arming lapses: the timer body, and nothing else. */
function armExpiry() {
  const body = deleteControl()
  const start = body.indexOf('deleteTimer = setTimeout(')
  assert.notEqual(start, -1, 'the arming has to expire on its own')
  const end = body.indexOf('}, 8000);', start)
  assert.notEqual(end, -1, 'the expiry has to be a timer with a deadline')
  return body.slice(start, end)
}

/** The second press: everything after the arming branch has returned. */
function confirmBranch() {
  const body = deleteControl()
  const start = body.indexOf('        return;')
  assert.notEqual(start, -1, 'the arming branch has to return instead of deleting')
  return body.slice(start)
}

test('the panel asks for nothing through a script dialog', () => {
  const text = source()
  // Both are answered without a visible dialog in a sandboxed page, so a use of
  // either reads as a confirmation that silently refuses.
  assert.doesNotMatch(text, /window\.confirm\(/, 'window.confirm cannot show in a sandboxed panel')
  assert.doesNotMatch(text, /window\.alert\(/, 'window.alert cannot show either')
  assert.doesNotMatch(text, /window\.prompt\(/, 'window.prompt cannot show either')
})

test('the delete button confirms on a second press', () => {
  const body = deleteControl()
  assert.match(body, /acct\.deleteConfirmAgain/, 'the armed label says what the next press does')
  assert.match(confirmBranch(), /setAccountState\(account\.id, "deleted"\)/, 'the second press is the one that deletes')
})

test('a press on a busy panel leaves the row armed instead of eating the confirmation', () => {
  // `setAccountState` answers a press made while another control is busy with
  // nothing at all - not even the busy banner - so consuming the arming first
  // turned that press into "did nothing, said nothing". The guard has to sit in
  // the second-press path, ahead of the delete and behind the arming branch: put
  // it before the arming check and the press neither arms nor confirms.
  const branch = confirmBranch()
  const guard = branch.indexOf('if (busy !== null) {')
  const remove = branch.indexOf('setAccountState(account.id, "deleted")')
  assert.notEqual(guard, -1, 'the second press has to refuse while the panel is busy')
  assert.ok(guard < remove, 'and refuse before it consumes the arming')
  assert.match(branch.slice(guard, remove), /note\(t\("err\.busy"\)/, 'the refusal has to say something')
})

test('arming repaints the row that carries the label', () => {
  // The label changed in the model but the repaint asked for was the account
  // picker's, which does not build these rows: the button still read 删除 after
  // the first press, so the second press looked like the first one failing.
  const branch = armBranch()
  assert.match(branch, /renderAccounts\(\)/, 'the arming branch repaints the account list')
  assert.doesNotMatch(branch, /renderChosen\(\)/, 'and not only the account picker')
})

test('the armed state survives a repaint', () => {
  // A poll rebuilds the row every 1.2-2 s. A flag written onto the button node was
  // gone before the second press landed, so every press re-armed and nothing was
  // ever deleted. The state has to live in the module, and the rebuilt row has to
  // read it back.
  const text = source()
  assert.match(text, /var pendingDelete = null;/, 'the armed account is module state')
  const body = deleteControl()
  assert.match(body, /var armed = pendingDelete === account\.id;/, 'the rebuilt button reads the armed state')
  assert.doesNotMatch(body, /deleteBtn\.setAttribute\("data-confirming"/, 'and does not keep it on the node')
})

test('the armed state lapses, so a stray press cannot leave a live delete button', () => {
  // Scoped to the timer body: the same `pendingDelete = null;` and
  // `renderAccounts();` also sit in the two branches, so a whole-control match
  // stayed green with the expiry emptied out.
  const expiry = armExpiry()
  assert.match(expiry, /deleteTimer = setTimeout\(/, 'the arming has to expire on its own')
  assert.match(expiry, /pendingDelete !== account\.id/, 'the expiry only disarms the row that armed it')
  assert.match(expiry, /pendingDelete = null;/, 'and the expiry is what disarms it')
  assert.match(expiry, /renderAccounts\(\);/, 'and the label goes back with it')
})

test('the row is disabled while any action is in flight', () => {
  // `setAccountState` answers a press made while another control is busy with
  // nothing at all - not even the busy banner - so a row that stayed enabled was a
  // press that did nothing and said nothing, on the delete button of all places.
  const text = source()
  const at = text.indexOf('function accountCard(')
  assert.notEqual(at, -1)
  const body = text.slice(at, at + 6000)
  assert.match(body, /var rowBusy = busy !== null;/, 'the whole panel being busy disables the row')
})

test('both locales carry the armed label', () => {
  const text = source()
  assert.match(text, /"acct\.deleteConfirmAgain": "Press delete again to confirm"/)
  assert.match(text, /"acct\.deleteConfirmAgain": "再按一次确认删除"/)
})
/**
 * Focus lands back on the control the user pressed, not on another account's.
 *
 * "Remove" is on every row and reads the same on every row, and the delete button
 * says exactly the same thing on each row that carries one, so the locator's
 * label fallback returns the FIRST such button in the column: pressing row five's
 * remove and getting a repaint put the focus ring on row one's. The index
 * fallback is no better - a rescan reorders the rows under a count that did not
 * change. Each row control therefore carries an id built from the account's own.
 */
test('a row control is identifiable by the account it belongs to', () => {
  const text = source()
  const at = text.indexOf('function accountCard(')
  assert.notEqual(at, -1, 'the account row has to exist')
  const body = text.slice(at, text.indexOf('\nfunction creditsBlock(', at))
  for (const suffix of ['-toggle', '-remove', '-delete']) {
    assert.match(body, new RegExp(`\\.id = rowKey \\+ "${suffix}"`),
      `the row's ${suffix.slice(1)} control must carry an id, or the focus hand-back picks another row`)
  }
  assert.match(body, /var rowKey = "acct-" \+ account\.id;/, 'built from the account id, which is what the locator matches on')
})
/**
 * A lapsed arming takes its banner with it.
 *
 * The banner names the account "the next press will delete" and stayed up after
 * the timer went back to the first-press label, so the panel went on inviting a
 * press that the button under it no longer offered.
 */
test('the arming that lapses clears the prompt it put up', () => {
  const expiry = armExpiry()
  assert.match(expiry, /bannerText === t\("acct\.deleteConfirm"/,
    'only the prompt this timer put up, not whatever the user did since')
  assert.match(expiry, /note\(""\)/, 'and the banner is what it clears')
})

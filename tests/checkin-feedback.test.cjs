const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'panel.js'), 'utf8')

/** The named panel function, evaluated with the globals it reads. */
function panelFunction(name) {
  const from = source.indexOf(`function ${name}(`)
  assert.notEqual(from, -1, `${name} must exist in the panel`)
  let depth = 0
  let index = source.indexOf('{', from)
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return source.slice(from, index + 1)
}

async function claim(result) {
  const notes = []
  const adopted = []
  const calls = [], busyKeys = []
  const context = vm.createContext({
    Promise, String, Number, console,
    busy: null,
    checkinBusy: null,
    invoke: async (channel, payload) => {
      calls.push(JSON.parse(JSON.stringify({ channel, payload })))
      return { state: { qoder: { accounts: [] } }, result }
    },
    adopt: (state) => adopted.push(state),
    note: (value) => notes.push(value),
    render: () => busyKeys.push(context.checkinBusy),
    t: (key) => key,
  })
  vm.runInContext(panelFunction('sourceCheckinKey') + '\n' + panelFunction('claimSourceCheckin'), context)
  await context.claimSourceCheckin('qoder', { id: 'account-a', label: 'A', region: 'cn' })
  return { notes: notes.filter((value) => value !== null), adopted, calls, busyKeys }
}

/**
 * A click can land after the automatic pass already collected the round.
 *
 * The panel's row was stale, so the click finds the round claimed and the host
 * answers `skipped` with `todayCheckedIn`. That is the state the user asked
 * for, and the card updates from the same answer, so the banner must report the
 * collection rather than "already collected today" - the wording that made the
 * click read as a failure until the panel was refreshed.
 */
test('a click that finds the round already collected reports success', async () => {
  const { notes, adopted, calls, busyKeys } = await claim({ outcome: 'skipped', todayCheckedIn: true })
  assert.deepEqual(calls, [{ channel: 'xd.sourceCheckin', payload: { source: 'qoder', accountId: 'account-a', region: 'cn' } }])
  assert.equal(busyKeys[0], 'qoder:cn:account-a')
  assert.deepEqual(notes, ['source.checkinDone'])
  assert.equal(adopted.length, 1, 'the card still takes the state that marks the row collected')
})

test('a skipped claim that left the round open still says so', async () => {
  const { notes } = await claim({ outcome: 'skipped' })
  assert.deepEqual(notes, ['source.checkinSkipped'])
})

test('the source picker selects by account ID and can clear the preference', async () => {
  const calls = []
  const context = vm.createContext({
    state: { qoder: { preferred: { cn: 'account-b' } } }, busy: null,
    el: (tag, _className, text) => ({
      tag, textContent: text, children: [], events: {},
      appendChild(child) { this.children.push(child) },
      setAttribute() {}, addEventListener(name, callback) { this.events[name] = callback },
    }),
    t: key => key, distributionControl: () => ({}),
    runBusy: (_key, work) => work(),
    invoke: async (channel, payload) => calls.push(JSON.parse(JSON.stringify({ channel, payload }))),
  })
  vm.runInContext(panelFunction('sourcePreferredPicker') + '\n' + panelFunction('setPreferredSourceAccount'), context)
  const picker = context.sourcePreferredPicker('qoder', 'cn', [
    { id: 'account-a', label: 'Shared name' }, { id: 'account-b', label: 'Shared name' },
  ]).children[1]
  assert.deepEqual(picker.children.map(option => option.value), ['', 'account-a', 'account-b'])
  assert.equal(picker.value, 'account-b')
  for (const value of ['account-a', '']) {
    picker.value = value
    await picker.events.change()
  }
  assert.deepEqual(calls, [
    { channel: 'xd.preferSourceAccount', payload: { source: 'qoder', region: 'cn', accountId: 'account-a' } },
    { channel: 'xd.preferSourceAccount', payload: { source: 'qoder', region: 'cn', accountId: '' } },
  ])
})

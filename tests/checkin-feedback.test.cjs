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
  const context = vm.createContext({
    Promise, String, Number, console,
    busy: null,
    checkinBusy: null,
    invoke: async () => ({ state: { qoder: { accounts: [] } }, result }),
    adopt: (state) => adopted.push(state),
    note: (value) => notes.push(value),
    render: () => {},
    sourceCheckinKey: (kind, account) => `${kind}:${account.label}`,
    t: (key) => key,
  })
  vm.runInContext(panelFunction('claimSourceCheckin'), context)
  await context.claimSourceCheckin('qoder', { label: 'A', region: 'cn' })
  return { notes: notes.filter((value) => value !== null), adopted }
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
  const { notes, adopted } = await claim({ outcome: 'skipped', todayCheckedIn: true })
  assert.deepEqual(notes, ['source.checkinDone'])
  assert.equal(adopted.length, 1, 'the card still takes the state that marks the row collected')
})

test('a skipped claim that left the round open still says so', async () => {
  const { notes } = await claim({ outcome: 'skipped' })
  assert.deepEqual(notes, ['source.checkinSkipped'])
})

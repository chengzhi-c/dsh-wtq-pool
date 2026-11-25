const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')

/** Lift `adopt` and `readGrowth`, with the module state they close over. */
function loadGrowth() {
  const source = fs.readFileSync(path.join(root, 'renderer', 'panel.js'), 'utf8')
  const lift = (name) => {
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
  const context = vm.createContext({
    state: null,
    growthState: null,
    growthReading: false,
    growthReadEpoch: 0,
    stateRevision: 0,
    answered: null,
    notes: [],
    rendered: 0,
    invoke: async () => context.answered,
    render: () => { context.rendered += 1 },
    note: (text) => { context.notes.push(text) },
    Date,
    Object,
    Promise,
    String,
    console,
  })
  vm.runInContext(lift('adopt'), context)
  vm.runInContext(lift('readGrowth'), context)
  return context
}

const ROWS = { accounts: 1, failed: 0, readAt: Date.now(), rows: [{ id: 'a1', label: 'One', region: 'cn', tiers: 1 }] }

test('only a newer pool revision invalidates the displayed rows', () => {
  const context = loadGrowth()
  context.adopt({ growth: { readEpoch: 1, read: ROWS } })
  context.adopt({ accounts: {} })
  context.adopt({ growth: { running: true } })
  context.adopt({ growth: { readEpoch: 1, read: null } })
  assert.equal(context.growthState, ROWS, 'a cache miss for the same pool leaves the rows alone')
  context.adopt({ growth: { readEpoch: 2, read: null } })
  context.adopt({ growth: { readEpoch: 1, read: ROWS } })
  assert.equal(context.growthState, null, 'a delayed status response cannot restore the old rows')
})

test('a read that was in flight when the drop landed does not put the rows back', async () => {
  const context = loadGrowth()
  context.adopt({ growth: { readEpoch: 1, read: null } })
  context.answered = { readEpoch: 1, growth: ROWS }
  const pending = context.readGrowth()
  // The drop arrives while the host read is still running. This is the sequence a
  // user produces by pressing "read state" and then switching an account off.
  context.adopt({ growth: { readEpoch: 2, read: null } })
  await pending
  assert.equal(context.growthState, null,
    'the answer describes the pool as it was, so adopting it would repaint the dropped rows as fresh')
})

test('ordinary polling does not discard the first growth read', async () => {
  const context = loadGrowth()
  const initial = { growth: { readEpoch: 1, read: null } }
  context.adopt(initial)
  context.answered = { readEpoch: 1, growth: ROWS }
  const pending = context.readGrowth()
  context.adopt(initial)
  await pending
  assert.equal(context.growthState, ROWS)
})

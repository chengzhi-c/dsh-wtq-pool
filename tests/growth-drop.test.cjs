/**
 * The growth drop signal, and what an in-flight read does with it.
 *
 * Three states the card must not reach:
 *
 *   1. the host dropped the read because the pool changed, and the panel kept
 *      painting the rows anyway;
 *   2. a read was running when the drop arrived, and its answer - computed against
 *      the pool as it was, stamped with the time it arrived - put the rows back and
 *      read as fresh for the whole throttle window;
 *   3. the host's own settings card, a rescan or a new login changed the pool
 *      without dropping, so (2) happened with nothing to notice it.
 *
 * The first two are driven here through the panel's own functions; the third is
 * asserted against the entry points, which is where the drop has to be called.
 */
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
    growthDropped: 0,
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

test('the panel drops its copy when the host publishes no read', () => {
  const context = loadGrowth()
  context.growthState = ROWS
  context.adopt({ growth: { read: null } })
  assert.equal(context.growthState, null, 'a published null is the host saying the pool changed')
})

test('a document that says nothing about growth leaves the rows alone', () => {
  const context = loadGrowth()
  context.growthState = ROWS
  // No `growth` key at all - this is what a pass in flight publishes, and taking
  // the figures off screen for it would be the same mistake in the other direction.
  context.adopt({ accounts: {} })
  context.adopt({ growth: { running: true } })
  assert.equal(context.growthState, ROWS, 'the rows the user is watching stay')
})

test('a read that was in flight when the drop landed does not put the rows back', async () => {
  const context = loadGrowth()
  context.answered = { growth: { ...ROWS, readAt: Date.now() } }
  const pending = context.readGrowth()
  // The drop arrives while the host read is still running. This is the sequence a
  // user produces by pressing "read state" and then switching an account off.
  context.adopt({ growth: { read: null } })
  await pending
  assert.equal(context.growthState, null,
    'the answer describes the pool as it was, so adopting it would repaint the dropped rows as fresh')
})

test('a read with no drop behind it is adopted as usual', async () => {
  const context = loadGrowth()
  const answer = { ...ROWS, readAt: Date.now() }
  context.answered = { growth: answer }
  await context.readGrowth()
  assert.deepEqual(context.growthState, answer, 'the ordinary path still paints what the host holds')
})

test('the host settings card, a rescan and a new login all drop the read', () => {
  // Each of these changes which accounts a read would return, so an answer in
  // flight across one of them describes a pool that no longer exists. Asserted on
  // the entry point: a helper test cannot see whether the call is there.
  const entry = fs.readFileSync(path.join(root, 'src', 'host.ts'), 'utf8')
  const bodyOf = (marker, length) => {
    const at = entry.indexOf(marker)
    assert.notEqual(at, -1, `${marker} must exist in the entry`)
    return entry.slice(at, at + length)
  }
  // Each window stops before the next call site, so deleting the call this case
  // is about cannot be covered by a neighbouring one.
  assert.match(bodyOf('async function onHostSettingsChanged(next)', 3000), /await applySettingsEverywhere\(toggled\)/,
    'a host settings change must reach the shared reconciliation')
  assert.match(bodyOf('async function applySettingsEverywhere(toggled)', 1400), /if \(toggled\)[\s\S]{0,160}?growthRead = null/,
    'a source or region switched in the host settings must drop the read')
  assert.match(bodyOf('case "xd.rescan": {', 900), /growthRead = null/,
    'a rescan can add or retire accounts, so it must drop the read')
  assert.match(bodyOf('case "xd.pollLogin": {', 1000), /growthRead = null/,
    'an account that just landed is not in a read taken before it')
})

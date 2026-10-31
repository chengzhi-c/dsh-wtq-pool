'use strict'

/**
 * Which accounts get a check-in row.
 *
 * Qoder's international service lists promotion campaigns but no daily
 * CLAIM_BENEFIT round, so an account there reports `active: false` with no
 * opening hour. Drawing a disabled button for it made the control look broken.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'panel.js'), 'utf8')
const from = source.indexOf('function checkinOffered(')
assert.notEqual(from, -1, 'checkinOffered must exist in the panel')
let depth = 0
let index = source.indexOf('{', from)
for (; index < source.length; index += 1) {
  if (source[index] === '{') depth += 1
  else if (source[index] === '}') { depth -= 1; if (depth === 0) break }
}
const checkinOffered = vm.runInNewContext(`(${source.slice(from, index + 1)})`, {})

test('an account with no campaign and no opening hour has no check-in surface', () => {
  assert.equal(checkinOffered(undefined), false)
  assert.equal(checkinOffered(null), false)
  assert.equal(checkinOffered({ active: false, todayCheckedIn: false }), false,
    'Qoder international lists promotions, not a daily round')
})

test('a claimed or still-open campaign keeps its row', () => {
  assert.equal(checkinOffered({ active: true, todayCheckedIn: false }), true)
  assert.equal(checkinOffered({ active: true, todayCheckedIn: true }), true)
  assert.equal(checkinOffered({ active: false, todayCheckedIn: false, opensAtHour: 10 }), true)
  assert.equal(checkinOffered({ active: false, campaignsUnavailable: true }), true,
    'a failed read is still worth naming')
})

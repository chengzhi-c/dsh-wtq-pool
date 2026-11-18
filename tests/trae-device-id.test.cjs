'use strict'

/**
 * Which persisted device number `x-device-id` may carry.
 *
 * Trae's storage can hold more than one `iCubeAuthInfo://icube-dc:` entry: one
 * per sign-in, plus leftovers the app writes when it migrates its device id.
 * Only the numeric suffix is the device number the official clients send, so a
 * single numeric id beside a migrated `aha-…` key is still usable, while two
 * numeric ids are two accounts and must fall back.
 */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

require('./ts-loader.cjs')

const DEV_DEVICE_ID = '11111111-2222-3333-4444-555555555555'
const scratch = (label) => fs.mkdtempSync(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), `dsh-${label}-`))

async function identityFor(deviceCenterKeys) {
  const { readTraeIdentity } = require('../src/trae-identity.ts')
  const directory = scratch('trae-device-id-')
  try {
    const storagePath = path.join(directory, 'User', 'globalStorage', 'storage.json')
    fs.mkdirSync(path.dirname(storagePath), { recursive: true })
    fs.writeFileSync(storagePath, JSON.stringify({
      'telemetry.machineId': 'fixture-machine',
      'telemetry.devDeviceId': DEV_DEVICE_ID,
      ...deviceCenterKeys,
    }))
    return await readTraeIdentity({ path: storagePath, edition: 'cn', source: 'desktop' })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('a numeric device id beside a migrated non-numeric key is still used', async () => {
  const identity = await identityFor({
    'iCubeAuthInfo://icube-dc:aha-0123456789abcdef0123456789abcdef': '{}',
    'iCubeAuthInfo://icube-dc:1000000000000003': '{}',
  })
  assert.equal(identity.deviceId, '1000000000000003',
    'the numeric suffix is the x-device-id; the migrated key is not a device number')
  assert.notEqual(identity.deviceIdIsFallback, true,
    'a usable numeric id means the identity is not a fallback')
})

test('two numeric device ids still mean two sign-ins and fall back', async () => {
  const identity = await identityFor({
    'iCubeAuthInfo://icube-dc:1000000000000001': '{}',
    'iCubeAuthInfo://icube-dc:1000000000000002': '{}',
  })
  assert.equal(identity.deviceIdIsFallback, true,
    'two numeric ids leave no way to know which account this machine is serving')
  assert.notEqual(identity.deviceId, '1000000000000001')
  assert.notEqual(identity.deviceId, '1000000000000002')
  assert.equal(identity.deviceId, DEV_DEVICE_ID,
    'the telemetry id is the documented fallback when no single device number exists')
})

test('a lone non-numeric device key keeps the previous single-entry behaviour', async () => {
  const identity = await identityFor({
    'iCubeAuthInfo://icube-dc:aha-0123456789abcdef0123456789abcdef': '{}',
  })
  assert.equal(identity.deviceId, 'aha-0123456789abcdef0123456789abcdef',
    'with one entry there is still a persisted id to send')
})

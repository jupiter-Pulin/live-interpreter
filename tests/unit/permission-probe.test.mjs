import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsPermissionProbe } from '../../src/shared/permission-probe.mjs'

test('AC-002 needsPermissionProbe：空列表 / 全空 label / 存在非空 label', () => {
  assert.equal(needsPermissionProbe([]), true)
  assert.equal(
    needsPermissionProbe([
      { deviceId: 'a', label: '' },
      { deviceId: 'b', label: '' },
    ]),
    true
  )
  assert.equal(
    needsPermissionProbe([
      { deviceId: 'a', label: '' },
      { deviceId: 'b', label: 'BlackHole 2ch' },
    ]),
    false
  )
})

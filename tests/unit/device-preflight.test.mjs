import { test } from 'node:test'
import assert from 'node:assert/strict'
import { preflight } from '../../src/shared/device-preflight.mjs'

// 两块 BlackHole + 多个非 BlackHole 设备；刻意让字典序最小者不在数组首位
const TWO_BLOCKS = [
  { deviceId: 'bh16-out', kind: 'audiooutput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
  { deviceId: 'spk-b', kind: 'audiooutput', label: 'MacBook Pro Speakers', groupId: 'g-spk' },
  { deviceId: 'bh2-in', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'mic-b', kind: 'audioinput', label: 'MacBook Pro Microphone', groupId: 'g-mic' },
  { deviceId: 'bh2-out', kind: 'audiooutput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'spk-a', kind: 'audiooutput', label: 'External Headphones', groupId: 'g-hp' },
  { deviceId: 'bh16-in', kind: 'audioinput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
  { deviceId: 'mic-a', kind: 'audioinput', label: 'USB Microphone', groupId: 'g-usb' },
]

const NO_BLACKHOLE = [
  { deviceId: 'spk-a', kind: 'audiooutput', label: 'External Headphones', groupId: 'g-hp' },
  { deviceId: 'mic-a', kind: 'audioinput', label: 'USB Microphone', groupId: 'g-usb' },
]

const ONE_BLOCK = [
  { deviceId: 'bh2-in', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'bh2-out', kind: 'audiooutput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'spk-a', kind: 'audiooutput', label: 'External Headphones', groupId: 'g-hp' },
  { deviceId: 'mic-a', kind: 'audioinput', label: 'USB Microphone', groupId: 'g-usb' },
]

test('AC-003 默认分配：通道数升序、kind 正确、与列表顺序无关', () => {
  const r = preflight(TWO_BLOCKS, {})
  assert.equal(r.category, 'ok')
  assert.equal(r.roles.capture, 'bh2-in')
  assert.equal(r.roles.virtualMic, 'bh16-out')
  assert.equal(r.roles.monitor, 'spk-a')
  assert.equal(r.roles.mic, 'mic-a')
  for (const id of Object.values(r.roles)) assert.notEqual(id, undefined)
  const captureEntry = TWO_BLOCKS.find((d) => d.deviceId === r.roles.capture)
  const vmEntry = TWO_BLOCKS.find((d) => d.deviceId === r.roles.virtualMic)
  assert.equal(captureEntry.kind, 'audioinput')
  assert.equal(captureEntry.groupId, 'g-bh2')
  assert.equal(vmEntry.kind, 'audiooutput')
  assert.equal(vmEntry.groupId, 'g-bh16')
  assert.notEqual(captureEntry.groupId, vmEntry.groupId)
  assert.ok(!r.labels.monitor.includes('BlackHole'))
  assert.ok(!r.labels.mic.includes('BlackHole'))

  const shuffled = [...TWO_BLOCKS].reverse()
  const r2 = preflight(shuffled)
  assert.deepEqual(r2.roles, r.roles)
})

test('AC-004 完全没装 BlackHole：返回安装指引', () => {
  const r = preflight(NO_BLACKHOLE)
  assert.equal(r.category, 'device_missing')
  assert.ok(r.message.includes('安装 BlackHole'))
  assert.ok(r.message.includes('多输出'))
})

test('AC-005 只有一块 BlackHole：不因两条条目误判齐备', () => {
  const r = preflight(ONE_BLOCK)
  assert.equal(r.category, 'device_missing')
  assert.ok(r.message.includes('第二个 BlackHole'))
  assert.notEqual(r.message, preflight(NO_BLACKHOLE).message)
})

test('AC-006 权限/枚举异常归入 permission_denied', () => {
  const emptyLabels = TWO_BLOCKS.map((d) => ({ ...d, label: '' }))
  const ra = preflight(emptyLabels)
  assert.equal(ra.category, 'permission_denied')
  const rb = preflight([])
  assert.equal(rb.category, 'permission_denied')
  assert.notEqual(rb.message, preflight(NO_BLACKHOLE).message)
  assert.ok(rb.message.includes('权限'))
})

test('AC-007 覆盖不能绕过物理设备互斥', () => {
  const a = preflight(TWO_BLOCKS, { capture: 'bh2-in', virtualMic: 'bh2-in' })
  assert.equal(a.category, 'device_missing')
  const b = preflight(TWO_BLOCKS, { capture: 'bh2-in', virtualMic: 'bh2-out' })
  assert.equal(b.category, 'device_missing')
  const c = preflight(TWO_BLOCKS, { capture: 'not-in-list' })
  assert.equal(c.category, 'device_missing')
})

test('AC-028 自听回环防线与无可用非 BlackHole 设备', () => {
  const a = preflight(TWO_BLOCKS, { monitor: 'bh16-out' })
  assert.equal(a.category, 'device_missing')
  assert.ok(a.message.includes('回环'))
  const b = preflight(TWO_BLOCKS, { mic: 'bh2-in' })
  assert.equal(b.category, 'device_missing')
  assert.ok(b.message.includes('回环'))
  const noOutput = TWO_BLOCKS.filter((d) => !(d.kind === 'audiooutput' && !d.label.includes('BlackHole')))
  const c = preflight(noOutput)
  assert.equal(c.category, 'device_missing')
  assert.ok(c.message.includes('monitor'))
  assert.notEqual(a.message, b.message)
  assert.notEqual(a.message, c.message)
  assert.notEqual(b.message, c.message)
})

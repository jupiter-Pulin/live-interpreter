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

// 真机形态（Chrome / macOS）：deviceId 在整个列表中并不唯一。
// 同一块 BlackHole 的 audioinput 与 audiooutput 条目共用一个 deviceId，
// Chrome 的 default 伪设备也在输入侧与输出侧各有一条、都叫 'default'。
const SHARED_IDS = [
  { deviceId: 'default', kind: 'audiooutput', label: '默认 - External Headphones', groupId: 'g-hp' },
  { deviceId: 'default', kind: 'audioinput', label: '默认 - MacBook Pro Microphone', groupId: 'g-mic' },
  { deviceId: 'bh2', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'bh2', kind: 'audiooutput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
  { deviceId: 'bh16', kind: 'audiooutput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
  { deviceId: 'bh16', kind: 'audioinput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
  { deviceId: 'hp-1', kind: 'audiooutput', label: 'External Headphones', groupId: 'g-hp' },
  { deviceId: 'mic-1', kind: 'audioinput', label: 'MacBook Pro Microphone', groupId: 'g-mic' },
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

test('deviceId 非全局唯一时，合法的四角色覆盖不被误拒', () => {
  const base = preflight(SHARED_IDS, {})
  assert.equal(base.category, 'ok')

  // 同一块 BlackHole 的进出两条共用 deviceId：按角色期望的 kind 解析，两个方向都要成立
  const capture = preflight(SHARED_IDS, { capture: 'bh2' })
  assert.equal(capture.category, 'ok', capture.message)
  assert.equal(capture.roles.capture, 'bh2')
  const virtualMic = preflight(SHARED_IDS, { virtualMic: 'bh16' })
  assert.equal(virtualMic.category, 'ok', virtualMic.message)
  assert.equal(virtualMic.roles.virtualMic, 'bh16')

  // 'default' 伪条目在输入/输出两侧同名：monitor 取输出侧、mic 取输入侧
  const monitor = preflight(SHARED_IDS, { monitor: 'default' })
  assert.equal(monitor.category, 'ok', monitor.message)
  assert.equal(monitor.roles.monitor, 'default')
  assert.equal(monitor.labels.monitor, '默认 - External Headphones')
  const mic = preflight(SHARED_IDS, { mic: 'default' })
  assert.equal(mic.category, 'ok', mic.message)
  assert.equal(mic.roles.mic, 'default')
  assert.equal(mic.labels.mic, '默认 - MacBook Pro Microphone')

  const all = preflight(SHARED_IDS, { capture: 'bh2', virtualMic: 'bh16', monitor: 'hp-1', mic: 'mic-1' })
  assert.equal(all.category, 'ok', all.message)
  assert.deepEqual(all.roles, { capture: 'bh2', virtualMic: 'bh16', monitor: 'hp-1', mic: 'mic-1' })
})

test('deviceId 非全局唯一时，既有防线仍然成立', () => {
  // 规则 0'：id 完全不存在
  const missing = preflight(SHARED_IDS, { capture: 'not-in-list' })
  assert.equal(missing.category, 'device_missing')
  assert.ok(missing.message.includes('已失效'))

  // 规则 4：capture 与 virtualMic 落在同一块物理设备（此处连 deviceId 都相同）
  const sameBlock = preflight(SHARED_IDS, { capture: 'bh2', virtualMic: 'bh2' })
  assert.equal(sameBlock.category, 'device_missing')
  assert.ok(sameBlock.message.includes('两块不同'))

  // 规则 8：monitor / mic 落在 BlackHole 上
  const monitorLoop = preflight(SHARED_IDS, { monitor: 'bh16' })
  assert.equal(monitorLoop.category, 'device_missing')
  assert.ok(monitorLoop.message.includes('回环'))
  const micLoop = preflight(SHARED_IDS, { mic: 'bh2' })
  assert.equal(micLoop.category, 'device_missing')
  assert.ok(micLoop.message.includes('回环'))

  // kind 不符：该 id 只存在于另一侧（hp-1 无输入条目、mic-1 无输出条目）
  const captureIsOutput = preflight(SHARED_IDS, { capture: 'hp-1' })
  assert.equal(captureIsOutput.category, 'device_missing')
  assert.ok(captureIsOutput.message.includes('输入端点'))
  const virtualMicIsInput = preflight(SHARED_IDS, { virtualMic: 'mic-1' })
  assert.equal(virtualMicIsInput.category, 'device_missing')
  assert.ok(virtualMicIsInput.message.includes('输出端点'))
  const monitorIsInput = preflight(SHARED_IDS, { monitor: 'mic-1' })
  assert.equal(monitorIsInput.category, 'device_missing')
  assert.ok(monitorIsInput.message.includes('类型不符'))
  const micIsOutput = preflight(SHARED_IDS, { mic: 'hp-1' })
  assert.equal(micIsOutput.category, 'device_missing')
  assert.ok(micIsOutput.message.includes('类型不符'))
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

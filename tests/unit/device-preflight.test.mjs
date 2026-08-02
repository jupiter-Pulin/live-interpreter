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

test('AC-029 同一 deviceId 兼作 input/output（Chrome 实机形态）：覆盖按角色 kind 取端点', () => {
  // 实机踩坑：同一块声卡的 input/output 两条记录共用同一个 deviceId，
  // 按 id 建平面索引会让后枚举的条目覆盖前者，导致 capture 覆盖被误判为输出设备。
  const SHARED_ID = [
    { deviceId: 'bh2', kind: 'audioinput', label: 'BlackHole 2ch (Virtual)', groupId: 'g-bh2' },
    { deviceId: 'bh2', kind: 'audiooutput', label: 'BlackHole 2ch (Virtual)', groupId: 'g-bh2' },
    { deviceId: 'bh16', kind: 'audioinput', label: 'BlackHole 16ch (Virtual)', groupId: 'g-bh16' },
    { deviceId: 'bh16', kind: 'audiooutput', label: 'BlackHole 16ch (Virtual)', groupId: 'g-bh16' },
    { deviceId: 'hp', kind: 'audiooutput', label: 'EDIFIER Fit900NB', groupId: 'g-hp' },
    { deviceId: 'mic', kind: 'audioinput', label: 'EDIFIER Fit900NB', groupId: 'g-mic' },
  ]
  const a = preflight(SHARED_ID, { capture: 'bh2' })
  assert.equal(a.category, 'ok', `capture 覆盖应取 audioinput 端点：${a.message ?? ''}`)
  assert.equal(a.roles.capture, 'bh2')
  assert.equal(a.roles.virtualMic, 'bh16')

  const b = preflight(SHARED_ID, { virtualMic: 'bh16' })
  assert.equal(b.category, 'ok', `virtualMic 覆盖应取 audiooutput 端点：${b.message ?? ''}`)

  // 覆盖指向的 id 只有错误方向的端点时，仍应报方向错误
  const onlyOut = SHARED_ID.filter((d) => !(d.deviceId === 'bh16' && d.kind === 'audiooutput'))
  const c = preflight(onlyOut, { virtualMic: 'bh16' })
  assert.equal(c.category, 'device_missing')
  assert.ok(c.message.includes('输出端点'))
})

test('AC-030 聚合设备回环防线：多输出设备不得用作 monitor/mic，默认分配自动跳过', () => {
  // 实机踩坑：monitor 被默认分配到「多输出设备」（内含 BlackHole 2ch），
  // 译文灌回 capture 形成自听回环，模型无限重复同一句译文。
  const WITH_AGGREGATE = [
    { deviceId: 'agg', kind: 'audiooutput', label: '多输出设备', groupId: 'g-agg' },
    { deviceId: 'bh2-in', kind: 'audioinput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
    { deviceId: 'bh2-out', kind: 'audiooutput', label: 'BlackHole 2ch', groupId: 'g-bh2' },
    { deviceId: 'bh16-in', kind: 'audioinput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
    { deviceId: 'bh16-out', kind: 'audiooutput', label: 'BlackHole 16ch', groupId: 'g-bh16' },
    { deviceId: 'zz-hp', kind: 'audiooutput', label: 'EDIFIER Fit900NB', groupId: 'g-hp' },
    { deviceId: 'zz-mic', kind: 'audioinput', label: 'EDIFIER Fit900NB', groupId: 'g-mic' },
  ]
  // 默认分配：'agg' 字典序在 'zz-hp' 之前，但必须被跳过
  const a = preflight(WITH_AGGREGATE, {})
  assert.equal(a.category, 'ok', a.message ?? '')
  assert.equal(a.roles.monitor, 'zz-hp', '默认分配必须跳过聚合设备')

  // 显式覆盖为聚合设备也要拒绝，且文案与 BlackHole 回环不同
  const b = preflight(WITH_AGGREGATE, { monitor: 'agg' })
  assert.equal(b.category, 'device_missing')
  assert.ok(b.message.includes('聚合'))
  const c = preflight(WITH_AGGREGATE, { monitor: 'bh16-out' })
  assert.ok(c.message.includes('回环'))
  assert.notEqual(b.message, c.message)

  // 英文命名的聚合设备同样命中
  const en = WITH_AGGREGATE.map((d) => (d.deviceId === 'agg' ? { ...d, label: 'Multi-Output Device' } : d))
  const e = preflight(en, {})
  assert.equal(e.roles.monitor, 'zz-hp')
})

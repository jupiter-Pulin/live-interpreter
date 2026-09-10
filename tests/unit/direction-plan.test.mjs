import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  buildDirections,
  diffPlan,
  DEVICE_ROLES,
} from '../../src/shared/direction-plan.mjs'
import { DIRECTIONS } from '../../src/shared/directions.mjs'

test('AC-107 默认计划即方向表：深相等但不共享引用', () => {
  const plan = buildDirections(DEFAULT_SETTINGS)
  assert.deepEqual(plan, DIRECTIONS)
  assert.notEqual(plan, DIRECTIONS, '返回值不得与 DIRECTIONS 共享引用')
  assert.notEqual(plan.downlink, DIRECTIONS.downlink)
  assert.deepEqual(DIRECTIONS.downlink, {
    id: 'downlink',
    source: 'auto',
    target: 'zh',
    inputRole: 'capture',
    outputRole: 'monitor',
    mode: 'translate',
  })
  assert.equal(DIRECTIONS.uplink.target, 'en')
  assert.equal(DIRECTIONS.uplink.source, 'auto')
  assert.equal(DIRECTIONS.uplink.inputRole, 'mic')
  assert.equal(DIRECTIONS.uplink.outputRole, 'virtualMic')
  assert.equal(DIRECTIONS.uplink.mode, 'translate')
  // 无参调用等价于默认设置
  assert.deepEqual(buildDirections(), DIRECTIONS)
})

test('AC-107 两个目标语言决定两个方向的 target，输入语言一律 auto', () => {
  const plan = buildDirections({ hear: 'ja', partnerHears: 'ko' })
  assert.equal(plan.downlink.target, 'ja')
  assert.equal(plan.uplink.target, 'ko')
  for (const id of ['downlink', 'uplink']) {
    assert.equal(plan[id].mode, 'translate')
    assert.equal(plan[id].source, 'auto')
  }
  // 设备角色与语言选择无关
  assert.equal(plan.downlink.outputRole, 'monitor')
  assert.equal(plan.uplink.outputRole, 'virtualMic')
})

test('AC-108 选「原声」的方向 target 为 null、mode 为 passthrough', () => {
  const down = buildDirections({ hear: 'original', partnerHears: 'en' }).downlink
  assert.equal(down.target, null)
  assert.equal(down.mode, 'passthrough')
  const up = buildDirections({ hear: 'zh', partnerHears: 'original' }).uplink
  assert.equal(up.target, null)
  assert.equal(up.mode, 'passthrough')
  // 另一方向不受影响
  assert.equal(buildDirections({ hear: 'original', partnerHears: 'en' }).uplink.mode, 'translate')
})

test('AC-108 normalizeSettings：丢弃未知键、非法值回落默认、不抛出', () => {
  assert.deepEqual(
    normalizeSettings({ speak: 'zh', autoConnect: true, hear: 'xx', partnerHears: 7, floorLevel: 0.3 }),
    DEFAULT_SETTINGS
  )
  assert.equal(normalizeSettings({ hear: 'original' }).hear, 'original')
  assert.equal(normalizeSettings({ partnerHears: 'ja' }).partnerHears, 'ja')
  assert.equal(normalizeSettings({ floorLevel: 0 }).floorLevel, 0)
  assert.equal(normalizeSettings({ floorLevel: 0.5 }).floorLevel, 0.5)
  for (const raw of [undefined, null, 'nope', 42, []]) {
    assert.doesNotThrow(() => normalizeSettings(raw))
    assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS)
  }
  // deviceOverrides 只留四个角色键且值为非空字符串
  const overrides = normalizeSettings({
    deviceOverrides: { capture: 'a', monitor: '', mic: 7, virtualMic: 'b', bogus: 'c' },
  }).deviceOverrides
  assert.deepEqual(overrides, { capture: 'a', virtualMic: 'b' })
  assert.equal(normalizeSettings({ speak: 'en' }).speak, undefined, '旧的 speak 键必须被丢弃')
  assert.equal(normalizeSettings({ autoConnect: true }).autoConnect, undefined)
})

test('AC-108/AC-109 diffPlan：只列出 target 或 mode 变化的方向', () => {
  const a = buildDirections({ hear: 'zh', partnerHears: 'en' })
  assert.deepEqual(diffPlan(a, buildDirections({ hear: 'zh', partnerHears: 'en' })), [])
  assert.deepEqual(diffPlan(a, buildDirections({ hear: 'ja', partnerHears: 'en' })), ['downlink'])
  assert.deepEqual(diffPlan(a, buildDirections({ hear: 'zh', partnerHears: 'original' })), ['uplink'])
  assert.deepEqual(diffPlan(a, buildDirections({ hear: 'ja', partnerHears: 'ko' })), ['downlink', 'uplink'])
  assert.deepEqual(diffPlan(null, a), ['downlink', 'uplink'], '没有上一份计划时两方向都要建立')
})

test('AC-129 设备角色表：四个角色、端点类型明确、与预检角色一致', () => {
  assert.deepEqual(
    DEVICE_ROLES.map((r) => r.role),
    ['capture', 'monitor', 'mic', 'virtualMic']
  )
  for (const entry of DEVICE_ROLES) {
    assert.ok(entry.kind === 'audioinput' || entry.kind === 'audiooutput')
    assert.ok(entry.title.length > 0 && entry.hint.length > 0)
  }
  assert.equal(DEVICE_ROLES.find((r) => r.role === 'capture').kind, 'audioinput')
  assert.equal(DEVICE_ROLES.find((r) => r.role === 'virtualMic').kind, 'audiooutput')
})

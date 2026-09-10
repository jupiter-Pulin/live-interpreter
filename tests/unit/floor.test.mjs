import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLOOR_LEVELS,
  FLOOR_ATTACK_MS,
  FLOOR_RELEASE_MS,
  FLOOR_RECOVER_MS,
  FLOOR_LEVEL_LABELS,
  floorTarget,
  isTranslating,
} from '../../src/shared/floor.mjs'

test('AC-137 floorTarget：holdFull 优先，其次译文播放中压到 level，否则 1.0', () => {
  for (const level of FLOOR_LEVELS) {
    assert.equal(floorTarget({ translating: true, holdFull: true, level }), 1, 'holdFull 时任何情况都不压低')
    assert.equal(floorTarget({ translating: false, holdFull: true, level }), 1)
    assert.equal(floorTarget({ translating: true, holdFull: false, level }), level)
    assert.equal(floorTarget({ translating: false, holdFull: false, level }), 1)
  }
  // 档位：关闭 / 低 / 中，默认 0.25
  assert.deepEqual(FLOOR_LEVELS, [0, 0.25, 0.5])
  assert.equal(floorTarget({ translating: true, holdFull: false, level: 0 }), 0, 'floorLevel=0 时译文播放期间原声为 0')
  // 非法档位回落默认值而不是产生静音或爆音
  assert.equal(floorTarget({ translating: true, holdFull: false, level: 0.3 }), 0.25)
  assert.equal(floorTarget({ translating: true, holdFull: false, level: undefined }), 0.25)
})

test('AC-137 isTranslating：当且仅当 now < playhead + releaseMs/1000', () => {
  assert.equal(isTranslating({ now: 10, playhead: 10.5, releaseMs: 700 }), true)
  assert.equal(isTranslating({ now: 11.199, playhead: 10.5, releaseMs: 700 }), true)
  assert.equal(isTranslating({ now: 11.2, playhead: 10.5, releaseMs: 700 }), false, '恰好 0.7s 后即视为停顿')
  assert.equal(isTranslating({ now: 12, playhead: 10.5, releaseMs: 700 }), false)
  // 队列从未排过音频（playhead=0）时不算在翻译
  assert.equal(isTranslating({ now: 5, playhead: 0, releaseMs: 700 }), false)
  // 默认 releaseMs 即 FLOOR_RELEASE_MS
  assert.equal(isTranslating({ now: 10.6, playhead: 10 }), true)
  assert.equal(isTranslating({ now: 10.8, playhead: 10 }), false)
})

test('AC-137 时间常数与选项页档位文案', () => {
  assert.equal(FLOOR_ATTACK_MS, 50)
  assert.equal(FLOOR_RELEASE_MS, 700)
  assert.equal(FLOOR_RECOVER_MS, 200)
  assert.deepEqual(
    FLOOR_LEVEL_LABELS.map((l) => l.level),
    FLOOR_LEVELS
  )
  for (const entry of FLOOR_LEVEL_LABELS) assert.ok(entry.label.length > 0)
})

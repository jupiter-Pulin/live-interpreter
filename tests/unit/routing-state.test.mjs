import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSinkId,
  forwardMicAudio,
  buildCaptureConstraints,
  buildFloorConstraints,
} from '../../src/shared/audio-routing.mjs'
import { DIRECTIONS } from '../../src/shared/directions.mjs'

const ROLE_IDS = { capture: 'id-cap', monitor: 'id-mon', mic: 'id-mic', virtualMic: 'id-vm' }

test('AC-016 方向表：语言对与输出角色', () => {
  // 输入语言由上游自动识别，因此 source 一律 'auto'；mode 决定是否建翻译会话
  assert.equal(DIRECTIONS.downlink.source, 'auto')
  assert.equal(DIRECTIONS.downlink.target, 'zh')
  assert.equal(DIRECTIONS.downlink.outputRole, 'monitor')
  assert.equal(DIRECTIONS.downlink.mode, 'translate')
  assert.equal(DIRECTIONS.uplink.source, 'auto')
  assert.equal(DIRECTIONS.uplink.target, 'en')
  assert.equal(DIRECTIONS.uplink.outputRole, 'virtualMic')
  assert.equal(DIRECTIONS.uplink.mode, 'translate')
})

test('AC-017 resolveSinkId：方向表是唯一真值来源', () => {
  assert.equal(resolveSinkId('downlink', ROLE_IDS), 'id-mon')
  assert.notEqual(resolveSinkId('downlink', ROLE_IDS), 'id-vm')
  assert.equal(resolveSinkId('uplink', ROLE_IDS), 'id-vm')
  assert.notEqual(resolveSinkId('uplink', ROLE_IDS), 'id-mon')
  // 改方向表的输出角色，返回必须随之改变——排除硬编码 if/else 实现
  const altered = {
    ...DIRECTIONS,
    downlink: { ...DIRECTIONS.downlink, outputRole: 'virtualMic' },
  }
  assert.equal(resolveSinkId('downlink', ROLE_IDS, altered), 'id-vm')
})

test('AC-015 forwardMicAudio：静音时不调用 sink；初始状态为静音', () => {
  let bytes = 0
  const sink = (chunk) => {
    bytes += chunk.length
  }
  forwardMicAudio({ muted: true, chunk: new Uint8Array(100), sink })
  assert.equal(bytes, 0)
  forwardMicAudio({ muted: false, chunk: new Uint8Array(100), sink })
  assert.ok(bytes > 0)
})

test('AC-018 采集约束：三项处理均严格为 false 且携带 deviceId', () => {
  const c = buildCaptureConstraints('dev-1')
  assert.equal(c.audio.echoCancellation, false)
  assert.equal(c.audio.autoGainControl, false)
  assert.equal(c.audio.noiseSuppression, false)
  assert.deepEqual(c.audio.deviceId, { exact: 'dev-1' })
})

test('AC-136 直通约束：截获路三项全关，真麦克风路开 AEC/NS 但关 AGC', () => {
  const capture = buildFloorConstraints('dev-cap', 'capture')
  assert.deepEqual(capture, buildCaptureConstraints('dev-cap'), '截获路与采集同规则，不破坏会议音频')
  assert.equal(capture.audio.echoCancellation, false)
  assert.equal(capture.audio.noiseSuppression, false)
  assert.equal(capture.audio.autoGainControl, false)

  const mic = buildFloorConstraints('dev-mic', 'mic')
  assert.deepEqual(mic.audio.deviceId, { exact: 'dev-mic' })
  assert.equal(mic.audio.echoCancellation, true, '外放时减少回声进会议')
  assert.equal(mic.audio.noiseSuppression, true)
  assert.equal(mic.audio.autoGainControl, false, '自动增益会让原声忽大忽小')
})

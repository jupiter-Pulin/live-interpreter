import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSinkId, forwardMicAudio, buildCaptureConstraints } from '../../src/shared/audio-routing.mjs'
import { DIRECTIONS } from '../../src/shared/directions.mjs'
import { createInitialState, start, stop, toggleMute } from '../../src/shared/session-state.mjs'

const ROLE_IDS = { capture: 'id-cap', monitor: 'id-mon', mic: 'id-mic', virtualMic: 'id-vm' }

test('AC-016 方向表：语言对与输出角色', () => {
  assert.equal(DIRECTIONS.downlink.source, 'en')
  assert.equal(DIRECTIONS.downlink.target, 'zh')
  assert.equal(DIRECTIONS.downlink.outputRole, 'monitor')
  assert.equal(DIRECTIONS.uplink.source, 'zh')
  assert.equal(DIRECTIONS.uplink.target, 'en')
  assert.equal(DIRECTIONS.uplink.outputRole, 'virtualMic')
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
  assert.equal(createInitialState().uplink.muted, true)
})

test('AC-018 采集约束：三项处理均严格为 false 且携带 deviceId', () => {
  const c = buildCaptureConstraints('dev-1')
  assert.equal(c.audio.echoCancellation, false)
  assert.equal(c.audio.autoGainControl, false)
  assert.equal(c.audio.noiseSuppression, false)
  assert.deepEqual(c.audio.deviceId, { exact: 'dev-1' })
})

test('AC-016 状态机：方向独立、入参不可变', () => {
  const s0 = createInitialState()
  const frozen = JSON.stringify(s0)
  const s1 = start(s0, 'downlink')
  const s2 = start(s1, 'uplink')
  const s3 = stop(s2, 'downlink')
  assert.equal(s3.uplink.status, 'running')
  assert.equal(s3.downlink.status, 'stopped')
  assert.equal(JSON.stringify(s0), frozen)
  assert.equal(JSON.stringify(s2), JSON.stringify(start(start(createInitialState(), 'downlink'), 'uplink')))
  const s4 = toggleMute(s3)
  assert.equal(s4.uplink.muted, false)
  assert.equal(s4.uplink.status, s3.uplink.status)
  assert.equal(s3.uplink.muted, true)
})

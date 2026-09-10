import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMeetMuteState, resolveMeetingMuted } from '../../src/shared/meeting-mute.mjs'

test('AC-130 parseMeetMuteState：按 mic/mic_off 图标连字定位麦克风按钮', () => {
  assert.equal(
    parseMeetMuteState({
      buttons: [
        { dataIsMuted: 'true', text: 'mic_off' },
        { dataIsMuted: 'false', text: 'videocam' },
      ],
    }),
    true
  )
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: 'false', text: 'mic' }] }), false)
  // 摄像头按钮也带 data-is-muted，不得被当成麦克风
  assert.equal(
    parseMeetMuteState({
      buttons: [
        { dataIsMuted: 'true', text: 'videocam_off' },
        { dataIsMuted: 'false', text: 'mic' },
      ],
    }),
    false
  )
})

test('AC-130 找不到麦克风按钮 / 属性不可读 → null（未知，不暂停）', () => {
  assert.equal(parseMeetMuteState({ buttons: [] }), null)
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: 'true', text: 'videocam' }] }), null)
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: null, text: 'mic' }] }), null)
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: 'maybe', text: 'mic' }] }), null)
  assert.equal(parseMeetMuteState({}), null)
  assert.equal(parseMeetMuteState(), null)
  // microphone 这类完整单词不是图标连字，不应靠 text 命中
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: 'true', text: 'microphone-wrapper' }] }), null)
})

test('AC-130 aria-label 兜底：Meet 改版丢了图标连字时仍能判定', () => {
  assert.equal(
    parseMeetMuteState({ buttons: [{ dataIsMuted: 'true', text: '', ariaLabel: 'Turn on microphone' }] }),
    true
  )
  assert.equal(parseMeetMuteState({ buttons: [{ dataIsMuted: 'false', text: '', ariaLabel: '关闭麦克风' }] }), false)
})

test('AC-130 resolveMeetingMuted：多个会议标签取最近上报，移除后回落', () => {
  assert.equal(resolveMeetingMuted([]), null)
  assert.equal(resolveMeetingMuted(), null)
  const reports = [
    { tabId: 1, muted: false, at: 1 },
    { tabId: 2, muted: true, at: 2 },
  ]
  assert.equal(resolveMeetingMuted(reports), true)
  assert.equal(
    resolveMeetingMuted(reports.filter((r) => r.tabId !== 2)),
    false,
    '关闭最近上报的标签后应回落到另一个标签的状态'
  )
  // 最近一次上报为未知即未知，不拿旧值顶替
  assert.equal(resolveMeetingMuted([{ tabId: 1, muted: true, at: 1 }, { tabId: 1, muted: null, at: 2 }]), null)
})

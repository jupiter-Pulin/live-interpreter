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

test('AC-130 图标连字整表优先于 aria 兜底：参会者磁贴不得抢答真麦克风按钮', () => {
  // 参会者行/磁贴也带 data-is-muted，aria-label 里还含 microphone；逐按钮混合匹配时
  // 它排在真麦克风按钮之前就会抢答，远端有人静音即静默暂停我们的上行
  assert.equal(
    parseMeetMuteState({
      buttons: [
        { dataIsMuted: 'true', text: '', ariaLabel: 'Zhang San microphone' },
        { dataIsMuted: 'false', text: 'mic' },
      ],
    }),
    false
  )
  // 其它语言的参会者标签同样不得抢答
  for (const aria of ['张三 麦克风', '参加者のマイク', '참가자 마이크']) {
    assert.equal(
      parseMeetMuteState({
        buttons: [
          { dataIsMuted: 'true', text: '', ariaLabel: aria },
          { dataIsMuted: 'false', text: 'mic_off' },
        ],
      }),
      false,
      `aria「${aria}」不得盖过图标连字按钮`
    )
  }
  // 图标连字一个都不命中时才轮到 aria 兜底
  assert.equal(
    parseMeetMuteState({
      buttons: [
        { dataIsMuted: 'false', text: 'videocam' },
        { dataIsMuted: 'true', text: '', ariaLabel: 'Turn on microphone' },
      ],
    }),
    true
  )
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

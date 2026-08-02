import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDirectionSubtitles, HISTORY_LIMIT } from '../../src/shared/direction-subtitles.mjs'

test('AC-003 每方向一份独立字幕状态：写入按方向寻址，互不串扰', () => {
  const s = createDirectionSubtitles()
  assert.deepEqual(s.directionIds, ['downlink', 'uplink'])
  assert.notEqual(s.for('downlink'), s.for('uplink'), '两方向必须是不同实例')

  s.for('uplink').appendDelta('我说的中文')
  assert.equal(s.getCurrentLine('uplink'), '我说的中文')
  assert.equal(s.getCurrentLine('downlink'), '', '上行增量不得出现在下行')

  s.for('downlink').appendDelta('对方说的英语')
  assert.equal(s.getCurrentLine('downlink'), '对方说的英语')
  assert.equal(s.getCurrentLine('uplink'), '我说的中文', '下行增量不得污染上行当前句')

  s.for('uplink').commit()
  assert.deepEqual(s.getRecentHistory('uplink'), ['我说的中文'])
  assert.deepEqual(s.getRecentHistory('downlink'), [], '上行固化不得写入下行历史')
  assert.equal(s.getCurrentLine('downlink'), '对方说的英语')

  assert.throws(() => s.for('sideways'), /未知方向/)
})

test('AC-004 单方向运行：另一方向保持为空，且不受对方后续写入影响', () => {
  const s = createDirectionSubtitles()
  for (const text of ['第一句', '第二句']) {
    s.for('downlink').appendDelta(text)
    s.for('downlink').commit()
  }
  assert.deepEqual(s.getRecentHistory('downlink'), ['第一句', '第二句'])
  assert.deepEqual(s.getRecentHistory('uplink'), [])
  assert.equal(s.getCurrentLine('uplink'), '')

  // 上行随后启动并固化一句，下行已显示的内容不得被清空或改变
  s.for('uplink').appendDelta('上行第一句')
  s.for('uplink').commit()
  assert.deepEqual(s.getRecentHistory('downlink'), ['第一句', '第二句'])
  assert.deepEqual(s.getRecentHistory('uplink'), ['上行第一句'])
})

test('AC-005 两方向历史上限一致：各自只保留最近 8 条', () => {
  assert.equal(HISTORY_LIMIT, 8)
  const s = createDirectionSubtitles()
  for (const directionId of s.directionIds) {
    for (let i = 1; i <= 10; i++) {
      s.for(directionId).appendDelta(`${directionId}-${i}`)
      s.for(directionId).commit()
    }
    const history = s.getRecentHistory(directionId)
    assert.equal(history.length, 8)
    assert.deepEqual(history, [3, 4, 5, 6, 7, 8, 9, 10].map((i) => `${directionId}-${i}`))
  }
})

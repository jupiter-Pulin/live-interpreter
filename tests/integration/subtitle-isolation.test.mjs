import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockRealtime } from '../../src/server/mock-realtime.mjs'
import { createSession } from '../../src/shared/session-protocol.mjs'
import { createDirectionSubtitles } from '../../src/shared/direction-subtitles.mjs'

function once(session, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${eventName} 超时`)), timeoutMs)
    session.on(eventName, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

// 与 src/web/session.js 的字幕接线一致：每个方向的会话只拿到该方向的字幕缓冲
function wire(session, subtitles, directionId) {
  const buffer = subtitles.for(directionId)
  session.on('subtitle-delta', ({ text }) => buffer.appendDelta(text))
  session.on('completed', () => buffer.commit())
}

test('AC-002/AC-006 mock 双向同时运行：两个方向的字幕零交叉', async () => {
  const mock = await startMockRealtime({ port: 0 })
  const subtitles = createDirectionSubtitles()
  const sessions = {}
  for (const directionId of ['downlink', 'uplink']) {
    sessions[directionId] = createSession({
      WebSocketCtor: WebSocket,
      url: mock.url,
      audioSink: () => {},
      directionId,
    })
    wire(sessions[directionId], subtitles, directionId)
  }
  await Promise.all([once(sessions.downlink, 'open'), once(sessions.uplink, 'open')])

  // 只有上行说话：字幕必须只落在上行，下行字幕区保持为空
  const uplinkDone = once(sessions.uplink, 'completed')
  sessions.uplink.sendAudio(new Uint8Array(4800))
  await uplinkDone
  assert.equal(subtitles.getRecentHistory('uplink').length, 1)
  assert.ok(subtitles.getRecentHistory('uplink')[0].length > 0)
  assert.equal(subtitles.getCurrentLine('uplink'), '')
  assert.deepEqual(subtitles.getRecentHistory('downlink'), [], '上行字幕不得出现在下行')
  assert.equal(subtitles.getCurrentLine('downlink'), '', '上行字幕不得出现在下行')

  const uplinkHistoryBefore = subtitles.getRecentHistory('uplink')

  // 下行随后也开口：各自累加，互不覆盖
  const downlinkDone = once(sessions.downlink, 'completed')
  sessions.downlink.sendAudio(new Uint8Array(4800))
  await downlinkDone
  assert.equal(subtitles.getRecentHistory('downlink').length, 1)
  assert.ok(subtitles.getRecentHistory('downlink')[0].length > 0)
  assert.deepEqual(
    subtitles.getRecentHistory('uplink'),
    uplinkHistoryBefore,
    '下行字幕不得改动上行已显示的内容'
  )

  // 停止一个方向不影响另一个方向已显示的字幕
  sessions.downlink.close()
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(subtitles.getRecentHistory('uplink'), uplinkHistoryBefore)

  sessions.uplink.close()
  await mock.stop()
})

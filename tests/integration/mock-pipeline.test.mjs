import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMockRealtime } from '../../src/server/mock-realtime.mjs'
import { createSession } from '../../src/shared/session-protocol.mjs'
import { createServer } from '../../src/server/index.mjs'
import { selectSessionEndpoint } from '../../src/shared/session-endpoint.mjs'

// 记录型包装器：底层真正建连，同时记录每次被请求的 URL
function makeRecordingWS() {
  const urls = []
  class RecordingWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols)
      urls.push(String(url))
    }
  }
  return { RecordingWS, urls }
}

function once(session, eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${eventName} 超时`)), timeoutMs)
    session.on(eventName, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

test('AC-009 mock 全链路：字幕 + 音频帧 + 无外呼 + config 衔接守卫', async () => {
  const mock = await startMockRealtime({ port: 0 })
  const { RecordingWS, urls } = makeRecordingWS()
  const sinkBytes = []
  const session = createSession({
    WebSocketCtor: RecordingWS,
    url: mock.url,
    audioSink: (bytes) => sinkBytes.push(bytes.length),
    directionId: 'downlink',
  })
  const opened = once(session, 'open')
  const subtitle = once(session, 'subtitle-delta')
  const frame = once(session, 'audio-frame')

  await opened
  assert.equal(session.getState(), 'running')
  session.sendAudio(new Uint8Array(4800))
  const sub = await subtitle
  assert.ok(sub.text.length > 0)
  const fr = await frame
  assert.ok(fr.bytes instanceof Uint8Array && fr.bytes.length > 0)
  assert.ok(sinkBytes.reduce((a, b) => a + b, 0) > 0, '假音频汇应收到字节')
  assert.ok(urls.every((u) => u.startsWith('ws://127.0.0.1')))
  assert.ok(!urls.some((u) => u.includes('api.openai.com')))
  session.close()

  // 服务端衔接守卫：GET /api/config 的真实响应体喂给 selectSessionEndpoint
  const server = createServer({
    backend: 'mock',
    mockWsUrl: mock.url,
    apiKey: undefined,
    exchangeToken: () => {
      throw new Error('mock 后端下不得调用 exchangeToken')
    },
  })
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  const res = await fetch(`http://127.0.0.1:${port}/api/config`)
  assert.ok(res.ok)
  const body = await res.json()
  assert.deepEqual(body, { backend: 'mock', mockWsUrl: mock.url })
  const endpoint = selectSessionEndpoint(body)
  assert.equal(endpoint.kind, 'mock-ws')
  assert.equal(endpoint.url, mock.url)
  assert.ok(!JSON.stringify(endpoint).includes('/api/session-token'))
  await new Promise((r) => server.close(r))
  await mock.stop()
})

test('AC-001 audioSink 抛出异常不中断消息处理', async () => {
  const mock = await startMockRealtime({ port: 0 })
  let errorCount = 0
  let lastError = null
  const session = createSession({
    WebSocketCtor: WebSocket,
    url: mock.url,
    audioSink: () => {
      throw new Error('播放失败（注入故障）')
    },
    directionId: 'downlink',
  })
  session.on('error', (payload) => {
    errorCount++
    lastError = payload
  })
  await once(session, 'open')
  session.sendAudio(new Uint8Array(4800))
  const sub1 = await once(session, 'subtitle-delta')
  assert.ok(sub1.text.length > 0)
  // 给协议层足够时间处理该句剩余消息（audio delta + done）
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(errorCount, 1, 'audioSink 抛出应恰好触发一次 error 事件')
  assert.equal(lastError.category, 'api_error')
  assert.ok(typeof lastError.message === 'string' && lastError.message.length > 0)
  assert.equal(session.getState(), 'running', '回调异常不应导致会话掉线')

  // 等下一句节流窗口过去，确认后续 subtitle-delta 仍可达
  await new Promise((resolve) => setTimeout(resolve, 2100))
  const sub2 = once(session, 'subtitle-delta')
  session.sendAudio(new Uint8Array(4800))
  const payload2 = await sub2
  assert.ok(payload2.text.length > 0)
  assert.equal(session.getState(), 'running')

  session.close()
  await mock.stop()
})

test('AC-020(a) 对端断开：closed 事件 + network_unavailable + disconnected', async () => {
  const mock = await startMockRealtime({ port: 0 })
  const session = createSession({
    WebSocketCtor: WebSocket,
    url: mock.url,
    audioSink: () => {},
    directionId: 'downlink',
  })
  await once(session, 'open')
  const closed = once(session, 'closed')
  mock.closeActiveConnections()
  const payload = await closed
  assert.equal(payload.category, 'network_unavailable')
  assert.ok(payload.message.length > 0)
  assert.equal(session.getState(), 'disconnected')
  await mock.stop()
})

test('AC-020(b) 客户端主动 close()：不产生 closed / error 事件', async () => {
  const mock = await startMockRealtime({ port: 0 })
  const session = createSession({
    WebSocketCtor: WebSocket,
    url: mock.url,
    audioSink: () => {},
    directionId: 'downlink',
  })
  let closedCount = 0
  let errorCount = 0
  session.on('closed', () => closedCount++)
  session.on('error', () => errorCount++)
  await once(session, 'open')
  session.close()
  assert.equal(session.getState(), 'disconnected')
  // 底层连接完全关闭后再断言事件计数
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(closedCount, 0, '主动停止不得派发 closed')
  assert.equal(errorCount, 0, '主动停止不得派发 error')
  await mock.stop()
})

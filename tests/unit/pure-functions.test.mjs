import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectBackend } from '../../src/shared/backend.mjs'
import { selectSessionEndpoint } from '../../src/shared/session-endpoint.mjs'
import { createSubtitles } from '../../src/shared/subtitles.mjs'
import { createLatencyTracker } from '../../src/shared/latency.mjs'
import { CATEGORIES, USER_MESSAGES, classifyError, classifyMediaError } from '../../src/shared/errors.mjs'

test('AC-008 selectBackend：仅严格 real 走真 API', () => {
  for (const raw of [undefined, '', 'mock', 'REAL', 'Real ', 'xyz', '0']) {
    assert.equal(selectBackend(raw), 'mock', `输入 ${JSON.stringify(raw)} 应为 mock`)
  }
  assert.equal(selectBackend('real'), 'real')
})

test('AC-030 selectSessionEndpoint：mock 分支绝不产出 token 路径', () => {
  const m = selectSessionEndpoint({ backend: 'mock', mockWsUrl: 'ws://127.0.0.1:1234' })
  assert.equal(m.kind, 'mock-ws')
  assert.equal(m.url, 'ws://127.0.0.1:1234')
  assert.ok(!JSON.stringify(m).includes('/api/session-token'))
  const r = selectSessionEndpoint({ backend: 'real' })
  assert.equal(r.kind, 'token')
  assert.equal(r.path, '/api/session-token')
})

test('AC-124 selectSessionEndpoint 第二参：宿主 baseUrl 与启动令牌', () => {
  // 单参调用保持网页时代形态：url 与 path 相同且为相对路径
  const bare = selectSessionEndpoint({ backend: 'real' })
  assert.equal(bare.url, '/api/session-token')
  assert.equal(bare.url, bare.path)
  assert.equal(bare.headers, undefined, '没有启动令牌时不产出 headers')

  const full = selectSessionEndpoint({ backend: 'real' }, { baseUrl: 'http://127.0.0.1:4321', launchToken: 't' })
  assert.equal(full.url, 'http://127.0.0.1:4321/api/session-token')
  assert.equal(full.headers.Authorization, 'Bearer t')

  // mock 分支带同样第二参仍不得产出 token 路径与 headers
  const mock = selectSessionEndpoint(
    { backend: 'mock', mockWsUrl: 'ws://127.0.0.1:1234' },
    { baseUrl: 'http://127.0.0.1:4321', launchToken: 't' }
  )
  assert.equal(mock.kind, 'mock-ws')
  assert.equal(mock.url, 'ws://127.0.0.1:1234')
  assert.equal(mock.headers, undefined)
  const json = JSON.stringify(mock)
  assert.ok(!json.includes('/api/session-token'))
  assert.ok(!json.includes('headers'))
  assert.ok(!json.includes('Bearer'), 'mock 分支绝不携带启动令牌')
})

test('AC-013 字幕缓冲：拼接 → 固化 → 新行不污染历史', () => {
  const s = createSubtitles()
  assert.equal(s.getCurrentLine(), '')
  s.appendDelta('你好')
  s.appendDelta('，世界')
  assert.equal(s.getCurrentLine(), '你好，世界')
  s.commit()
  assert.deepEqual(s.getHistory(), ['你好，世界'])
  assert.equal(s.getCurrentLine(), '')
  s.appendDelta('第二句')
  assert.equal(s.getCurrentLine(), '第二句')
  assert.deepEqual(s.getHistory(), ['你好，世界'])
})

test('AC-014 延迟统计：注入时钟、首帧前为 null、同句只记首帧、方向独立', () => {
  const t = createLatencyTracker()
  const T0 = 100000
  t.markInputEnd({ directionId: 'downlink', now: T0 })
  assert.equal(t.getCurrentLatencyMs('downlink'), null)
  t.markFirstAudioFrame({ directionId: 'downlink', now: T0 + 1500 })
  assert.equal(t.getCurrentLatencyMs('downlink'), 1500)
  t.markFirstAudioFrame({ directionId: 'downlink', now: T0 + 3000 })
  assert.equal(t.getCurrentLatencyMs('downlink'), 1500)
  assert.equal(t.getCurrentLatencyMs('uplink'), null)
})

test('AC-019 错误分类：五类文案两两不同，未知形态兜底 api_error', () => {
  const messages = CATEGORIES.map((c) => USER_MESSAGES[c])
  for (const m of messages) assert.ok(typeof m === 'string' && m.length > 0)
  assert.equal(new Set(messages).size, CATEGORIES.length)
  const r = classifyError({ some: 'unknown', shape: true })
  assert.equal(r.category, 'api_error')
  assert.ok(r.message.length > 0)
  assert.doesNotThrow(() => classifyError(null))
  assert.doesNotThrow(() => classifyError(undefined))
})

test('AC-141/AC-105 classifyMediaError：媒体 DOMException 先按名字归类，别被压成 api_error', () => {
  for (const name of ['NotAllowedError', 'SecurityError']) {
    assert.equal(classifyMediaError(name), 'permission_denied')
  }
  for (const name of ['NotFoundError', 'OverconstrainedError', 'NotReadableError']) {
    assert.equal(classifyMediaError(name), 'device_missing')
  }
  // 认不出的一律 null：交回 classifyError 兜底，不冒充分类
  for (const name of ['AbortError', 'TypeError', '', undefined, null, 7, {}, 'constructor', '__proto__', 'toString']) {
    assert.equal(classifyMediaError(name), null, `${String(name)} 不该被当成媒体错误`)
  }
  // 归类结果必须是 CATEGORIES 里的合法值，且能被 classifyError 原样接住并配上中文文案
  for (const name of ['NotAllowedError', 'NotFoundError']) {
    const category = classifyMediaError(name)
    assert.ok(CATEGORIES.includes(category))
    assert.deepEqual(classifyError({ category }), { category, message: USER_MESSAGES[category] })
  }
})

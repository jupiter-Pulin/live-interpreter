import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../../src/shared/session-protocol.mjs'

// 真实后端不发送 session.output_transcript.done（实测验证），协议层需在输出
// 流停顿 idleCommitMs 后合成 completed；mock 后端的显式 done 不得重复提交。

// 脚本化假 WebSocket：测试用例手动派发 open/message/close 事件
class ScriptedWS {
  constructor() {
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    ScriptedWS.last = this
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  }
  dispatch(name, event = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn(event)
  }
  open() {
    this.readyState = 1
    this.dispatch('open')
  }
  message(obj) {
    this.dispatch('message', { data: JSON.stringify(obj) })
  }
  send(msg) {
    this.sent.push(msg)
  }
  close() {
    this.readyState = 3
  }
}

function makeSession({ idleCommitMs }) {
  const session = createSession({
    WebSocketCtor: ScriptedWS,
    url: 'ws://scripted',
    directionId: 'downlink',
    audioSink: () => {},
    idleCommitMs,
  })
  return { session, ws: ScriptedWS.last }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('无显式 done 时：输出停顿 idleCommitMs 后合成一次 completed', async () => {
  const { session, ws } = makeSession({ idleCommitMs: 40 })
  let completed = 0
  session.on('completed', () => completed++)
  ws.open()
  ws.message({ type: 'session.output_transcript.delta', delta: '大家' })
  ws.message({ type: 'session.output_audio.delta', delta: '' })
  ws.message({ type: 'session.output_transcript.delta', delta: '好' })
  assert.equal(completed, 0, '停顿前不得提前提交')
  await sleep(80)
  assert.equal(completed, 1, '停顿超过 idleCommitMs 应恰好合成一次 completed')
  await sleep(80)
  assert.equal(completed, 1, '无新输出时不得重复提交')
  session.close()
})

test('音频增量持续到达会顺延合成提交（流未停顿则句子未结束）', async () => {
  const { session, ws } = makeSession({ idleCommitMs: 60 })
  let completed = 0
  session.on('completed', () => completed++)
  ws.open()
  ws.message({ type: 'session.output_transcript.delta', delta: '译文' })
  for (let i = 0; i < 3; i++) {
    await sleep(30)
    ws.message({ type: 'session.output_audio.delta', delta: '' })
  }
  assert.equal(completed, 0, '输出流持续时不得提交')
  await sleep(120)
  assert.equal(completed, 1)
  session.close()
})

test('显式 done 到达：立即提交且取消合成，不产生第二次 completed', async () => {
  const { session, ws } = makeSession({ idleCommitMs: 40 })
  let completed = 0
  session.on('completed', () => completed++)
  ws.open()
  ws.message({ type: 'session.output_transcript.delta', delta: '模拟' })
  ws.message({ type: 'session.output_transcript.done' })
  assert.equal(completed, 1, '显式 done 应立即提交')
  await sleep(100)
  assert.equal(completed, 1, '合成定时器必须已被取消')
  session.close()
})

test('句间独立：done 提交后新句的增量重新计时、再次合成', async () => {
  const { session, ws } = makeSession({ idleCommitMs: 40 })
  let completed = 0
  session.on('completed', () => completed++)
  ws.open()
  ws.message({ type: 'session.output_transcript.delta', delta: '第一句' })
  ws.message({ type: 'session.output_transcript.done' })
  ws.message({ type: 'session.output_transcript.delta', delta: '第二句' })
  await sleep(80)
  assert.equal(completed, 2, '第二句应由合成提交')
  session.close()
})

test('close 取消未决的合成定时器，不在关闭后补发 completed', async () => {
  const { session, ws } = makeSession({ idleCommitMs: 40 })
  let completed = 0
  session.on('completed', () => completed++)
  ws.open()
  ws.message({ type: 'session.output_transcript.delta', delta: '未完句' })
  session.close()
  await sleep(100)
  assert.equal(completed, 0, '关闭后不得再派发 completed')
})

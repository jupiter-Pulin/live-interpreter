import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, createFrameDecoder, MAX_FRAME_BYTES } from '../../src/shared/native-protocol.mjs'

const FRAMES = [
  { type: 'ready', port: 51234, backend: 'mock', mockWsUrl: 'ws://127.0.0.1:51235' },
  { type: 'pong' },
  { type: 'error', category: 'config_missing', message: '缺少配置（含非 ASCII 字符以验证 UTF-8 长度）' },
]

function concat(list) {
  const total = list.reduce((sum, a) => sum + a.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const a of list) {
    out.set(a, at)
    at += a.length
  }
  return out
}

test('AC-111 encodeFrame：4 字节小端长度前缀 + UTF-8 JSON', () => {
  const frame = encodeFrame({ type: 'pong' })
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true)
  const body = new TextDecoder().decode(frame.subarray(4))
  assert.equal(length, body.length)
  assert.equal(frame.length, 4 + length)
  assert.deepEqual(JSON.parse(body), { type: 'pong' })
  assert.ok(frame instanceof Uint8Array)
  // 非 ASCII 的长度按字节算而不是按字符算
  const cn = encodeFrame({ m: '中' })
  const cnLength = new DataView(cn.buffer, cn.byteOffset, cn.byteLength).getUint32(0, true)
  assert.equal(cnLength, new TextEncoder().encode(JSON.stringify({ m: '中' })).length)
})

test('AC-111 createFrameDecoder：逐字节 / 半包 / 粘包都按序还原同一对象序列', () => {
  const stream = concat(FRAMES.map(encodeFrame))

  const splits = {
    逐字节: Array.from(stream, (b) => new Uint8Array([b])),
    半包: [stream.subarray(0, 3), stream.subarray(3, 7), stream.subarray(7, stream.length - 1), stream.subarray(stream.length - 1)],
    粘包: [stream],
  }

  for (const [name, chunks] of Object.entries(splits)) {
    const got = []
    const errors = []
    const decoder = createFrameDecoder({ onFrame: (f) => got.push(f), onError: (e) => errors.push(e) })
    for (const chunk of chunks) decoder.push(chunk)
    assert.deepEqual(got, FRAMES, `${name} 切分应还原相同对象序列`)
    assert.deepEqual(errors, [], `${name} 切分不应产生错误`)
    assert.equal(decoder.pendingBytes(), 0, `${name} 切分后不应有残留字节`)
  }
})

test('AC-111 单帧超过 maxBytes：上报一次错误并停止解析后续字节', () => {
  const got = []
  const errors = []
  const decoder = createFrameDecoder({ maxBytes: 16, onFrame: (f) => got.push(f), onError: (e) => errors.push(e) })
  decoder.push(encodeFrame({ type: 'pong' }))
  assert.deepEqual(got, [{ type: 'pong' }], '超限前的帧正常产出')
  decoder.push(concat([encodeFrame({ padding: 'x'.repeat(64) }), encodeFrame({ type: 'pong' })]))
  assert.equal(errors.length, 1)
  assert.ok(errors[0].message.length > 0)
  assert.equal(got.length, 1, '超限后不得继续解析后续字节')
  decoder.push(encodeFrame({ type: 'pong' }))
  assert.equal(got.length, 1, '已失控的解码器不得复活')
  assert.equal(errors.length, 1, '错误只上报一次')
  assert.equal(decoder.isBroken(), true)
})

test('AC-111 默认上限为 1 MiB；JSON 非法时停止解析', () => {
  assert.equal(MAX_FRAME_BYTES, 1024 * 1024)
  const errors = []
  const got = []
  const decoder = createFrameDecoder({ onFrame: (f) => got.push(f), onError: (e) => errors.push(e) })
  const bad = new Uint8Array(4 + 3)
  new DataView(bad.buffer).setUint32(0, 3, true)
  bad.set(new TextEncoder().encode('{x:'), 4)
  decoder.push(bad)
  assert.equal(errors.length, 1)
  assert.equal(got.length, 0)
  assert.equal(decoder.isBroken(), true)
})

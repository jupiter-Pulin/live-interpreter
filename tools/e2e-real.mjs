// 真实后端端到端验证：会产生少量 API 费用（约 $0.05/次），因此不进 npm test，
// 需显式运行：npm run e2e:real（要求 .env 含 OPENAI_API_KEY）。
// 链路与浏览器完全一致：本进程起服务器 → /api/session-token 换 ephemeral secret
// → 连 OpenAI realtime translations WS → 实时灌入 fixtures/sample-en.wav → 验证
// 中文字幕、译文音频与句尾提交（合成 completed）回流。
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from '../src/server/index.mjs'
import { createSession } from '../src/shared/session-protocol.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REAL_WS_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'
const RATE = 24000

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('缺少 OPENAI_API_KEY：请在 .env 中配置后用 npm run e2e:real 运行。')
  process.exit(1)
}

let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ---- 解析 WAV（支持 PCM16 与 float32），线性重采样到 24kHz 单声道 PCM16 ----
function wavToPcm16At24k(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size)
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块')

  const bytesPer = fmt.bits / 8
  const frameCount = Math.floor(data.length / bytesPer / fmt.channels)
  const readSample = (frame) => {
    const base = frame * fmt.channels * bytesPer // 多声道时取首声道
    if (fmt.format === 3 && fmt.bits === 32) return Math.max(-1, Math.min(1, data.readFloatLE(base)))
    if (fmt.format === 1 && fmt.bits === 16) return data.readInt16LE(base) / 0x8000
    throw new Error(`不支持的 WAV 编码：format=${fmt.format} bits=${fmt.bits}`)
  }
  const outFrames = Math.floor((frameCount * RATE) / fmt.rate)
  const out = Buffer.alloc(outFrames * 2)
  for (let i = 0; i < outFrames; i++) {
    const pos = (i * fmt.rate) / RATE
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, frameCount - 1)
    const s = readSample(i0) + (readSample(i1) - readSample(i0)) * (pos - i0)
    out.writeInt16LE(Math.round(s * 0x7fff), i * 2)
  }
  return out
}

const pcm = wavToPcm16At24k(await readFile(path.join(ROOT, 'fixtures', 'sample-en.wav')))
check('fixture 重采样为 PCM16@24kHz', pcm.length > 0, `${(pcm.length / 2 / RATE).toFixed(1)}s`)

// ---- 本进程起 real 后端服务器，走与浏览器相同的凭证交换 ----
const server = createServer({ backend: 'real', apiKey })
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`
const tokRes = await fetch(base + '/api/session-token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ targetLanguage: 'zh' }),
})
const tok = await tokRes.json()
check('/api/session-token 换取 ephemeral secret', tokRes.ok && typeof tok.clientSecret === 'string')
if (!tokRes.ok) {
  console.error('凭证交换失败：', tok)
  process.exit(1)
}

// ---- 真实 WS 会话 ----
const events = { subtitles: [], frames: 0, audioBytes: 0, completed: 0, errors: [] }
const session = createSession({
  WebSocketCtor: WebSocket,
  url: REAL_WS_URL,
  protocols: ['realtime', `openai-insecure-api-key.${tok.clientSecret}`],
  directionId: 'downlink',
  audioSink: (bytes) => { events.audioBytes += bytes.length },
})
session.on('subtitle-delta', ({ text }) => events.subtitles.push(text))
session.on('audio-frame', () => { events.frames += 1 })
session.on('completed', () => { events.completed += 1 })
session.on('error', (e) => events.errors.push(e))
session.on('closed', (e) => events.errors.push(e))

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('WS open 超时（10s）')), 10000)
  session.on('open', () => { clearTimeout(t); resolve() })
})
check('已连接 OpenAI realtime translations WS', session.getState() === 'running')

// ---- 按浏览器节奏（~170ms/块）实时灌音频，尾部补 1s 静音助断句 ----
const CHUNK = Math.floor(RATE * 0.17) * 2
for (let i = 0; i < pcm.length; i += CHUNK) {
  session.sendAudio(pcm.subarray(i, i + CHUNK))
  await new Promise((r) => setTimeout(r, 170))
}
const silence = new Uint8Array(CHUNK)
for (let i = 0; i < 6; i++) {
  session.sendAudio(silence)
  await new Promise((r) => setTimeout(r, 170))
}

// ---- 等输出流干涸（8s 无新事件即认为结束，总超时 60s）----
let lastActivity = Date.now()
const bump = () => { lastActivity = Date.now() }
session.on('subtitle-delta', bump)
session.on('audio-frame', bump)
const deadline = Date.now() + 60000
while (Date.now() < deadline && Date.now() - lastActivity <= 8000) {
  await new Promise((r) => setTimeout(r, 250))
}

const text = events.subtitles.join('')
check('收到中文字幕', events.subtitles.length > 0 && /[一-鿿]/.test(text), text.slice(0, 40) + (text.length > 40 ? '…' : ''))
check('收到译文音频', events.audioBytes > 0, `${events.frames} 帧 ≈ ${(events.audioBytes / 2 / RATE).toFixed(1)}s`)
check('句尾提交（合成 completed）', events.completed > 0, `completed=${events.completed}`)
check('全程无 error/closed 事件', events.errors.length === 0, events.errors.map((e) => e.message).join('; '))

session.close()
await new Promise((r) => server.close(r))
console.log(failures === 0 ? '\n真实链路 E2E：全部通过' : `\n真实链路 E2E：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

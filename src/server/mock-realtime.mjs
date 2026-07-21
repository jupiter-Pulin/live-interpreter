import { WebSocketServer } from 'ws'

// mock 翻译会话服务端：收到音频即回送字幕增量 + 一帧静音音频 + 句结束标记。
// 消息形态与 real 后端一致，供 session-protocol.mjs 归并成同一套事件。

// 400ms @ 24kHz PCM16 的 660Hz 正弦音（带淡入淡出消除爆音）。
// 用可听见的提示音而非静音，使音频路由（sinkId → BlackHole/耳机）能靠耳朵验证，零 API 成本。
function buildToneFrame({ freq = 660, ms = 400, rate = 24000, amplitude = 0.25 } = {}) {
  const frames = Math.floor((rate * ms) / 1000)
  const buf = Buffer.alloc(frames * 2)
  const fade = Math.floor(rate * 0.01) // 10ms 淡入淡出
  for (let i = 0; i < frames; i++) {
    let gain = amplitude
    if (i < fade) gain *= i / fade
    else if (i > frames - fade) gain *= (frames - i) / fade
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * gain * 0x7fff), i * 2)
  }
  return buf.toString('base64')
}

const TONE_FRAME_B64 = buildToneFrame()

export function startMockRealtime({ port }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    const conns = new Set()

    // 浏览器每 ~170ms 送一块音频；按句节流，避免字幕刷屏与提示音叠加
    const SENTENCE_INTERVAL_MS = 2000

    wss.on('connection', (ws) => {
      conns.add(ws)
      let lastSentenceAt = 0
      let sentenceNo = 0
      ws.on('close', () => conns.delete(ws))
      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (msg.type !== 'session.input_audio_buffer.append') return
        const now = Date.now()
        if (now - lastSentenceAt < SENTENCE_INTERVAL_MS) return
        lastSentenceAt = now
        sentenceNo += 1
        ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: `这是第 ${sentenceNo} 句` }))
        ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: '模拟译文。' }))
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: TONE_FRAME_B64 }))
        ws.send(JSON.stringify({ type: 'session.output_transcript.done' }))
      })
    })

    wss.on('error', reject)
    wss.on('listening', () => {
      resolve({
        url: `ws://127.0.0.1:${wss.address().port}`,
        closeActiveConnections() {
          for (const c of conns) c.close()
        },
        stop() {
          return new Promise((r) => {
            for (const c of conns) c.terminate()
            wss.close(() => r())
          })
        },
      })
    })
  })
}

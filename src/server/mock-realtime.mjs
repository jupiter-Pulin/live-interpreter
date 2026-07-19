import { WebSocketServer } from 'ws'

// mock 翻译会话服务端：收到音频即回送字幕增量 + 一帧静音音频 + 句结束标记。
// 消息形态与 real 后端一致，供 session-protocol.mjs 归并成同一套事件。

const SILENCE_FRAME_B64 = Buffer.alloc(4800).toString('base64') // 100ms @ 24kHz PCM16 静音

export function startMockRealtime({ port }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, host: '127.0.0.1' })
    const conns = new Set()

    wss.on('connection', (ws) => {
      conns.add(ws)
      ws.on('close', () => conns.delete(ws))
      ws.on('message', (data) => {
        let msg
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        if (msg.type === 'session.input_audio_buffer.append') {
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: '这是' }))
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: '模拟译文。' }))
          ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: SILENCE_FRAME_B64 }))
          ws.send(JSON.stringify({ type: 'session.output_transcript.done' }))
        }
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

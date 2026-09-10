import { createSession } from '/shared/session-protocol.mjs'
import { DIRECTIONS } from '/shared/directions.mjs'

// 浏览器会话接线：决定连 mock 还是取凭证连真 API，并把协议事件接到字幕/延迟统计。
// 自身不含协议解析与端点判定逻辑。

const REAL_WS_URL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'

export async function openTranslationSession({
  endpoint,
  directionId,
  audioSink,
  subtitles,
  latency,
  onEvent,
  directionTable = DIRECTIONS,
}) {
  let url = null
  let protocols
  if (endpoint.kind === 'mock-ws') {
    url = endpoint.url
  } else {
    // 扩展里端点是绝对地址并带启动令牌；网页时代的相对路径形态仍然兼容
    const res = await fetch(endpoint.url ?? endpoint.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(endpoint.headers ?? {}) },
      body: JSON.stringify({ targetLanguage: directionTable[directionId].target }),
    })
    const body = await res.json()
    if (!res.ok) {
      const err = new Error(body.message ?? '获取凭证失败')
      err.category = body.category ?? 'api_error'
      throw err
    }
    protocols = ['realtime', `openai-insecure-api-key.${body.clientSecret}`]
  }

  const session = createSession({
    WebSocketCtor: WebSocket,
    url: url ?? REAL_WS_URL,
    protocols,
    audioSink,
    directionId,
    directionTable,
  })

  // 延迟口径：该句首个 subtitle-delta 之前的最后一次 sendAudio → 首帧译文音频
  let lastSendTs = null
  let sawSubtitleThisSentence = false
  let sawFrameThisSentence = false

  const rawSendAudio = session.sendAudio.bind(session)
  session.sendAudio = (chunk) => {
    lastSendTs = performance.now()
    rawSendAudio(chunk)
  }

  session.on('subtitle-delta', ({ text }) => {
    if (!sawSubtitleThisSentence && lastSendTs !== null) {
      sawSubtitleThisSentence = true
      latency.markInputEnd({ directionId, now: lastSendTs })
    }
    subtitles.appendDelta(text)
    onEvent('subtitle')
  })
  session.on('audio-frame', () => {
    if (!sawFrameThisSentence) {
      sawFrameThisSentence = true
      latency.markFirstAudioFrame({ directionId, now: performance.now() })
    }
    onEvent('latency')
  })
  session.on('completed', () => {
    subtitles.commit()
    sawSubtitleThisSentence = false
    sawFrameThisSentence = false
    onEvent('subtitle')
  })
  session.on('error', (payload) => onEvent('error', payload))
  session.on('closed', (payload) => onEvent('error', payload))
  session.on('open', () => onEvent('open'))

  return session
}

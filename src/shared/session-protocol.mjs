import { DIRECTIONS } from './directions.mjs'
import { messageFor } from './errors.mjs'

// 翻译会话协议层：传输无关，WebSocket 构造器由调用方注入。
// mock 与 real 后端共用同一套消息形态（OpenAI realtime translations 事件名）。

function bytesToBase64(bytes) {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

function base64ToBytes(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function createSession({
  WebSocketCtor,
  url,
  protocols,
  audioSink,
  directionId,
  idleCommitMs = 1200,
  directionTable = DIRECTIONS,
}) {
  const handlers = new Map()
  let state = 'idle'
  let closedByClient = false
  const pendingBeforeOpen = []

  function emit(eventName, payload) {
    for (const h of handlers.get(eventName) ?? []) h(payload)
  }

  // 真实后端（gpt-realtime-translate）持续流式输出、从不发送
  // session.output_transcript.done；mock 后端每句都发。为使两种后端对上层
  // 表现一致，输出流停顿 idleCommitMs 后合成一次 completed；显式 done 到达
  // 时取消合成，绝不重复提交。
  let idleTimer = null
  let sentenceOpen = false

  function cancelIdleCommit() {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function scheduleIdleCommit() {
    cancelIdleCommit()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (sentenceOpen) {
        sentenceOpen = false
        emit('completed')
      }
    }, idleCommitMs)
  }

  const ws = protocols ? new WebSocketCtor(url, protocols) : new WebSocketCtor(url)

  ws.addEventListener('open', () => {
    state = 'running'
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: { audio: { output: { language: directionTable[directionId].target } } },
      })
    )
    // 就绪前排队的音频按原顺序补发
    for (const msg of pendingBeforeOpen) ws.send(msg)
    pendingBeforeOpen.length = 0
    emit('open')
  })

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      emit('error', { category: 'api_error', message: messageFor('api_error') })
      return
    }
    switch (msg.type) {
      case 'session.output_transcript.delta':
        sentenceOpen = true
        scheduleIdleCommit()
        emit('subtitle-delta', { text: msg.delta ?? '' })
        break
      case 'session.output_audio.delta': {
        if (sentenceOpen) scheduleIdleCommit()
        const bytes = base64ToBytes(msg.delta ?? '')
        if (audioSink) {
          try {
            audioSink(bytes)
          } catch {
            // 播放侧异常不得中断协议层消息处理，归类上报后继续
            emit('error', { category: 'api_error', message: messageFor('api_error') })
          }
        }
        emit('audio-frame', { bytes })
        break
      }
      case 'session.output_transcript.done':
        cancelIdleCommit()
        sentenceOpen = false
        emit('completed')
        break
      case 'session.input_transcript.delta':
      case 'session.output_audio.done':
      case 'session.closed':
        break
      case 'error':
        emit('error', { category: 'api_error', message: messageFor('api_error') })
        break
      default:
        break
    }
  })

  ws.addEventListener('close', () => {
    cancelIdleCommit()
    state = 'disconnected'
    // 客户端主动 close() 是正常操作，不派发 closed 事件
    if (!closedByClient) {
      emit('closed', { category: 'network_unavailable', message: messageFor('network_unavailable') })
    }
  })

  ws.addEventListener('error', () => {
    if (!closedByClient && state !== 'disconnected') {
      emit('error', { category: 'network_unavailable', message: messageFor('network_unavailable') })
    }
  })

  return {
    sendAudio(chunk) {
      const msg = JSON.stringify({ type: 'session.input_audio_buffer.append', audio: bytesToBase64(chunk) })
      if (state === 'running' && ws.readyState === 1) {
        ws.send(msg)
      } else if (state === 'idle') {
        pendingBeforeOpen.push(msg)
      }
      // disconnected 状态下静默丢弃，绝不抛出
    },
    on(eventName, handler) {
      if (!handlers.has(eventName)) handlers.set(eventName, [])
      handlers.get(eventName).push(handler)
    },
    getState() {
      return state
    },
    close() {
      closedByClient = true
      cancelIdleCommit()
      state = 'disconnected'
      try {
        ws.close()
      } catch {
        // 忽略重复关闭
      }
    },
  }
}

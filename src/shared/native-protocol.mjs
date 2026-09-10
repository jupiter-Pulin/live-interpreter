// Native Messaging 帧编解码：4 字节小端长度前缀 + UTF-8 JSON。
// 纯 Uint8Array / DataView 实现，浏览器与 Node 同一份代码（不用 Buffer）。

export const MAX_FRAME_BYTES = 1024 * 1024

export function encodeFrame(value) {
  const body = new TextEncoder().encode(JSON.stringify(value))
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, true)
  frame.set(body, 4)
  return frame
}

// 流式解码：逐字节、半包、粘包三种切分都必须按序还原同一批对象。
// 单帧超过 maxBytes 视为协议失控（上游文档规定宿主 → 扩展单帧 ≤ 1 MB），
// 上报一次 onError 后彻底停止解析，绝不继续按错位边界猜。
export function createFrameDecoder({ maxBytes = MAX_FRAME_BYTES, onFrame, onError } = {}) {
  let pending = new Uint8Array(0)
  let broken = false
  const decoder = new TextDecoder()

  function fail(message) {
    broken = true
    pending = new Uint8Array(0)
    onError?.({ category: 'api_error', message })
  }

  return {
    push(bytes) {
      if (broken) return
      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      const merged = new Uint8Array(pending.length + chunk.length)
      merged.set(pending, 0)
      merged.set(chunk, pending.length)
      pending = merged

      while (!broken && pending.length >= 4) {
        const length = new DataView(pending.buffer, pending.byteOffset, pending.byteLength).getUint32(0, true)
        if (length > maxBytes) {
          fail(`单帧长度 ${length} 字节超过上限 ${maxBytes} 字节，已停止解析。`)
          return
        }
        if (pending.length < 4 + length) return
        const body = pending.subarray(4, 4 + length)
        let parsed
        try {
          parsed = JSON.parse(decoder.decode(body))
        } catch {
          fail('收到无法解析的协议帧（JSON 非法），已停止解析。')
          return
        }
        pending = pending.slice(4 + length)
        onFrame?.(parsed)
      }
    },
    isBroken() {
      return broken
    },
    pendingBytes() {
      return pending.length
    },
  }
}

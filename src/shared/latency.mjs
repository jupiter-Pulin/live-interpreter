// 延迟统计：时钟一律由参数注入；口径 = 输入语音结束 → 该句首帧译文音频
export function createLatencyTracker() {
  const perDirection = {}
  function slot(directionId) {
    if (!perDirection[directionId]) perDirection[directionId] = { inputEnd: null, latency: null }
    return perDirection[directionId]
  }
  return {
    markInputEnd({ directionId, now }) {
      const s = slot(directionId)
      s.inputEnd = now
      s.latency = null
    },
    markFirstAudioFrame({ directionId, now }) {
      const s = slot(directionId)
      if (s.latency !== null || s.inputEnd === null) return
      s.latency = now - s.inputEnd
    },
    getCurrentLatencyMs(directionId) {
      return slot(directionId).latency
    },
  }
}

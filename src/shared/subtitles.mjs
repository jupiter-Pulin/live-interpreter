// 字幕增量缓冲：按到达顺序拼接当前行，completed 时由接线层调用 commit() 固化
export function createSubtitles() {
  let current = []
  const history = []
  return {
    appendDelta(text) {
      current.push(text)
    },
    getCurrentLine() {
      return current.join('')
    },
    commit() {
      history.push(current.join(''))
      current = []
    },
    getHistory() {
      return [...history]
    },
  }
}

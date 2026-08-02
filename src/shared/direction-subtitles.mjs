import { DIRECTIONS } from './directions.mjs'
import { createSubtitles } from './subtitles.mjs'

// 按方向隔离的字幕状态：每个方向一份独立的 createSubtitles()，写入与读取都以 directionId 寻址，
// 方向之间零共享，因此一个方向的增量/固化/停止都不会影响另一个方向。
// 历史条数上限对所有方向一致，由此处统一裁剪，接线层只负责渲染。

export const HISTORY_LIMIT = 8

export function createDirectionSubtitles() {
  const directionIds = Object.keys(DIRECTIONS)
  const perDirection = {}
  for (const id of directionIds) perDirection[id] = createSubtitles()

  function slot(directionId) {
    const s = perDirection[directionId]
    if (!s) throw new Error(`未知方向：${directionId}`)
    return s
  }

  return {
    directionIds,
    // 交给单个方向的会话使用：拿到的是该方向专属的缓冲，写不进别的方向
    for(directionId) {
      return slot(directionId)
    },
    getCurrentLine(directionId) {
      return slot(directionId).getCurrentLine()
    },
    getRecentHistory(directionId) {
      return slot(directionId).getHistory().slice(-HISTORY_LIMIT)
    },
  }
}

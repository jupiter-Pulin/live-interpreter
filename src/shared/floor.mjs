// 衬底（duck）判定：原声是底、翻译是顶。译文播放期间把直通增益压到 floorLevel，
// 队列播完并静默 FLOOR_RELEASE_MS 后回到 1.0——任何状态都不出现无声。
// 上游「同语言片段可能不出声」时，正是靠这条规则听到 100% 原声。

export const FLOOR_LEVELS = [0, 0.25, 0.5]

export const FLOOR_ATTACK_MS = 50
export const FLOOR_RELEASE_MS = 700
export const FLOOR_RECOVER_MS = 200

// holdFull 优先（上行暂停 / passthrough）：任何情况下都不压低
export function floorTarget({ translating, holdFull, level }) {
  if (holdFull) return 1
  if (!translating) return 1
  return FLOOR_LEVELS.includes(level) ? level : FLOOR_LEVELS[1]
}

// now / playhead 取 AudioContext 时间（秒），releaseMs 取毫秒
export function isTranslating({ now, playhead, releaseMs = FLOOR_RELEASE_MS }) {
  return now < playhead + releaseMs / 1000
}

// 选项页三选一的文案（默认值即 FLOOR_LEVELS[1]）
export const FLOOR_LEVEL_LABELS = [
  { level: 0, label: '关闭（翻译时只听译文）' },
  { level: 0.25, label: '低 25%（默认）' },
  { level: 0.5, label: '中 50%' },
]

export const FLOOR_NOTE = '翻译停顿时原声总会恢复，不会无声。'

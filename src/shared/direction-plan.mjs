import { ORIGINAL, isTargetChoice } from './languages.mjs'
import { FLOOR_LEVELS } from './floor.mjs'

// 方向计划：两个目标语言（你想听 / 对方听）→ 两个方向的目标与模式。
// 输入语言由上游自动识别，因此 source 一律 'auto'。
// 不得反向 import directions.mjs（directions.mjs 由本模块生成，避免成环）。

const ROLE_KEYS = ['capture', 'monitor', 'mic', 'virtualMic']

export const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  hear: 'zh',
  partnerHears: 'en',
  floorLevel: 0.25,
  deviceOverrides: {},
}

// 方向骨架：设备角色固定，语言与模式由设置决定
const SHAPE = {
  downlink: { id: 'downlink', inputRole: 'capture', outputRole: 'monitor', choiceKey: 'hear' },
  uplink: { id: 'uplink', inputRole: 'mic', outputRole: 'virtualMic', choiceKey: 'partnerHears' },
}

export function buildDirections(settings = DEFAULT_SETTINGS) {
  const plan = {}
  for (const id of Object.keys(SHAPE)) {
    const { inputRole, outputRole, choiceKey } = SHAPE[id]
    const raw = settings?.[choiceKey]
    const choice = isTargetChoice(raw) ? raw : DEFAULT_SETTINGS[choiceKey]
    const passthrough = choice === ORIGINAL
    plan[id] = {
      id,
      source: 'auto',
      target: passthrough ? null : choice,
      inputRole,
      outputRole,
      mode: passthrough ? 'passthrough' : 'translate',
    }
  }
  return plan
}

// 未知键（旧的 speak、autoConnect 等）一律丢弃；非法值回落到默认值，绝不抛出
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const hear = isTargetChoice(source.hear) ? source.hear : DEFAULT_SETTINGS.hear
  const partnerHears = isTargetChoice(source.partnerHears) ? source.partnerHears : DEFAULT_SETTINGS.partnerHears
  const floorLevel = FLOOR_LEVELS.includes(source.floorLevel) ? source.floorLevel : DEFAULT_SETTINGS.floorLevel
  const overrides = {}
  const rawOverrides = source.deviceOverrides && typeof source.deviceOverrides === 'object' ? source.deviceOverrides : {}
  for (const role of ROLE_KEYS) {
    const value = rawOverrides[role]
    if (typeof value === 'string' && value.length > 0) overrides[role] = value
  }
  return { schemaVersion: DEFAULT_SETTINGS.schemaVersion, hear, partnerHears, floorLevel, deviceOverrides: overrides }
}

// 只列出 target 或 mode 发生变化的方向：改语言只重建受影响方向
export function diffPlan(prev, next) {
  const changed = []
  for (const id of Object.keys(next ?? {})) {
    const a = prev?.[id]
    const b = next[id]
    if (!a || a.target !== b.target || a.mode !== b.mode) changed.push(id)
  }
  return changed
}

// 运行态只记两个选择，面板与通知文案据此重建计划
export function languagesOf(settings) {
  return { hear: settings.hear, partnerHears: settings.partnerHears }
}

// 选项页四张设备卡：角色 → 端点类型与说明。按 kind 过滤设备列表的判定在此，
// 选项页只负责把它渲染成 <select>。
export const DEVICE_ROLES = [
  { role: 'capture', kind: 'audioinput', title: '会议声音 · 截获', hint: '会议 app 的输出先进这里（BlackHole）' },
  { role: 'monitor', kind: 'audiooutput', title: '你的耳机 · 监听', hint: '对方的原声与译文从这里播出' },
  { role: 'mic', kind: 'audioinput', title: '你的麦克风', hint: '你的原声从这里进来' },
  { role: 'virtualMic', kind: 'audiooutput', title: '虚拟麦克风 · 送回会议', hint: '会议把它当麦克风（另一块 BlackHole）' },
]

export const DEFAULT_ASSIGNMENT_LABEL = '（默认分配）'

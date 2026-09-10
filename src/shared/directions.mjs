import { DEFAULT_SETTINGS, buildDirections } from './direction-plan.mjs'

// 方向表：方向 → 目标语言与设备角色的唯一真值来源。
// 默认设置（你想听中文 / 对方听 English）生成的计划即默认方向表；
// 运行期实际使用的计划由 buildDirections(settings) 生成。
export const DIRECTIONS = buildDirections(DEFAULT_SETTINGS)

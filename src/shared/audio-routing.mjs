import { DIRECTIONS } from './directions.mjs'

// 方向 → 输出角色的映射一律读方向表，不在此硬编码
export function resolveSinkId(directionId, roleDeviceIds, directionTable = DIRECTIONS) {
  const role = directionTable[directionId].outputRole
  return roleDeviceIds[role]
}

// 静音时绝不调用 sink
export function forwardMicAudio({ muted, chunk, sink }) {
  if (muted) return false
  sink(chunk)
  return true
}

// 采集约束：关闭回声消除/自动增益/降噪，避免破坏 BlackHole 截获的会议音频
export function buildCaptureConstraints(deviceId) {
  return {
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
    },
  }
}

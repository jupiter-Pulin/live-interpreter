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

// 直通（音频桥）约束：BlackHole 截获路与采集同规则（三项处理全关，不破坏会议音频）；
// 真麦克风路开回声消除与降噪（用户外放时减少回声进会议），但仍关自动增益避免忽大忽小。
export function buildFloorConstraints(deviceId, inputRole) {
  if (inputRole === 'mic') {
    return {
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: true,
        autoGainControl: false,
        noiseSuppression: true,
      },
    }
  }
  return buildCaptureConstraints(deviceId)
}

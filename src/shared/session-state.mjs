// 会话编排状态机：纯转换，不原地修改入参
export function createInitialState() {
  return {
    downlink: { status: 'stopped' },
    uplink: { status: 'stopped', muted: true },
  }
}

export function start(state, directionId) {
  return { ...state, [directionId]: { ...state[directionId], status: 'running' } }
}

export function stop(state, directionId) {
  return { ...state, [directionId]: { ...state[directionId], status: 'stopped' } }
}

export function toggleMute(state) {
  return { ...state, uplink: { ...state.uplink, muted: !state.uplink.muted } }
}

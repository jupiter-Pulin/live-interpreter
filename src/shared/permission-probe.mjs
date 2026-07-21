// 权限探测判定：设备列表为空、或全部条目 label 为空字符串时，说明还没有麦克风权限
export function needsPermissionProbe(devices) {
  return devices.length === 0 || devices.every((d) => d.label === '')
}

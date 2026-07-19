// 方向表：方向 → 语言对与设备角色的唯一真值来源
export const DIRECTIONS = {
  downlink: { id: 'downlink', source: 'en', target: 'zh', inputRole: 'capture', outputRole: 'monitor' },
  uplink: { id: 'uplink', source: 'zh', target: 'en', inputRole: 'mic', outputRole: 'virtualMic' },
}

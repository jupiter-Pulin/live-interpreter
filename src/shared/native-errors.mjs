import { messageFor } from './errors.mjs'

// Native Messaging 失败分类：把 chrome.runtime.lastError.message 归成一条可行动的中文提示。
// 一律归为 host_unavailable（宿主是本地依赖，用户能自己修），并按两种成因给不同下一步。

const NOT_INSTALLED = /not found|forbidden|Access to the specified|no such native/i
const CRASHED = /exited|communicating|Error when communicating|disconnected/i

export const HOST_LOG_HINT = '（宿主启动日志见 dist/native-host/host.log）'

export function classifyNativeError(lastErrorMessage) {
  const raw = typeof lastErrorMessage === 'string' ? lastErrorMessage : ''
  const base = messageFor('host_unavailable')
  if (NOT_INSTALLED.test(raw)) {
    return { category: 'host_unavailable', message: base }
  }
  if (CRASHED.test(raw)) {
    return { category: 'host_unavailable', message: `${base}${HOST_LOG_HINT}` }
  }
  return { category: 'host_unavailable', message: base }
}

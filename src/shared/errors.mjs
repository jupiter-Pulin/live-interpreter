export const CATEGORIES = [
  'device_missing',
  'permission_denied',
  'network_unavailable',
  'api_error',
  'config_missing',
  'host_unavailable',
]

export const USER_MESSAGES = {
  device_missing: '可用音频设备不满足要求：请检查 BlackHole 与耳机/麦克风的安装与选择。',
  permission_denied: '请先在浏览器中授予麦克风权限，然后刷新页面重试。',
  network_unavailable: '网络连接不可用或已中断，请检查网络后重试。',
  api_error: '翻译服务返回了错误，请稍后重试。',
  config_missing: '缺少必要配置：请在服务端设置 OPENAI_API_KEY 环境变量后重启服务。',
  host_unavailable:
    '本地翻译服务不可用：请在项目目录运行 npm run install:host 完成安装后重试（升级 Node 后需重新运行）。',
}

export function messageFor(category) {
  return USER_MESSAGES[category] ?? USER_MESSAGES.api_error
}

// getUserMedia / setSinkId 抛出的 DOMException 只有 name，没有 category。
// 不先按 name 归类就会被 classifyError 压成 api_error：用户看到「翻译服务返回了错误」
// 而实际是没授权或设备不在，且 device_missing 才触发的 devicechange 重试永不发生。
const MEDIA_ERROR_CATEGORIES = new Map([
  ['NotAllowedError', 'permission_denied'],
  ['SecurityError', 'permission_denied'],
  ['NotFoundError', 'device_missing'],
  ['OverconstrainedError', 'device_missing'],
  ['NotReadableError', 'device_missing'],
])

// 认得的媒体异常名 → 分类；其它（含 undefined）返回 null，交回 classifyError 兜底
export function classifyMediaError(name) {
  return MEDIA_ERROR_CATEGORIES.get(name) ?? null
}

// 分类器：已带合法分类的对象原样归类，其余一律兜底为 api_error，绝不抛出
export function classifyError(err) {
  if (err && typeof err.category === 'string' && CATEGORIES.includes(err.category)) {
    const message = typeof err.message === 'string' && err.message.length > 0 ? err.message : messageFor(err.category)
    return { category: err.category, message }
  }
  return { category: 'api_error', message: USER_MESSAGES.api_error }
}

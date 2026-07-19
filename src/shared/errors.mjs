export const CATEGORIES = ['device_missing', 'permission_denied', 'network_unavailable', 'api_error', 'config_missing']

export const USER_MESSAGES = {
  device_missing: '可用音频设备不满足要求：请检查 BlackHole 与耳机/麦克风的安装与选择。',
  permission_denied: '请先在浏览器中授予麦克风权限，然后刷新页面重试。',
  network_unavailable: '网络连接不可用或已中断，请检查网络后重试。',
  api_error: '翻译服务返回了错误，请稍后重试。',
  config_missing: '缺少必要配置：请在服务端设置 OPENAI_API_KEY 环境变量后重启服务。',
}

export function messageFor(category) {
  return USER_MESSAGES[category] ?? USER_MESSAGES.api_error
}

// 分类器：已带合法分类的对象原样归类，其余一律兜底为 api_error，绝不抛出
export function classifyError(err) {
  if (err && typeof err.category === 'string' && CATEGORIES.includes(err.category)) {
    const message = typeof err.message === 'string' && err.message.length > 0 ? err.message : messageFor(err.category)
    return { category: err.category, message }
  }
  return { category: 'api_error', message: USER_MESSAGES.api_error }
}

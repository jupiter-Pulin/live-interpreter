const TOKEN_PATH = '/api/session-token'

// 会话端点选择：mock 分支绝不产出 token 路径。
// 第二参给扩展用：宿主端口是运行期才知道的，启动令牌同理；
// 不传第二参时返回与网页时代完全一致的相对路径形态。
export function selectSessionEndpoint(config, { baseUrl, launchToken } = {}) {
  if (config.backend === 'mock') {
    return { kind: 'mock-ws', url: config.mockWsUrl }
  }
  const endpoint = { kind: 'token', path: TOKEN_PATH, url: baseUrl ? `${baseUrl}${TOKEN_PATH}` : TOKEN_PATH }
  if (launchToken) endpoint.headers = { Authorization: `Bearer ${launchToken}` }
  return endpoint
}

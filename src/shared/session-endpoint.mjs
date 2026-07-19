// 会话端点选择：mock 分支绝不产出 token 路径
export function selectSessionEndpoint(config) {
  if (config.backend === 'mock') {
    return { kind: 'mock-ws', url: config.mockWsUrl }
  }
  return { kind: 'token', path: '/api/session-token' }
}

// 后端选择：仅严格等于 'real' 时走真 API，其余一律 mock（默认安全）
export function selectBackend(raw) {
  return raw === 'real' ? 'real' : 'mock'
}

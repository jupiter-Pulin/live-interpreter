import { createHash } from 'node:crypto'

// 扩展 ID 推导：Chrome 取公钥（SPKI DER）的 sha256，前 16 字节逐 nibble 映射到 a–p。
// manifest 里固定 key → 扩展 ID 固定 → 宿主 manifest 的 allowed_origins 才能提前写死。

export function extensionIdFromKey(key) {
  const der = Buffer.from(String(key).replace(/\s+/g, ''), 'base64')
  const digest = createHash('sha256').update(der).digest()
  let id = ''
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4))
    id += String.fromCharCode(97 + (byte & 0x0f))
  }
  return id
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extensionIdFromKey } from '../../tools/extension-id.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 独立实现：sha256(SPKI DER) 前 16 字节 → 前 32 个十六进制位逐位映射 0-f → a-p
function referenceId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')
}

test('AC-117 extensionIdFromKey：固定向量 → 固定的 32 位 a–p 字符串', () => {
  const vectors = {
    'bGl2ZS1pbnRlcnByZXRlci10ZXN0LXZlY3Rvcg==': 'npfipcdbfdpgbpcdplnfkaimejpiopdd',
    '': 'odlameecjipmbmbejkplpemijjgpljce',
  }
  for (const [key, expected] of Object.entries(vectors)) {
    assert.equal(extensionIdFromKey(key), expected)
    assert.equal(extensionIdFromKey(key), referenceId(key), '与独立实现一致（防止半字节顺序写反）')
    assert.match(expected, /^[a-p]{32}$/)
  }
  // 换一位 key 就换一个 ID
  assert.notEqual(extensionIdFromKey('AAAA'), extensionIdFromKey('AAAB'))
  // 换行/空白不影响推导（manifest 里可能带折行）
  assert.equal(extensionIdFromKey('AAAA'), extensionIdFromKey('AA\n AA'))
})

test('AC-115/AC-117 仓库 manifest 的 key 固定，扩展 ID 因此固定', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'src', 'extension', 'manifest.json'), 'utf8'))
  assert.ok(typeof manifest.key === 'string' && manifest.key.length > 0, 'manifest 必须含非空 key')
  // 宿主 manifest 的 allowed_origins 写死这个 ID：换 key 必须同步重跑 npm run install:host
  assert.equal(extensionIdFromKey(manifest.key), 'bicdajleioedhnconkbbmdnliocbofee')
  assert.equal(extensionIdFromKey(manifest.key), referenceId(manifest.key))
})

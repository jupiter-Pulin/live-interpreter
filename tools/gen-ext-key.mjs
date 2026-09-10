import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { extensionIdFromKey } from './extension-id.mjs'

// 一次性工具：生成 RSA 密钥对，把公钥（SPKI DER 的 base64）写进 manifest 的 key 字段
// 并打印推导出的扩展 ID。私钥不保存也不需要——未打包加载的扩展只靠 key 固定 ID。
// 已有 key 时需加 --force 才覆盖（覆盖会换扩展 ID，宿主 manifest 必须重装）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = path.join(ROOT, 'src', 'extension', 'manifest.json')

const force = process.argv.includes('--force')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

if (manifest.key && !force) {
  console.log(`manifest 已有 key，扩展 ID = ${extensionIdFromKey(manifest.key)}`)
  console.log('要换一把新钥匙请加 --force（换 key 等于换扩展 ID，需重跑 npm run install:host）')
  process.exit(0)
}

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

// 保持 manifest 字段顺序稳定：key 紧跟在 version 之后
const next = {}
for (const [field, value] of Object.entries(manifest)) {
  next[field] = value
  if (field === 'version') next.key = key
}
if (!next.key) next.key = key

writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`)
console.log(`已写入 manifest.key（公钥可提交，私钥未保存）`)
console.log(`扩展 ID = ${extensionIdFromKey(key)}`)

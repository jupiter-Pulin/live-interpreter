import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SHARED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared')

test('src/shared 纯度：可被 Node 直接 import 且不含环境耦合', async () => {
  const files = (await readdir(SHARED_DIR)).filter((f) => f.endsWith('.mjs'))
  assert.ok(files.length >= 8, `shared 模块数量异常: ${files.length}`)
  for (const f of files) {
    const full = path.join(SHARED_DIR, f)
    await assert.doesNotReject(() => import(full), `${f} 应能被 Node 直接 import`)
    const src = await readFile(full, 'utf8')
    assert.ok(!/\bnode:/.test(src), `${f} 不得使用 node: 前缀 import`)
    assert.ok(!src.includes('require('), `${f} 不得使用 require(`)
    assert.ok(!/\b(document|window|process)\b/.test(src), `${f} 不得引用浏览器/Node 全局环境对象`)
  }
})

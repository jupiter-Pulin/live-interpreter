import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const AUDIO_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/extension/audio.js')

test('AC-003 audio.js 权限探测分支：唯一依据是导入的 needsPermissionProbe', async () => {
  const src = await readFile(AUDIO_JS, 'utf8')
  assert.ok(
    /import\s*\{\s*needsPermissionProbe\s*\}\s*from\s*['"]\/shared\/permission-probe\.mjs['"]/.test(src),
    'audio.js 必须从 shared 导入 needsPermissionProbe'
  )
  assert.ok(
    /if\s*\(\s*needsPermissionProbe\(/.test(src),
    'getUserMedia 探测分支必须直接以 needsPermissionProbe(...) 作为条件'
  )
  // 判定逻辑不得在 audio.js 内重复实现
  assert.ok(!/\.every\(/.test(src), 'audio.js 不得自行重复实现 label 判定（应复用 shared 纯函数）')
  assert.ok(!/label\s*===\s*['"]{2}/.test(src), 'audio.js 不得自行判断 label 是否为空')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('AC-021 密钥卫生：被跟踪文件无密钥形态字符串', async () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  assert.ok(tracked.length > 0)
  const keyPattern = /sk-[A-Za-z0-9_-]{20,}/
  const literal = typeof globalThis.process !== 'undefined' ? globalThis.process.env.OPENAI_API_KEY : undefined
  for (const f of tracked) {
    const content = await readFile(path.join(ROOT, f), 'utf8')
    assert.ok(!keyPattern.test(content), `${f} 疑似包含 OpenAI 密钥形态字符串`)
    if (literal && literal.length > 0) {
      assert.ok(!content.includes(literal), `${f} 包含 OPENAI_API_KEY 的字面值`)
    }
  }

  const gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8')
  assert.ok(gitignore.includes('.env'))
  assert.ok(gitignore.includes('node_modules'))
  assert.ok(!gitignore.includes('package-lock.json'))
  const envExample = await readFile(path.join(ROOT, '.env.example'), 'utf8')
  assert.match(envExample, /^OPENAI_API_KEY=$/m)
})

test('AC-022 不引入会议平台 SDK', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).map((d) => d.toLowerCase())
  for (const banned of ['zoom', 'meet', 'teams', '@zoom', '@microsoft/teams']) {
    assert.ok(!deps.some((d) => d.includes(banned)), `不得依赖会议平台 SDK: ${banned}`)
  }
})

test('AC-118 dist 不入库；扩展与工具目录通过密钥扫描', async () => {
  const gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8')
  assert.match(gitignore, /^dist$/m, '.gitignore 必须忽略 dist')

  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  assert.ok(!tracked.some((f) => f.startsWith('dist/')), 'dist/ 不得被跟踪')

  // 构建产物与宿主日志都在 dist 下，扩展源码与工具链本身必须干净
  const scanned = tracked.filter((f) => f.startsWith('src/extension/') || f.startsWith('tools/'))
  assert.ok(scanned.length >= 5, `待扫描文件过少：${scanned.length}`)
  const keyPattern = /sk-[A-Za-z0-9_-]{20,}/
  for (const f of scanned) {
    const content = await readFile(path.join(ROOT, f), 'utf8')
    assert.ok(!keyPattern.test(content), `${f} 疑似包含 OpenAI 密钥形态字符串`)
    assert.ok(!/OPENAI_API_KEY\s*[:=]\s*['"][^'"]+['"]/.test(content), `${f} 不得内联 API key`)
  }
})

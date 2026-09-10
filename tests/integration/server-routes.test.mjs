import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from '../../src/server/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function missing(relative) {
  try {
    await stat(path.join(ROOT, relative))
    return false
  } catch {
    return true
  }
}

test('AC-134 网页版文件与专用测试已移除', async () => {
  for (const gone of [
    'src/web',
    'src/web/index.html',
    'src/web/app.js',
    'src/shared/session-state.mjs',
    'tests/unit/subtitle-panel-static.test.mjs',
  ]) {
    assert.ok(await missing(gone), `${gone} 应已删除`)
  }
  // 接线文件迁入扩展目录
  for (const moved of ['src/extension/audio.js', 'src/extension/session.js']) {
    assert.ok(!(await missing(moved)), `${moved} 应存在`)
  }
})

test('AC-134 createServer 只剩令牌端点：静态托管与 /api/config 的代码已不存在', async () => {
  const src = await readFile(path.join(ROOT, 'src', 'server', 'index.mjs'), 'utf8')
  for (const gone of ['serveStatic', '/api/config', 'readFile', 'process.env', 'CONTENT_TYPES', 'mockWsUrl']) {
    assert.ok(!src.includes(gone), `src/server/index.mjs 不得再含 ${gone}`)
  }
  assert.ok(!/node:(fs|path|url)/.test(src), '不得再 import 文件系统/路径模块')
  assert.ok(!src.includes('pathToFileURL'), 'CLI 入口块必须删除')
})

test('AC-134 GET / 、/api/config 、/index.html 一律 404 JSON', async () => {
  const server = createServer({ backend: 'mock', apiKey: undefined, exchangeToken: async () => ({}) })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    for (const route of ['/', '/api/config', '/index.html', '/shared/errors.mjs', '/app.js']) {
      const res = await fetch(`${base}${route}`)
      assert.equal(res.status, 404, `${route} 应为 404`)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
      const body = await res.json()
      assert.ok(typeof body.message === 'string' && body.message.length > 0)
      assert.ok(!('mockWsUrl' in body), '404 响应不得泄露 mock 地址')
    }
    // 非 GET 的未知路径同样 404
    const posted = await fetch(`${base}/api/other`, { method: 'POST' })
    assert.equal(posted.status, 404)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('AC-134 package.json scripts：网页版入口已删，扩展工具链就位', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.start, undefined, 'npm start 必须删除')
  assert.equal(pkg.scripts['start:real'], undefined, 'npm run start:real 必须删除')
  for (const needed of ['test', 'pretest', 'e2e:real', 'build:ext', 'install:host']) {
    assert.ok(typeof pkg.scripts[needed] === 'string' && pkg.scripts[needed].length > 0, `缺少 ${needed} 脚本`)
  }
  // 零新增运行时依赖
  assert.deepEqual(Object.keys(pkg.dependencies), ['ws'])
  assert.equal(pkg.devDependencies, undefined)
})

test('AC-134 tools/e2e-real.mjs 不依赖已删除的 mockWsUrl', async () => {
  const src = await readFile(path.join(ROOT, 'tools', 'e2e-real.mjs'), 'utf8')
  assert.ok(!src.includes('mockWsUrl'))
  assert.ok(src.includes('createServer'), '真实链路验证仍复用同一个 createServer')
})

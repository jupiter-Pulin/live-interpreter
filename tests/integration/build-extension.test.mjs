import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildExtension } from '../../tools/build-extension.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function build() {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'li-ext-')), 'extension')
  await buildExtension(out)
  return out
}

async function listAll(dir, prefix = '') {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listAll(path.join(dir, entry.name), rel)))
    else found.push(rel)
  }
  return found
}

test('AC-116 产物包含扩展全部文件与 shared 同名同内容副本', async () => {
  const out = await build()
  const produced = new Set(await listAll(out))

  const expected = [
    'manifest.json',
    'background.js',
    'offscreen.html',
    'offscreen.js',
    'meet-mute.js',
    'audio.js',
    'session.js',
    'popup.html',
    'sidepanel.html',
    'panel.js',
    'panel.css',
    'options.html',
    'options.js',
    'icons/icon16.png',
    'icons/icon32.png',
    'icons/icon48.png',
    'icons/icon128.png',
  ]
  for (const file of expected) {
    assert.ok(produced.has(file), `产物缺少 ${file}`)
  }

  // shared/ 下与 src/shared/*.mjs 同名同内容
  const sharedFiles = (await readdir(path.join(ROOT, 'src', 'shared'))).filter((f) => f.endsWith('.mjs'))
  assert.ok(sharedFiles.length >= 10)
  for (const file of sharedFiles) {
    assert.ok(produced.has(`shared/${file}`), `产物缺少 shared/${file}`)
    assert.deepEqual(
      await readFile(path.join(out, 'shared', file)),
      await readFile(path.join(ROOT, 'src', 'shared', file)),
      `shared/${file} 内容必须与源文件逐字节相同`
    )
  }
})

test('AC-116 manifest.version 与 package.json 一致', async () => {
  const out = await build()
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, pkg.version)
  assert.ok(manifest.key.length > 0, '构建不得丢掉固定 key')
})

test('AC-116/AC-118 产物绝不包含 .env、node_modules、src/server', async () => {
  const out = await build()
  const produced = await listAll(out)
  for (const file of produced) {
    assert.ok(!file.includes('node_modules'), `产物混入 ${file}`)
    assert.ok(!/(^|\/)\.env/.test(file), `产物混入 ${file}`)
    assert.ok(!file.includes('native-host'), `产物混入服务端文件 ${file}`)
    assert.ok(!file.includes('token.mjs'), `产物混入服务端文件 ${file}`)
    assert.ok(!file.includes('mock-realtime'), `产物混入服务端文件 ${file}`)
  }
  const bundled = await Promise.all(produced.map((f) => readFile(path.join(out, f), 'utf8').catch(() => '')))
  for (const content of bundled) {
    assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(content), '产物疑似含密钥形态字符串')
  }
})

test('AC-116 重复构建：先清空目标目录，不残留上一轮的文件', async () => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'li-ext-')), 'extension')
  await mkdir(out, { recursive: true })
  await writeFile(path.join(out, 'stale.js'), '// 上一轮的残留')
  await buildExtension(out)
  const produced = await listAll(out)
  assert.ok(!produced.includes('stale.js'), '重复构建必须先清空目标目录')
})

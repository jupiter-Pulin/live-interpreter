import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { installNativeHost } from '../../tools/install-native-host.mjs'
import { extensionIdFromKey } from '../../tools/extension-id.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

async function freshHome() {
  return mkdtemp(path.join(tmpdir(), 'li-host-'))
}

test('AC-117 宿主 manifest：字段齐备、path 指向可执行 wrapper、来源限定本扩展', async () => {
  const home = await freshHome()
  const out = path.join(home, 'dist-native')
  const result = await installNativeHost({ home, outDir: out })

  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  assert.equal(manifest.name, 'com.live_interpreter.host')
  assert.ok(manifest.description.length > 0)
  assert.equal(manifest.type, 'stdio')
  assert.equal(manifest.path, result.wrapperPath)

  const extManifest = JSON.parse(await readFile(path.join(ROOT, 'src', 'extension', 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionIdFromKey(extManifest.key)}/`])

  // 落在 Chrome 的 NativeMessagingHosts 目录里
  assert.ok(
    result.manifestPath.endsWith(
      path.join('Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.live_interpreter.host.json')
    ),
    result.manifestPath
  )

  // wrapper 可执行，且写死了当前 node 与仓库根（Dock 启动的 Chrome PATH 极简）
  const mode = (await stat(result.wrapperPath)).mode & 0o777
  assert.equal(mode, 0o755)
  const wrapper = await readFile(result.wrapperPath, 'utf8')
  assert.ok(wrapper.startsWith('#!/bin/sh'))
  assert.ok(wrapper.includes(process.execPath), 'wrapper 必须写死当前 node 的绝对路径')
  assert.ok(wrapper.includes(ROOT), 'wrapper 必须 cd 到仓库根的绝对路径')
  assert.ok(wrapper.includes('src/server/native-host.mjs'))
  assert.ok(wrapper.includes('--env-file=.env'), '存在 .env 时应带上它（运行时判断）')
})

test('AC-117 幂等：连续执行两次产物逐字节相同', async () => {
  const home = await freshHome()
  const out = path.join(home, 'dist-native')
  const first = await installNativeHost({ home, outDir: out })
  const manifestA = await readFile(first.manifestPath)
  const wrapperA = await readFile(first.wrapperPath)
  const second = await installNativeHost({ home, outDir: out })
  assert.equal(second.manifestPath, first.manifestPath)
  assert.deepEqual(await readFile(second.manifestPath), manifestA)
  assert.deepEqual(await readFile(second.wrapperPath), wrapperA)
})

test('AC-117 --browser edge 写到 Microsoft Edge 的目录；--extension-id 可覆盖', async () => {
  const home = await freshHome()
  const result = await installNativeHost({
    home,
    browser: 'edge',
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    outDir: path.join(home, 'dist-native'),
  })
  assert.ok(
    result.manifestPath.includes(path.join('Microsoft Edge', 'NativeMessagingHosts')),
    result.manifestPath
  )
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'))
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'])
  await assert.rejects(() => installNativeHost({ home, browser: 'firefox' }), /未知浏览器/)
})

test('AC-118 安装脚本只写用户目录下的 manifest 与 dist/：不碰仓库其它文件', async () => {
  const src = await readFile(path.join(ROOT, 'tools', 'install-native-host.mjs'), 'utf8')
  assert.ok(!src.includes('OPENAI_API_KEY'), '安装脚本不得接触密钥')
  const writes = [...src.matchAll(/writeFile\(([^,]+),/g)].map((m) => m[1].trim())
  assert.deepEqual(writes.sort(), ['manifestPath', 'wrapperPath'], `只允许写这两个文件，实际：${writes}`)
})

import { chmod, mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { extensionIdFromKey } from './extension-id.mjs'

// 安装 Native Messaging 宿主：写一个宿主 manifest 到浏览器的 NativeMessagingHosts 目录，
// 并生成一个 wrapper 脚本（写死当前 node 绝对路径与仓库根）。幂等：连跑两次产物逐字节相同。
// 卸载 = 删掉那个 manifest。升级 Node 后需重跑（wrapper 里的 node 路径会失效）。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOST_NAME = 'com.live_interpreter.host'

const BROWSER_DIRS = {
  chrome: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
  edge: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
}

function argValue(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

// wrapper 而不是直接指向 node：宿主进程的 cwd 是可执行文件所在目录，且从 Dock 启动的
// Chrome 的 PATH 极简（可能连 node 都找不到），所以 cd 与解释器路径都得写死。
function wrapperScript(nodePath, repoRoot) {
  return [
    '#!/bin/sh',
    '# 由 npm run install:host 生成，请勿手改。升级 Node 后重跑该命令。',
    `cd "${repoRoot}" || exit 1`,
    'if [ -f .env ]; then',
    `  exec "${nodePath}" --env-file=.env src/server/native-host.mjs "$@"`,
    'fi',
    `exec "${nodePath}" src/server/native-host.mjs "$@"`,
    '',
  ].join('\n')
}

export async function installNativeHost({
  home = homedir(),
  browser = 'chrome',
  extensionId,
  outDir = path.join(ROOT, 'dist', 'native-host'),
  nodePath = process.execPath,
  repoRoot = ROOT,
} = {}) {
  const segments = BROWSER_DIRS[browser]
  if (!segments) throw new Error(`未知浏览器：${browser}（支持 chrome / edge）`)

  let id = extensionId
  if (!id) {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, 'src', 'extension', 'manifest.json'), 'utf8'))
    if (!manifest.key) throw new Error('manifest 缺少 key：请先运行 node tools/gen-ext-key.mjs')
    id = extensionIdFromKey(manifest.key)
  }

  const wrapperPath = path.join(outDir, 'host.sh')
  await mkdir(outDir, { recursive: true })
  await writeFile(wrapperPath, wrapperScript(nodePath, repoRoot))
  await chmod(wrapperPath, 0o755)

  const hostManifest = {
    name: HOST_NAME,
    description: '会议同传本地翻译服务（Live Interpreter native host）',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  }
  const manifestDir = path.join(home, ...segments)
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`)
  await mkdir(manifestDir, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(hostManifest, null, 2)}\n`)

  return { manifestPath, wrapperPath, extensionId: id, envPresent: await exists(path.join(repoRoot, '.env')) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await installNativeHost({
    home: argValue('--home', homedir()),
    browser: argValue('--browser', 'chrome'),
    extensionId: argValue('--extension-id', undefined),
    outDir: argValue('--out', path.join(ROOT, 'dist', 'native-host')),
  })
  console.log(`[install:host] 宿主 manifest → ${result.manifestPath}`)
  console.log(`[install:host] 启动脚本   → ${result.wrapperPath}`)
  console.log(`[install:host] 允许的扩展 → chrome-extension://${result.extensionId}/`)
  console.log(`[install:host] 后端配置   → ${result.envPresent ? '已发现 .env（按其中的 TRANSLATE_BACKEND 决定 mock/real）' : '未发现 .env（按 mock 后端运行，零 API 费用）'}`)
  console.log('[install:host] 卸载：删除上面那个 manifest 文件即可。升级 Node 后请重跑本命令。')
}

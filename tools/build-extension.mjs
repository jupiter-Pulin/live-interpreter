import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// 零依赖、零打包器：构建 = 把 src/extension 原样拷进 --out，再把 src/shared/*.mjs
// 拷成 <out>/shared/（扩展里用 /shared/xxx.mjs 这种扩展根绝对路径加载）。
// 只拷这两处，因此 .env、node_modules、src/server 永远不会进产物。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXT_SRC = path.join(ROOT, 'src', 'extension')
const SHARED_SRC = path.join(ROOT, 'src', 'shared')

function argValue(name, fallback) {
  const at = process.argv.indexOf(name)
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback
}

export async function buildExtension(outDir) {
  const out = path.resolve(ROOT, outDir)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  // 扩展目录整体拷贝（含 icons/ 子目录）
  await cp(EXT_SRC, out, { recursive: true })

  // shared 纯逻辑：只拷 .mjs，不建子目录
  const sharedOut = path.join(out, 'shared')
  await mkdir(sharedOut, { recursive: true })
  const sharedFiles = (await readdir(SHARED_SRC)).filter((f) => f.endsWith('.mjs'))
  for (const file of sharedFiles) {
    await cp(path.join(SHARED_SRC, file), path.join(sharedOut, file))
  }

  // 版本号以 package.json 为唯一真值，避免两处手工同步
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const manifestPath = path.join(out, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.version = pkg.version
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  return { out, sharedFiles }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = argValue('--out', path.join('dist', 'extension'))
  const { out, sharedFiles } = await buildExtension(outDir)
  console.log(`[build:ext] 已产出 ${out}（shared 模块 ${sharedFiles.length} 个）`)
  console.log('[build:ext] 在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」→ 选择该目录')
}

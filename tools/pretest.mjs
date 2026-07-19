import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'

const require = createRequire(import.meta.url)
try {
  require.resolve('ws')
} catch {
  console.log('[pretest] 缺少运行时依赖 ws，正在安装（需可访问 npm registry）……')
  try {
    execSync('npm install --no-audit --no-fund', { stdio: 'inherit' })
  } catch {
    console.error('[pretest] 依赖安装失败：缺少 ws 包。请在联网环境下手动执行一次 npm install 后重试。')
    process.exit(1)
  }
}

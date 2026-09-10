import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { selectBackend } from '../shared/backend.mjs'
import { encodeFrame, createFrameDecoder } from '../shared/native-protocol.mjs'
import { createServer } from './index.mjs'
import { startMockRealtime } from './mock-realtime.mjs'

// Native Messaging 宿主：由扩展的 connectNative 拉起，随端口断开退出。
// 只在同传开启期间存在，每次开启都是冷启动。OPENAI_API_KEY 只存在于本进程。
//
// 协议：stdin/stdout，4 字节小端长度前缀 + UTF-8 JSON。
// stdout 只允许写协议帧，所有日志一律走 stderr 与日志文件。

const STARTED_AT = Date.now()
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LOG_PATH = process.env.LI_HOST_LOG || path.join(ROOT, 'dist', 'native-host', 'host.log')

function readVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

function log(line) {
  const text = `[${new Date().toISOString()}] [pid ${process.pid}] ${line}\n`
  try {
    process.stderr.write(text)
  } catch {
    // 宿主由浏览器拉起，stderr 可能不可写，绝不因此中断
  }
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, text)
  } catch {
    // 日志写不动也不影响协议
  }
}

// 误用的 console.log 会污染协议流（Chrome 按长度前缀解析），一律改道 stderr
console.log = console.error
console.info = console.error
console.warn = console.error

function send(frame) {
  process.stdout.write(encodeFrame(frame))
}

let server = null
let mock = null
let closing = false

// stdin EOF / shutdown 帧 / SIGTERM 走同一条收尾路径，确保不留孤儿端口
async function closeAll(code) {
  if (closing) return
  closing = true
  log(`closing (code=${code})`)
  const forceExit = setTimeout(() => process.exit(code), 1500)
  forceExit.unref?.()
  try {
    if (server) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
    if (mock) await mock.stop()
  } catch (err) {
    log(`close error: ${err?.message ?? err}`)
  }
  clearTimeout(forceExit)
  process.exit(code)
}

const decoder = createFrameDecoder({
  onFrame: (msg) => {
    if (msg?.type === 'ping') {
      send({ type: 'pong' })
      return
    }
    if (msg?.type === 'shutdown') {
      closeAll(0)
      return
    }
    log(`忽略未知帧：${msg?.type}`)
  },
  onError: (err) => {
    log(`协议帧解析失败：${err.message}`)
    closeAll(1)
  },
})

process.stdin.on('data', (chunk) => {
  decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
})
process.stdin.on('end', () => closeAll(0))
process.stdin.on('error', (err) => {
  log(`stdin 错误：${err?.message ?? err}`)
  closeAll(0)
})
process.on('SIGTERM', () => closeAll(0))
process.on('SIGINT', () => closeAll(0))

async function main() {
  const backend = selectBackend(process.env.TRANSLATE_BACKEND)
  // 启动令牌：扩展用它调用 /api/session-token，绝不落盘、绝不进 chrome.storage
  const launchToken = randomBytes(32).toString('base64url')
  let mockWsUrl = null
  if (backend === 'mock') {
    mock = await startMockRealtime({ port: 0 })
    mockWsUrl = mock.url
  }
  server = createServer({ backend, apiKey: process.env.OPENAI_API_KEY, launchToken })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  send({
    type: 'ready',
    port,
    backend,
    mockWsUrl,
    launchToken,
    pid: process.pid,
    version: readVersion(),
  })
  log(`ready backend=${backend} port=${port} 冷启动耗时=${Date.now() - STARTED_AT}ms`)
}

main().catch((err) => {
  const message = `本地翻译服务启动失败：${err?.message ?? err}`
  log(message)
  try {
    send({ type: 'error', category: 'api_error', message })
  } catch {
    // stdout 不可写时只能依靠日志
  }
  process.exit(1)
})

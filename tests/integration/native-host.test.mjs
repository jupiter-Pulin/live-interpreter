import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { encodeFrame, createFrameDecoder } from '../../src/shared/native-protocol.mjs'
import { selectSessionEndpoint } from '../../src/shared/session-endpoint.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOST = path.join(ROOT, 'src', 'server', 'native-host.mjs')

// 以 Chrome 的方式启动宿主：纯管道 stdio，4 字节长度前缀帧
function startHost() {
  const child = spawn(process.execPath, [HOST], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 不继承 TRANSLATE_BACKEND / OPENAI_API_KEY，确保测试永不打真 API
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LI_HOST_LOG: '/dev/null' },
  })
  const frames = []
  const waiters = []
  const stdoutBytes = []
  let read = 0
  let stderr = ''
  const decoder = createFrameDecoder({
    onFrame: (frame) => {
      frames.push(frame)
      const waiter = waiters.shift()
      if (waiter) {
        read = frames.length
        waiter(frame)
      }
    },
    onError: (err) => assert.fail(`宿主 stdout 不是合法协议流：${err.message}`),
  })
  child.stdout.on('data', (chunk) => {
    stdoutBytes.push(chunk)
    decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  return {
    child,
    frames,
    get stderr() {
      return stderr
    },
    rawStdout() {
      return Buffer.concat(stdoutBytes)
    },
    // 按到达顺序逐帧消费，绝不把上一帧当成新帧
    nextFrame(timeoutMs = 10000) {
      if (read < frames.length) return Promise.resolve(frames[read++])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待宿主协议帧超时，stderr=${stderr}`)), timeoutMs)
        waiters.push((frame) => {
          clearTimeout(timer)
          resolve(frame)
        })
      })
    },
    send(frame) {
      child.stdin.write(encodeFrame(frame))
    },
    exited(timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`宿主未在 ${timeoutMs}ms 内退出`)), timeoutMs)
        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })
    },
  }
}

async function waitForReady(host) {
  const frame = await host.nextFrame()
  assert.equal(frame.type, 'ready', `首帧必须是 ready，实际：${JSON.stringify(frame)} stderr=${host.stderr}`)
  return frame
}

test('AC-112 首帧 ready：端口/后端/启动令牌齐备，stdout 只有协议帧', async () => {
  const host = startHost()
  try {
    const ready = await waitForReady(host)
    assert.equal(ready.backend, 'mock', '未设 TRANSLATE_BACKEND 时必须是 mock（默认安全）')
    assert.ok(Number.isInteger(ready.port) && ready.port >= 1024 && ready.port <= 65535, `端口异常：${ready.port}`)
    assert.ok(typeof ready.mockWsUrl === 'string' && ready.mockWsUrl.startsWith('ws://127.0.0.1:'))
    assert.ok(Buffer.from(ready.launchToken, 'base64url').length >= 32, '启动令牌至少 32 字节随机数')
    assert.equal(ready.pid, host.child.pid)
    assert.ok(typeof ready.version === 'string' && ready.version.length > 0)

    // stdout 字节数恰等于协议帧本身，没有任何日志混入
    const expected = encodeFrame(ready)
    assert.equal(host.rawStdout().length, expected.length, 'stdout 除协议帧外不得有其它字节')
    assert.deepEqual(new Uint8Array(host.rawStdout()), expected)

    // ready 帧原样喂给端点选择：mock 后端必须接 mock WS 而不是令牌端点
    const endpoint = selectSessionEndpoint(ready, { baseUrl: `http://127.0.0.1:${ready.port}`, launchToken: ready.launchToken })
    assert.equal(endpoint.kind, 'mock-ws')
    assert.equal(endpoint.url, ready.mockWsUrl)
    assert.ok(!JSON.stringify(endpoint).includes('/api/session-token'))

    // 宿主 HTTP 只剩令牌端点：网页版的入口一律 404 JSON
    for (const route of ['/', '/api/config', '/index.html']) {
      const res = await fetch(`http://127.0.0.1:${ready.port}${route}`)
      assert.equal(res.status, 404, `${route} 应为 404`)
      assert.match(res.headers.get('content-type') ?? '', /application\/json/)
      assert.ok((await res.json()).message.length > 0)
    }
  } finally {
    host.child.kill('SIGKILL')
  }
})

test('AC-113 ping → pong；shutdown 后 2s 内以 0 退出且端口释放', async () => {
  const host = startHost()
  try {
    const ready = await waitForReady(host)
    host.send({ type: 'ping' })
    const pong = await host.nextFrame()
    assert.equal(pong.type, 'pong')

    host.send({ type: 'shutdown' })
    const { code } = await host.exited()
    assert.equal(code, 0)
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${ready.port}/api/session-token`, { method: 'POST' }),
      '宿主退出后端口必须释放'
    )
  } finally {
    host.child.kill('SIGKILL')
  }
})

test('AC-113 关闭 stdin 等价于 shutdown：进程 2s 内以 0 退出', async () => {
  const host = startHost()
  try {
    const ready = await waitForReady(host)
    host.child.stdin.end()
    const { code } = await host.exited()
    assert.equal(code, 0)
    await assert.rejects(() => fetch(`http://127.0.0.1:${ready.port}/`))
  } finally {
    host.child.kill('SIGKILL')
  }
})

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { selectBackend } from '../shared/backend.mjs'
import { exchangeToken as realExchangeToken } from './token.mjs'
import { startMockRealtime } from './mock-realtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function serveStatic(res, urlPath) {
  let filePath
  if (urlPath === '/') {
    filePath = path.join(ROOT, 'src', 'web', 'index.html')
  } else if (urlPath.startsWith('/shared/')) {
    filePath = path.join(ROOT, 'src', 'shared', urlPath.slice('/shared/'.length))
  } else {
    filePath = path.join(ROOT, 'src', 'web', urlPath.slice(1))
  }
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.join(ROOT, 'src') + path.sep)) {
    sendJson(res, 403, { message: '路径不允许' })
    return
  }
  try {
    const data = await readFile(resolved)
    const type = CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type })
    res.end(data)
  } catch {
    sendJson(res, 404, { message: '资源不存在' })
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function createServer({ backend, apiKey, exchangeToken = realExchangeToken, mockWsUrl }) {
  return http.createServer(async (req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname

    if (req.method === 'GET' && urlPath === '/api/config') {
      if (backend === 'mock') {
        sendJson(res, 200, { backend: 'mock', mockWsUrl })
      } else {
        sendJson(res, 200, { backend: 'real' })
      }
      return
    }

    if (req.method === 'POST' && urlPath === '/api/session-token') {
      if (backend !== 'real') {
        sendJson(res, 404, { category: 'config_missing', message: '当前为 mock 后端，不提供真实凭证。' })
        return
      }
      if (!apiKey) {
        sendJson(res, 500, {
          category: 'config_missing',
          message: '缺少必要配置：请在服务端设置 OPENAI_API_KEY 环境变量后重启服务。',
        })
        return
      }
      const body = await readBody(req)
      try {
        const { clientSecret, expiresAt } = await exchangeToken({
          apiKey,
          targetLanguage: body.targetLanguage,
        })
        sendJson(res, 200, { clientSecret, expiresAt })
      } catch (err) {
        if (err && typeof err.status === 'number') {
          sendJson(res, 502, { category: 'api_error', message: '翻译服务返回了错误，请稍后重试。' })
        } else {
          sendJson(res, 502, { category: 'network_unavailable', message: '网络连接不可用或已中断，请检查网络后重试。' })
        }
      }
      return
    }

    if (req.method === 'GET') {
      await serveStatic(res, urlPath)
      return
    }
    sendJson(res, 405, { message: '方法不允许' })
  })
}

// 进程入口：唯一读取环境变量的位置
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backend = selectBackend(process.env.TRANSLATE_BACKEND)
  const rawPort = Number(process.env.PORT)
  const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 5173

  const boot = async () => {
    let mockWsUrl
    if (backend === 'mock') {
      const mock = await startMockRealtime({ port: 0 })
      mockWsUrl = mock.url
    }
    const server = createServer({ backend, apiKey: process.env.OPENAI_API_KEY, mockWsUrl })
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${port} 已被占用：请先释放该端口，或用 PORT 环境变量指定其他端口后重启。`)
        process.exit(1)
      }
      throw err
    })
    server.listen(port, () => {
      console.log(`[live-interpreter] 后端=${backend} http://localhost:${port}/`)
      if (mockWsUrl) console.log(`[live-interpreter] mock 翻译会话: ${mockWsUrl}`)
    })
  }
  boot()
}

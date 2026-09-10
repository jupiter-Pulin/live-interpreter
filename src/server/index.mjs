import http from 'node:http'
import { exchangeToken as realExchangeToken } from './token.mjs'

// 本地令牌服务：唯一职责是用服务端 API key 换取浏览器可用的短期凭证。
// 只在同传开启期间由 Native Messaging 宿主拉起（见 ./native-host.mjs），
// 绑 127.0.0.1 随机端口；除令牌端点外一律 404。

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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

// launchToken 缺省时行为与网页时代完全一致（不鉴权）；传入则必须带 Bearer 令牌。
// 令牌检查在 backend / apiKey 判定之前，避免未授权方探测后端配置。
export function createServer({ backend, apiKey, exchangeToken = realExchangeToken, launchToken }) {
  return http.createServer(async (req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname

    if (req.method === 'POST' && urlPath === '/api/session-token') {
      if (launchToken && req.headers.authorization !== `Bearer ${launchToken}`) {
        sendJson(res, 401, { category: 'api_error', message: '启动令牌无效：请重新开启同传。' })
        return
      }
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

    sendJson(res, 404, { message: '资源不存在' })
  })
}

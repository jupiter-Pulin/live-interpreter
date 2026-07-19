// 短期客户端凭证签发：用服务端 API key 向 OpenAI 换取浏览器可用的 ephemeral secret。
// 上游 4xx/5xx 抛带 status 的 Error；网络失败由 fetch 抛出（无 status），调用方据此分类。

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets'

export async function exchangeToken({ apiKey, targetLanguage = 'zh' }) {
  const res = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        model: 'gpt-realtime-translate',
        audio: { output: { language: targetLanguage } },
      },
    }),
  })
  if (!res.ok) {
    const err = new Error(`上游凭证接口返回 ${res.status}`)
    err.status = res.status
    throw err
  }
  const data = await res.json()
  const clientSecret = data.value ?? data.client_secret ?? data.secret
  const expiresAtSec = data.expires_at ?? data.expiresAt ?? 0
  return {
    clientSecret,
    expiresAt: expiresAtSec > 1e12 ? expiresAtSec : expiresAtSec * 1000,
  }
}

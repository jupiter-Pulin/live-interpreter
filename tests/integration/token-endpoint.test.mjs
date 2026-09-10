import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../../src/server/index.mjs'

const FAKE_KEY = 'test-fake-api-key-value'

async function withServer(opts, fn) {
  const server = createServer(opts)
  await new Promise((r) => server.listen(0, r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

test('AC-010 成功签发：clientSecret/expiresAt 齐备且不泄露 apiKey', async () => {
  await withServer(
    {
      backend: 'real',
      apiKey: FAKE_KEY,
      exchangeToken: async () => ({ clientSecret: 'ephemeral-abc', expiresAt: 1893456000000 }),
    },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST' })
      assert.ok(res.ok)
      const text = await res.text()
      const body = JSON.parse(text)
      assert.ok(typeof body.clientSecret === 'string' && body.clientSecret.length > 0)
      assert.notEqual(body.clientSecret, FAKE_KEY)
      assert.equal(typeof body.expiresAt, 'number')
      assert.ok(!text.includes(FAKE_KEY))
    }
  )
})

test('AC-011 缺 apiKey：config_missing 且服务不崩溃', async () => {
  await withServer({ backend: 'real', apiKey: undefined, exchangeToken: async () => ({}) }, async (base) => {
    const res1 = await fetch(`${base}/api/session-token`, { method: 'POST' })
    assert.ok(!res1.ok)
    const body1 = await res1.json()
    assert.equal(body1.category, 'config_missing')
    assert.ok(body1.message.includes('OPENAI_API_KEY'))
    const res2 = await fetch(`${base}/api/session-token`, { method: 'POST' })
    assert.ok(res2.status > 0, '同一实例第二次请求仍应收到 HTTP 响应')
  })
})

test('AC-012 上游 4xx/5xx → api_error；网络错误 → network_unavailable', async () => {
  let apiErrorMessage
  await withServer(
    {
      backend: 'real',
      apiKey: FAKE_KEY,
      exchangeToken: async () => {
        const e = new Error('上游 502')
        e.status = 502
        throw e
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST' })
      const text = await res.text()
      const body = JSON.parse(text)
      assert.equal(body.category, 'api_error')
      assert.ok(!text.includes(FAKE_KEY))
      apiErrorMessage = body.message
    }
  )
  await withServer(
    {
      backend: 'real',
      apiKey: FAKE_KEY,
      exchangeToken: async () => {
        throw new TypeError('fetch failed')
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST' })
      const text = await res.text()
      const body = JSON.parse(text)
      assert.equal(body.category, 'network_unavailable')
      assert.notEqual(body.message, apiErrorMessage)
      assert.ok(!text.includes(FAKE_KEY))
    }
  )
})

test('AC-114 启动令牌：缺失或不符即 401，且绝不调用 exchangeToken', async () => {
  let called = 0
  await withServer(
    {
      backend: 'real',
      apiKey: FAKE_KEY,
      launchToken: 't',
      exchangeToken: async () => {
        called++
        return { clientSecret: 'ephemeral-abc', expiresAt: 1893456000000 }
      },
    },
    async (base) => {
      for (const headers of [undefined, { Authorization: 'Bearer wrong' }, { Authorization: 't' }, { Authorization: '' }]) {
        const res = await fetch(`${base}/api/session-token`, { method: 'POST', headers })
        assert.equal(res.status, 401, `headers=${JSON.stringify(headers)} 应为 401`)
        const body = await res.json()
        assert.equal(body.category, 'api_error')
        assert.ok(body.message.length > 0)
      }
      assert.equal(called, 0, '未授权请求绝不触达上游凭证交换')

      const ok = await fetch(`${base}/api/session-token`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t' },
      })
      assert.ok(ok.ok)
      assert.equal((await ok.json()).clientSecret, 'ephemeral-abc')
      assert.equal(called, 1)
    }
  )
})

test('AC-114 带令牌时现有 500/502 分支不变', async () => {
  await withServer(
    { backend: 'real', apiKey: undefined, launchToken: 't', exchangeToken: async () => ({}) },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST', headers: { Authorization: 'Bearer t' } })
      assert.equal(res.status, 500)
      assert.equal((await res.json()).category, 'config_missing')
    }
  )
  await withServer(
    {
      backend: 'real',
      apiKey: FAKE_KEY,
      launchToken: 't',
      exchangeToken: async () => {
        const e = new Error('上游 502')
        e.status = 502
        throw e
      },
    },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST', headers: { Authorization: 'Bearer t' } })
      assert.equal(res.status, 502)
      assert.equal((await res.json()).category, 'api_error')
    }
  )
  // mock 后端即便令牌正确也不提供真实凭证
  await withServer(
    { backend: 'mock', apiKey: FAKE_KEY, launchToken: 't', exchangeToken: async () => ({}) },
    async (base) => {
      const res = await fetch(`${base}/api/session-token`, { method: 'POST', headers: { Authorization: 'Bearer t' } })
      assert.equal(res.status, 404)
      assert.equal((await res.json()).category, 'config_missing')
    }
  )
})

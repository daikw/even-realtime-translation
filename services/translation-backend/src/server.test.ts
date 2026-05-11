import { describe, expect, it, vi } from 'vitest'
import { computeSafetyIdentifier } from '@even-rt/shared/server'
import { buildServer, type BuildServerOptions } from './server.js'

const baseOptions: BuildServerOptions = {
  logger: false,
  config: {
    port: 3000,
    host: '127.0.0.1',
    openaiApiKey: 'sk-test',
    safetyIdSalt: 'app-salt',
    allowedOrigins: ['http://localhost:5173'],
  },
}

function okOpenAIResponse(value = 'cs_abc', expiresAt = 1700000000): Response {
  return new Response(JSON.stringify({ value, expires_at: expiresAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fetchMock(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response)
}

function fetchRejectMock(err: Error) {
  return vi.fn<typeof fetch>().mockRejectedValue(err)
}

function headersOfCall(
  mock: ReturnType<typeof fetchMock>,
  index: number,
): Record<string, string> {
  const call = mock.mock.calls[index]
  if (!call) throw new Error(`fetch was not called at index ${String(index)}`)
  const init = call[1]
  if (!init) throw new Error('fetch was called without RequestInit')
  return init.headers as Record<string, string>
}

describe('GET /health', () => {
  it('returns 200 with ok flag and version', async () => {
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body: { ok: boolean; version: string } = res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
    expect(body.version.length).toBeGreaterThan(0)
    await app.close()
  })
})

describe('POST /api/openai/realtime/translation/session — success', () => {
  it('returns 200 with clientSecret, expiresAt (ISO), and model', async () => {
    const fetchImpl = fetchMock(okOpenAIResponse('cs_abc', 1700000000))
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: {
        targetLanguage: 'ja',
        sourceHint: 'auto',
        userId: 'user-123',
        client: { appVersion: '0.1.0', device: 'G2' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body: { clientSecret: string; expiresAt?: string; model: string } = res.json()
    expect(body.clientSecret).toBe('cs_abc')
    expect(body.expiresAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(body.model).toBe('gpt-realtime-translate')
    await app.close()
  })

  it('does not leak OPENAI_API_KEY in headers, body, or response', async () => {
    const fetchImpl = fetchMock(okOpenAIResponse())
    const app = buildServer({
      ...baseOptions,
      config: { ...baseOptions.config!, openaiApiKey: 'sk-secret-leak-canary' },
      fetchImpl,
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: {
        targetLanguage: 'ja',
        userId: 'u',
      },
    })
    const serialized = JSON.stringify({ headers: res.headers, body: res.body })
    expect(serialized).not.toContain('sk-secret-leak-canary')
    await app.close()
  })

  it('uses default sourceHint when omitted and works without userId', async () => {
    const fetchImpl = fetchMock(okOpenAIResponse())
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'en' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})

describe('POST /api/openai/realtime/translation/session — validation', () => {
  it('returns 400 for unsupported target language', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'zz' },
    })
    expect(res.statusCode).toBe(400)
    const body: { error: { code: string; message: string } } = res.json()
    expect(body.error.code).toBe('invalid_request')
    expect(fetchImpl).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 400 when target language is "auto"', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'auto' },
    })
    expect(res.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 400 when targetLanguage is missing', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 400 when sourceHint is invalid', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja', sourceHint: 'zz' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 400 when userId is too long', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja', userId: 'x'.repeat(257) },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 400 when client.appVersion is too long', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: {
        targetLanguage: 'ja',
        client: { appVersion: 'x'.repeat(65) },
      },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns 400 when client.device is too long', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: {
        targetLanguage: 'ja',
        client: { device: 'x'.repeat(65) },
      },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /api/openai/realtime/translation/session — upstream errors', () => {
  it('maps upstream 503 to 502 + upstream_error and hides upstream body', async () => {
    const fetchImpl = fetchMock(
      new Response(
        JSON.stringify({ error: { message: 'OpenAI internal failure XYZ' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja' },
    })
    expect(res.statusCode).toBe(502)
    const body: { error: { code: string; message: string } } = res.json()
    expect(body.error.code).toBe('upstream_error')
    expect(body.error.message).toBe('Translation service unavailable')
    expect(res.body).not.toContain('OpenAI internal failure XYZ')
    await app.close()
  })

  it('maps upstream 401 to 502 + auth_error', async () => {
    const fetchImpl = fetchMock(
      new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    )
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja' },
    })
    expect(res.statusCode).toBe(502)
    const body: { error: { code: string } } = res.json()
    expect(body.error.code).toBe('auth_error')
    await app.close()
  })

  it('maps upstream 429 to 429 + rate_limited', async () => {
    const fetchImpl = fetchMock(
      new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    )
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja' },
    })
    expect(res.statusCode).toBe(429)
    const body: { error: { code: string } } = res.json()
    expect(body.error.code).toBe('rate_limited')
    await app.close()
  })

  it('maps fetch-level (network) errors to 502 + upstream_error', async () => {
    const fetchImpl = fetchRejectMock(new Error('ECONNRESET'))
    const app = buildServer({ ...baseOptions, fetchImpl })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja' },
    })
    expect(res.statusCode).toBe(502)
    const body: { error: { code: string } } = res.json()
    expect(body.error.code).toBe('upstream_error')
    expect(res.body).not.toContain('ECONNRESET')
    await app.close()
  })
})

describe('POST /api/openai/realtime/translation/session — safety identifier', () => {
  it('uses the anonymous baseline when userId is omitted', async () => {
    const fetchImpl = fetchMock(okOpenAIResponse())
    const app = buildServer({ ...baseOptions, fetchImpl })
    await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja' },
    })
    const expected = await computeSafetyIdentifier('app-salt', 'anonymous')
    const headers = headersOfCall(fetchImpl, 0)
    expect(headers['OpenAI-Safety-Identifier']).toBe(expected)
    await app.close()
  })

  it('produces different safety ids for different userIds and never includes raw userId', async () => {
    const fetchImpl = fetchMock(okOpenAIResponse())
    const app = buildServer({ ...baseOptions, fetchImpl })

    await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja', userId: 'alice@example.com' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      payload: { targetLanguage: 'ja', userId: 'bob@example.com' },
    })

    const aliceHeaders = headersOfCall(fetchImpl, 0)
    const bobHeaders = headersOfCall(fetchImpl, 1)
    const aliceId = aliceHeaders['OpenAI-Safety-Identifier']!
    const bobId = bobHeaders['OpenAI-Safety-Identifier']!
    expect(aliceId).not.toBe(bobId)
    expect(aliceId).toBe(await computeSafetyIdentifier('app-salt', 'alice@example.com'))
    expect(bobId).toBe(await computeSafetyIdentifier('app-salt', 'bob@example.com'))

    // Raw userId must never be sent to OpenAI in the headers or body.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1]
      if (!init) continue
      const headers = init.headers as Record<string, string>
      expect(JSON.stringify(headers)).not.toContain('alice@example.com')
      expect(JSON.stringify(headers)).not.toContain('bob@example.com')
      const body = init.body as string
      expect(body).not.toContain('alice@example.com')
      expect(body).not.toContain('bob@example.com')
    }

    await app.close()
  })
})

describe('CORS', () => {
  it('reflects allowed origin', async () => {
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    await app.close()
  })

  it('does not reflect disallowed origin', async () => {
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://evil.example.com',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })
})

describe('global error handling', () => {
  it('returns structured 400 for malformed JSON body', async () => {
    const app = buildServer({ ...baseOptions, fetchImpl: vi.fn<typeof fetch>() })
    const res = await app.inject({
      method: 'POST',
      url: '/api/openai/realtime/translation/session',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    })
    expect(res.statusCode).toBe(400)
    const body: { error: { code: string } } = res.json()
    expect(body.error.code).toBe('invalid_request')
    await app.close()
  })

  it('returns structured 429 once the per-route rate limit is exceeded', async () => {
    // Fresh Response per call: Response bodies are single-use streams.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(okOpenAIResponse()))
    const app = buildServer({ ...baseOptions, fetchImpl })
    let lastStatus = 0
    let lastBody = ''
    // The session route's per-route limit is 20/min. Fire 25 requests to
    // overrun it (inject() uses a constant fake IP, so all share a key).
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/openai/realtime/translation/session',
        payload: { targetLanguage: 'ja' },
      })
      lastStatus = res.statusCode
      lastBody = res.body
    }
    expect(lastStatus).toBe(429)
    const parsed = JSON.parse(lastBody) as { error: { code: string } }
    expect(parsed.error.code).toBe('rate_limited')
    await app.close()
  })
})

describe('POST /api/events', () => {
  it('returns 204 No Content', async () => {
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { kind: 'session_start', sessionId: 'abc' },
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    await app.close()
  })

  it('accepts an empty body', async () => {
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({ method: 'POST', url: '/api/events' })
    expect(res.statusCode).toBe(204)
    await app.close()
  })
})

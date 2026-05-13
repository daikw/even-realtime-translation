import { describe, expect, it } from 'vitest'

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
    const app = buildServer({ ...baseOptions })
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    })
    expect(res.statusCode).toBe(400)
    const body: { error: { code: string } } = res.json()
    expect(body.error.code).toBe('invalid_request')
    await app.close()
  })

  it('returns structured 429 once the global rate limit is exceeded', async () => {
    const app = buildServer({ ...baseOptions })
    let lastStatus = 0
    let lastBody = ''
    // Global limit is 60/min — fire 65 requests against /health to exceed.
    for (let i = 0; i < 65; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/health' })
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

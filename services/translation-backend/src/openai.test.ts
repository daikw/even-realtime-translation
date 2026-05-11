import { describe, expect, it, vi } from 'vitest'
import { mapUpstreamError, requestClientSecret } from './openai.js'

function makeFetchMock(response: Response) {
  return vi.fn<typeof fetch>().mockResolvedValue(response)
}

function makeFetchRejectMock(err: Error) {
  return vi.fn<typeof fetch>().mockRejectedValue(err)
}

describe('requestClientSecret', () => {
  it('posts to OpenAI client_secrets endpoint with correct headers and body', async () => {
    const fetchImpl = makeFetchMock(
      new Response(JSON.stringify({ value: 'cs_abc', expires_at: 1700000000 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const out = await requestClientSecret({
      apiKey: 'sk-test',
      safetyId: 'safety-hash',
      targetLanguage: 'ja',
      fetchImpl,
    })

    expect(out.clientSecret).toBe('cs_abc')
    // OpenAI returns `expires_at` as unix seconds; we surface ISO-8601.
    expect(out.expiresAt).toBe(new Date(1700000000 * 1000).toISOString())

    expect(fetchImpl).toHaveBeenCalledOnce()
    const call = fetchImpl.mock.calls[0]!
    const url = call[0]
    const init = call[1]!
    expect(url).toBe('https://api.openai.com/v1/realtime/translations/client_secrets')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['OpenAI-Safety-Identifier']).toBe('safety-hash')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      session: {
        model: 'gpt-realtime-translate',
        audio: { output: { language: 'ja' } },
      },
    })
  })

  it('falls back to `secret` field when `value` is missing', async () => {
    const fetchImpl = makeFetchMock(
      new Response(JSON.stringify({ secret: 'cs_alt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const out = await requestClientSecret({
      apiKey: 'sk-test',
      safetyId: 'safety-hash',
      targetLanguage: 'en',
      fetchImpl,
    })
    expect(out.clientSecret).toBe('cs_alt')
    expect(out.expiresAt).toBeUndefined()
  })

  it('throws an UpstreamError on non-2xx response', async () => {
    const fetchImpl = makeFetchMock(
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(
      requestClientSecret({
        apiKey: 'sk-test',
        safetyId: 'safety-hash',
        targetLanguage: 'ja',
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 503 })
  })

  it('throws when the response body is not parseable JSON', async () => {
    const fetchImpl = makeFetchMock(
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )
    await expect(
      requestClientSecret({
        apiKey: 'sk-test',
        safetyId: 'safety-hash',
        targetLanguage: 'ja',
        fetchImpl,
      }),
    ).rejects.toThrow()
  })

  it('throws when neither `value` nor `secret` is present', async () => {
    const fetchImpl = makeFetchMock(
      new Response(JSON.stringify({ unrelated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(
      requestClientSecret({
        apiKey: 'sk-test',
        safetyId: 'safety-hash',
        targetLanguage: 'ja',
        fetchImpl,
      }),
    ).rejects.toThrow()
  })

  it('rethrows fetch-level network errors as-is', async () => {
    const fetchImpl = makeFetchRejectMock(new Error('ECONNRESET'))
    await expect(
      requestClientSecret({
        apiKey: 'sk-test',
        safetyId: 'safety-hash',
        targetLanguage: 'ja',
        fetchImpl,
      }),
    ).rejects.toThrow('ECONNRESET')
  })
})

describe('mapUpstreamError', () => {
  it('maps 401 to auth_error / 502', () => {
    expect(mapUpstreamError(401)).toEqual({
      status: 502,
      code: 'auth_error',
      message: 'Translation service unavailable',
    })
  })

  it('maps 403 to auth_error / 502', () => {
    expect(mapUpstreamError(403)).toEqual({
      status: 502,
      code: 'auth_error',
      message: 'Translation service unavailable',
    })
  })

  it('maps 429 to rate_limited / 429', () => {
    expect(mapUpstreamError(429)).toEqual({
      status: 429,
      code: 'rate_limited',
      message: 'Too many sessions. Please try again later.',
    })
  })

  it('maps 5xx to upstream_error / 502', () => {
    expect(mapUpstreamError(503)).toEqual({
      status: 502,
      code: 'upstream_error',
      message: 'Translation service unavailable',
    })
  })

  it('maps unknown statuses to upstream_error / 502', () => {
    expect(mapUpstreamError(418)).toEqual({
      status: 502,
      code: 'upstream_error',
      message: 'Translation service unavailable',
    })
  })
})

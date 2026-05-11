import { describe, expect, it, vi } from 'vitest'

import type { TranslationSessionRequest } from '@even-rt/shared'

import { TranslationApiError, createTranslationSession } from './apiClient.js'

const validRequest: TranslationSessionRequest = {
  targetLanguage: 'ja',
  sourceHint: 'auto',
  userId: 'anonymous',
  client: { appVersion: '0.1.0', device: 'G2' },
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('createTranslationSession', () => {
  it('POSTs the JSON request body and returns the parsed response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        clientSecret: 'sk-ephemeral',
        expiresAt: '2026-01-01T00:00:00Z',
        model: 'gpt-realtime-translate',
      }),
    )
    const result = await createTranslationSession({
      backendUrl: 'http://localhost:3000',
      request: validRequest,
      fetchImpl,
    })

    expect(result.clientSecret).toBe('sk-ephemeral')
    expect(result.model).toBe('gpt-realtime-translate')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:3000/api/openai/realtime/translation/session')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init?.body).toBe(JSON.stringify(validRequest))
  })

  it('strips trailing slashes from backendUrl', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        clientSecret: 'x',
        expiresAt: '2026-01-01T00:00:00Z',
        model: 'm',
      }),
    )
    await createTranslationSession({
      backendUrl: 'http://localhost:3000///',
      request: validRequest,
      fetchImpl,
    })
    const [url] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:3000/api/openai/realtime/translation/session')
  })

  it('throws TranslationApiError on 4xx with structured body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'rate_limited', message: 'Too many sessions' } },
        { status: 429 },
      ),
    )
    await expect(
      createTranslationSession({
        backendUrl: 'http://localhost:3000',
        request: validRequest,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'rate_limited',
      status: 429,
    })
  })

  it('falls back to http_<status> when 4xx body is not structured', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('not json', { status: 500 }),
    )
    await expect(
      createTranslationSession({
        backendUrl: 'http://localhost:3000',
        request: validRequest,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'http_500',
      status: 500,
    })
  })

  it('throws TranslationApiError("network_error") when fetch rejects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('offline'))
    await expect(
      createTranslationSession({
        backendUrl: 'http://localhost:3000',
        request: validRequest,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'network_error',
    })
  })

  it('throws TranslationApiError("invalid_response") when response is malformed JSON', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
    await expect(
      createTranslationSession({
        backendUrl: 'http://localhost:3000',
        request: validRequest,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'invalid_response',
    })
  })

  it('throws TranslationApiError("invalid_response") when response misses clientSecret', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ model: 'm' }))
    await expect(
      createTranslationSession({
        backendUrl: 'http://localhost:3000',
        request: validRequest,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'invalid_response',
    })
  })

  it('TranslationApiError exposes code and optional status', () => {
    const e = new TranslationApiError('code', 'msg', 418)
    expect(e.code).toBe('code')
    expect(e.message).toBe('msg')
    expect(e.status).toBe(418)
    expect(e.name).toBe('TranslationApiError')
  })

  it('passes through expiresAt when the backend returns one', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        clientSecret: 'cs',
        expiresAt: '2026-05-08T12:34:56Z',
        model: 'gpt-realtime-translate',
      }),
    )
    const result = await createTranslationSession({
      backendUrl: 'http://localhost:3000',
      request: validRequest,
      fetchImpl,
    })
    expect(result.expiresAt).toBe('2026-05-08T12:34:56Z')
  })

  it('omits expiresAt (undefined) when the backend does not return one', async () => {
    // The backend may legitimately omit expiresAt when OpenAI's upstream
    // client_secrets response lacks `expires_at`. Forward as undefined so
    // callers can distinguish "unknown" from "empty string".
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        clientSecret: 'cs',
        model: 'gpt-realtime-translate',
      }),
    )
    const result = await createTranslationSession({
      backendUrl: 'http://localhost:3000',
      request: validRequest,
      fetchImpl,
    })
    expect(result.expiresAt).toBeUndefined()
  })

  it('omits expiresAt (undefined) when the backend returns a non-string value', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        clientSecret: 'cs',
        expiresAt: 12345 as unknown as string,
        model: 'gpt-realtime-translate',
      }),
    )
    const result = await createTranslationSession({
      backendUrl: 'http://localhost:3000',
      request: validRequest,
      fetchImpl,
    })
    expect(result.expiresAt).toBeUndefined()
  })
})

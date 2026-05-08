/**
 * End-to-end contract test between the Fastify backend and the WebView
 * `apiClient`. Both halves are exercised through their public entrypoints:
 *
 *  1. `buildServer({ config, fetchImpl })` boots a real Fastify instance
 *     listening on a random port. OpenAI itself is still mocked through
 *     `fetchImpl` so we never hit the network during CI.
 *  2. `createTranslationSession({ backendUrl, request, fetchImpl: fetch })`
 *     calls the backend over real HTTP through the platform `fetch`.
 *
 * The shape of the success/error responses is the contract that
 * `services/translation-backend` and `apps/evenhub-app/src/backend/apiClient`
 * have to agree on; if either side drifts, this suite breaks.
 */
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TranslationApiError,
  createTranslationSession,
} from '../../../../apps/evenhub-app/src/backend/apiClient.js'
import { buildServer, type BuildServerOptions } from '../../src/server.js'

const baseConfig: NonNullable<BuildServerOptions['config']> = {
  port: 0,
  openaiApiKey: 'sk-test',
  safetyIdSalt: 'integration-salt',
  allowedOrigins: ['http://localhost:5173'],
}

function okOpenAIResponse(value = 'cs_int', expiresAt = 1700000000): Response {
  return new Response(JSON.stringify({ value, expires_at: expiresAt }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function startServer(opts: BuildServerOptions): Promise<{
  app: FastifyInstance
  baseUrl: string
}> {
  const app = buildServer(opts)
  // Bind to ephemeral port and loopback only so concurrent test workers can
  // each grab their own slot.
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address() as AddressInfo
  return { app, baseUrl: `http://127.0.0.1:${String(address.port)}` }
}

describe('integration: backend + apiClient over real HTTP', () => {
  let app: FastifyInstance | null = null

  beforeEach(() => {
    app = null
  })
  afterEach(async () => {
    if (app !== null) {
      await app.close()
      app = null
    }
  })

  it('returns clientSecret/expiresAt(ISO)/model on the happy path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(okOpenAIResponse('cs_int', 1700000000))
    const started = await startServer({ logger: false, config: baseConfig, fetchImpl })
    app = started.app

    const result = await createTranslationSession({
      backendUrl: started.baseUrl,
      request: {
        targetLanguage: 'ja',
        sourceHint: 'auto',
        userId: 'integration-user',
        client: { appVersion: '0.1.0', device: 'G2' },
      },
      fetchImpl: fetch,
    })

    expect(result.clientSecret).toBe('cs_int')
    expect(result.expiresAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(result.model).toBe('gpt-realtime-translate')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // The upstream call was authorized with our API key — the backend is the
    // only place that ever sees it.
    const upstreamInit = fetchImpl.mock.calls[0]?.[1]
    const headers = upstreamInit?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    // Raw user id never leaks upstream — replaced by the safety identifier.
    expect(JSON.stringify(headers)).not.toContain('integration-user')
    const body = upstreamInit?.body
    expect(typeof body === 'string' ? body : '').not.toContain('integration-user')
  })

  it('400 invalid_request: unsupported targetLanguage surfaces as TranslationApiError', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const started = await startServer({ logger: false, config: baseConfig, fetchImpl })
    app = started.app

    await expect(
      createTranslationSession({
        backendUrl: started.baseUrl,
        // The backend rejects 'auto' as a target — apiClient should propagate
        // the structured error code without retrying.
        request: {
          targetLanguage: 'auto',
          sourceHint: 'auto',
          userId: 'u',
          client: { appVersion: '0.1.0', device: 'G2' },
        },
        fetchImpl: fetch,
      }),
    ).rejects.toMatchObject({
      name: 'TranslationApiError',
      code: 'invalid_request',
      status: 400,
    })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('upstream 429 maps to TranslationApiError(rate_limited, status=429)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }),
    )
    const started = await startServer({ logger: false, config: baseConfig, fetchImpl })
    app = started.app

    let captured: TranslationApiError | null = null
    try {
      await createTranslationSession({
        backendUrl: started.baseUrl,
        request: {
          targetLanguage: 'ja',
          sourceHint: 'auto',
          userId: 'u',
          client: { appVersion: '0.1.0', device: 'G2' },
        },
        fetchImpl: fetch,
      })
    } catch (err) {
      if (err instanceof TranslationApiError) captured = err
    }
    expect(captured).not.toBeNull()
    expect(captured?.code).toBe('rate_limited')
    expect(captured?.status).toBe(429)
  })

  it('GET /health returns ok flag and a non-empty version string', async () => {
    // /health is the smoke endpoint deploys hit. Going through real fetch
    // confirms Fastify's startup, route registration, and JSON encoder all
    // work together.
    const started = await startServer({ logger: false, config: baseConfig })
    app = started.app

    const res = await fetch(`${started.baseUrl}/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(body.version.length).toBeGreaterThan(0)
  })
})

import type { TranslationSessionRequest, TranslationSessionResponse } from '@even-rt/shared'

/**
 * Error thrown by {@link createTranslationSession}.
 *
 * `code` is the canonical machine-readable identifier:
 *  - structured backend error → use the body's `error.code`
 *  - HTTP non-2xx with no/unexpected body → `http_<status>`
 *  - fetch network failure → `network_error`
 *  - malformed body or missing `clientSecret` → `invalid_response`
 */
export class TranslationApiError extends Error {
  readonly code: string
  readonly status: number | undefined

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'TranslationApiError'
    this.code = code
    this.status = status
  }
}

const SESSION_PATH = '/api/openai/realtime/translation/session'

interface BackendErrorBody {
  error?: { code?: unknown; message?: unknown }
}

interface SessionResponseBody {
  clientSecret?: unknown
  expiresAt?: unknown
  model?: unknown
}

export interface CreateTranslationSessionOptions {
  backendUrl: string
  request: TranslationSessionRequest
  fetchImpl?: typeof fetch
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal
}

function stripTrailingSlash(url: string): string {
  // Defensive: tolerate accidental `localhost:3000/` or `/api/` suffix in env config.
  return url.replace(/\/+$/, '')
}

function isStructuredError(value: unknown): value is BackendErrorBody {
  if (typeof value !== 'object' || value === null) return false
  return 'error' in value
}

/**
 * POST a translation session request to the backend (§13.1).
 *
 * The backend brokers OpenAI's short-lived client secret — the WebView never
 * holds a long-lived API key (§10.1). This client therefore stores nothing,
 * only forwards the response.
 */
export async function createTranslationSession(
  opts: CreateTranslationSessionOptions,
): Promise<TranslationSessionResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${stripTrailingSlash(opts.backendUrl)}${SESSION_PATH}`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts.request),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    throw new TranslationApiError(
      'network_error',
      err instanceof Error ? `Backend unavailable: ${err.message}` : 'Backend unavailable',
    )
  }

  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = (await response.json()) as unknown
    } catch {
      // Non-JSON error body — fall through to default.
    }
    if (isStructuredError(payload)) {
      const code = typeof payload.error?.code === 'string' ? payload.error.code : `http_${String(response.status)}`
      const message =
        typeof payload.error?.message === 'string'
          ? payload.error.message
          : `Backend error ${String(response.status)}`
      throw new TranslationApiError(code, message, response.status)
    }
    throw new TranslationApiError(
      `http_${String(response.status)}`,
      `Backend error ${String(response.status)}`,
      response.status,
    )
  }

  let body: unknown
  try {
    body = (await response.json()) as unknown
  } catch (err) {
    throw new TranslationApiError(
      'invalid_response',
      err instanceof Error ? `Malformed JSON: ${err.message}` : 'Malformed JSON',
      response.status,
    )
  }

  if (typeof body !== 'object' || body === null) {
    throw new TranslationApiError('invalid_response', 'Response was not an object', response.status)
  }
  const candidate = body as SessionResponseBody
  if (typeof candidate.clientSecret !== 'string' || candidate.clientSecret.length === 0) {
    throw new TranslationApiError(
      'invalid_response',
      'Response missing clientSecret',
      response.status,
    )
  }
  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    throw new TranslationApiError('invalid_response', 'Response missing model', response.status)
  }

  // expiresAt is documented as required (§13.1) but the backend currently omits
  // it when OpenAI doesn't return one. Treat missing/non-string as invalid here
  // so callers always get a usable timestamp.
  const expiresAt = typeof candidate.expiresAt === 'string' ? candidate.expiresAt : ''

  return {
    clientSecret: candidate.clientSecret,
    expiresAt,
    model: candidate.model,
  }
}

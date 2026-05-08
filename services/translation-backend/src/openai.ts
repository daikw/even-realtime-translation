import type { LanguageCode } from '@even-rt/shared'

const OPENAI_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/translations/client_secrets'

export const TRANSLATION_MODEL = 'gpt-realtime-translate'

export interface RequestClientSecretInput {
  apiKey: string
  safetyId: string
  targetLanguage: LanguageCode
  /** Inject for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch
}

export interface ClientSecret {
  clientSecret: string
  /** ISO-8601 expiry, when the upstream supplied one. */
  expiresAt?: string
}

/**
 * Error thrown when the upstream OpenAI API returns a non-2xx response. The
 * raw upstream body is intentionally **not** propagated — the caller must
 * translate this into a sanitized `ApiError` via {@link mapUpstreamError}.
 */
export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? `Upstream returned ${String(status)}`)
    this.name = 'UpstreamError'
  }
}

interface OpenAIClientSecretBody {
  // OpenAI's stable response field is `value` (per design §21.1). Some preview
  // builds use `secret` — accept either, but never log the value itself.
  value?: string
  secret?: string
  expires_at?: number
}

function isClientSecretBody(value: unknown): value is OpenAIClientSecretBody {
  return typeof value === 'object' && value !== null
}

export async function requestClientSecret(input: RequestClientSecretInput): Promise<ClientSecret> {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'OpenAI-Safety-Identifier': input.safetyId,
    },
    body: JSON.stringify({
      session: {
        model: TRANSLATION_MODEL,
        audio: { output: { language: input.targetLanguage } },
      },
    }),
  })

  if (!response.ok) {
    // Drain the body so the connection can be reused, but discard it: we do
    // NOT propagate upstream messages downstream (PII / leak risk).
    try {
      await response.text()
    } catch {
      // ignore
    }
    throw new UpstreamError(response.status)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('Upstream returned a non-JSON success response')
  }
  if (!isClientSecretBody(body)) {
    throw new Error('Upstream success response had unexpected shape')
  }
  const clientSecret = body.value ?? body.secret
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new Error('Upstream success response did not include a client secret')
  }
  const result: ClientSecret = { clientSecret }
  if (typeof body.expires_at === 'number' && Number.isFinite(body.expires_at)) {
    result.expiresAt = new Date(body.expires_at * 1000).toISOString()
  }
  return result
}

export interface MappedError {
  status: number
  code: 'auth_error' | 'rate_limited' | 'upstream_error'
  message: string
}

/**
 * Maps an upstream HTTP status to a sanitized response. We never expose the
 * upstream message verbatim because OpenAI error bodies can include API keys,
 * org ids, or partial prompts in edge cases.
 */
export function mapUpstreamError(status: number): MappedError {
  if (status === 401 || status === 403) {
    return {
      status: 502,
      code: 'auth_error',
      message: 'Translation service unavailable',
    }
  }
  if (status === 429) {
    return {
      status: 429,
      code: 'rate_limited',
      message: 'Too many sessions. Please try again later.',
    }
  }
  return {
    status: 502,
    code: 'upstream_error',
    message: 'Translation service unavailable',
  }
}

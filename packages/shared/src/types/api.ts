import type { LanguageCode } from './state.js'

/** POST /api/openai/realtime/translation/session — request body. See §13.1. */
export interface TranslationSessionRequest {
  targetLanguage: LanguageCode
  sourceHint: LanguageCode
  /** Even Hub user id. Use `'anonymous'` when no signed-in user is available. */
  userId: string
  client: {
    appVersion: string
    device: string
  }
}

/** POST /api/openai/realtime/translation/session — success response. */
export interface TranslationSessionResponse {
  clientSecret: string
  /** ISO-8601 expiry timestamp for the short-lived OpenAI client secret. */
  expiresAt: string
  model: string
}

export interface ApiError {
  error: {
    code: string
    message: string
  }
}

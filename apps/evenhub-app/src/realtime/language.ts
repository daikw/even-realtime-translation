import type { LanguageCode } from '@even-rt/shared'

/**
 * Concrete (non-auto) target language. The OpenAI Realtime translation API
 * requires a fixed output language; `auto` is only meaningful for source
 * detection upstream.
 */
export type OutputLanguageCode = Exclude<LanguageCode, 'auto'>

/**
 * Wire-format JSON event sent over the `oai-events` data channel to switch the
 * translation output language mid-session. Mirrors the OpenAI Realtime
 * `session.update` event shape (see design doc §6.3 / §14.1, and §21.1 for
 * the matching client-secret payload).
 */
export interface SessionUpdateClientEvent {
  type: 'session.update'
  session: {
    audio: {
      output: {
        language: OutputLanguageCode
      }
    }
  }
}

export function buildSessionUpdateEvent(targetLanguage: LanguageCode): SessionUpdateClientEvent {
  if (targetLanguage === 'auto') {
    throw new Error("buildSessionUpdateEvent: target 'auto' is not a valid output language")
  }
  return {
    type: 'session.update',
    session: { audio: { output: { language: targetLanguage } } },
  }
}

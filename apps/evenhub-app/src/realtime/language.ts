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
 *
 * TODO (API contract verification):
 * The `session.audio.output.language` payload key is from the OpenAI Realtime
 * *Translation* preview spec. It has NOT yet been confirmed against a live
 * session. When running the manual smoke checklist in `docs/test-plan.md`
 * ("API contract smoke"), capture the actual `session.update` payload that
 * makes the upstream switch languages on the fly; update the shape here if
 * upstream now expects e.g. `session.target_language` or a different nesting.
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

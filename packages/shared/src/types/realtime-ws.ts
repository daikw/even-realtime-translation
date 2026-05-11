/**
 * Typed protocol for the **frontend ↔ backend** WebSocket proxy that fronts
 * the OpenAI Realtime Translation API.
 *
 * Boundary note: this is the *internal* wire format. The backend translates
 * client `audio` → upstream `session.input_audio_buffer.append`, `close` →
 * upstream `session.close`, etc. See `docs/phase2-migration-plan.md` §2.1 and
 * §3 T2.2. The `session.` prefix on OpenAI's client→server events is upstream-
 * facing; we deliberately keep this internal protocol short and human-readable
 * so the frontend doesn't have to care about upstream naming.
 *
 * Stay defensive when widening this union — the backend mirrors fields
 * verbatim from upstream where it can (transcript text, audio bytes) but
 * never propagates upstream error messages (PII / key-leak risk; see
 * `services/translation-backend/src/openai.ts` for the existing pattern).
 */

import type { LanguageCode } from './state.js'

// ──────────────────────────────────────────────────────────────────────────
// Client → server messages.
// ──────────────────────────────────────────────────────────────────────────

/**
 * First message after WebSocket upgrade. The backend uses it to initialise
 * the upstream `session.update` payload (transcription model, noise reduction,
 * output language).
 */
export interface ClientWsOpen {
  type: 'open'
  targetLanguage: LanguageCode
}

/**
 * A single mic chunk encoded as base64 PCM16 24 kHz mono. The frontend is
 * expected to resample 16 kHz → 24 kHz with `resample16to24` before encoding.
 * Backend forwards verbatim as `session.input_audio_buffer.append`.
 */
export interface ClientWsAudio {
  type: 'audio'
  pcm: string
}

/**
 * Mid-session target-language change (e.g. user rotates with G2 swipe).
 * Backend re-emits a `session.update` to the upstream session.
 */
export interface ClientWsLanguage {
  type: 'language'
  target: LanguageCode
}

/**
 * Graceful shutdown. Backend forwards `session.close` to OpenAI and holds the
 * upstream WS open for ~6 s afterwards so trailing transcript / audio deltas
 * can flush (T0.1 finding §10.3).
 */
export interface ClientWsClose {
  type: 'close'
}

export type ClientWsMessage = ClientWsOpen | ClientWsAudio | ClientWsLanguage | ClientWsClose

// ──────────────────────────────────────────────────────────────────────────
// Server → client messages.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sent once the upstream session is open. `meta` exists strictly for debug —
 * UI code should not consume `upstreamSessionId` because it leaks an
 * implementation detail. Logged to the dev console in development builds.
 */
export interface ServerWsSessionCreated {
  type: 'session.created'
  meta: {
    upstreamSessionId?: string
    model: string
    targetLanguage: LanguageCode
  }
}

/**
 * Partial transcript delta. `source: 'input'` is the recognised source-language
 * text (English when user speaks English), `'output'` is the translated text.
 * `text` is the raw delta — concat in order to form a segment.
 */
export interface ServerWsTranscriptDelta {
  type: 'transcript.delta'
  source: 'input' | 'output'
  text: string
  /** Upstream item id when available; used to correlate deltas into segments. */
  itemId?: string
}

/**
 * Translated audio delta. Variable-length base64 PCM16 24 kHz mono — T0.1
 * observed 19200 bytes (400 ms) fixed frames empirically but the protocol
 * stays variable-length-aware so we survive an upstream change without a
 * client-side rebuild.
 */
export interface ServerWsAudioDelta {
  type: 'audio.delta'
  pcm: string
}

/**
 * Sanitised error. `message` is a human-readable description with PII and
 * upstream identifiers scrubbed; `code` is one of a fixed enumeration the
 * backend maintains (see `mapUpstreamError` in `openai.ts`). UI surfaces
 * `message`; telemetry can branch on `code`.
 */
export interface ServerWsError {
  type: 'error'
  code: string
  message: string
}

export type ServerWsMessage =
  | ServerWsSessionCreated
  | ServerWsTranscriptDelta
  | ServerWsAudioDelta
  | ServerWsError

/**
 * Transport-agnostic translation runtime — the abstraction the App layer
 * talks to (docs/phase2-migration-plan.md §3 T5.1).
 *
 * Why this layer exists:
 *   The Phase 1 codebase wired `acquireMic`, `createSession`, and
 *   `createRtcClient` directly through `AppDeps`. That coupling makes
 *   rollback fragile — switching transports requires touching the App's
 *   state machine, the test seams, and the reconnect controller all at
 *   once. By collapsing the session lifecycle behind `TranslationRuntime`,
 *   AppDeps takes a single \`translationRuntime: TranslationRuntimeFactory\`
 *   and the choice of WS vs. WebRTC becomes a one-line swap at config
 *   resolution time.
 *
 * The runtime owns every external resource a session needs:
 *   - microphone acquisition (bridge.audioControl or getUserMedia)
 *   - transport (WebSocket or RTCPeerConnection)
 *   - reconnect bookkeeping
 *   - optional audio output
 *
 * Each \`factory.create()\` returns a runtime for a single session. After
 * \`stop()\` the runtime is single-shot; the App requests a new one for the
 * next session.
 */

import type { ConnectionStatus, LanguageCode, TranscriptDelta } from '@even-rt/shared'

/** Concrete output target. `auto` is a valid source hint but never a target. */
export type TargetLanguageCode = Exclude<LanguageCode, 'auto'>

export interface TranslationRuntimeStartOpts {
  targetLanguage: TargetLanguageCode
  /** Source-language hint. The WS runtime currently **ignores** this — the
   * backend WS relay does not yet accept a source hint in its
   * \`session.update\` payload (Codex review M-1). The WebRTC runtime
   * forwards it through \`createSession\` for the legacy client_secret
   * flow. */
  sourceHint: LanguageCode
  /** Translated text deltas (target language). */
  onOutputTranscriptDelta: (delta: TranscriptDelta) => void
  /** Source-language transcription deltas (recognised speech). Optional. */
  onInputTranscriptDelta?: (delta: TranscriptDelta) => void
  /** 24 kHz PCM16 mono audio frames. Only the WS runtime emits these today
   * (T6 / M3+). The WebRTC runtime attaches audio out through an internal
   * HTMLAudioElement and does not call this. */
  onAudioDelta?: (samples: Int16Array) => void
  /** Transport-level connection state changes (connecting → connected → …). */
  onStateChange: (state: ConnectionStatus) => void
  /** Observability hook — terminal errors are also surfaced via state='failed'. */
  onError?: (err: Error) => void
}

export interface TranslationRuntime {
  /**
   * Open the upstream session. Resolves once the runtime has reached
   * `connected` for the first time (or once an in-progress reconnect
   * converges). Rejects on terminal failure (e.g. mic permission denied,
   * backend unreachable from the get-go).
   *
   * Implementations are expected to be re-entry-safe: a second \`start()\`
   * while one is in flight returns the same Promise.
   */
  start(opts: TranslationRuntimeStartOpts): Promise<void>

  /** Tear down the session. Idempotent. */
  stop(): Promise<void>

  /** Mid-session target-language change. No-op if not currently live. */
  sendLanguageUpdate(target: TargetLanguageCode): void
}

export interface TranslationRuntimeFactory {
  /** Build a fresh runtime. Called once per session. */
  create(): TranslationRuntime
}

/** Sentinel error subtype so the App can branch on mic permission denials
 * without parsing browser-specific name strings — the WebRTC runtime
 * already maps this via `MicPermissionDeniedError`, the WS runtime maps
 * any bridge-audioControl failure to the same shape so App.ts treats both
 * transports uniformly. */
export class MicPermissionError extends Error {
  constructor(message = 'mic permission denied', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MicPermissionError'
  }
}

/** Sentinel error subtype so the App can distinguish backend rejections
 * (e.g. rate limit) from transport faults. The WebRTC runtime maps
 * `TranslationApiError` to this; the WS runtime maps backend-emitted
 * upstream_error / auth_error frames. */
export class BackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'BackendError'
  }
}

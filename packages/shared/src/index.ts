// Type re-exports (must use `export type` under verbatimModuleSyntax-style
// boundaries so consumers don't accidentally import nothing at runtime).
export type {
  AppState,
  AppStatus,
  ConnectionStatus,
  LanguageCode,
  LanguagePair,
} from './types/state.js'
export type {
  RealtimeServerEvent,
  SubtitleSegment,
  TranscriptDelta,
} from './types/translation.js'
export type {
  ApiError,
  TranslationSessionRequest,
  TranslationSessionResponse,
} from './types/api.js'

// Runtime exports.
export {
  DEFAULT_LANGUAGE_PAIR,
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  isLanguageCode,
  nextTargetLanguage,
} from './language.js'
export { breakLines, charWidth, stringWidth, truncate } from './formatting/lineBreak.js'
export { findSegmentBoundary } from './formatting/segmentBoundary.js'
export { bytesToSamplesLE, resample16to24, samplesToBytesLE } from './audio/pcm.js'
// `computeSafetyIdentifier` is server-only — import it from
// `@even-rt/shared/server` to keep `node:crypto` out of browser bundles.

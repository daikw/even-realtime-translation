/**
 * Application state types for the Even G2 realtime translation HUD.
 * Mirrors §7.1 of the design doc.
 */
export type AppStatus =
  | 'booting'
  | 'permission_required'
  | 'idle'
  | 'connecting'
  | 'live'
  | 'paused'
  | 'reconnecting'
  | 'error'
  | 'exiting'

/**
 * Lower-level transport / WebRTC connection state. Distinct from {@link AppStatus}
 * so the UI layer can show "Reconnecting" while the high-level app is still
 * considered live.
 */
export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed'

/** ISO 639-1 language codes supported by the MVP, plus the special value `auto`. */
export type LanguageCode = 'auto' | 'en' | 'ja' | 'es' | 'fr' | 'ko'

/**
 * Source/target language pair. `source` may be `auto` (let the model detect),
 * but `target` should be a concrete language for predictable G2 rendering.
 */
export interface LanguagePair {
  source: LanguageCode
  target: LanguageCode
}

export interface AppState {
  status: AppStatus
  languagePair: LanguagePair
  connection: ConnectionStatus
}

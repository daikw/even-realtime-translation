import {
  DEFAULT_LANGUAGE_PAIR,
  type AppStatus,
  type ConnectionStatus,
  type LanguagePair,
} from '@even-rt/shared'

/**
 * Re-export the canonical {@link AppStatus} and connection types for app-level
 * consumers; the rest of the state shape is owned here because the design
 * doc's runtime view (§7.1, §15) carries fields — `elapsedSeconds`,
 * `activeSubtitle`, `error`, `sessionStartedAt` — that are not part of the
 * shared cross-package contract.
 */
export type { AppStatus, ConnectionStatus, LanguagePair } from '@even-rt/shared'

export interface AppErrorInfo {
  code: string
  message: string
}

/**
 * In-app state carried through {@link import('./reducer.js').appReducer}.
 *
 * - `elapsedSeconds` is updated by `TICK` actions; it stays at 0 until a
 *   session is `connected` (`sessionStartedAt` is set), so reconnecting
 *   doesn't reset the clock.
 * - `activeSubtitle` mirrors the SubtitleBuffer's most recent rendered text;
 *   the reducer is the single source of truth for what the HUD displays.
 * - `error` is null in healthy states; the `ERROR` action populates it and
 *   transitions `status` to `'error'`. `CLEAR_ERROR` resets it without
 *   changing the status (callers decide where to go next).
 */
export interface AppState {
  status: AppStatus
  languagePair: LanguagePair
  connection: ConnectionStatus
  elapsedSeconds: number
  activeSubtitle: string
  error: AppErrorInfo | null
  sessionStartedAt: number | null
}

export const INITIAL_STATE: AppState = {
  status: 'booting',
  languagePair: DEFAULT_LANGUAGE_PAIR,
  connection: 'idle',
  elapsedSeconds: 0,
  activeSubtitle: '',
  error: null,
  sessionStartedAt: null,
}

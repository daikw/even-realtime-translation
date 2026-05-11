import type { ConnectionStatus, LanguagePair } from '@even-rt/shared'

/**
 * Discriminated union of state transitions consumed by
 * {@link import('./reducer.js').appReducer}.
 *
 * Naming follows §7.2 of the design doc: high-level user/system events rather
 * than direct status assignments. The reducer owns the mapping from action to
 * resulting `AppStatus` so the side-effect layer (main.ts) can stay declarative.
 */
export type AppAction =
  | { type: 'BOOT_COMPLETED' }
  | { type: 'PERMISSION_GRANTED' }
  | { type: 'PERMISSION_DENIED'; reason: string }
  | { type: 'START_REQUESTED' }
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED'; startedAt: number }
  | { type: 'CONNECTION_STATE_CHANGED'; state: ConnectionStatus }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP_REQUESTED' }
  | { type: 'EXITED' }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SUBTITLE_UPDATED'; text: string }
  | { type: 'LANGUAGE_CHANGED'; pair: LanguagePair }
  | { type: 'TICK'; nowMs: number }

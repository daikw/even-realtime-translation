import type { AppAction } from './actions.js'
import type { AppErrorInfo, AppState } from './appState.js'

/**
 * Pure reducer for the Even Hub app — design doc §7.2 transitions.
 *
 * - Returns the same `state` reference for unknown actions and disallowed
 *   transitions, so subscribers using identity equality (e.g. React /
 *   bespoke listener fan-out) won't refire on noise.
 * - Side effects (mic acquisition, RTC start/stop, HUD render) are owned by
 *   `main.ts`; this reducer never touches the outside world.
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'BOOT_COMPLETED': {
      if (state.status !== 'booting') return state
      return { ...state, status: 'idle' }
    }

    case 'PERMISSION_GRANTED': {
      if (state.status !== 'permission_required') return state
      return { ...state, status: 'idle', error: null }
    }

    case 'PERMISSION_DENIED': {
      // Allowed from booting (initial permission check) and from idle/connecting
      // when getUserMedia rejects on a start attempt. We only step into
      // `permission_required` from booting; from other statuses we still record
      // the error so the UI can react.
      const errorInfo: AppErrorInfo = {
        code: 'permission_denied',
        message: action.reason,
      }
      if (state.status === 'booting') {
        return { ...state, status: 'permission_required', error: errorInfo }
      }
      return { ...state, status: 'permission_required', error: errorInfo }
    }

    case 'START_REQUESTED': {
      if (state.status !== 'idle') return state
      return { ...state, status: 'connecting', connection: 'connecting', error: null }
    }

    case 'CONNECTING': {
      // Idempotent: callers may dispatch this both from a button handler and
      // from RTC onStateChange before the SDP exchange resolves.
      if (state.status === 'connecting') return state
      if (state.status !== 'idle' && state.status !== 'reconnecting') return state
      return { ...state, status: 'connecting', connection: 'connecting' }
    }

    case 'CONNECTED': {
      if (state.status !== 'connecting' && state.status !== 'reconnecting') return state
      // Preserve `sessionStartedAt` across reconnects so the elapsed clock
      // doesn't reset every time WebRTC bounces.
      const sessionStartedAt =
        state.sessionStartedAt !== null ? state.sessionStartedAt : action.startedAt
      return {
        ...state,
        status: 'live',
        connection: 'connected',
        sessionStartedAt,
        error: null,
      }
    }

    case 'CONNECTION_STATE_CHANGED': {
      // `connection` mirrors the WebRTC state regardless of high-level status,
      // but the high-level status only flips into `reconnecting` when we were
      // previously live/paused.
      const connection = action.state
      if (
        (state.status === 'live' || state.status === 'paused') &&
        (connection === 'disconnected' || connection === 'failed' || connection === 'reconnecting')
      ) {
        return { ...state, status: 'reconnecting', connection }
      }
      // Don't bounce out of `reconnecting` here; the dedicated CONNECTED action
      // handles the recovery path.
      return { ...state, connection }
    }

    case 'PAUSE': {
      if (state.status !== 'live') return state
      return { ...state, status: 'paused' }
    }

    case 'RESUME': {
      if (state.status !== 'paused') return state
      return { ...state, status: 'live' }
    }

    case 'STOP_REQUESTED': {
      if (state.status === 'live' || state.status === 'paused' || state.status === 'reconnecting') {
        return { ...state, status: 'exiting' }
      }
      return state
    }

    case 'EXITED': {
      // Terminal. Keep `exiting` so the HUD shows "Closing..." until the page
      // container is torn down.
      return state
    }

    case 'ERROR': {
      // Idempotent on identical payload: if we are already in `error` with the
      // same code+message, return the same reference. This lets multiple
      // observers (RTC client.onError observer + App-side catch on
      // client.start() rejection) report the same failure without churning
      // subscribers or overwriting equivalent error info. A *different*
      // payload still wins so a subsequent, distinct failure surfaces.
      if (
        state.status === 'error' &&
        state.error !== null &&
        state.error.code === action.code &&
        state.error.message === action.message
      ) {
        return state
      }
      return {
        ...state,
        status: 'error',
        error: { code: action.code, message: action.message },
      }
    }

    case 'CLEAR_ERROR': {
      if (state.error === null) return state
      return { ...state, error: null }
    }

    case 'SUBTITLE_UPDATED': {
      if (state.status !== 'live' && state.status !== 'paused') return state
      if (state.activeSubtitle === action.text) return state
      return { ...state, activeSubtitle: action.text }
    }

    case 'LANGUAGE_CHANGED': {
      if (
        state.languagePair.source === action.pair.source &&
        state.languagePair.target === action.pair.target
      ) {
        return state
      }
      return { ...state, languagePair: action.pair }
    }

    case 'TICK': {
      if (state.status !== 'live' && state.status !== 'paused' && state.status !== 'reconnecting') {
        return state
      }
      if (state.sessionStartedAt === null) return state
      const elapsed = Math.max(0, Math.floor((action.nowMs - state.sessionStartedAt) / 1000))
      if (elapsed === state.elapsedSeconds) return state
      return { ...state, elapsedSeconds: elapsed }
    }

    default: {
      // Exhaustiveness via never — guards against forgetting a new action type.
      const _exhaustive: never = action
      void _exhaustive
      return state
    }
  }
}

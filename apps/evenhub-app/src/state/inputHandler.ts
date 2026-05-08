import { nextTargetLanguage } from '@even-rt/shared'

import type { AppInputEvent } from '../even/input.js'
import type { AppAction } from './actions.js'
import type { Store } from './store.js'
import type { AppState } from './appState.js'

/**
 * Map a normalized G2/R1 input event to a state-machine action (design §8.1).
 *
 * This is intentionally side-effect-free: it reads the current state and
 * emits a single action via `store.dispatch`. The actual mic / RTC work is
 * driven by `main.ts` reacting to status transitions, NOT directly here.
 */
export function handleInputEvent(event: AppInputEvent, store: Store<AppState, AppAction>): void {
  const state = store.getState()

  switch (event.kind) {
    case 'singlePress': {
      switch (state.status) {
        case 'idle':
          store.dispatch({ type: 'START_REQUESTED' })
          return
        case 'live':
          store.dispatch({ type: 'PAUSE' })
          return
        case 'paused':
          store.dispatch({ type: 'RESUME' })
          return
        case 'error':
          // §12.1 error screen: "Press retry" — clear and let the user try
          // again from idle. We don't auto-restart the session.
          store.dispatch({ type: 'CLEAR_ERROR' })
          return
        default:
          return
      }
    }

    case 'doublePress': {
      // §8.1 double press: exit confirmation. Always dispatch — reducer
      // handles invalid statuses by no-op'ing.
      store.dispatch({ type: 'STOP_REQUESTED' })
      return
    }

    case 'swipeUp': {
      const target = nextTargetLanguage(state.languagePair.target, 'prev')
      store.dispatch({
        type: 'LANGUAGE_CHANGED',
        pair: { source: state.languagePair.source, target },
      })
      return
    }

    case 'swipeDown': {
      const target = nextTargetLanguage(state.languagePair.target, 'next')
      store.dispatch({
        type: 'LANGUAGE_CHANGED',
        pair: { source: state.languagePair.source, target },
      })
      return
    }

    case 'longPress':
    case 'unknown':
      return
  }
}

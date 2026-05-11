/**
 * Minimal observable store. Intentionally NOT depending on React or any
 * external lib — we just need:
 *  - synchronous dispatch
 *  - getState snapshot
 *  - fan-out to subscribers when the reducer returns a new reference
 *
 * Listener exceptions are isolated so one buggy subscriber can't take down
 * the rest of the wiring (HUD render, telemetry, etc.).
 */
export interface Store<S, A> {
  getState(): S
  dispatch(action: A): void
  subscribe(listener: (state: S) => void): () => void
}

export function createStore<S, A>(reducer: (state: S, action: A) => S, initial: S): Store<S, A> {
  let state: S = initial
  const listeners = new Set<(state: S) => void>()

  return {
    getState(): S {
      return state
    },

    dispatch(action: A): void {
      const next = reducer(state, action)
      if (Object.is(next, state)) return
      state = next
      // Snapshot listeners so a subscriber that unsubscribes mid-iteration
      // doesn't shift the live Set.
      for (const listener of Array.from(listeners)) {
        try {
          listener(state)
        } catch {
          // Listeners are observers; swallow so dispatch stays atomic.
          // Production code should attach an error reporter via a wrapping
          // listener, not throw inline.
        }
      }
    },

    subscribe(listener: (state: S) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

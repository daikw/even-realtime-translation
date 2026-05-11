import { describe, expect, it, vi } from 'vitest'

import type { AppInputEvent } from '../even/input.js'
import { INITIAL_STATE, type AppState } from './appState.js'
import { handleInputEvent } from './inputHandler.js'
import type { Store } from './store.js'
import type { AppAction } from './actions.js'

type DispatchMock = ReturnType<typeof vi.fn<(action: AppAction) => void>>

function fakeStore(state: AppState): { store: Store<AppState, AppAction>; dispatch: DispatchMock } {
  const dispatch: DispatchMock = vi.fn<(action: AppAction) => void>()
  return {
    dispatch,
    store: {
      getState: () => state,
      dispatch,
      subscribe: () => () => {
        // not used here
      },
    },
  }
}

const event = (kind: AppInputEvent['kind']): AppInputEvent =>
  ({ kind, raw: {} as unknown }) as unknown as AppInputEvent

describe('handleInputEvent — singlePress', () => {
  it('idle → START_REQUESTED', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'idle' })
    handleInputEvent(event('singlePress'), store)
    expect(dispatch).toHaveBeenCalledWith({ type: 'START_REQUESTED' })
  })

  it('live → PAUSE', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'live' })
    handleInputEvent(event('singlePress'), store)
    expect(dispatch).toHaveBeenCalledWith({ type: 'PAUSE' })
  })

  it('paused → RESUME', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'paused' })
    handleInputEvent(event('singlePress'), store)
    expect(dispatch).toHaveBeenCalledWith({ type: 'RESUME' })
  })

  it('booting → no-op (no dispatch)', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'booting' })
    handleInputEvent(event('singlePress'), store)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('error → CLEAR_ERROR (retry)', () => {
    const { store, dispatch } = fakeStore({
      ...INITIAL_STATE,
      status: 'error',
      error: { code: 'x', message: 'y' },
    })
    handleInputEvent(event('singlePress'), store)
    expect(dispatch).toHaveBeenCalledWith({ type: 'CLEAR_ERROR' })
  })
})

describe('handleInputEvent — doublePress', () => {
  it('dispatches STOP_REQUESTED in any non-exiting state', () => {
    for (const status of ['idle', 'live', 'paused', 'reconnecting', 'error'] as const) {
      const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status })
      handleInputEvent(event('doublePress'), store)
      expect(dispatch).toHaveBeenCalledWith({ type: 'STOP_REQUESTED' })
    }
  })
})

describe('handleInputEvent — swipeUp / swipeDown', () => {
  it('swipeUp rotates target language backward', () => {
    const { store, dispatch } = fakeStore({
      ...INITIAL_STATE,
      status: 'idle',
      languagePair: { source: 'auto', target: 'ja' },
    })
    handleInputEvent(event('swipeUp'), store)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const action = dispatch.mock.calls[0]![0]
    expect(action.type).toBe('LANGUAGE_CHANGED')
    if (action.type !== 'LANGUAGE_CHANGED') throw new Error('unreachable')
    expect(action.pair.source).toBe('auto')
    expect(action.pair.target).toBe('en')
  })

  it('swipeDown rotates target language forward', () => {
    const { store, dispatch } = fakeStore({
      ...INITIAL_STATE,
      status: 'idle',
      languagePair: { source: 'auto', target: 'ja' },
    })
    handleInputEvent(event('swipeDown'), store)
    const action = dispatch.mock.calls[0]![0]
    if (action.type !== 'LANGUAGE_CHANGED') throw new Error('unreachable')
    expect(action.pair.target).toBe('es')
  })
})

describe('handleInputEvent — unknown / longPress', () => {
  it('unknown is a no-op', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'idle' })
    handleInputEvent(event('unknown'), store)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('longPress is a no-op (Phase 1 reserved)', () => {
    const { store, dispatch } = fakeStore({ ...INITIAL_STATE, status: 'idle' })
    handleInputEvent(event('longPress'), store)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

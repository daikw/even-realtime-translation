/**
 * Cross-layer integration: reducer + store + SubtitleBuffer + screens.
 *
 * The unit tests cover each module in isolation. This suite glues them
 * together to verify the *pure* HUD pipeline:
 *
 *   action → reducer → state → renderForStatus → subtitle text
 *
 * No DOM, no fetch, no WebRTC, no Even bridge. Timers are faked so the
 * 150 ms throttle inside SubtitleBuffer is deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createStore } from '../../src/state/store.js'
import { appReducer } from '../../src/state/reducer.js'
import { INITIAL_STATE, type AppState } from '../../src/state/appState.js'
import type { AppAction } from '../../src/state/actions.js'
import {
  SubtitleBuffer,
  renderForStatus,
  type HudViewModel,
} from '../../src/hud/index.js'

function projectVm(state: AppState): HudViewModel {
  return {
    status: state.status,
    languagePair: state.languagePair,
    connection: state.connection,
    elapsedSeconds: state.elapsedSeconds,
    subtitle: state.activeSubtitle,
  }
}

describe('integration: state machine + HUD screens', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drives every documented status through the right screen renderer', () => {
    const store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)

    // booting → idle (BOOT_COMPLETED)
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'G2 Translate\nPress to start\nSwipe: language',
    )
    store.dispatch({ type: 'BOOT_COMPLETED' })
    expect(store.getState().status).toBe('idle')
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'G2 Translate\nPress to start\nSwipe: language',
    )

    // idle → connecting (START_REQUESTED)
    store.dispatch({ type: 'START_REQUESTED' })
    expect(store.getState().status).toBe('connecting')
    // Default pair is auto → ja per shared.DEFAULT_LANGUAGE_PAIR.
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'Connecting...\nAUTO → JA',
    )

    // LANGUAGE_CHANGED while connecting flips the screen to the new pair.
    store.dispatch({
      type: 'LANGUAGE_CHANGED',
      pair: { source: 'en', target: 'ja' },
    })
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'Connecting...\nEN → JA',
    )

    // connecting → live (CONNECTED)
    store.dispatch({ type: 'CONNECTED', startedAt: 1000 })
    expect(store.getState().status).toBe('live')
    // Live screen with empty subtitle → only the status bar (no body).
    const liveBare = renderForStatus(projectVm(store.getState()))
    expect(liveBare).toContain('EN→JA')
    expect(liveBare).toContain('LIVE ●')
    expect(liveBare).toContain('00:00')

    // live → paused
    store.dispatch({ type: 'PAUSE' })
    expect(store.getState().status).toBe('paused')
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'Paused\nPress to resume\nDouble press to exit',
    )

    // paused → live → reconnecting (CONNECTION_STATE_CHANGED)
    store.dispatch({ type: 'RESUME' })
    store.dispatch({ type: 'CONNECTION_STATE_CHANGED', state: 'failed' })
    expect(store.getState().status).toBe('reconnecting')
    expect(renderForStatus(projectVm(store.getState()))).toBe('Reconnecting...')

    // reconnecting → live (CONNECTED again preserves sessionStartedAt)
    store.dispatch({ type: 'CONNECTED', startedAt: 9999 })
    expect(store.getState().status).toBe('live')
    expect(store.getState().sessionStartedAt).toBe(1000)

    // STOP_REQUESTED → exiting
    store.dispatch({ type: 'STOP_REQUESTED' })
    expect(store.getState().status).toBe('exiting')
    expect(renderForStatus(projectVm(store.getState()))).toBe('Closing...')
  })

  it('plumbs SubtitleBuffer.append through SUBTITLE_UPDATED into the live screen body', () => {
    const store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)
    const buffer = new SubtitleBuffer({
      onRender: (text) => {
        store.dispatch({ type: 'SUBTITLE_UPDATED', text })
      },
    })

    store.dispatch({ type: 'BOOT_COMPLETED' })
    store.dispatch({ type: 'START_REQUESTED' })
    store.dispatch({ type: 'CONNECTED', startedAt: 0 })
    expect(store.getState().status).toBe('live')

    // Two appends inside the throttle window only fire onRender once on the
    // trailing edge.
    buffer.append('Hello ')
    buffer.append('world.')
    // Nothing rendered yet — the throttle defers to the trailing edge.
    expect(store.getState().activeSubtitle).toBe('')

    vi.advanceTimersByTime(160)

    // After the throttle window, "Hello world." is finalized into history
    // (sentence terminator) and SUBTITLE_UPDATED was dispatched once.
    expect(buffer.getActive()).toBe('')
    expect(buffer.getHistory()).toHaveLength(1)
    expect(buffer.getHistory()[0]?.text).toBe('Hello world.')

    const rendered = renderForStatus(projectVm(store.getState()))
    expect(rendered).toContain('Hello world.')
    // Status bar still leads the output.
    expect(rendered.split('\n')[0]).toContain('LIVE ●')

    buffer.dispose()
  })

  it('SUBTITLE_UPDATED is ignored outside live/paused so reconnecting screen stays clean', () => {
    const store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)
    const buffer = new SubtitleBuffer({
      onRender: (text) => {
        store.dispatch({ type: 'SUBTITLE_UPDATED', text })
      },
    })

    store.dispatch({ type: 'BOOT_COMPLETED' })
    store.dispatch({ type: 'START_REQUESTED' })
    store.dispatch({ type: 'CONNECTED', startedAt: 0 })
    // Drop into reconnecting so SUBTITLE_UPDATED is rejected by the reducer.
    store.dispatch({ type: 'CONNECTION_STATE_CHANGED', state: 'failed' })
    expect(store.getState().status).toBe('reconnecting')

    buffer.append('this should not render')
    vi.advanceTimersByTime(160)

    expect(store.getState().activeSubtitle).toBe('')
    expect(renderForStatus(projectVm(store.getState()))).toBe('Reconnecting...')
    buffer.dispose()
  })

  it('TICK updates elapsedSeconds and the live status bar reflects it', () => {
    const store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)

    store.dispatch({ type: 'BOOT_COMPLETED' })
    store.dispatch({ type: 'START_REQUESTED' })
    store.dispatch({ type: 'CONNECTED', startedAt: 0 })

    store.dispatch({ type: 'TICK', nowMs: 42_000 })
    expect(store.getState().elapsedSeconds).toBe(42)

    const rendered = renderForStatus(projectVm(store.getState()))
    // §6.4 example: `EN→JA  LIVE ●  00:42`. Default pair is auto → ja, but the
    // structure is the same.
    expect(rendered).toMatch(/00:42/)
  })

  it('error path: reducer ERROR puts us on the error screen with the canonical reason copy', () => {
    const store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)
    store.dispatch({ type: 'BOOT_COMPLETED' })
    store.dispatch({ type: 'ERROR', code: 'rate_limited', message: 'Too many sessions' })
    expect(store.getState().status).toBe('error')
    expect(store.getState().error).toEqual({
      code: 'rate_limited',
      message: 'Too many sessions',
    })
    // §12.1: error renderer doesn't surface the reason — just the canonical copy.
    expect(renderForStatus(projectVm(store.getState()))).toBe(
      'Connection failed\nCheck phone app\nPress retry',
    )
  })
})

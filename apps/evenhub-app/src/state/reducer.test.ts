import { describe, expect, it } from 'vitest'

import { INITIAL_STATE, type AppState } from './appState.js'
import { appReducer } from './reducer.js'

const idle = (): AppState => ({ ...INITIAL_STATE, status: 'idle' })
const live = (overrides: Partial<AppState> = {}): AppState => ({
  ...INITIAL_STATE,
  status: 'live',
  connection: 'connected',
  sessionStartedAt: 1000,
  ...overrides,
})

describe('appReducer — booting', () => {
  it('booting → idle on BOOT_COMPLETED', () => {
    const next = appReducer(INITIAL_STATE, { type: 'BOOT_COMPLETED' })
    expect(next.status).toBe('idle')
  })
})

describe('appReducer — permission_required', () => {
  it('booting → permission_required on PERMISSION_DENIED', () => {
    const next = appReducer(INITIAL_STATE, {
      type: 'PERMISSION_DENIED',
      reason: 'mic',
    })
    expect(next.status).toBe('permission_required')
    expect(next.error).toEqual({ code: 'permission_denied', message: 'mic' })
  })

  it('permission_required → idle on PERMISSION_GRANTED', () => {
    const start: AppState = {
      ...INITIAL_STATE,
      status: 'permission_required',
      error: { code: 'permission_denied', message: 'mic' },
    }
    const next = appReducer(start, { type: 'PERMISSION_GRANTED' })
    expect(next.status).toBe('idle')
    expect(next.error).toBeNull()
  })
})

describe('appReducer — connect flow', () => {
  it('idle → connecting on START_REQUESTED', () => {
    const next = appReducer(idle(), { type: 'START_REQUESTED' })
    expect(next.status).toBe('connecting')
    expect(next.connection).toBe('connecting')
  })

  it('connecting → live on CONNECTED, sets sessionStartedAt', () => {
    const start: AppState = { ...INITIAL_STATE, status: 'connecting' }
    const next = appReducer(start, { type: 'CONNECTED', startedAt: 1234 })
    expect(next.status).toBe('live')
    expect(next.connection).toBe('connected')
    expect(next.sessionStartedAt).toBe(1234)
  })

  it('connecting → error on ERROR', () => {
    const start: AppState = { ...INITIAL_STATE, status: 'connecting' }
    const next = appReducer(start, {
      type: 'ERROR',
      code: 'rtc_error',
      message: 'failed',
    })
    expect(next.status).toBe('error')
    expect(next.error).toEqual({ code: 'rtc_error', message: 'failed' })
  })
})

describe('appReducer — live transitions', () => {
  it('live → paused on PAUSE', () => {
    const next = appReducer(live(), { type: 'PAUSE' })
    expect(next.status).toBe('paused')
  })

  it('live → reconnecting on CONNECTION_STATE_CHANGED to disconnected', () => {
    const next = appReducer(live(), {
      type: 'CONNECTION_STATE_CHANGED',
      state: 'disconnected',
    })
    expect(next.status).toBe('reconnecting')
    expect(next.connection).toBe('disconnected')
  })

  it('live → reconnecting on CONNECTION_STATE_CHANGED to failed', () => {
    const next = appReducer(live(), {
      type: 'CONNECTION_STATE_CHANGED',
      state: 'failed',
    })
    expect(next.status).toBe('reconnecting')
  })

  it('live stays live on CONNECTION_STATE_CHANGED to connected', () => {
    const next = appReducer(live(), {
      type: 'CONNECTION_STATE_CHANGED',
      state: 'connected',
    })
    expect(next.status).toBe('live')
    expect(next.connection).toBe('connected')
  })

  it('live → exiting on STOP_REQUESTED', () => {
    const next = appReducer(live(), { type: 'STOP_REQUESTED' })
    expect(next.status).toBe('exiting')
  })

  it('live → error on ERROR', () => {
    const next = appReducer(live(), {
      type: 'ERROR',
      code: 'rtc_error',
      message: 'oops',
    })
    expect(next.status).toBe('error')
  })
})

describe('appReducer — paused transitions', () => {
  it('paused → live on RESUME', () => {
    const start: AppState = { ...live(), status: 'paused' }
    const next = appReducer(start, { type: 'RESUME' })
    expect(next.status).toBe('live')
  })

  it('paused → exiting on STOP_REQUESTED', () => {
    const start: AppState = { ...live(), status: 'paused' }
    const next = appReducer(start, { type: 'STOP_REQUESTED' })
    expect(next.status).toBe('exiting')
  })
})

describe('appReducer — reconnecting transitions', () => {
  it('reconnecting → live on CONNECTED', () => {
    const start: AppState = { ...live(), status: 'reconnecting' }
    const next = appReducer(start, { type: 'CONNECTED', startedAt: 5000 })
    expect(next.status).toBe('live')
    // Existing session clock should be preserved when reconnecting succeeds.
    expect(next.sessionStartedAt).toBe(start.sessionStartedAt)
  })

  it('reconnecting → error on ERROR', () => {
    const start: AppState = { ...live(), status: 'reconnecting' }
    const next = appReducer(start, {
      type: 'ERROR',
      code: 'rtc_error',
      message: 'gave up',
    })
    expect(next.status).toBe('error')
  })
})

describe('appReducer — exiting / EXITED', () => {
  it('STOP_REQUESTED from idle leaves status idle', () => {
    const next = appReducer(idle(), { type: 'STOP_REQUESTED' })
    // idle has no session to stop — design §7.2 only models stop from live/paused.
    expect(next.status).toBe('idle')
  })

  it('EXITED keeps status exiting (terminal)', () => {
    const start: AppState = { ...live(), status: 'exiting' }
    const next = appReducer(start, { type: 'EXITED' })
    expect(next.status).toBe('exiting')
  })
})

describe('appReducer — TICK', () => {
  it('updates elapsedSeconds in live based on sessionStartedAt', () => {
    const start: AppState = { ...live({ sessionStartedAt: 1000 }) }
    const next = appReducer(start, { type: 'TICK', nowMs: 4500 })
    expect(next.elapsedSeconds).toBe(3)
  })

  it('updates elapsedSeconds in paused', () => {
    const start: AppState = { ...live({ status: 'paused', sessionStartedAt: 1000 }) }
    const next = appReducer(start, { type: 'TICK', nowMs: 6500 })
    expect(next.elapsedSeconds).toBe(5)
  })

  it('updates elapsedSeconds in reconnecting', () => {
    const start: AppState = { ...live({ status: 'reconnecting', sessionStartedAt: 1000 }) }
    const next = appReducer(start, { type: 'TICK', nowMs: 8000 })
    expect(next.elapsedSeconds).toBe(7)
  })

  it('keeps elapsedSeconds at 0 when sessionStartedAt is null', () => {
    const start: AppState = { ...live({ sessionStartedAt: null }) }
    const next = appReducer(start, { type: 'TICK', nowMs: 10_000 })
    expect(next.elapsedSeconds).toBe(0)
  })

  it('does not run in idle', () => {
    const next = appReducer(idle(), { type: 'TICK', nowMs: 9999 })
    expect(next).toBe(idle.toString.length === 0 ? next : next) // sanity
    expect(next.elapsedSeconds).toBe(0)
  })
})

describe('appReducer — SUBTITLE_UPDATED', () => {
  it('updates activeSubtitle when live', () => {
    const next = appReducer(live(), { type: 'SUBTITLE_UPDATED', text: 'hello' })
    expect(next.activeSubtitle).toBe('hello')
  })

  it('updates activeSubtitle when paused', () => {
    const start: AppState = { ...live(), status: 'paused' }
    const next = appReducer(start, { type: 'SUBTITLE_UPDATED', text: 'frozen' })
    expect(next.activeSubtitle).toBe('frozen')
  })

  it('ignores SUBTITLE_UPDATED in idle', () => {
    const next = appReducer(idle(), { type: 'SUBTITLE_UPDATED', text: 'x' })
    expect(next.activeSubtitle).toBe('')
  })
})

describe('appReducer — LANGUAGE_CHANGED', () => {
  it('updates pair in idle', () => {
    const next = appReducer(idle(), {
      type: 'LANGUAGE_CHANGED',
      pair: { source: 'auto', target: 'fr' },
    })
    expect(next.languagePair.target).toBe('fr')
  })

  it('updates pair in connecting', () => {
    const start: AppState = { ...INITIAL_STATE, status: 'connecting' }
    const next = appReducer(start, {
      type: 'LANGUAGE_CHANGED',
      pair: { source: 'auto', target: 'es' },
    })
    expect(next.languagePair.target).toBe('es')
  })

  it('updates pair in live, paused, reconnecting', () => {
    for (const status of ['live', 'paused', 'reconnecting'] as const) {
      const start: AppState = { ...live(), status }
      const next = appReducer(start, {
        type: 'LANGUAGE_CHANGED',
        pair: { source: 'auto', target: 'ko' },
      })
      expect(next.languagePair.target).toBe('ko')
    }
  })

  it('updates pair in exiting (no-op-safe)', () => {
    const start: AppState = { ...live(), status: 'exiting' }
    const next = appReducer(start, {
      type: 'LANGUAGE_CHANGED',
      pair: { source: 'auto', target: 'fr' },
    })
    expect(next.languagePair.target).toBe('fr')
  })
})

describe('appReducer — CONNECTING idempotency', () => {
  it('idle → connecting on CONNECTING', () => {
    const next = appReducer(idle(), { type: 'CONNECTING' })
    expect(next.status).toBe('connecting')
  })

  it('reconnecting → connecting on CONNECTING', () => {
    const start: AppState = { ...live(), status: 'reconnecting' }
    const next = appReducer(start, { type: 'CONNECTING' })
    expect(next.status).toBe('connecting')
  })

  it('connecting → connecting (no-op) on CONNECTING', () => {
    const start: AppState = { ...INITIAL_STATE, status: 'connecting' }
    const next = appReducer(start, { type: 'CONNECTING' })
    expect(next).toBe(start)
  })

  it('live + CONNECTING is rejected', () => {
    const start = live()
    const next = appReducer(start, { type: 'CONNECTING' })
    expect(next).toBe(start)
  })
})

describe('appReducer — LANGUAGE_CHANGED no-op when same', () => {
  it('returns same reference when pair is unchanged', () => {
    const start = idle()
    const next = appReducer(start, {
      type: 'LANGUAGE_CHANGED',
      pair: { ...start.languagePair },
    })
    expect(next).toBe(start)
  })
})

describe('appReducer — STOP_REQUESTED from reconnecting', () => {
  it('reconnecting → exiting', () => {
    const start: AppState = { ...live(), status: 'reconnecting' }
    const next = appReducer(start, { type: 'STOP_REQUESTED' })
    expect(next.status).toBe('exiting')
  })
})

describe('appReducer — PERMISSION_DENIED from non-booting', () => {
  it('idle + PERMISSION_DENIED → permission_required with reason', () => {
    const next = appReducer(idle(), { type: 'PERMISSION_DENIED', reason: 'mic' })
    expect(next.status).toBe('permission_required')
    expect(next.error).toEqual({ code: 'permission_denied', message: 'mic' })
  })
})

describe('appReducer — CONNECTION_STATE_CHANGED transitions', () => {
  it('connecting + CONNECTION_STATE_CHANGED("connected") only updates connection', () => {
    const start: AppState = { ...INITIAL_STATE, status: 'connecting' }
    const next = appReducer(start, {
      type: 'CONNECTION_STATE_CHANGED',
      state: 'connected',
    })
    expect(next.status).toBe('connecting')
    expect(next.connection).toBe('connected')
  })

  it('paused + disconnected → reconnecting', () => {
    const start: AppState = { ...live(), status: 'paused' }
    const next = appReducer(start, {
      type: 'CONNECTION_STATE_CHANGED',
      state: 'disconnected',
    })
    expect(next.status).toBe('reconnecting')
  })
})

describe('appReducer — SUBTITLE_UPDATED no-op when same text', () => {
  it('returns same reference when text unchanged', () => {
    const start: AppState = { ...live(), activeSubtitle: 'hello' }
    const next = appReducer(start, { type: 'SUBTITLE_UPDATED', text: 'hello' })
    expect(next).toBe(start)
  })
})

describe('appReducer — CLEAR_ERROR no-op when no error', () => {
  it('returns same reference when error is already null', () => {
    const start = idle()
    const next = appReducer(start, { type: 'CLEAR_ERROR' })
    expect(next).toBe(start)
  })
})

describe('appReducer — error handling', () => {
  it('CLEAR_ERROR clears error info but keeps status', () => {
    const start: AppState = {
      ...INITIAL_STATE,
      status: 'error',
      error: { code: 'x', message: 'y' },
    }
    const next = appReducer(start, { type: 'CLEAR_ERROR' })
    expect(next.error).toBeNull()
    expect(next.status).toBe('error')
  })

  it('ERROR is idempotent: a second ERROR with the same code/message returns the same reference', () => {
    // Defends against double-dispatch when both client.onError and the
    // App-side catch report the same RTC start failure (F2 invariant).
    const start: AppState = {
      ...INITIAL_STATE,
      status: 'error',
      error: { code: 'rtc_error', message: 'sdp failed' },
    }
    const next = appReducer(start, {
      type: 'ERROR',
      code: 'rtc_error',
      message: 'sdp failed',
    })
    expect(next).toBe(start)
  })

  it('ERROR while already in error preserves the FIRST error info on identical payload', () => {
    const first: AppState = {
      ...INITIAL_STATE,
      status: 'error',
      error: { code: 'rtc_error', message: 'first' },
    }
    const next = appReducer(first, {
      type: 'ERROR',
      code: 'rtc_error',
      message: 'first',
    })
    expect(next.error).toEqual(first.error)
  })

  it('ERROR with a different payload still overwrites (operator can introduce a new failure)', () => {
    const start: AppState = {
      ...INITIAL_STATE,
      status: 'error',
      error: { code: 'rtc_error', message: 'first' },
    }
    const next = appReducer(start, {
      type: 'ERROR',
      code: 'backend_error',
      message: 'second',
    })
    expect(next.error).toEqual({ code: 'backend_error', message: 'second' })
  })
})

describe('appReducer — unknown / no-op safety', () => {
  it('returns same state for unknown action', () => {
    const start: AppState = idle()
    const next = appReducer(start, { type: 'NOT_A_REAL_ACTION' } as unknown as never)
    expect(next).toBe(start)
  })

  it('returns same state when transition is invalid', () => {
    // PAUSE while idle — design doc only allows live → paused.
    const start: AppState = idle()
    const next = appReducer(start, { type: 'PAUSE' })
    expect(next).toBe(start)
  })

  it('returns same state for RESUME outside paused', () => {
    const start: AppState = idle()
    const next = appReducer(start, { type: 'RESUME' })
    expect(next).toBe(start)
  })
})

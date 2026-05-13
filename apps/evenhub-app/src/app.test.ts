/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStatus, TranscriptDelta } from '@even-rt/shared'

import { App, type AppDeps } from './app.js'
import type { AppConfig } from './config.js'
import { createMockBridge } from './even/bridge.mock.js'
import { EvenBridgeInitError } from './even/bridge.js'
import {
  BackendError,
  MicPermissionError,
  type TranslationRuntime,
  type TranslationRuntimeFactory,
  type TranslationRuntimeStartOpts,
} from './realtime/index.js'

// ──────────────────────────────────────────────────────────────────────────
// Fake TranslationRuntime helpers.
// ──────────────────────────────────────────────────────────────────────────

interface FakeRuntimeInstance {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  sendLanguageUpdate: ReturnType<typeof vi.fn>
  fireState: (state: ConnectionStatus) => void
  fireOutputTranscript: (text: string, itemId?: string) => void
  fireInputTranscript: (text: string, itemId?: string) => void
  fireError: (err: Error) => void
  failNextStart: (err: unknown) => void
  startOpts: () => TranslationRuntimeStartOpts | null
}

interface FakeRuntimeFactoryHandle {
  factory: TranslationRuntimeFactory
  latest: () => FakeRuntimeInstance
  all: () => FakeRuntimeInstance[]
  /** Replace the create() shim so each new runtime is pre-armed by `arm`. */
  armNext: (arm: (inst: FakeRuntimeInstance) => void) => void
}

function makeFakeRuntimeFactory(): FakeRuntimeFactoryHandle {
  const instances: FakeRuntimeInstance[] = []
  let armNextFn: ((inst: FakeRuntimeInstance) => void) | null = null
  const factory: TranslationRuntimeFactory = {
    create(): TranslationRuntime {
      let pendingReject: unknown = null
      let capturedOpts: TranslationRuntimeStartOpts | null = null
      const start = vi.fn<(opts: TranslationRuntimeStartOpts) => Promise<void>>((opts) => {
        capturedOpts = opts
        if (pendingReject !== null) {
          const err = pendingReject
          pendingReject = null
          // Deliberately keeps the original `unknown` shape so we can test
          // the non-Error rejection branch (App.startSession's err-instance
          // narrowing). The eslint rule wants Error instances by default.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(err)
        }
        return Promise.resolve()
      })
      const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      const sendLanguageUpdate = vi.fn<(target: string) => void>()
      const instance: FakeRuntimeInstance = {
        start,
        stop,
        sendLanguageUpdate,
        fireState: (state) => {
          capturedOpts?.onStateChange(state)
        },
        fireOutputTranscript: (text, itemId) => {
          const delta: TranscriptDelta =
            itemId === undefined ? { text, createdAt: 0 } : { text, itemId, createdAt: 0 }
          capturedOpts?.onOutputTranscriptDelta(delta)
        },
        fireInputTranscript: (text, itemId) => {
          const delta: TranscriptDelta =
            itemId === undefined ? { text, createdAt: 0 } : { text, itemId, createdAt: 0 }
          capturedOpts?.onInputTranscriptDelta?.(delta)
        },
        fireError: (err) => {
          capturedOpts?.onError?.(err)
        },
        failNextStart: (err) => {
          pendingReject = err
        },
        startOpts: () => capturedOpts,
      }
      instances.push(instance)
      if (armNextFn !== null) {
        const arm = armNextFn
        armNextFn = null
        arm(instance)
      }
      const runtime: TranslationRuntime = { start, stop, sendLanguageUpdate }
      return runtime
    },
  }
  return {
    factory,
    latest: () => {
      const last = instances[instances.length - 1]
      if (last === undefined) throw new Error('No runtime instance created yet')
      return last
    },
    all: () => instances.slice(),
    armNext: (arm) => {
      armNextFn = arm
    },
  }
}

function defaultCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    backendUrl: 'http://localhost:3000',
    openaiBaseUrl: 'https://api.openai.com',
    modelName: 'gpt-realtime-translate',
    useMockBridge: true,
    dev: false,
    realtimeWsUrl: '/api/realtime/ws',
    transport: 'ws',
    ...over,
  }
}

function defaultDeps(rh: FakeRuntimeFactoryHandle, over: Partial<AppDeps> = {}): AppDeps {
  return {
    bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
    mockBridgeFactory: () => createMockBridge(),
    translationRuntimeFactory: rh.factory,
    setIntervalImpl: () => 0,
    clearIntervalImpl: () => undefined,
    now: () => 1000,
    log: () => undefined,
    ...over,
  }
}

function clearBody(): void {
  while (document.body.firstChild !== null) document.body.removeChild(document.body.firstChild)
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests.
// ──────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearBody()
})
afterEach(() => {
  clearBody()
  vi.restoreAllMocks()
})

describe('App.boot — happy path', () => {
  it('reaches idle after BOOT_COMPLETED via mock bridge', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    expect(app.store.getState().status).toBe('idle')
    await app.dispose()
  })

  it('start → connecting → CONNECTED → live drives a runtime start', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh, { now: () => 5000 }))
    await app.boot()
    expect(app.store.getState().status).toBe('idle')

    app.dispatch({ type: 'START_REQUESTED' })
    expect(app.store.getState().status).toBe('connecting')

    await flushMicrotasks()
    expect(rh.latest().start).toHaveBeenCalledTimes(1)
    expect(rh.latest().startOpts()?.targetLanguage).toBe('ja')

    rh.latest().fireState('connected')
    expect(app.store.getState().status).toBe('live')
    expect(app.store.getState().sessionStartedAt).toBe(5000)

    await app.dispose()
    expect(rh.latest().stop).toHaveBeenCalled()
  })

  it('routes output transcript deltas into the subtitle buffer', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    rh.latest().fireOutputTranscript('Hello, ')
    rh.latest().fireOutputTranscript('world!')
    await new Promise((r) => setTimeout(r, 200))
    expect(app.store.getState().activeSubtitle).toContain('Hello')
    await app.dispose()
  })
})

describe('App — start error paths', () => {
  it('runtime.start() rejecting with MicPermissionError → permission_required', async () => {
    const rh = makeFakeRuntimeFactory()
    rh.armNext((inst) => {
      inst.failNextStart(new MicPermissionError('user denied'))
    })
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    expect(app.store.getState().status).toBe('permission_required')
    await app.dispose()
  })

  it('runtime.start() rejecting with BackendError → status=error with original code', async () => {
    const rh = makeFakeRuntimeFactory()
    rh.armNext((inst) => {
      inst.failNextStart(new BackendError('rate_limited', 'slow down'))
    })
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('rate_limited')
    expect(state.error?.message).toBe('slow down')
    await app.dispose()
  })

  it('runtime.start() rejecting with generic Error → status=error/rtc_error', async () => {
    const rh = makeFakeRuntimeFactory()
    rh.armNext((inst) => {
      inst.failNextStart(new Error('handshake refused'))
    })
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('rtc_error')
    expect(state.error?.message).toBe('handshake refused')
    await app.dispose()
  })

  it('runtime.start() rejecting with non-Error throw still surfaces as rtc_error', async () => {
    const rh = makeFakeRuntimeFactory()
    rh.armNext((inst) => {
      inst.failNextStart('plain string rejection')
    })
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('rtc_error')
    await app.dispose()
  })

  it('rejects target=auto with invalid_target before invoking the runtime', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    // Force target='auto' even though the rotation never lands there.
    app.dispatch({
      type: 'LANGUAGE_CHANGED',
      pair: { source: 'auto', target: 'auto' } as unknown as { source: 'auto'; target: 'ja' },
    })
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('invalid_target')
    expect(rh.all()).toHaveLength(0)
    await app.dispose()
  })
})

describe('App — connection state mapping', () => {
  it('runtime reconnecting state → status=reconnecting (from live)', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')
    expect(app.store.getState().status).toBe('live')

    rh.latest().fireState('reconnecting')
    expect(app.store.getState().status).toBe('reconnecting')
    await app.dispose()
  })

  it('reconnecting → connected drives back to live (transparent reconnect)', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')
    rh.latest().fireState('reconnecting')
    expect(app.store.getState().status).toBe('reconnecting')
    rh.latest().fireState('connected')
    expect(app.store.getState().status).toBe('live')
    await app.dispose()
  })

  it('runtime failed state → ERROR with code reconnect_failed', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    rh.latest().fireState('failed')
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('reconnect_failed')
    await app.dispose()
  })
})

describe('App — onError observer (after start)', () => {
  it('BackendError emitted via onError dispatches ERROR with code', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    rh.latest().fireError(new BackendError('upstream_error', 'service unavailable'))
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('upstream_error')
    await app.dispose()
  })

  it('generic Error via onError does NOT dispatch ERROR (observability only)', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    rh.latest().fireError(new Error('transient blip'))
    expect(app.store.getState().status).toBe('live')
    await app.dispose()
  })
})

describe('App — STOP_REQUESTED + lifecycle', () => {
  it('STOP_REQUESTED in live drives shutdown and stops the runtime', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    app.dispatch({ type: 'STOP_REQUESTED' })
    await flushMicrotasks()
    expect(rh.latest().stop).toHaveBeenCalled()
    // EXITED reducer keeps status='exiting' so the HUD shows "Closing..."
    // until the page container is torn down (see state/reducer.ts).
    expect(app.store.getState().status).toBe('exiting')
  })

  it('STOP_REQUESTED dispatched again from idle is a no-op', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'STOP_REQUESTED' }) // status stays idle (reducer guard)
    await flushMicrotasks()
    expect(app.store.getState().status).toBe('idle')
    expect(rh.all()).toHaveLength(0)
  })
})

describe('App.boot — bridge failure path', () => {
  it('rethrows when the SDK bridge fails and useMockBridge is false', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(
      defaultCfg({ useMockBridge: false }),
      defaultDeps(rh, {
        bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      }),
    )
    await expect(app.boot()).rejects.toBeInstanceOf(EvenBridgeInitError)
  })
})

describe('App — exiting cleanup', () => {
  it('disposes the subtitle buffer before any further upgradeText (F8)', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    rh.latest().fireOutputTranscript('lorem ')
    app.dispatch({ type: 'STOP_REQUESTED' })
    // Late-arriving transcripts after STOP_REQUESTED must be no-ops.
    rh.latest().fireOutputTranscript('ipsum')
    await flushMicrotasks()
    expect(rh.latest().stop).toHaveBeenCalledTimes(1)
  })
})

describe('App — TICK', () => {
  it('TICK from interval updates elapsedSeconds while live', async () => {
    const rh = makeFakeRuntimeFactory()
    const tickRef: { fn: (() => void) | null } = { fn: null }
    let now = 5000
    const app = new App(
      defaultCfg(),
      defaultDeps(rh, {
        setIntervalImpl: (fn) => {
          tickRef.fn = fn
          return 0
        },
        now: () => now,
      }),
    )
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')
    expect(app.store.getState().sessionStartedAt).toBe(5000)

    now = 8000
    tickRef.fn?.()
    expect(app.store.getState().elapsedSeconds).toBe(3)
    await app.dispose()
  })
})

describe('App — language change wiring', () => {
  it('forwards LANGUAGE_CHANGED to runtime.sendLanguageUpdate', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    rh.latest().fireState('connected')

    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'auto', target: 'en' } })
    expect(rh.latest().sendLanguageUpdate).toHaveBeenCalledWith('en')

    // Dispatching the same target again must NOT re-fire sendLanguageUpdate.
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'auto', target: 'en' } })
    expect(rh.latest().sendLanguageUpdate).toHaveBeenCalledTimes(1)

    // Rotating to another target fires again.
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'auto', target: 'ko' } })
    expect(rh.latest().sendLanguageUpdate).toHaveBeenCalledTimes(2)
    expect(rh.latest().sendLanguageUpdate).toHaveBeenLastCalledWith('ko')

    await app.dispose()
  })

  it('does not call sendLanguageUpdate when there is no active runtime', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()
    // No START_REQUESTED — no runtime exists yet.
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'auto', target: 'fr' } })
    expect(rh.all()).toHaveLength(0)
    await app.dispose()
  })
})

describe('App — runtime factory error propagation', () => {
  it('factory.create() throwing surfaces as ERROR rtc_error', async () => {
    const rh = makeFakeRuntimeFactory()
    const factory: TranslationRuntimeFactory = {
      create: () => {
        throw new Error('factory unavailable')
      },
    }
    const app = new App(
      defaultCfg(),
      defaultDeps(rh, { translationRuntimeFactory: factory }),
    )
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await flushMicrotasks()
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('rtc_error')
    await app.dispose()
  })
})

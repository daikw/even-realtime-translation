/**
 * @vitest-environment jsdom
 *
 * App-class lifecycle integration. Where `src/app.test.ts` covers a single
 * transition or error per case, this suite walks an end-to-end session with
 * mocked I/O (via the fake TranslationRuntime factory) and asserts the
 * *combined* effect across layers.
 *
 * Focus (intentionally non-overlapping with app.test.ts):
 *  - LANGUAGE_CHANGED at idle is forwarded into runtime.start's opts.
 *  - Multiple output_transcript.delta events finalize into the SubtitleBuffer
 *    history; the live status bar shows the rolling clock.
 *  - PAUSE/RESUME during live keep the runtime running.
 *  - STOP_REQUESTED triggers the full teardown via runtime.stop.
 *  - Mid-transition store subscribers behave per the documented contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStatus, TranscriptDelta } from '@even-rt/shared'

import { App, type AppDeps } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createMockBridge } from '../../src/even/bridge.mock.js'
import { EvenBridgeInitError } from '../../src/even/bridge.js'
import type {
  TranslationRuntime,
  TranslationRuntimeFactory,
  TranslationRuntimeStartOpts,
} from '../../src/realtime/index.js'

// ──────────────────────────────────────────────────────────────────────────
// Fake runtime helpers (mirrors src/app.test.ts).
// ──────────────────────────────────────────────────────────────────────────

interface FakeRuntimeInstance {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  sendLanguageUpdate: ReturnType<typeof vi.fn>
  fireState: (state: ConnectionStatus) => void
  fireOutputTranscript: (text: string) => void
  startOpts: () => TranslationRuntimeStartOpts | null
}

interface FakeRuntimeFactoryHandle {
  factory: TranslationRuntimeFactory
  latest: () => FakeRuntimeInstance
  all: () => FakeRuntimeInstance[]
}

function makeFakeRuntimeFactory(): FakeRuntimeFactoryHandle {
  const instances: FakeRuntimeInstance[] = []
  const factory: TranslationRuntimeFactory = {
    create(): TranslationRuntime {
      let capturedOpts: TranslationRuntimeStartOpts | null = null
      const start = vi.fn<(opts: TranslationRuntimeStartOpts) => Promise<void>>((opts) => {
        capturedOpts = opts
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
        fireOutputTranscript: (text) => {
          const delta: TranscriptDelta = { text, createdAt: 0 }
          capturedOpts?.onOutputTranscriptDelta(delta)
        },
        startOpts: () => capturedOpts,
      }
      instances.push(instance)
      return { start, stop, sendLanguageUpdate }
    },
  }
  return {
    factory,
    latest: () => {
      const last = instances[instances.length - 1]
      if (last === undefined) throw new Error('No runtime created yet')
      return last
    },
    all: () => instances.slice(),
  }
}

function defaultCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    useMockBridge: true,
    dev: false,
    realtimeWsUrl: '/api/realtime/ws',
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

async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests.
// ──────────────────────────────────────────────────────────────────────────

describe('integration: App full session lifecycle', () => {
  beforeEach(() => {
    clearBody()
  })
  afterEach(() => {
    clearBody()
  })

  it('LANGUAGE_CHANGED before START forwards the new target into runtime.start', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))

    await app.boot()
    // Default language pair is auto → ja (DEFAULT_LANGUAGE_PAIR). Rotate to fr.
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'en', target: 'fr' } })
    expect(app.store.getState().languagePair).toEqual({ source: 'en', target: 'fr' })

    app.dispatch({ type: 'START_REQUESTED' })
    await drain()

    expect(rh.latest().start).toHaveBeenCalledTimes(1)
    const opts = rh.latest().startOpts()
    expect(opts?.targetLanguage).toBe('fr')
    expect(opts?.sourceHint).toBe('en')

    await app.dispose()
  })

  it('multiple output_transcript.delta events finalize a sentence into history', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    rh.latest().fireState('connected')
    expect(app.store.getState().status).toBe('live')

    rh.latest().fireOutputTranscript('Hello, ')
    rh.latest().fireOutputTranscript('world')
    rh.latest().fireOutputTranscript('.')
    // SubtitleBuffer trailing-edge throttle is 150 ms.
    await new Promise((r) => setTimeout(r, 200))

    const state = app.store.getState()
    expect(state.activeSubtitle).toContain('Hello, world.')

    await app.dispose()
  })

  it('PAUSE/RESUME from live keeps the runtime running and only flips the screen', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    rh.latest().fireState('connected')

    app.dispatch({ type: 'PAUSE' })
    expect(app.store.getState().status).toBe('paused')
    expect(rh.latest().stop).not.toHaveBeenCalled()

    app.dispatch({ type: 'RESUME' })
    expect(app.store.getState().status).toBe('live')
    expect(rh.latest().stop).not.toHaveBeenCalled()

    await app.dispose()
  })

  it('STOP_REQUESTED tears down: runtime.stop is called once', async () => {
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    rh.latest().fireState('connected')
    expect(app.store.getState().status).toBe('live')

    app.dispatch({ type: 'STOP_REQUESTED' })
    // Status flips to exiting synchronously; runtime.stop runs in the
    // onStatusChange microtask. EXITED keeps the status on 'exiting' so
    // the HUD continues to show "Closing..." (see state/reducer.ts).
    expect(app.store.getState().status).toBe('exiting')
    await drain()

    expect(rh.latest().stop).toHaveBeenCalledTimes(1)
    expect(app.store.getState().status).toBe('exiting')

    await app.dispose()
  })

  it('subscribers added during a transition do not run for it but are called on the next dispatch', async () => {
    // Regression guard: dispatch fans out via Array.from(listeners), so a
    // listener added inside another listener is invoked on the *next* action,
    // not the current one. We rely on this when App.boot subscribes its
    // status-change handler after the render handler.
    const rh = makeFakeRuntimeFactory()
    const app = new App(defaultCfg(), defaultDeps(rh))
    await app.boot()

    const seen: string[] = []
    const off = app.store.subscribe((s) => {
      seen.push(s.status)
    })
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'en', target: 'ko' } })
    expect(seen).toEqual(['idle'])
    off()
    await app.dispose()
  })
})

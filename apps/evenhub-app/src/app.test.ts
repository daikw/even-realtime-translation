/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, type AppDeps } from './app.js'
import type { AppConfig } from './config.js'
import { createMockBridge } from './even/bridge.mock.js'
import { EvenBridgeInitError } from './even/bridge.js'
import { MicPermissionDeniedError } from './audio/phoneMic.js'
import { TranslationApiError } from './backend/apiClient.js'
import type { WebRtcTranslationClient } from './realtime/index.js'

interface RtcCalls {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  sendSessionUpdate: ReturnType<typeof vi.fn>
  getState: ReturnType<typeof vi.fn>
  callbacks: {
    onOutputTranscriptDelta?: (delta: { text: string }) => void
    onRemoteAudioTrack?: (track: MediaStreamTrack) => void
    onStateChange?: (state: RTCPeerConnectionState) => void
    onError?: (err: Error) => void
  }
}

function makeRtcClient(): { client: WebRtcTranslationClient; calls: RtcCalls } {
  const startMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const stopMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const sendSessionUpdateMock = vi.fn<(lang: string) => void>()
  const getStateMock = vi.fn<() => RTCPeerConnectionState>(() => 'new')
  const calls: RtcCalls = {
    start: startMock,
    stop: stopMock,
    sendSessionUpdate: sendSessionUpdateMock,
    getState: getStateMock,
    callbacks: {},
  }
  const client: WebRtcTranslationClient = {
    start: startMock,
    stop: stopMock,
    sendSessionUpdate: sendSessionUpdateMock,
    getState: getStateMock,
  }
  return { client, calls }
}

function makeMicStream(): MediaStream {
  const tracks = [{ stop: vi.fn() }]
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream
}

function defaultCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    backendUrl: 'http://localhost:3000',
    openaiBaseUrl: 'https://api.openai.com',
    modelName: 'gpt-realtime-translate',
    useMockBridge: true,
    dev: false,
    ...over,
  }
}

function clearBody(): void {
  while (document.body.firstChild !== null) document.body.removeChild(document.body.firstChild)
}

describe('App.boot — happy path', () => {
  beforeEach(() => {
    clearBody()
  })
  afterEach(() => {
    clearBody()
  })

  it('reaches idle after BOOT_COMPLETED via mock bridge', async () => {
    const { client } = makeRtcClient()
    const deps: AppDeps = {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    }
    const app = new App(defaultCfg(), deps)
    await app.boot()
    expect(app.store.getState().status).toBe('idle')
    await app.dispose()
  })

  it('start → connecting → CONNECTED → live drives an RTC start', async () => {
    const { client, calls } = makeRtcClient()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      calls.callbacks.onOutputTranscriptDelta = opts.onOutputTranscriptDelta
      calls.callbacks.onRemoteAudioTrack = opts.onRemoteAudioTrack
      calls.callbacks.onError = opts.onError
      return client
    }
    const deps: AppDeps = {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 'secret',
        expiresAt: '2026-01-01',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 5000,
      log: () => {
        // noop
      },
    }
    const app = new App(defaultCfg(), deps)
    await app.boot()
    expect(app.store.getState().status).toBe('idle')

    app.dispatch({ type: 'START_REQUESTED' })
    expect(app.store.getState().status).toBe('connecting')

    // Microtasks: mic + session + RTC start each await once.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.start).toHaveBeenCalled()

    // Simulate the RTC client transitioning to connected.
    calls.callbacks.onStateChange?.('connected')
    expect(app.store.getState().status).toBe('live')
    expect(app.store.getState().sessionStartedAt).toBe(5000)

    await app.dispose()
    expect(calls.stop).toHaveBeenCalled()
  })

  it('routes output transcript deltas into the subtitle buffer', async () => {
    const { client, calls } = makeRtcClient()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onOutputTranscriptDelta = opts.onOutputTranscriptDelta
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const deps: AppDeps = {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 5000,
      log: () => {
        // noop
      },
    }
    const app = new App(defaultCfg(), deps)
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    calls.callbacks.onStateChange?.('connected')

    calls.callbacks.onOutputTranscriptDelta?.({ text: 'hello' })
    // SubtitleBuffer throttles on 150ms; wait long enough for the trailing edge.
    await new Promise((r) => setTimeout(r, 200))
    expect(app.store.getState().activeSubtitle).toContain('hello')

    await app.dispose()
  })
})

describe('App — error paths', () => {
  beforeEach(() => {
    clearBody()
  })
  afterEach(() => {
    clearBody()
  })

  it('mic permission denied → permission_required', async () => {
    const { client } = makeRtcClient()
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.reject(new MicPermissionDeniedError('denied')),
      createSession: vi.fn(),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(app.store.getState().status).toBe('permission_required')
    await app.dispose()
  })

  it('backend rate-limited → status=error with original code', async () => {
    const { client } = makeRtcClient()
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: () =>
        Promise.reject(new TranslationApiError('rate_limited', 'too many', 429)),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('rate_limited')
    await app.dispose()
  })

  it('STOP_REQUESTED in live drives shutdown and stops RTC', async () => {
    const { client, calls } = makeRtcClient()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    calls.callbacks.onStateChange?.('connected')

    app.dispatch({ type: 'STOP_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.stop).toHaveBeenCalled()
    await app.dispose()
  })

  it('CONNECTION_STATE_CHANGED with disconnected from live → reconnecting', async () => {
    const { client, calls } = makeRtcClient()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    calls.callbacks.onStateChange?.('connected')
    calls.callbacks.onStateChange?.('disconnected')
    expect(app.store.getState().status).toBe('reconnecting')
    await app.dispose()
  })

  it('boot rethrows when the SDK bridge fails and useMockBridge is false', async () => {
    const app = new App(defaultCfg({ useMockBridge: false }), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn(),
      createRtcClient: () => makeRtcClient().client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 0,
      log: () => {
        // noop
      },
    })
    await expect(app.boot()).rejects.toBeInstanceOf(EvenBridgeInitError)
  })

  it('mic acquisition rejecting with non-permission error → status=error/mic_error', async () => {
    const { client } = makeRtcClient()
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.reject(new Error('hardware glitch')),
      createSession: vi.fn(),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 0,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const state = app.store.getState()
    expect(state.status).toBe('error')
    expect(state.error?.code).toBe('mic_error')
    await app.dispose()
  })

  it('lifecycle abnormalExit dispatches STOP_REQUESTED', async () => {
    const bridge = createMockBridge()
    const { client, calls } = makeRtcClient()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.resolve(bridge),
      mockBridgeFactory: () => bridge,
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 1000,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    calls.callbacks.onStateChange?.('connected')
    expect(app.store.getState().status).toBe('live')

    // Emit ABNORMAL_EXIT_EVENT (6) through the mock bridge.
    bridge.emitEvenHubEvent({
      sysEvent: { eventType: 6 /* ABNORMAL_EXIT_EVENT */ },
    } as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(app.store.getState().status).toBe('exiting')
    await app.dispose()
  })

  it('client.start() rejection routes through ERROR via onError', async () => {
    const startMock = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('sdp failed'))
    const stopMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const sendSessionUpdateMock = vi.fn<(lang: string) => void>()
    const getStateMock = vi.fn<() => RTCPeerConnectionState>(() => 'failed')
    const calls: RtcCalls = {
      start: startMock,
      stop: stopMock,
      sendSessionUpdate: sendSessionUpdateMock,
      getState: getStateMock,
      callbacks: {},
    }
    const client: WebRtcTranslationClient = {
      start: startMock,
      stop: stopMock,
      sendSessionUpdate: sendSessionUpdateMock,
      getState: getStateMock,
    }
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onError = opts.onError
      // Simulate: the orchestrator reports the error before throwing.
      void Promise.resolve().then(() => {
        opts.onError(new Error('sdp failed'))
      })
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 0,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(app.store.getState().status).toBe('error')
    expect(stopMock).toHaveBeenCalled()
    await app.dispose()
  })

  it('non-Error mic rejection still surfaces as mic_error', async () => {
    const { client } = makeRtcClient()
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      // Reject with a non-Error value to exercise the `instanceof Error` else branch.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      acquireMic: () => Promise.reject('weird-string'),
      createSession: vi.fn(),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => {
        // noop
      },
      now: () => 0,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(app.store.getState().error?.code).toBe('mic_error')
    await app.dispose()
  })

  it('TICK from interval updates elapsedSeconds while live', async () => {
    const { client, calls } = makeRtcClient()
    const intervalSlot: { fn: (() => void) | null } = { fn: null }
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const nowSlot: { value: number } = { value: 1000 }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(makeMicStream()),
      createSession: vi.fn().mockResolvedValue({
        clientSecret: 's',
        expiresAt: 'e',
        model: 'm',
      }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: (fn: () => void) => {
        intervalSlot.fn = fn
        return 0
      },
      clearIntervalImpl: () => {
        // noop
      },
      now: () => nowSlot.value,
      log: () => {
        // noop
      },
    })
    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    calls.callbacks.onStateChange?.('connected')
    // sessionStartedAt = now() = 1000 at CONNECTED dispatch time.
    nowSlot.value = 4500
    intervalSlot.fn?.()
    expect(app.store.getState().elapsedSeconds).toBe(3)
    await app.dispose()
  })
})

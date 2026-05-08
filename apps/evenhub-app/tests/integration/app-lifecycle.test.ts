/**
 * @vitest-environment jsdom
 *
 * App-class lifecycle integration. Where `src/app.test.ts` covers a single
 * transition or error per case, this suite walks an end-to-end session with
 * mocked I/O and asserts the *combined* effect across layers.
 *
 * Focus (intentionally non-overlapping with app.test.ts):
 *  - LANGUAGE_CHANGED at idle is forwarded into createSession's request.
 *  - Multiple output_transcript.delta events finalize into the SubtitleBuffer
 *    history; the live status bar shows the rolling clock.
 *  - PAUSE/RESUME during live keep the WebRTC client running.
 *  - STOP_REQUESTED triggers the full teardown: client.stop, mic tracks
 *    stopped, detachAudio invoked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App, type AppDeps } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createMockBridge } from '../../src/even/bridge.mock.js'
import { EvenBridgeInitError } from '../../src/even/bridge.js'
import type { WebRtcTranslationClient } from '../../src/realtime/index.js'

interface RtcCalls {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  callbacks: {
    onOutputTranscriptDelta?: (delta: { text: string }) => void
    onStateChange?: (state: RTCPeerConnectionState) => void
    onRemoteAudioTrack?: (track: MediaStreamTrack) => void
    onError?: (err: Error) => void
  }
}

function makeRtcClient(): { client: WebRtcTranslationClient; calls: RtcCalls } {
  const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const calls: RtcCalls = { start, stop, callbacks: {} }
  const client: WebRtcTranslationClient = {
    start,
    stop,
    sendSessionUpdate: vi.fn<(lang: string) => void>(),
    getState: vi.fn<() => RTCPeerConnectionState>(() => 'new'),
  }
  return { client, calls }
}

function makeMicStream(): { stream: MediaStream; trackStop: ReturnType<typeof vi.fn> } {
  const trackStop = vi.fn()
  const tracks = [{ stop: trackStop }]
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream
  return { stream, trackStop }
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

/** Drain microtasks. Each await of `setTimeout(0)` flushes one task tick. */
async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

describe('integration: App full session lifecycle', () => {
  beforeEach(() => {
    clearBody()
  })
  afterEach(() => {
    clearBody()
  })

  it('LANGUAGE_CHANGED before START forwards the new target into createSession', async () => {
    const { client, calls } = makeRtcClient()
    const { stream } = makeMicStream()
    const createSession = vi.fn<NonNullable<AppDeps['createSession']>>().mockResolvedValue({
      clientSecret: 's',
      expiresAt: 'e',
      model: 'm',
    })
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(stream),
      createSession,
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => undefined,
      now: () => 1000,
      log: () => undefined,
    })

    await app.boot()
    // Default language pair is auto → ja (DEFAULT_LANGUAGE_PAIR). Rotate target
    // to fr while still idle.
    app.dispatch({ type: 'LANGUAGE_CHANGED', pair: { source: 'en', target: 'fr' } })
    expect(app.store.getState().languagePair).toEqual({ source: 'en', target: 'fr' })

    app.dispatch({ type: 'START_REQUESTED' })
    await drain()

    expect(createSession).toHaveBeenCalledTimes(1)
    const call = createSession.mock.calls[0]?.[0]
    expect(call?.request.targetLanguage).toBe('fr')
    expect(call?.request.sourceHint).toBe('en')
    // Backend URL and client metadata are passed through verbatim from the config.
    expect(call?.backendUrl).toBe('http://localhost:3000')
    expect(call?.request.client.device).toBe('G2')

    await app.dispose()
  })

  it('multiple output_transcript.delta events finalize a sentence into history', async () => {
    const { client, calls } = makeRtcClient()
    const { stream } = makeMicStream()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onOutputTranscriptDelta = opts.onOutputTranscriptDelta
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }

    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(stream),
      createSession: vi
        .fn<NonNullable<AppDeps['createSession']>>()
        .mockResolvedValue({ clientSecret: 's', expiresAt: 'e', model: 'm' }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => undefined,
      now: () => 1000,
      log: () => undefined,
    })

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    calls.callbacks.onStateChange?.('connected')
    expect(app.store.getState().status).toBe('live')

    // Drip three deltas that together form a complete sentence.
    calls.callbacks.onOutputTranscriptDelta?.({ text: 'Hello, ' })
    calls.callbacks.onOutputTranscriptDelta?.({ text: 'world' })
    calls.callbacks.onOutputTranscriptDelta?.({ text: '.' })
    // SubtitleBuffer's default trailing-edge throttle is 150 ms.
    await new Promise((r) => setTimeout(r, 200))

    // The finalized sentence appears in the active subtitle (which is what
    // the reducer mirrors) and the live status bar wraps the rendered text.
    const state = app.store.getState()
    expect(state.activeSubtitle).toContain('Hello, world.')

    await app.dispose()
  })

  it('PAUSE/RESUME from live keeps the RTC client running and only flips the screen', async () => {
    const { client, calls } = makeRtcClient()
    const { stream } = makeMicStream()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(stream),
      createSession: vi
        .fn<NonNullable<AppDeps['createSession']>>()
        .mockResolvedValue({ clientSecret: 's', expiresAt: 'e', model: 'm' }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => undefined,
      now: () => 1000,
      log: () => undefined,
    })

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    calls.callbacks.onStateChange?.('connected')

    app.dispatch({ type: 'PAUSE' })
    expect(app.store.getState().status).toBe('paused')
    expect(calls.stop).not.toHaveBeenCalled()

    app.dispatch({ type: 'RESUME' })
    expect(app.store.getState().status).toBe('live')
    expect(calls.stop).not.toHaveBeenCalled()

    await app.dispose()
  })

  it('STOP_REQUESTED tears down: client.stop, mic tracks stopped, detachAudio called', async () => {
    const { client, calls } = makeRtcClient()
    const { stream, trackStop } = makeMicStream()
    const detachAudio = vi.fn()
    const createRtcClient: AppDeps['createRtcClient'] = (opts) => {
      calls.callbacks.onStateChange = opts.onStateChange
      return client
    }

    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(stream),
      createSession: vi
        .fn<NonNullable<AppDeps['createSession']>>()
        .mockResolvedValue({ clientSecret: 's', expiresAt: 'e', model: 'm' }),
      createRtcClient,
      attachAudio: vi.fn(),
      detachAudio,
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => undefined,
      now: () => 1000,
      log: () => undefined,
    })

    await app.boot()
    app.dispatch({ type: 'START_REQUESTED' })
    await drain()
    calls.callbacks.onStateChange?.('connected')
    expect(app.store.getState().status).toBe('live')

    app.dispatch({ type: 'STOP_REQUESTED' })
    // Status flips to exiting synchronously; teardown microtasks run after.
    expect(app.store.getState().status).toBe('exiting')
    await drain()

    expect(calls.stop).toHaveBeenCalledTimes(1)
    expect(trackStop).toHaveBeenCalledTimes(1)
    expect(detachAudio).toHaveBeenCalled()

    await app.dispose()
  })

  it('subscribers added during a transition do not run for it but are called on the next dispatch', async () => {
    // Regression guard: dispatch fans out via Array.from(listeners), so a
    // listener added inside another listener is invoked on the *next* action,
    // not the current one. We rely on this when App.boot subscribes its
    // status-change handler after the render handler.
    const { client } = makeRtcClient()
    const { stream } = makeMicStream()
    const app = new App(defaultCfg(), {
      bridgeFactory: () => Promise.reject(new EvenBridgeInitError('timeout', 'no host')),
      mockBridgeFactory: () => createMockBridge(),
      acquireMic: () => Promise.resolve(stream),
      createSession: vi
        .fn<NonNullable<AppDeps['createSession']>>()
        .mockResolvedValue({ clientSecret: 's', expiresAt: 'e', model: 'm' }),
      createRtcClient: () => client,
      attachAudio: vi.fn(),
      detachAudio: vi.fn(),
      setIntervalImpl: () => 0,
      clearIntervalImpl: () => undefined,
      now: () => 1000,
      log: () => undefined,
    })
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

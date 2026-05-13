import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptDelta } from '@even-rt/shared'

import { createMockBridge } from '../even/bridge.mock.js'
import type { BridgeMicHandle, BridgeMicHandler } from '../audio/bridgeMic.js'
import {
  BackendError,
  MicPermissionError,
  type TranslationRuntimeStartOpts,
} from './runtime.js'
import { createWebSocketRuntimeFactory } from './runtimeWs.js'
import type { WebSocketTranslationClient } from './websocketTranslationClient.js'

// ──────────────────────────────────────────────────────────────────────────
// Test doubles.
// ──────────────────────────────────────────────────────────────────────────

function makeMicHandle(): {
  handle: BridgeMicHandle
  stopped: () => boolean
  handlerCount: () => number
  emit: (samples: Int16Array) => void
} {
  const handlers = new Set<BridgeMicHandler>()
  let stopped = false
  return {
    handle: {
      stop(): Promise<void> {
        stopped = true
        handlers.clear()
        return Promise.resolve()
      },
      onPcm(handler: BridgeMicHandler): () => void {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    },
    stopped: () => stopped,
    handlerCount: () => handlers.size,
    emit: (samples) => {
      for (const fn of handlers) fn(samples)
    },
  }
}

interface FakeClient extends WebSocketTranslationClient {
  /** Test seam: drive the onStateChange callback. */
  fireState(state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'): void
  /** Test seam: drive a transcript delta. */
  fireOutputTranscript(delta: TranscriptDelta): void
  fireInputTranscript(delta: TranscriptDelta): void
  fireAudio(samples: Int16Array): void
  fireError(err: Error): void
  /** Reject the start() promise (simulate handshake failure). */
  failNextStart(err: Error): void
  startCount: number
  stopCount: number
  languageUpdates: string[]
}

function makeFakeClient(): FakeClient & { _opts?: Parameters<typeof import('./websocketTranslationClient.js').createWebSocketTranslationClient>[0] } {
  let startReject: Error | null = null
  let optsCapture: Parameters<typeof import('./websocketTranslationClient.js').createWebSocketTranslationClient>[0] | null = null

  const fc: FakeClient & { _opts?: Parameters<typeof import('./websocketTranslationClient.js').createWebSocketTranslationClient>[0] } = {
    startCount: 0,
    stopCount: 0,
    languageUpdates: [],
    start(): Promise<void> {
      fc.startCount += 1
      if (startReject !== null) {
        const e = startReject
        startReject = null
        return Promise.reject(e)
      }
      // Default: simulate WS open → 'connecting' → 'connected' transitions
      // so the runtime's start() promise resolves.
      optsCapture?.onStateChange('connecting')
      optsCapture?.onStateChange('connected')
      return Promise.resolve()
    },
    stop(): Promise<void> {
      fc.stopCount += 1
      return Promise.resolve()
    },
    sendLanguageUpdate(target): void {
      fc.languageUpdates.push(target)
    },
    getState() {
      return 'connected'
    },
    fireState(state) {
      optsCapture?.onStateChange(state)
    },
    fireOutputTranscript(delta) {
      optsCapture?.onOutputTranscriptDelta(delta)
    },
    fireInputTranscript(delta) {
      optsCapture?.onInputTranscriptDelta?.(delta)
    },
    fireAudio(samples) {
      optsCapture?.onAudioDelta?.(samples)
    },
    fireError(err) {
      optsCapture?.onError?.(err)
    },
    failNextStart(err): void {
      startReject = err
    },
  }
  // Inject the captured opts via a hidden setter.
  ;(fc as unknown as { __setOpts: (o: typeof optsCapture) => void }).__setOpts = (o) => {
    optsCapture = o
  }
  return fc
}

interface Harness {
  states: import('@even-rt/shared').ConnectionStatus[]
  outputs: TranscriptDelta[]
  inputs: TranscriptDelta[]
  errors: Error[]
  audios: Int16Array[]
  startOpts: TranslationRuntimeStartOpts
}

function makeStartOpts(): Harness {
  const states: import('@even-rt/shared').ConnectionStatus[] = []
  const outputs: TranscriptDelta[] = []
  const inputs: TranscriptDelta[] = []
  const errors: Error[] = []
  const audios: Int16Array[] = []
  return {
    states,
    outputs,
    inputs,
    errors,
    audios,
    startOpts: {
      targetLanguage: 'ja',
      sourceHint: 'auto',
      onOutputTranscriptDelta: (d) => outputs.push(d),
      onInputTranscriptDelta: (d) => inputs.push(d),
      onAudioDelta: (s) => audios.push(s),
      onStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests.
// ──────────────────────────────────────────────────────────────────────────

let bridge: ReturnType<typeof createMockBridge>
let micHelpers: ReturnType<typeof makeMicHandle>
let fakeClient: ReturnType<typeof makeFakeClient>

beforeEach(() => {
  bridge = createMockBridge()
  micHelpers = makeMicHandle()
  fakeClient = makeFakeClient()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createWebSocketRuntimeFactory — happy path', () => {
  it('opens mic via bridge, starts the WS client, and emits connected', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)

    expect(fakeClient.startCount).toBe(1)
    expect(h.states).toEqual(['connecting', 'connected'])
    await runtime.stop()
    expect(fakeClient.stopCount).toBe(1)
    expect(micHelpers.stopped()).toBe(true)
  })

  it('passes targetLanguage through to the underlying client', async () => {
    let captured: { targetLanguage?: string } = {}
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        captured = { targetLanguage: opts.targetLanguage }
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    h.startOpts.targetLanguage = 'en'
    await runtime.start(h.startOpts)
    expect(captured.targetLanguage).toBe('en')
    await runtime.stop()
  })

  it('routes transcript / audio / error callbacks transparently', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)

    fakeClient.fireOutputTranscript({ text: 'こんにちは', createdAt: 0 })
    fakeClient.fireInputTranscript({ text: 'hi', createdAt: 0 })
    fakeClient.fireAudio(new Int16Array([1, 2, 3]))
    fakeClient.fireError(new Error('upstream burped'))

    expect(h.outputs).toHaveLength(1)
    expect(h.inputs).toHaveLength(1)
    expect(h.audios).toHaveLength(1)
    expect(h.errors).toHaveLength(1)
    await runtime.stop()
  })

  it('maps WsConnectionState to ConnectionStatus on subsequent transitions', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    h.states.length = 0

    fakeClient.fireState('reconnecting')
    fakeClient.fireState('connected')
    fakeClient.fireState('failed')

    expect(h.states).toEqual(['reconnecting', 'connected', 'failed'])
    await runtime.stop()
  })

  it('forwards language updates to the underlying client', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    runtime.sendLanguageUpdate('en')
    runtime.sendLanguageUpdate('ko')
    expect(fakeClient.languageUpdates).toEqual(['en', 'ko'])
    await runtime.stop()
  })
})

describe('createWebSocketRuntimeFactory — failure modes', () => {
  it('maps bridge acquisition failure to MicPermissionError', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.reject(new Error('bridge audio busy')),
      createClient: () => fakeClient,
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await expect(runtime.start(h.startOpts)).rejects.toBeInstanceOf(MicPermissionError)
    expect(fakeClient.startCount).toBe(0)
  })

  it('cleans up mic and client if client.start() fails', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    fakeClient.failNextStart(new Error('handshake refused'))
    const runtime = factory.create()
    const h = makeStartOpts()
    await expect(runtime.start(h.startOpts)).rejects.toThrow(/handshake refused/)
    expect(micHelpers.stopped()).toBe(true)
  })

  it('concurrent start() calls share the in-flight Promise', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    const a = runtime.start(h.startOpts)
    const b = runtime.start(h.startOpts)
    expect(a).toBe(b)
    await a
    expect(fakeClient.startCount).toBe(1)
    await runtime.stop()
  })

  it('stop() after start() releases mic and client even on best-effort teardown failures', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    fakeClient.stop = () => Promise.reject(new Error('client stop refused'))
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    await runtime.stop() // must NOT throw
    expect(micHelpers.stopped()).toBe(true)
  })

  it('start() after stop() rejects (single-shot lifecycle)', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    await runtime.stop()
    const h = makeStartOpts()
    await expect(runtime.start(h.startOpts)).rejects.toThrow(/already stopped/)
  })
})

describe('createWebSocketRuntimeFactory — Codex review regressions', () => {
  // H-1: client.start() rejection used to call mic.stop() but leave the
  // partially-open client (and any reconnect timer) running.
  it('H-1: client.start() rejection tears down BOTH mic and client', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    fakeClient.failNextStart(new Error('handshake refused'))
    const runtime = factory.create()
    const h = makeStartOpts()
    await expect(runtime.start(h.startOpts)).rejects.toThrow(/handshake refused/)
    expect(micHelpers.stopped()).toBe(true)
    expect(fakeClient.stopCount).toBe(1)
  })

  // H-2: createClient() throwing synchronously used to leak the mic — the
  // try/catch only covered client.start().
  it('H-2: createClient() constructor throw releases the mic', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: () => {
        throw new Error('WS unavailable in this runtime')
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await expect(runtime.start(h.startOpts)).rejects.toThrow(/WS unavailable/)
    expect(micHelpers.stopped()).toBe(true)
  })

  // H-3: a second start() after success used to spin up a second
  // mic+client pair (and orphan the first). After the fix the second
  // call resolves immediately without re-entering openSession.
  it('H-3: start() after successful start is a no-op', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    // Second call: must not produce a second client.start().
    await runtime.start(h.startOpts)
    expect(fakeClient.startCount).toBe(1)
    expect(micHelpers.handlerCount()).toBe(0) // fake client doesn't subscribe
    await runtime.stop()
  })

  // H-4: backend error frames used to surface as generic Error. App.ts
  // wants to branch on rate_limited / auth_error / upstream_error via
  // `instanceof BackendError`.
  it('H-4: WS client error frames are normalised to BackendError before onError', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)

    // WS client emits the documented "ws translation error [<code>]: <message>"
    // shape; the runtime should normalise it.
    fakeClient.fireError(new Error('ws translation error [rate_limited]: slow down'))
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toBeInstanceOf(BackendError)
    const be = h.errors[0] as BackendError
    expect(be.code).toBe('rate_limited')
    expect(be.message).toBe('slow down')
    await runtime.stop()
  })

  // H-4 negative: non-matching error messages stay generic.
  it('H-4: non-WS-pattern errors are surfaced as plain Error (not BackendError)', async () => {
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    fakeClient.fireError(new Error('network blip'))
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).not.toBeInstanceOf(BackendError)
    expect(h.errors[0]!.message).toBe('network blip')
    await runtime.stop()
  })

  // Bonus: stop() during in-flight start should not leave mic open.
  it('stop() while start() is in flight tears down the mic acquired so far', async () => {
    let resolveMic: (h: BridgeMicHandle) => void = () => undefined
    const micPromise = new Promise<BridgeMicHandle>((resolve) => {
      resolveMic = resolve
    })
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => micPromise,
      createClient: (opts) => {
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    const startP = runtime.start(h.startOpts)
    // While start() is waiting on acquireMic, the App calls stop().
    await runtime.stop()
    // Now resolve the mic — the runtime should detect `stopped` and clean
    // up rather than continue to open the WS.
    resolveMic(micHelpers.handle)
    await expect(startP).rejects.toThrow(/stopped/)
    expect(micHelpers.stopped()).toBe(true)
  })
})

describe('createWebSocketRuntimeFactory — URL resolution', () => {
  it('passes absolute ws:// URLs through unchanged', async () => {
    let observedUrl = ''
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: 'ws://example.test/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        observedUrl = opts.backendUrl
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    expect(observedUrl).toBe('ws://example.test/api/realtime/ws')
    await runtime.stop()
  })

  it('resolves path-relative URLs against the page origin', async () => {
    let observedUrl = ''
    const factory = createWebSocketRuntimeFactory({
      bridge,
      backendWsUrl: '/api/realtime/ws',
      acquireMic: () => Promise.resolve(micHelpers.handle),
      createClient: (opts) => {
        observedUrl = opts.backendUrl
        ;(fakeClient as unknown as { __setOpts: (o: typeof opts) => void }).__setOpts(opts)
        return fakeClient
      },
    })
    const runtime = factory.create()
    const h = makeStartOpts()
    await runtime.start(h.startOpts)
    // jsdom location → ws://localhost/api/realtime/ws (or wss:// if https).
    expect(observedUrl).toMatch(/^wss?:\/\/[^/]+\/api\/realtime\/ws$/)
    await runtime.stop()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { bytesToSamplesLE, resample16to24, samplesToBytesLE } from '@even-rt/shared'

import type { BridgeMicHandle, BridgeMicHandler } from '../audio/bridgeMic.js'
import {
  createWebSocketTranslationClient,
  type WsConnectionState,
} from './websocketTranslationClient.js'

// ──────────────────────────────────────────────────────────────────────────
// Test doubles.
// ──────────────────────────────────────────────────────────────────────────

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  /** All instances ever constructed, in order. */
  static instances: FakeWebSocket[] = []

  url: string
  readyState: number = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  /** Test helper: drive the open transition + fire onopen. */
  simulateOpen(): void {
    this.readyState = this.OPEN
    this.onopen?.(new Event('open'))
  }
  simulateMessage(msg: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))
  }
  simulateRawMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: data as string }))
  }
  simulateClose(code: number, reason = ''): void {
    this.readyState = this.CLOSED
    this.onclose?.(new CloseEvent('close', { code, reason }))
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) {
      throw new Error('FakeWebSocket: send before open')
    }
    this.sent.push(data)
  }

  close(code = 1000): void {
    this.readyState = this.CLOSED
    this.onclose?.(new CloseEvent('close', { code }))
  }
}

function makeMicHandle(): {
  handle: BridgeMicHandle
  emit: (samples: Int16Array) => void
  handlerCount: () => number
  stopped: () => boolean
} {
  const handlers = new Set<BridgeMicHandler>()
  let stopped = false
  const handle: BridgeMicHandle = {
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
  }
  return {
    handle,
    emit(samples: Int16Array): void {
      for (const fn of handlers) fn(samples)
    },
    handlerCount: (): number => handlers.size,
    stopped: (): boolean => stopped,
  }
}

interface ClientHarness {
  client: ReturnType<typeof createWebSocketTranslationClient>
  states: WsConnectionState[]
  errors: Error[]
  mic: ReturnType<typeof makeMicHandle>
  outputs: { text: string; itemId?: string }[]
  inputs: { text: string; itemId?: string }[]
  audios: Int16Array[]
}

async function startClient(
  options: { withInputHandler?: boolean; withAudioHandler?: boolean; backendUrl?: string } = {},
): Promise<ClientHarness> {
  const mic = makeMicHandle()
  const states: WsConnectionState[] = []
  const errors: Error[] = []
  const outputs: { text: string; itemId?: string }[] = []
  const inputs: { text: string; itemId?: string }[] = []
  const audios: Int16Array[] = []
  const client = createWebSocketTranslationClient({
    backendUrl: options.backendUrl ?? 'ws://127.0.0.1:0/api/realtime/ws',
    targetLanguage: 'ja',
    micHandle: mic.handle,
    onOutputTranscriptDelta: (d): void => {
      outputs.push(d)
    },
    onStateChange: (s): void => {
      states.push(s)
    },
    onError: (e): void => {
      errors.push(e)
    },
    wsImpl: FakeWebSocket as unknown as typeof WebSocket,
    reconnectOptions: { maxAttempts: 3, baseDelayMs: 1 },
    // Spread the optional handlers so exactOptionalPropertyTypes is happy —
    // an explicit `undefined` would violate the contract.
    ...(options.withInputHandler === false
      ? {}
      : {
          onInputTranscriptDelta: (d: { text: string; itemId?: string; createdAt: number }) => {
            inputs.push(d)
          },
        }),
    ...(options.withAudioHandler === false
      ? {}
      : {
          onAudioDelta: (s: Int16Array) => {
            audios.push(s)
          },
        }),
  })
  // start() resolves on the first onopen. Drive the WS open synchronously
  // right after start() kicks the constructor.
  const startPromise = client.start()
  // The constructor pushed an instance; drive its open.
  const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
  sock.simulateOpen()
  await startPromise
  return { client, states, errors, mic, outputs, inputs, audios }
}

afterEach(() => {
  FakeWebSocket.instances.length = 0
})

// ──────────────────────────────────────────────────────────────────────────
// Tests.
// ──────────────────────────────────────────────────────────────────────────

describe('createWebSocketTranslationClient — happy path', () => {
  it('opens the WS and sends an `open` frame with the configured target language', async () => {
    const h = await startClient()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const sock = FakeWebSocket.instances[0]!
    expect(sock.sent).toHaveLength(1)
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: 'open', targetLanguage: 'ja' })
    expect(h.states).toEqual(['connecting', 'connected'])
    expect(h.client.getState()).toBe('connected')
    await h.client.stop()
  })

  it('subscribes to the mic only after the WS is open (not before)', async () => {
    const mic = makeMicHandle()
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'en',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: () => undefined,
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const startPromise = client.start()
    // Before WS opens, no mic subscription should exist yet.
    expect(mic.handlerCount()).toBe(0)
    const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    sock.simulateOpen()
    await startPromise
    expect(mic.handlerCount()).toBe(1)
    await client.stop()
  })

  it('forwards mic chunks as resampled 24 kHz base64-PCM audio frames', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.sent.length = 0 // drop the initial `open` frame

    // 100 ms @ 16 kHz mono = 1600 samples. Use a deterministic ramp so we
    // can decode the frame and compare against the reference resampler
    // output.
    const samples = new Int16Array(1600)
    for (let i = 0; i < samples.length; i += 1) samples[i] = i - 800

    h.mic.emit(samples)
    expect(sock.sent).toHaveLength(1)
    const msg = JSON.parse(sock.sent[0]!) as { type: string; pcm: string }
    expect(msg.type).toBe('audio')

    // Reverse the encode chain and confirm we landed on resample16to24(samples).
    const decodedBytes = Uint8Array.from(atob(msg.pcm), (c) => c.charCodeAt(0))
    const decodedSamples = bytesToSamplesLE(decodedBytes)
    const expected = samplesToBytesLE(resample16to24(samples))
    expect(decodedBytes).toEqual(expected)
    expect(decodedSamples.length).toBe(2400)

    await h.client.stop()
  })

  it('routes transcript.delta server messages to the matching handlers', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.simulateMessage({
      type: 'transcript.delta',
      source: 'output',
      text: 'こんにちは',
      itemId: 'item-1',
    })
    sock.simulateMessage({ type: 'transcript.delta', source: 'input', text: 'Hello' })
    expect(h.outputs).toHaveLength(1)
    expect(h.outputs[0]).toMatchObject({ text: 'こんにちは', itemId: 'item-1' })
    expect(h.inputs).toHaveLength(1)
    expect(h.inputs[0]).toMatchObject({ text: 'Hello' })
    await h.client.stop()
  })

  it('decodes audio.delta into Int16Array samples for the optional callback', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    const samples = new Int16Array([100, -100, 200, -200])
    const b64 = btoa(String.fromCharCode(...samplesToBytesLE(samples)))
    sock.simulateMessage({ type: 'audio.delta', pcm: b64 })
    expect(h.audios).toHaveLength(1)
    expect(Array.from(h.audios[0]!)).toEqual(Array.from(samples))
    await h.client.stop()
  })

  it('skips input/output handlers gracefully when not provided', async () => {
    const h = await startClient({ withInputHandler: false, withAudioHandler: false })
    const sock = FakeWebSocket.instances[0]!
    sock.simulateMessage({ type: 'transcript.delta', source: 'input', text: 'hi' })
    sock.simulateMessage({ type: 'audio.delta', pcm: btoa('xx') })
    expect(h.inputs).toHaveLength(0)
    expect(h.audios).toHaveLength(0)
    await h.client.stop()
  })

  it('relays server `error` messages through onError', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.simulateMessage({ type: 'error', code: 'rate_limited', message: 'slow down' })
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]!.message).toMatch(/rate_limited/)
    expect(h.errors[0]!.message).toMatch(/slow down/)
    await h.client.stop()
  })
})

describe('createWebSocketTranslationClient — language update', () => {
  it('sends `language` frame and remembers the target for the next (re)open', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.sent.length = 0
    h.client.sendLanguageUpdate('en')
    expect(sock.sent).toHaveLength(1)
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: 'language', target: 'en' })

    // After a reconnect, the new socket should re-open with the updated target.
    sock.simulateClose(1011)
    // ReconnectController fires after baseDelayMs=1ms.
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    next.simulateOpen()
    expect(JSON.parse(next.sent[0]!)).toEqual({ type: 'open', targetLanguage: 'en' })
    await h.client.stop()
  })
})

describe('createWebSocketTranslationClient — stop semantics', () => {
  it('sends `close` then tears down the socket and unsubscribes from the mic', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.sent.length = 0
    await h.client.stop()
    expect(JSON.parse(sock.sent[0]!)).toEqual({ type: 'close' })
    expect(sock.readyState).toBe(FakeWebSocket.CLOSED)
    expect(h.mic.handlerCount()).toBe(0)
    expect(h.client.getState()).toBe('idle')
  })

  it('stop() before start() is a no-op', async () => {
    const mic = makeMicHandle()
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'ja',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: () => undefined,
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    await client.stop()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })
})

describe('createWebSocketTranslationClient — reconnect', () => {
  it('reconnects on unexpected close, then transitions through reconnecting → connected', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    h.states.length = 0
    sock.simulateClose(1011) // server error → reconnectable
    expect(h.states[0]).toBe('reconnecting')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    next.simulateOpen()
    expect(h.client.getState()).toBe('connected')
    await h.client.stop()
  })

  it('transitions to `failed` after exceeding the configured max attempts', async () => {
    const mic = makeMicHandle()
    const states: WsConnectionState[] = []
    const errors: Error[] = []
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'ja',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnectOptions: { maxAttempts: 1, baseDelayMs: 1 },
    })
    const startPromise = client.start()
    const first = FakeWebSocket.instances[0]!
    first.simulateOpen()
    await startPromise

    // After exhausting maxAttempts=1, the next unexpected close must give up.
    first.simulateClose(1011) // attempts the 1 allowed reconnect
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const second = FakeWebSocket.instances[1]
    if (second) second.simulateClose(1011) // exhausts; controller rejects
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(states).toContain('failed')
    expect(errors.length).toBeGreaterThan(0)
    await client.stop()
  })

  it('does not reconnect after stop()', async () => {
    const h = await startClient()
    await h.client.stop()
    const countBefore = FakeWebSocket.instances.length
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(FakeWebSocket.instances.length).toBe(countBefore)
  })
})

describe('createWebSocketTranslationClient — Codex review regressions', () => {
  // H-1: stop() permanently dispose()'d the ReconnectController; a second
  // start() then failed to reconnect after any transient close because the
  // shared controller rejected scheduleNext() immediately.
  it('H-1: stop() → start() → unexpected close still reconnects (fresh controller)', async () => {
    const h = await startClient()
    await h.client.stop()
    expect(h.client.getState()).toBe('idle')

    // Second start() — controller must be recreated.
    const restart = h.client.start()
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    second.simulateOpen()
    await restart
    expect(h.client.getState()).toBe('connected')

    // Now trigger a reconnectable close and verify a new socket opens.
    const before = FakeWebSocket.instances.length
    second.simulateClose(1011)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before)
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.simulateOpen()
    expect(h.client.getState()).toBe('connected')

    await h.client.stop()
  })

  // H-2: original onclose called reject(...) for never-opened sockets AND
  // fell through into scheduleReconnect(). A failed start() should leave the
  // client idle, not silently retry behind the user's back.
  it('H-2: start() rejection on pre-open close does not schedule a background reconnect', async () => {
    const mic = makeMicHandle()
    const states: WsConnectionState[] = []
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'ja',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: (s): void => {
        states.push(s)
      },
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnectOptions: { maxAttempts: 3, baseDelayMs: 1 },
    })
    const start = client.start()
    const first = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    first.simulateClose(1011) // close before open
    await expect(start).rejects.toThrow(/closed before open/)

    const countAfterReject = FakeWebSocket.instances.length
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(FakeWebSocket.instances.length).toBe(countAfterReject)
    expect(client.getState()).toBe('failed')
  })

  // H-3: a terminal failure (non-reconnectable code or max-attempts exhausted)
  // used to leave mic.onPcm subscribed, burning CPU on chunks that have no
  // socket to ship them through.
  it('H-3a: terminal close (non-reconnectable code) detaches the mic subscription', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    expect(h.mic.handlerCount()).toBe(1)
    sock.simulateClose(4404) // not in RECONNECTABLE_CLOSE_CODES → terminal
    expect(h.client.getState()).toBe('failed')
    expect(h.mic.handlerCount()).toBe(0)
  })

  it('H-3b: exhausting max reconnect attempts detaches the mic subscription', async () => {
    const mic = makeMicHandle()
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'ja',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: () => undefined,
      onError: () => undefined,
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnectOptions: { maxAttempts: 1, baseDelayMs: 1 },
    })
    const startPromise = client.start()
    const first = FakeWebSocket.instances[0]!
    first.simulateOpen()
    await startPromise
    expect(mic.handlerCount()).toBe(1)

    first.simulateClose(1011) // first reconnect attempt
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const second = FakeWebSocket.instances[1]
    if (second) second.simulateClose(1011) // exhausts maxAttempts=1
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(client.getState()).toBe('failed')
    expect(mic.handlerCount()).toBe(0)

    await client.stop()
  })

  // H-4: `meta: null` slipped past `typeof obj.meta !== 'object'` because
  // `typeof null === 'object'`. Server frame with `meta: null` then threw on
  // `meta.model` and tore down the message loop.
  it('H-4: server.session.created with meta=null is dropped, not thrown', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    expect(() => {
      sock.simulateMessage({ type: 'session.created', meta: null })
    }).not.toThrow()
    // Subsequent transcripts still flow.
    sock.simulateMessage({ type: 'transcript.delta', source: 'output', text: 'ok' })
    expect(h.outputs).toHaveLength(1)
    await h.client.stop()
  })

  // M-1: code 1000 (normal closure) used to be on the reconnect path.
  // Backend uses 1000 for many deliberate teardowns — we'd loop until
  // max-attempts on every benign close.
  it('M-1: close code 1000 (normal) does not trigger a reconnect', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    const before = FakeWebSocket.instances.length
    sock.simulateClose(1000)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(FakeWebSocket.instances.length).toBe(before)
    expect(h.client.getState()).toBe('failed')
  })

  // M-2: concurrent start() must share the pending Promise so the second
  // caller doesn't resolve before the WS is actually open.
  it('M-2: concurrent start() calls return the same in-flight Promise', async () => {
    const mic = makeMicHandle()
    const client = createWebSocketTranslationClient({
      backendUrl: 'ws://x/y',
      targetLanguage: 'ja',
      micHandle: mic.handle,
      onOutputTranscriptDelta: () => undefined,
      onStateChange: () => undefined,
      wsImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const a = client.start()
    const b = client.start()
    expect(a).toBe(b) // identity, not just equivalence
    FakeWebSocket.instances[0]!.simulateOpen()
    await a
    expect(client.getState()).toBe('connected')
    await client.stop()
  })
})

describe('createWebSocketTranslationClient — message hardening', () => {
  it('drops non-JSON payloads silently', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.simulateRawMessage('not json')
    sock.simulateRawMessage(new ArrayBuffer(8))
    expect(h.outputs).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
    await h.client.stop()
  })

  it('drops messages with unknown `type` field', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.simulateMessage({ type: 'unknown.future.event', payload: 'x' })
    expect(h.outputs).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
    await h.client.stop()
  })

  it('drops malformed transcript.delta (no text or bad source)', async () => {
    const h = await startClient()
    const sock = FakeWebSocket.instances[0]!
    sock.simulateMessage({ type: 'transcript.delta' })
    sock.simulateMessage({ type: 'transcript.delta', source: 'sideways', text: 'x' })
    expect(h.outputs).toHaveLength(0)
    expect(h.inputs).toHaveLength(0)
    await h.client.stop()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptDelta } from '@even-rt/shared'

import { createWebRtcTranslationClient } from './webrtcTranslationClient.js'

// ---------------------------------------------------------------------------
// Typed `vi.fn` factories. Without an explicit signature, `vi.fn()` returns
// `Mock<Procedure | Constructable>` which TS strict mode refuses to assign to
// `(x: T) => void` callback fields, so we declare narrow factories per type.
// ---------------------------------------------------------------------------
type DeltaFn = ReturnType<typeof vi.fn<(d: TranscriptDelta) => void>>
type TrackFn = ReturnType<typeof vi.fn<(t: MediaStreamTrack) => void>>
type StateFn = ReturnType<typeof vi.fn<(s: RTCPeerConnectionState) => void>>
type ErrorFn = ReturnType<typeof vi.fn<(e: Error) => void>>

const fnDelta = (): DeltaFn => vi.fn<(d: TranscriptDelta) => void>()
const fnTrack = (): TrackFn => vi.fn<(t: MediaStreamTrack) => void>()
const fnState = (): StateFn => vi.fn<(s: RTCPeerConnectionState) => void>()
const fnError = (): ErrorFn => vi.fn<(e: Error) => void>()

// ---------------------------------------------------------------------------
// Minimal in-test stand-ins for browser WebRTC primitives. jsdom doesn't
// implement RTCPeerConnection / MediaStream, so we inject our own.
// ---------------------------------------------------------------------------

class FakeRTCDataChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: MessageEvent<string>) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []

  send(data: string): void {
    if (this.readyState !== 'open') {
      throw new Error(`FakeRTCDataChannel.send while readyState=${this.readyState}`)
    }
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 'closed'
    this.onclose?.()
  }

  emitOpen(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>)
  }
}

interface FakeSender {
  track: { stop: () => void; kind: string; id: string }
}

class FakeRTCPeerConnection {
  // captured config
  readonly config: RTCConfiguration | undefined
  static lastInstance: FakeRTCPeerConnection | null = null

  ontrack: ((ev: RTCTrackEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null

  connectionState: RTCPeerConnectionState = 'new'
  iceConnectionState: RTCIceConnectionState = 'new'

  createdDataChannels: { label: string; channel: FakeRTCDataChannel }[] = []
  senders: FakeSender[] = []
  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null

  closed = false

  constructor(config?: RTCConfiguration) {
    this.config = config
    FakeRTCPeerConnection.lastInstance = this
  }

  createDataChannel(label: string): FakeRTCDataChannel {
    const dc = new FakeRTCDataChannel()
    this.createdDataChannels.push({ label, channel: dc })
    return dc
  }

  addTrack(track: { stop: () => void; kind: string; id: string }): FakeSender {
    const sender = { track }
    this.senders.push(sender)
    return sender
  }

  getSenders(): FakeSender[] {
    return this.senders
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' })
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc
    return Promise.resolve()
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    this.connectionState = 'closed'
    this.onconnectionstatechange?.()
  }

  // Test helpers
  emitTrack(track: MediaStreamTrack): void {
    this.ontrack?.({
      track,
      streams: [],
      receiver: {} as RTCRtpReceiver,
      transceiver: {} as RTCRtpTransceiver,
    } as unknown as RTCTrackEvent)
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  getMainDataChannel(): FakeRTCDataChannel | undefined {
    return this.createdDataChannels[0]?.channel
  }
}

function makeFakeMediaStream(tracks: { stop: () => void; kind: string; id: string }[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => tracks,
    id: 'fake-stream',
  } as unknown as MediaStream
}

interface FakeAudioTrack {
  stop: ReturnType<typeof vi.fn<() => void>>
  kind: string
  id: string
}

function makeAudioTrack(id: string): FakeAudioTrack {
  return {
    stop: vi.fn<() => void>(),
    kind: 'audio',
    id,
  }
}

function fakeFetch(answer = 'v=0\r\nfake-answer\r\n', status = 200): typeof fetch {
  const impl: typeof fetch = () => Promise.resolve(new Response(answer, { status }))
  return vi.fn<typeof fetch>(impl)
}

afterEach(() => {
  vi.useRealTimers()
  FakeRTCPeerConnection.lastInstance = null
})

// ---------------------------------------------------------------------------

describe('createWebRtcTranslationClient.start', () => {
  let onOutputDelta: DeltaFn
  let onInputDelta: DeltaFn
  let onTrack: TrackFn
  let onState: StateFn
  let onError: ErrorFn

  beforeEach(() => {
    onOutputDelta = fnDelta()
    onInputDelta = fnDelta()
    onTrack = fnTrack()
    onState = fnState()
    onError = fnError()
  })

  it('creates a peer connection with empty iceServers, adds the mic track, and exchanges SDP', async () => {
    const track = makeAudioTrack('mic-1')
    const stream = makeFakeMediaStream([track])
    const fetchImpl = fakeFetch()

    const client = createWebRtcTranslationClient({
      clientSecret: 'cs_secret',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onInputTranscriptDelta: onInputDelta,
      onRemoteAudioTrack: onTrack,
      onStateChange: onState,
      onError,
      fetchImpl,
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })

    await client.start()

    const pc = FakeRTCPeerConnection.lastInstance
    expect(pc).not.toBeNull()
    if (pc === null) throw new Error('unreachable')
    expect(pc.config).toEqual({ iceServers: [] })
    expect(pc.senders.length).toBe(1)
    expect(pc.senders[0]?.track).toBe(track)
    expect(pc.createdDataChannels[0]?.label).toBe('oai-events')
    expect(pc.localDescription?.type).toBe('offer')
    expect(pc.remoteDescription?.type).toBe('answer')
    expect(pc.remoteDescription?.sdp).toBe('v=0\r\nfake-answer\r\n')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('forwards remote tracks via onRemoteAudioTrack', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: onTrack,
      onStateChange: onState,
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const pc = FakeRTCPeerConnection.lastInstance
    if (pc === null) throw new Error('unreachable')

    const remoteTrack = { kind: 'audio', id: 'remote-1' } as unknown as MediaStreamTrack
    pc.emitTrack(remoteTrack)

    expect(onTrack).toHaveBeenCalledWith(remoteTrack)
  })

  it('forwards connection state changes', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: onTrack,
      onStateChange: onState,
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const pc = FakeRTCPeerConnection.lastInstance
    if (pc === null) throw new Error('unreachable')

    pc.setConnectionState('connecting')
    pc.setConnectionState('connected')

    expect(onState).toHaveBeenCalledWith('connecting')
    expect(onState).toHaveBeenCalledWith('connected')
    expect(client.getState()).toBe('connected')
  })

  it('throws (and reports via onError) when SDP exchange fails', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: onTrack,
      onStateChange: onState,
      onError,
      fetchImpl: fakeFetch('boom', 500),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })

    await expect(client.start()).rejects.toThrow(/500/)
    // start() failure should also surface via onError so the app reducer can
    // observe both fail-fast (rejection) and observer-style (callback) paths.
    expect(onError).toHaveBeenCalled()
  })

  it('does nothing on a second start() call (idempotent)', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const fetchImpl = fakeFetch()
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: onTrack,
      onStateChange: onState,
      fetchImpl,
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })

    await client.start()
    await client.start()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('data channel events', () => {
  it('routes session.output_transcript.delta to onOutputTranscriptDelta', async () => {
    const onOutputDelta = fnDelta()
    const onInputDelta = fnDelta()
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onInputTranscriptDelta: onInputDelta,
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    const before = Date.now()
    dc.emitMessage(
      JSON.stringify({
        type: 'session.output_transcript.delta',
        delta: 'こん',
        itemId: 'i1',
      }),
    )
    const after = Date.now()

    expect(onOutputDelta).toHaveBeenCalledTimes(1)
    const arg = onOutputDelta.mock.calls[0]?.[0]
    expect(arg).toBeDefined()
    if (!arg) throw new Error('unreachable')
    expect(arg.text).toBe('こん')
    expect(arg.itemId).toBe('i1')
    expect(arg.createdAt).toBeGreaterThanOrEqual(before)
    expect(arg.createdAt).toBeLessThanOrEqual(after)
    expect(onInputDelta).not.toHaveBeenCalled()
  })

  it('routes session.input_transcript.delta to onInputTranscriptDelta', async () => {
    const onOutputDelta = fnDelta()
    const onInputDelta = fnDelta()
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onInputTranscriptDelta: onInputDelta,
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    dc.emitMessage(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: 'hello' }),
    )

    expect(onInputDelta).toHaveBeenCalledTimes(1)
    const arg = onInputDelta.mock.calls[0]?.[0]
    expect(arg?.text).toBe('hello')
    expect(onOutputDelta).not.toHaveBeenCalled()
  })

  it('drops malformed JSON without notifying callbacks (best-effort logging happens out of band)', async () => {
    const onOutputDelta = fnDelta()
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    dc.emitMessage('not-json{')
    dc.emitMessage(JSON.stringify({ type: 'session.unknown' }))

    expect(onOutputDelta).not.toHaveBeenCalled()
  })

  it('forwards server error events to onError', async () => {
    const onError = fnError()
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      onError,
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    dc.emitMessage(JSON.stringify({ type: 'error', code: 'rate_limited', message: 'slow' }))
    expect(onError).toHaveBeenCalled()
    const arg = onError.mock.calls[0]?.[0]
    expect(arg).toBeInstanceOf(Error)
    expect(arg?.message).toMatch(/rate_limited/)
  })

  it('catches synchronous errors thrown by user callbacks and forwards to onError', async () => {
    const onError = fnError()
    const onOutputDelta = vi.fn<(d: TranscriptDelta) => void>(() => {
      throw new Error('boom in output handler')
    })
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: onOutputDelta,
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      onError,
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    expect(() => {
      dc.emitMessage(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'x' }))
    }).not.toThrow()
    expect(onError).toHaveBeenCalled()
    const reported = onError.mock.calls[0]?.[0]
    expect(reported?.message).toMatch(/boom/)
  })
})

describe('sendSessionUpdate', () => {
  it('sends the session.update JSON when the data channel is open', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')
    dc.emitOpen()

    client.sendSessionUpdate('ja')

    expect(dc.sent.length).toBe(1)
    const sent = dc.sent[0]
    expect(sent).toBeDefined()
    if (sent === undefined) throw new Error('unreachable')
    expect(JSON.parse(sent)).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'ja' } } },
    })
  })

  it('queues sends until the data channel opens, then flushes in order', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')

    client.sendSessionUpdate('ja')
    client.sendSessionUpdate('en')
    expect(dc.sent.length).toBe(0)

    dc.emitOpen()

    expect(dc.sent.length).toBe(2)
    const first = dc.sent[0]
    const second = dc.sent[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) throw new Error('unreachable')
    expect(JSON.parse(first)).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'ja' } } },
    })
    expect(JSON.parse(second)).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'en' } } },
    })
  })

  it('reports invalid target language via onError without throwing', async () => {
    const onError = fnError()
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      onError,
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const dc = FakeRTCPeerConnection.lastInstance?.getMainDataChannel()
    if (!dc) throw new Error('no data channel')
    dc.emitOpen()

    expect(() => {
      client.sendSessionUpdate('auto')
    }).not.toThrow()
    expect(onError).toHaveBeenCalled()
    expect(dc.sent.length).toBe(0)
  })
})

describe('stop', () => {
  it('closes the peer connection and stops local tracks', async () => {
    const track = makeAudioTrack('mic-1')
    const stream = makeFakeMediaStream([track])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    const pc = FakeRTCPeerConnection.lastInstance
    if (pc === null) throw new Error('unreachable')

    await client.stop()

    expect(pc.closed).toBe(true)
    expect(track.stop).toHaveBeenCalled()
  })

  it('is a no-op if start() has not been called', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await expect(client.stop()).resolves.toBeUndefined()
  })

  it('reports state as "closed" after stop()', async () => {
    const stream = makeFakeMediaStream([makeAudioTrack('mic-1')])
    const client = createWebRtcTranslationClient({
      clientSecret: 'cs',
      sourceStream: stream,
      onOutputTranscriptDelta: fnDelta(),
      onRemoteAudioTrack: fnTrack(),
      onStateChange: fnState(),
      fetchImpl: fakeFetch(),
      rtcImpl: FakeRTCPeerConnection as unknown as typeof RTCPeerConnection,
    })
    await client.start()
    await client.stop()
    expect(client.getState()).toBe('closed')
  })
})

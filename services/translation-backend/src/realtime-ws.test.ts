/**
 * Integration tests for the Phase 2 backend WS relay.
 *
 * Strategy:
 * - Start a real Fastify server with `registerRealtimeWs` on a random
 *   loopback port.
 * - Stand up an in-process `ws.WebSocketServer` that impersonates the OpenAI
 *   Realtime Translation upstream. The relay is given this URL via
 *   `BuildServerOptions.upstreamWsUrl`.
 * - Drive scenarios end-to-end via a real `ws.WebSocket` client.
 *
 * This avoids mocking the relay's internal state machine — the test catches
 * regressions in message-name translation (`session.input_audio_buffer.append`,
 * §10.3), error normalisation, graceful-close handling, and Origin / per-IP
 * gates.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as WsClient, WebSocketServer, type RawData } from 'ws'
import type { AddressInfo } from 'node:net'

import { buildServer } from './server.js'
import { GRACE_PERIOD_MS } from './realtime-ws.js'

interface AppHandle {
  close: () => Promise<void>
  port: number
}

interface UpstreamCapture {
  /** Pop the next message that arrived on this upstream socket. */
  nextMessage(): Promise<unknown>
  /** All messages received on this upstream socket so far. */
  readonly messages: unknown[]
}

interface UpstreamMock {
  url: string
  /** All upstream sockets that have been accepted, in connection order. */
  sockets: WsClient[]
  /** Resolves once the next upstream connection is established. */
  nextConnection: () => Promise<WsClient>
  /** Per-socket message capture by index; lazily created on first read. */
  capture(socketIndex: number): UpstreamCapture
  close: () => Promise<void>
}

const TEST_CONFIG = {
  port: 0,
  host: '127.0.0.1',
  openaiApiKey: 'sk-test',
  safetyIdSalt: 'spike-salt',
  allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
}

function parseRawData(raw: RawData): unknown {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf-8')
    : raw instanceof ArrayBuffer
      ? Buffer.from(raw).toString('utf-8')
      : Buffer.concat(raw).toString('utf-8')
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function startUpstreamMock(
  onMessage?: (socket: WsClient, msg: unknown) => void | Promise<void>,
): Promise<UpstreamMock> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  const sockets: WsClient[] = []
  const waiters: Array<(s: WsClient) => void> = []
  const captures = new Map<number, { messages: unknown[]; queue: Array<(v: unknown) => void> }>()

  function captureFor(idx: number): { messages: unknown[]; queue: Array<(v: unknown) => void> } {
    let entry = captures.get(idx)
    if (!entry) {
      entry = { messages: [], queue: [] }
      captures.set(idx, entry)
    }
    return entry
  }

  server.on('connection', (socket) => {
    const idx = sockets.length
    sockets.push(socket)
    const waiter = waiters.shift()
    if (waiter) waiter(socket)
    socket.on('message', (raw: RawData) => {
      const parsed = parseRawData(raw)
      const entry = captureFor(idx)
      const w = entry.queue.shift()
      if (w) w(parsed)
      else entry.messages.push(parsed)
      if (onMessage) void onMessage(socket, parsed)
    })
  })

  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    sockets,
    nextConnection(): Promise<WsClient> {
      const existing = sockets[sockets.length - 1]
      if (existing && existing.readyState === existing.OPEN) {
        return Promise.resolve(existing)
      }
      return new Promise<WsClient>((resolve) => waiters.push(resolve))
    },
    capture(idx: number): UpstreamCapture {
      const entry = captureFor(idx)
      return {
        get messages() {
          return entry.messages.slice()
        },
        nextMessage(): Promise<unknown> {
          if (entry.messages.length > 0) return Promise.resolve(entry.messages.shift())
          return new Promise<unknown>((resolve) => entry.queue.push(resolve))
        },
      }
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const s of sockets) {
          try {
            s.close()
          } catch {
            /* swallow */
          }
        }
        server.close(() => resolve())
      })
    },
  }
}

async function startApp(opts: {
  upstreamWsUrl: string
  idleTimeoutMs?: number
  gracePeriodMs?: number
}): Promise<AppHandle> {
  const app = buildServer({
    logger: false,
    config: TEST_CONFIG,
    upstreamWsUrl: opts.upstreamWsUrl,
    ...(opts.idleTimeoutMs !== undefined ? { realtimeWsIdleTimeoutMs: opts.idleTimeoutMs } : {}),
    ...(opts.gracePeriodMs !== undefined ? { realtimeWsGracePeriodMs: opts.gracePeriodMs } : {}),
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  return {
    port: addr.port,
    close: async () => {
      await app.close()
    },
  }
}

interface ClientEvents {
  messages: unknown[]
  closes: Array<{ code: number; reason: string }>
  errors: Error[]
  /** Wait for the next message. Resolves with the parsed JSON. Will hang
   * until a message arrives — callers that race against close should `Promise.race`. */
  nextMessage(): Promise<unknown>
  /** Wait for the WS to close. */
  closed(): Promise<{ code: number; reason: string }>
}

function attachClient(client: WsClient): ClientEvents {
  const events: Omit<ClientEvents, 'nextMessage' | 'closed'> = {
    messages: [],
    closes: [],
    errors: [],
  }
  const messageQueue: Array<(v: unknown) => void> = []
  const closeQueue: Array<(v: { code: number; reason: string }) => void> = []

  client.on('message', (raw: RawData) => {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf-8')
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString('utf-8')
        : Buffer.concat(raw).toString('utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    // Hand off to a waiting `nextMessage()` consumer if there is one,
    // otherwise buffer for a later call. Pushing to both would double-count.
    const waiter = messageQueue.shift()
    if (waiter) waiter(parsed)
    else events.messages.push(parsed)
  })
  client.on('close', (code: number, reason: Buffer) => {
    const evt = { code, reason: reason.toString('utf-8') }
    const waiter = closeQueue.shift()
    if (waiter) waiter(evt)
    else events.closes.push(evt)
  })
  client.on('error', (err: Error) => {
    events.errors.push(err)
  })
  return {
    ...events,
    nextMessage(): Promise<unknown> {
      if (events.messages.length > 0) {
        return Promise.resolve(events.messages.shift())
      }
      return new Promise((resolve) => messageQueue.push(resolve))
    },
    closed(): Promise<{ code: number; reason: string }> {
      if (events.closes.length > 0) return Promise.resolve(events.closes[0]!)
      return new Promise((resolve) => closeQueue.push(resolve))
    },
  }
}

function makeWsUrl(port: number): string {
  return `ws://127.0.0.1:${String(port)}/api/realtime/ws`
}

async function openClient(
  port: number,
  options: { origin?: string } = {},
): Promise<WsClient> {
  const origin = options.origin ?? 'http://localhost:5173'
  const client = new WsClient(makeWsUrl(port), {
    headers: { Origin: origin },
  })
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve())
    client.once('error', (err) => reject(err))
    client.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected upgrade response: ${String(res.statusCode)}`))
    })
  })
  return client
}

let app: AppHandle
let upstream: UpstreamMock

afterEach(async () => {
  if (app) await app.close()
  if (upstream) await upstream.close()
})

beforeEach(() => {
  // Reset module-scoped handles so afterEach doesn't double-close last run's.
  app = undefined as unknown as AppHandle
  upstream = undefined as unknown as UpstreamMock
})

describe('WS upgrade gating', () => {
  it('rejects upgrades from an Origin not on the allowlist', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    await expect(openClient(app.port, { origin: 'http://evil.example' })).rejects.toThrow(
      /unexpected upgrade response: 403/,
    )
  })

  it('rejects the 3rd concurrent connection from the same IP with 429', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    const a = await openClient(app.port)
    const b = await openClient(app.port)
    await expect(openClient(app.port)).rejects.toThrow(/unexpected upgrade response: 429/)
    a.close()
    b.close()
  })
})

describe('happy path', () => {
  it('forwards `open` → upstream session.update and surfaces session.created downstream', async () => {
    let upstreamSeen: unknown = null
    upstream = await startUpstreamMock((socket, msg) => {
      upstreamSeen = msg
      // Echo a session.created so the relay emits its downstream session.created.
      socket.send(
        JSON.stringify({
          type: 'session.created',
          session: { id: 'sess_abc', model: 'gpt-realtime-translate' },
        }),
      )
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    // First downstream message should be `session.created`.
    const downstream = (await events.nextMessage()) as {
      type: string
      meta: { upstreamSessionId?: string; targetLanguage: string; model: string }
    }
    expect(downstream.type).toBe('session.created')
    expect(downstream.meta.targetLanguage).toBe('ja')
    expect(downstream.meta.upstreamSessionId).toBe('sess_abc')

    // The upstream must have received a session.update with the documented payload.
    expect(upstreamSeen).toEqual({
      type: 'session.update',
      session: {
        audio: {
          input: {
            transcription: { model: 'gpt-realtime-whisper' },
            noise_reduction: { type: 'near_field' },
          },
          output: { language: 'ja' },
        },
      },
    })

    client.close()
  })

  it('rejects `open` with targetLanguage="auto" as invalid_request', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })
    const client = await openClient(app.port)
    const events = attachClient(client)

    client.send(JSON.stringify({ type: 'open', targetLanguage: 'auto' }))
    const err = (await events.nextMessage()) as { type: string; code: string }
    expect(err.type).toBe('error')
    expect(err.code).toBe('invalid_request')

    client.close()
  })

  it('forwards client audio as upstream session.input_audio_buffer.append (T0.1 prefix)', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
      }
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))
    await events.nextMessage() // session.created

    client.send(JSON.stringify({ type: 'audio', pcm: 'AAEC' }))
    client.send(JSON.stringify({ type: 'audio', pcm: 'AwQF' }))

    // Event-driven wait: pop messages off the upstream socket capture in
    // order. First message was session.update from `open`; next two are
    // the audio frames we just sent.
    const upstreamCapture = upstream.capture(0)
    await upstreamCapture.nextMessage() // skip session.update
    const audio1 = await upstreamCapture.nextMessage()
    const audio2 = await upstreamCapture.nextMessage()
    expect(audio1).toEqual({ type: 'session.input_audio_buffer.append', audio: 'AAEC' })
    expect(audio2).toEqual({ type: 'session.input_audio_buffer.append', audio: 'AwQF' })

    client.close()
  })

  it('relays upstream transcript / audio deltas to the client with the documented shape', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
        socket.send(
          JSON.stringify({
            type: 'session.input_transcript.delta',
            delta: ' Hello',
            item_id: 'item_1',
          }),
        )
        socket.send(
          JSON.stringify({
            type: 'session.output_transcript.delta',
            delta: 'こんにちは',
          }),
        )
        socket.send(
          JSON.stringify({ type: 'session.output_audio.delta', delta: 'ZmFrZQ==' }),
        )
      }
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    const messages: unknown[] = []
    for (let i = 0; i < 4; i += 1) messages.push(await events.nextMessage())

    expect(messages[0]).toMatchObject({ type: 'session.created' })
    expect(messages[1]).toEqual({
      type: 'transcript.delta',
      source: 'input',
      text: ' Hello',
      itemId: 'item_1',
    })
    expect(messages[2]).toEqual({
      type: 'transcript.delta',
      source: 'output',
      text: 'こんにちは',
    })
    expect(messages[3]).toEqual({ type: 'audio.delta', pcm: 'ZmFrZQ==' })

    client.close()
  })

  it('forwards `language` as a session.update with the new target', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
      }
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))
    await events.nextMessage()

    const upstreamCapture = upstream.capture(0)
    await upstreamCapture.nextMessage() // initial session.update

    client.send(JSON.stringify({ type: 'language', target: 'en' }))
    const secondUpdate = await upstreamCapture.nextMessage()
    expect(secondUpdate).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'en' } } },
    })

    client.close()
  })
})

describe('open / close races (Codex review B-1 / B-2)', () => {
  it('does not create a second upstream connection when `open` is sent twice', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
      }
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    // Two `open` frames back-to-back, before any await can resolve.
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'en' }))

    const first = (await events.nextMessage()) as { type: string }
    const second = (await events.nextMessage()) as { type: string; code?: string }

    // Expect exactly one of the responses to be session.created and the
    // other to be the "open already received" rejection. The order depends
    // on whether the state lock or the hash await wins; both interleavings
    // are valid as long as only one upstream connection materialised.
    const types = [first.type, second.type].sort()
    expect(types).toEqual(['error', 'session.created'])

    // Give a tick for any racing upstream connect to land; we want a hard
    // upper bound of 1 connection.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(upstream.sockets.length).toBe(1)

    client.close()
  })

  it('does not connect upstream if `close` arrives while `open` is awaiting the safety-id hash', async () => {
    // Send `open` and `close` immediately one after the other. The relay's
    // state machine should observe `close` and skip the connectUpstream call.
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))
    client.send(JSON.stringify({ type: 'close' }))

    // 200 ms is plenty for the hash to complete (a few hundred μs) and for
    // any erroneous connectUpstream to land on the mock.
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    expect(upstream.sockets.length).toBe(0)

    client.close()
  })
})

describe('idle timeout', () => {
  it('emits idle_timeout and closes the socket after the configured idle window', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({
      upstreamWsUrl: upstream.url,
      idleTimeoutMs: 150,
      gracePeriodMs: 200,
    })

    const client = await openClient(app.port)
    const events = attachClient(client)
    // No client message → idle timer must fire.
    const msg = (await events.nextMessage()) as { type: string; code: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('idle_timeout')

    const closed = await events.closed()
    expect(closed.code).toBeGreaterThanOrEqual(1000)
  })
})

describe('upstream close while live', () => {
  it('emits upstream_closed and tears down when OpenAI closes mid-session', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
        // Immediately close upstream to simulate OpenAI dropping the session.
        setTimeout(() => {
          socket.close(1011, 'upstream went away')
        }, 30)
      }
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    await events.nextMessage() // session.created
    const errMsg = (await events.nextMessage()) as { type: string; code: string }
    expect(errMsg.type).toBe('error')
    expect(errMsg.code).toBe('upstream_closed')
  })
})

describe('graceful close with trailing-deltas grace period', () => {
  it('production GRACE_PERIOD_MS is at least 6 s (T0.1 finding §10.3)', () => {
    // Sanity: guard against accidentally shrinking the grace period and
    // losing the tail of every translation.
    expect(GRACE_PERIOD_MS).toBeGreaterThanOrEqual(6000)
  })

  it('sends session.close upstream and holds the upstream open during the grace period', async () => {
    upstream = await startUpstreamMock((socket, msg) => {
      const m = msg as { type?: string }
      if (m.type === 'session.update') {
        socket.send(JSON.stringify({ type: 'session.created', session: { id: 's1' } }))
      }
    })
    // Short grace period so the test asserts behaviour rather than burning
    // a 6 s wall clock. Production uses 6000 ms (guarded above).
    app = await startApp({ upstreamWsUrl: upstream.url, gracePeriodMs: 300 })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))
    await events.nextMessage()

    const upstreamSocket = upstream.sockets[0]!
    const upstreamCapture = upstream.capture(0)
    await upstreamCapture.nextMessage() // initial session.update

    client.send(JSON.stringify({ type: 'close' }))
    const closeMsg = await upstreamCapture.nextMessage()
    expect(closeMsg).toEqual({ type: 'session.close' })
    // Upstream must still be open immediately after session.close forward.
    expect(upstreamSocket.readyState).toBe(upstreamSocket.OPEN)

    // Wait until the grace period has elapsed; the relay must then close
    // the upstream (we observe via close event).
    await new Promise<void>((resolve) => upstreamSocket.once('close', () => resolve()))
    expect(upstreamSocket.readyState).toBe(upstreamSocket.CLOSED)

    client.close()
  })
})

describe('error normalisation', () => {
  it('translates upstream invalid_request_error into invalid_request', async () => {
    upstream = await startUpstreamMock((socket) => {
      socket.send(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'invalid_value',
            message: 'Invalid value: …',
          },
        }),
      )
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    // Sanitised — neither upstream message text nor upstream code propagates.
    const msg = (await events.nextMessage()) as { type: string; code: string; message: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('invalid_request')
    expect(msg.message).not.toMatch(/Invalid value/)

    client.close()
  })

  it('translates upstream rate_limit_exceeded into rate_limited', async () => {
    upstream = await startUpstreamMock((socket) => {
      socket.send(
        JSON.stringify({
          type: 'error',
          error: { type: 'server_error', code: 'rate_limit_exceeded', message: 'slow' },
        }),
      )
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    const msg = (await events.nextMessage()) as { code: string; message: string }
    expect(msg.code).toBe('rate_limited')
    expect(msg.message).toBe('Too many requests')

    client.close()
  })

  it('falls back to upstream_error for unknown upstream error shapes', async () => {
    upstream = await startUpstreamMock((socket) => {
      socket.send(JSON.stringify({ type: 'error', error: {} }))
    })
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'open', targetLanguage: 'ja' }))

    const msg = (await events.nextMessage()) as { code: string }
    expect(msg.code).toBe('upstream_error')

    client.close()
  })
})

describe('client-side guards', () => {
  it('responds with invalid_request to malformed client messages', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send('not json')

    const msg = (await events.nextMessage()) as { code: string }
    expect(msg.code).toBe('invalid_request')

    client.close()
  })

  it('silently drops audio sent before `open` (no error, no upstream connection)', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'audio', pcm: 'AAEC' }))

    // The relay should *not* emit anything in response to pre-open audio.
    // We assert that by racing the next-message wait against a small timeout;
    // a real message arrival would fail the test.
    const outcome = await Promise.race([
      new Promise<'message'>((resolve) => {
        void events.nextMessage().then(() => {
          resolve('message')
        })
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(outcome).toBe('timeout')
    expect(upstream.sockets.length).toBe(0)

    client.close()
  })

  it('rejects `language` before `live` with invalid_request', async () => {
    upstream = await startUpstreamMock()
    app = await startApp({ upstreamWsUrl: upstream.url })

    const client = await openClient(app.port)
    const events = attachClient(client)
    client.send(JSON.stringify({ type: 'language', target: 'en' }))

    const msg = (await events.nextMessage()) as { type: string; code: string }
    expect(msg.type).toBe('error')
    expect(msg.code).toBe('invalid_request')

    client.close()
  })
})

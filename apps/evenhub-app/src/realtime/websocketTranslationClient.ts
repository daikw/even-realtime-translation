/**
 * WebSocket orchestrator for the Phase 2 translation path — replaces
 * `webrtcTranslationClient.ts` (docs/phase2-migration-plan.md §3 T4).
 *
 * Wires the bridge-mic stream (16 kHz S16LE PCM mono) through the shared
 * `resample16to24` resampler, base64-encodes each 24 kHz chunk, and ships
 * it through the backend WS relay at `/api/realtime/ws`. The relay handles
 * the OpenAI-side namespacing (`session.input_audio_buffer.append`, etc.)
 * per T0.1 finding §10.3 — the client only ever speaks the
 * `{ type: 'audio' | 'open' | 'language' | 'close' }` internal protocol.
 *
 * Reconnect semantics:
 *   - Unexpected close → exponential backoff via `ReconnectController`.
 *   - On reconnect we re-open with `{type:'open', targetLanguage}` because
 *     the upstream session is fresh on each connect (backend pairs a new
 *     OpenAI WS each time).
 *   - `stop()` disables further reconnects; `start()` after `stop()` is a
 *     supported user-driven re-entry path.
 */

import type {
  ClientWsAudio,
  ClientWsClose,
  ClientWsLanguage,
  ClientWsOpen,
  LanguageCode,
  ServerWsMessage,
  TranscriptDelta,
} from '@even-rt/shared'
import { bytesToSamplesLE, resample16to24, samplesToBytesLE } from '@even-rt/shared'

import type { BridgeMicHandle } from '../audio/bridgeMic.js'
import { ReconnectController } from './reconnect.js'

export type WsConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

export interface WebSocketTranslationOpts {
  /** WS endpoint (e.g. `wss://<host>/api/realtime/ws` or same-origin `/api/realtime/ws`). */
  backendUrl: string
  targetLanguage: LanguageCode
  micHandle: BridgeMicHandle
  onOutputTranscriptDelta: (delta: TranscriptDelta) => void
  onInputTranscriptDelta?: (delta: TranscriptDelta) => void
  /** 24 kHz PCM16 mono frames decoded from upstream `audio.delta`. */
  onAudioDelta?: (samples: Int16Array) => void
  onStateChange: (state: WsConnectionState) => void
  onError?: (err: Error) => void
  /** Inject `ws` mock for tests; production uses the global `WebSocket`. */
  wsImpl?: typeof WebSocket
  /** Inject reconnect timing for tests. */
  reconnectOptions?: { maxAttempts?: number; baseDelayMs?: number }
}

export interface WebSocketTranslationClient {
  start(): Promise<void>
  stop(): Promise<void>
  sendLanguageUpdate(target: LanguageCode): void
  getState(): WsConnectionState
}

// 1000 (normal closure) is intentionally excluded — the backend uses it for
// both deliberate teardowns (auth refusal, idle gate) and successful client
// `stop()` flows. Reconnecting on 1000 turns a benign close into an infinite
// loop. The relay surfaces a synthetic 1011 if it wants the client to retry
// (Codex review M-1).
const RECONNECTABLE_CLOSE_CODES = new Set([
  1001, // going away
  1006, // abnormal closure
  1011, // server error
  1012, // service restart
  1013, // try again later
  1014, // bad gateway
])

export function createWebSocketTranslationClient(
  opts: WebSocketTranslationOpts,
): WebSocketTranslationClient {
  const Ws = opts.wsImpl ?? globalThis.WebSocket
  if (Ws === undefined) {
    throw new Error('WebSocket is not available in this runtime')
  }
  // ReconnectController.dispose() is permanent, so a fresh controller is
  // created on every start() call. Holding a single long-lived instance
  // (the original implementation) made stop()→start()→reconnect die
  // immediately on the first transient close (Codex review H-1).
  const reconnectOptions = opts.reconnectOptions ?? {}
  let reconnect = new ReconnectController(reconnectOptions)

  let ws: WebSocket | null = null
  let micUnsubscribe: (() => void) | null = null
  let stopped = false
  let started = false
  let currentTarget: LanguageCode = opts.targetLanguage
  let state: WsConnectionState = 'idle'
  // Shared promise for concurrent start() calls so a second start() doesn't
  // resolve early (Codex review M-2).
  let startPromise: Promise<void> | null = null

  function setState(next: WsConnectionState): void {
    if (state === next) return
    state = next
    try {
      opts.onStateChange(next)
    } catch {
      // Final defensive net: state callbacks must never tear down the client.
    }
  }

  function reportError(err: unknown): void {
    if (opts.onError === undefined) return
    const error = err instanceof Error ? err : new Error(String(err))
    try {
      opts.onError(error)
    } catch {
      /* swallow — error reporter must not bubble */
    }
  }

  function sendMessage(
    msg: ClientWsOpen | ClientWsAudio | ClientWsLanguage | ClientWsClose,
  ): boolean {
    const sock = ws
    if (sock === null || sock.readyState !== sock.OPEN) return false
    try {
      sock.send(JSON.stringify(msg))
      return true
    } catch (err) {
      reportError(err)
      return false
    }
  }

  function handleMicChunk(samples: Int16Array): void {
    // 16 kHz S16LE mono → 24 kHz S16LE mono → bytes → base64. Each link is
    // pure so the resampler's tail-clamp behaviour stays inspectable.
    let pcm24: Int16Array
    try {
      pcm24 = resample16to24(samples)
    } catch (err) {
      reportError(err)
      return
    }
    const bytes = samplesToBytesLE(pcm24)
    const b64 = bytesToBase64(bytes)
    sendMessage({ type: 'audio', pcm: b64 })
  }

  function handleServerMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const msg = parseServerMessage(parsed)
    if (msg === null) return
    switch (msg.type) {
      case 'session.created':
        // Backend has confirmed the upstream session. `meta.upstreamSessionId`
        // is an implementation detail of the relay so we intentionally do not
        // log it here — observability lives in the backend pino stream
        // (Codex review M-3).
        return
      case 'transcript.delta': {
        const delta: TranscriptDelta =
          msg.itemId === undefined
            ? { text: msg.text, createdAt: Date.now() }
            : { text: msg.text, itemId: msg.itemId, createdAt: Date.now() }
        if (msg.source === 'output') {
          try {
            opts.onOutputTranscriptDelta(delta)
          } catch (err) {
            reportError(err)
          }
        } else if (opts.onInputTranscriptDelta !== undefined) {
          const handler = opts.onInputTranscriptDelta
          try {
            handler(delta)
          } catch (err) {
            reportError(err)
          }
        }
        return
      }
      case 'audio.delta': {
        if (opts.onAudioDelta === undefined) return
        let bytes: Uint8Array
        try {
          bytes = base64ToBytes(msg.pcm)
        } catch (err) {
          reportError(err)
          return
        }
        let samples: Int16Array
        try {
          samples = bytesToSamplesLE(bytes)
        } catch (err) {
          reportError(err)
          return
        }
        try {
          opts.onAudioDelta(samples)
        } catch (err) {
          reportError(err)
        }
        return
      }
      case 'error':
        reportError(new Error(`ws translation error [${msg.code}]: ${msg.message}`))
        return
    }
  }

  function openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let resolved = false
      const sock = new Ws(opts.backendUrl)
      ws = sock

      sock.onopen = (): void => {
        if (!sendMessage({ type: 'open', targetLanguage: currentTarget })) {
          const err = new Error('failed to send open frame')
          reportError(err)
          if (!resolved) {
            resolved = true
            reject(err)
          }
          return
        }
        if (micUnsubscribe === null) {
          micUnsubscribe = opts.micHandle.onPcm(handleMicChunk)
        }
        reconnect.reset()
        setState('connected')
        if (!resolved) {
          resolved = true
          resolve()
        }
      }

      sock.onmessage = (ev: MessageEvent): void => {
        handleServerMessage(ev.data)
      }

      sock.onerror = (): void => {
        // Browser `WebSocket` doesn't surface a useful error object on the
        // Event passed to onerror; the subsequent `close` event carries the
        // actual code. Translating to a generic Error keeps onError useful.
        reportError(new Error('ws transport error'))
      }

      sock.onclose = (ev: CloseEvent): void => {
        ws = null
        if (stopped) {
          setState('idle')
          if (!resolved) {
            resolved = true
            reject(new Error('stopped before open'))
          }
          return
        }
        if (!resolved) {
          // Never opened — the initial start() promise must reject. Don't
          // also schedule a reconnect: the caller is awaiting start() and a
          // background reconnect after a rejected promise would leave the
          // client in a state inconsistent with the API contract (Codex
          // review H-2).
          resolved = true
          detachMic()
          setState('failed')
          reject(new Error(`ws closed before open (code=${String(ev.code)})`))
          return
        }
        if (RECONNECTABLE_CLOSE_CODES.has(ev.code)) {
          scheduleReconnect()
        } else {
          // Permanent failure → release mic + tear down reconnect controller
          // so we stop spending CPU on resample/base64 for chunks that have
          // nowhere to go (Codex review H-3).
          detachMic()
          setState('failed')
          reportError(new Error(`ws closed permanently (code=${String(ev.code)})`))
        }
      }
    })
  }

  function detachMic(): void {
    if (micUnsubscribe !== null) {
      micUnsubscribe()
      micUnsubscribe = null
    }
  }

  function scheduleReconnect(): void {
    setState('reconnecting')
    reconnect
      .scheduleNext(() => openSocket())
      .catch((err: unknown) => {
        if (stopped) return
        // Max attempts hit → terminal failure. Release the mic for the same
        // reason as the non-reconnectable close path above (Codex review H-3).
        detachMic()
        setState('failed')
        reportError(err)
      })
  }

  function start(): Promise<void> {
    if (startPromise !== null) return startPromise
    if (started && !stopped) return Promise.resolve()
    started = true
    stopped = false
    // Recreate the reconnect controller — a previous stop() may have
    // dispose()'d the old one permanently (Codex review H-1).
    reconnect = new ReconnectController(reconnectOptions)
    setState('connecting')
    const p = openSocket()
      .catch((err) => {
        if (!stopped) setState('failed')
        throw err
      })
      .finally(() => {
        startPromise = null
      })
    startPromise = p
    return p
  }

  async function stop(): Promise<void> {
    if (!started) return
    stopped = true
    reconnect.dispose()
    detachMic()
    const sock = ws
    if (sock !== null) {
      // Send graceful close so the backend forwards `session.close` upstream
      // and holds the trailing-deltas grace period (T0.1 §10.3). The actual
      // socket close happens on the backend's timer or via our finalisation
      // below — whichever fires first.
      sendMessage({ type: 'close' })
      try {
        sock.close(1000, 'client stop')
      } catch {
        /* socket may already be torn down */
      }
    }
    ws = null
    started = false
    setState('idle')
    return Promise.resolve()
  }

  function sendLanguageUpdate(target: LanguageCode): void {
    currentTarget = target
    sendMessage({ type: 'language', target })
  }

  function getState(): WsConnectionState {
    return state
  }

  return { start, stop, sendLanguageUpdate, getState }
}

// ──────────────────────────────────────────────────────────────────────────
// Server-message validation.
// ──────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  // `typeof null === 'object'` so the null guard is non-negotiable — without
  // it a server frame with `meta: null` would throw before reaching the
  // discriminated-union branches (Codex review H-4).
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseServerMessage(value: unknown): ServerWsMessage | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'session.created': {
      const meta = value.meta
      if (!isRecord(meta)) return null
      if (typeof meta.model !== 'string') return null
      if (typeof meta.targetLanguage !== 'string') return null
      return {
        type: 'session.created',
        meta: {
          model: meta.model,
          // Cast is safe at runtime — the server only emits codes from the
          // shared `LanguageCode` set. A mismatched cast would fail at the
          // UI layer (which checks against SUPPORTED_LANGUAGES) not here.
          targetLanguage: meta.targetLanguage as LanguageCode,
          ...(typeof meta.upstreamSessionId === 'string'
            ? { upstreamSessionId: meta.upstreamSessionId }
            : {}),
        },
      }
    }
    case 'transcript.delta': {
      const source = value.source
      if (source !== 'input' && source !== 'output') return null
      if (typeof value.text !== 'string') return null
      return {
        type: 'transcript.delta',
        source,
        text: value.text,
        ...(typeof value.itemId === 'string' ? { itemId: value.itemId } : {}),
      }
    }
    case 'audio.delta': {
      if (typeof value.pcm !== 'string' || value.pcm.length === 0) return null
      return { type: 'audio.delta', pcm: value.pcm }
    }
    case 'error': {
      const code = typeof value.code === 'string' ? value.code : 'unknown'
      const message = typeof value.message === 'string' ? value.message : 'Unknown error'
      return { type: 'error', code, message }
    }
    default:
      return null
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Base64 helpers — kept private so the wire format stays an implementation
// detail of this module. The chunked encode avoids stack overflow when the
// resampler produces a large frame (e.g. backend-buffered audio replay).
// ──────────────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

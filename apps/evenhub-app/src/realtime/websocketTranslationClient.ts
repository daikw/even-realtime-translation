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
  const reconnect = new ReconnectController(opts.reconnectOptions ?? {})

  let ws: WebSocket | null = null
  let micUnsubscribe: (() => void) | null = null
  let stopped = false
  let started = false
  let currentTarget: LanguageCode = opts.targetLanguage
  let state: WsConnectionState = 'idle'

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
        // Backend has confirmed the upstream session. We don't expose this
        // to the UI today; only kept for dev-time observability.
        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          console.debug('[ws-translation] session.created', msg.meta)
        }
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
          // Never opened — the initial start() promise must reject.
          resolved = true
          reject(new Error(`ws closed before open (code=${String(ev.code)})`))
        }
        if (RECONNECTABLE_CLOSE_CODES.has(ev.code) || ev.code === 1000 || ev.code === 0) {
          // 1000 (normal) is included here because some upstream paths close
          // the relay with a vanilla "normal closure" even on transient
          // failures (e.g. OpenAI session expiry). Letting the reconnect
          // controller cap the retries keeps this benign.
          scheduleReconnect()
        } else {
          setState('failed')
          reportError(new Error(`ws closed permanently (code=${String(ev.code)})`))
        }
      }
    })
  }

  function scheduleReconnect(): void {
    setState('reconnecting')
    reconnect
      .scheduleNext(() => openSocket())
      .catch((err: unknown) => {
        if (stopped) return
        setState('failed')
        reportError(err)
      })
  }

  async function start(): Promise<void> {
    if (started && !stopped) return
    started = true
    stopped = false
    reconnect.reset()
    setState('connecting')
    try {
      await openSocket()
    } catch (err) {
      if (!stopped) setState('failed')
      throw err
    }
  }

  async function stop(): Promise<void> {
    if (!started) return
    stopped = true
    reconnect.dispose()
    if (micUnsubscribe !== null) {
      micUnsubscribe()
      micUnsubscribe = null
    }
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

function parseServerMessage(value: unknown): ServerWsMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  switch (obj.type) {
    case 'session.created': {
      const meta = obj.meta as Record<string, unknown> | undefined
      if (meta === undefined || typeof meta !== 'object') return null
      if (typeof meta.model !== 'string') return null
      if (typeof meta.targetLanguage !== 'string') return null
      return {
        type: 'session.created',
        meta: {
          model: meta.model,
          targetLanguage: meta.targetLanguage as LanguageCode,
          ...(typeof meta.upstreamSessionId === 'string'
            ? { upstreamSessionId: meta.upstreamSessionId }
            : {}),
        },
      }
    }
    case 'transcript.delta': {
      const source = obj.source
      if (source !== 'input' && source !== 'output') return null
      if (typeof obj.text !== 'string') return null
      return {
        type: 'transcript.delta',
        source,
        text: obj.text,
        ...(typeof obj.itemId === 'string' ? { itemId: obj.itemId } : {}),
      }
    }
    case 'audio.delta': {
      if (typeof obj.pcm !== 'string' || obj.pcm.length === 0) return null
      return { type: 'audio.delta', pcm: obj.pcm }
    }
    case 'error': {
      const code = typeof obj.code === 'string' ? obj.code : 'unknown'
      const message = typeof obj.message === 'string' ? obj.message : 'Unknown error'
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

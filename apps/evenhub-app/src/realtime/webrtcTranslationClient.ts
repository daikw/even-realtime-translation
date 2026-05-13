import type { LanguageCode, TranscriptDelta } from '@even-rt/shared'

import {
  isInputTranscriptDelta,
  isOutputTranscriptDelta,
  isServerError,
  parseRealtimeEvent,
} from './eventParser.js'
import { buildSessionUpdateEvent } from './language.js'
import { exchangeSdp } from './sdp.js'

/**
 * WebRTC orchestrator for the OpenAI Realtime translation session
 * (design doc §6.3, §14.1, §15.2).
 *
 * Responsibilities:
 * - Build an `RTCPeerConnection` with no STUN/TURN servers (PoC: rely on
 *   direct connectivity to the OpenAI endpoint).
 * - Attach the caller-provided microphone stream as the outgoing track.
 * - Open the `oai-events` data channel and route incoming events to the
 *   appropriate user callback after parsing & narrowing.
 * - Perform the SDP offer/answer exchange via {@link exchangeSdp}.
 * - Allow the caller to switch the output language at runtime through
 *   {@link WebRtcTranslationClient.sendSessionUpdate}; sends made before the
 *   data channel is open are queued and flushed on `open`.
 *
 * All user-supplied callbacks are wrapped so that synchronous exceptions are
 * forwarded to `onError` instead of escaping into the event loop and tearing
 * down the call. Callers should treat `onError` as a best-effort observability
 * hook, not a control-flow primitive.
 *
 * @deprecated since 2026-05-12 — Phase 2 migration (docs/phase2-migration-plan.md §3 T7.3).
 *
 * The WebRTC path depends on `getUserMedia`, which is blocked in the
 * production Even Realities iOS WKWebView (Issue #7). The replacement is
 * `realtime/websocketTranslationClient.ts` driven by
 * `realtime/runtimeWs.ts` — same OpenAI API contract, different transport
 * (WS proxy through the backend instead of direct WebRTC).
 *
 * This file is retained for the §6 rollback gate (Discord #7 confirmation +
 * real-device validation of the WS path). It will be deleted in T7b after
 * both conditions are met. The `realtime/sdp.ts` helper goes with it.
 */

export interface WebRtcTranslationOpts {
  clientSecret: string
  sourceStream: MediaStream
  onOutputTranscriptDelta: (delta: TranscriptDelta) => void
  onInputTranscriptDelta?: (delta: TranscriptDelta) => void
  onRemoteAudioTrack: (track: MediaStreamTrack) => void
  onStateChange: (state: RTCPeerConnectionState) => void
  onError?: (err: Error) => void
  baseUrl?: string
  model?: string
  fetchImpl?: typeof fetch
  rtcImpl?: typeof RTCPeerConnection
}

export interface WebRtcTranslationClient {
  start(): Promise<void>
  stop(): Promise<void>
  sendSessionUpdate(targetLanguage: LanguageCode): void
  getState(): RTCPeerConnectionState
}

/** @deprecated Phase 2 (2026-05-12). Use
 * \`createWebSocketTranslationClient\` (driven by \`createWebSocketRuntimeFactory\`)
 * instead. The WebRTC path depends on \`getUserMedia\`, which is blocked in
 * the iOS WKWebView (Issue #7). Retained until T7b clears the §6 rollback
 * gate (see file header). */
export function createWebRtcTranslationClient(
  opts: WebRtcTranslationOpts,
): WebRtcTranslationClient {
  const RtcImpl: typeof RTCPeerConnection = opts.rtcImpl ?? RTCPeerConnection

  let pc: RTCPeerConnection | null = null
  let dataChannel: RTCDataChannel | null = null
  let started = false
  // Wire-format JSON messages waiting for the data channel to become open.
  // Keep as ordered array because session.update ordering matters when a user
  // toggles the language quickly.
  const sendQueue: string[] = []
  let lastState: RTCPeerConnectionState = 'new'

  function reportError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err))
    try {
      opts.onError?.(error)
    } catch {
      // Final defensive net: never let an error reporter exception escape.
    }
  }

  function safeCall<T>(label: string, fn: () => T): void {
    try {
      fn()
    } catch (err) {
      reportError(
        err instanceof Error
          ? new Error(`${label}: ${err.message}`, { cause: err })
          : new Error(`${label}: ${String(err)}`),
      )
    }
  }

  function flushQueue(dc: RTCDataChannel): void {
    while (sendQueue.length > 0) {
      const msg = sendQueue.shift()
      if (msg === undefined) break
      try {
        dc.send(msg)
      } catch (err) {
        reportError(err)
        break
      }
    }
  }

  function handleDataChannelMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      // The OpenAI events channel sends UTF-8 JSON; anything else is unexpected.
      return
    }
    const ev = parseRealtimeEvent(raw)
    if (ev === null) return

    if (isOutputTranscriptDelta(ev)) {
      const delta: TranscriptDelta =
        ev.itemId === undefined
          ? { text: ev.delta, createdAt: Date.now() }
          : { text: ev.delta, itemId: ev.itemId, createdAt: Date.now() }
      safeCall('onOutputTranscriptDelta', () => {
        opts.onOutputTranscriptDelta(delta)
      })
      return
    }
    if (isInputTranscriptDelta(ev)) {
      if (opts.onInputTranscriptDelta === undefined) return
      const inputDelta: TranscriptDelta =
        ev.itemId === undefined
          ? { text: ev.delta, createdAt: Date.now() }
          : { text: ev.delta, itemId: ev.itemId, createdAt: Date.now() }
      const handler = opts.onInputTranscriptDelta
      safeCall('onInputTranscriptDelta', () => {
        handler(inputDelta)
      })
      return
    }
    if (isServerError(ev)) {
      reportError(new Error(`OpenAI realtime error: ${ev.code}: ${ev.message}`))
      return
    }
    // session.created / session.updated currently have no handler; left in place
    // for future telemetry without changing the public contract.
  }

  async function start(): Promise<void> {
    if (started) return
    started = true

    try {
      pc = new RtcImpl({ iceServers: [] })

      pc.ontrack = (event) => {
        safeCall('onRemoteAudioTrack', () => {
          opts.onRemoteAudioTrack(event.track)
        })
      }
      pc.onconnectionstatechange = () => {
        const state = pc?.connectionState ?? 'new'
        lastState = state
        safeCall('onStateChange', () => {
          opts.onStateChange(state)
        })
      }

      // Add local audio tracks. The SDK accepts `addTrack(track, ...streams)`
      // but we keep a single-stream PoC; phone-mic-only per design §14.1 step 4.
      for (const track of opts.sourceStream.getAudioTracks()) {
        pc.addTrack(track, opts.sourceStream)
      }

      const dc = pc.createDataChannel('oai-events')
      dataChannel = dc
      dc.onopen = () => {
        flushQueue(dc)
      }
      dc.onmessage = (ev: MessageEvent) => {
        handleDataChannelMessage(ev.data)
      }
      dc.onerror = (ev: Event) => {
        // RTCErrorEvent in browsers; jsdom/test env may emit a plain Event.
        reportError(new Error(`data channel error: ${(ev as { type?: string }).type ?? 'unknown'}`))
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      if (offer.sdp === undefined) {
        throw new Error('createOffer() returned no SDP')
      }

      const answerSdp = await exchangeSdp({
        offerSdp: offer.sdp,
        clientSecret: opts.clientSecret,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (err) {
      reportError(err)
      // Allow the caller to retry: best-effort cleanup of any partial state.
      try {
        pc?.close()
      } catch {
        // ignore
      }
      pc = null
      dataChannel = null
      started = false
      throw err
    }
  }

  async function stop(): Promise<void> {
    if (pc === null) return

    // Stop locally-added tracks so the mic indicator clears even if the SDK
    // implementation doesn't auto-stop on close().
    try {
      const senders = pc.getSenders()
      for (const sender of senders) {
        const track = sender.track
        if (track !== null && track !== undefined) {
          try {
            track.stop()
          } catch {
            // continue stopping the rest
          }
        }
      }
    } catch (err) {
      reportError(err)
    }

    try {
      pc.close()
    } catch (err) {
      reportError(err)
    }

    lastState = 'closed'
    pc = null
    dataChannel = null
    sendQueue.length = 0
    return Promise.resolve()
  }

  function sendSessionUpdate(targetLanguage: LanguageCode): void {
    let payload: string
    try {
      const event = buildSessionUpdateEvent(targetLanguage)
      payload = JSON.stringify(event)
    } catch (err) {
      reportError(err)
      return
    }

    const dc = dataChannel
    if (dc !== null && dc.readyState === 'open') {
      try {
        dc.send(payload)
      } catch (err) {
        reportError(err)
      }
      return
    }
    // Queue until open.
    sendQueue.push(payload)
  }

  function getState(): RTCPeerConnectionState {
    return lastState
  }

  return { start, stop, sendSessionUpdate, getState }
}

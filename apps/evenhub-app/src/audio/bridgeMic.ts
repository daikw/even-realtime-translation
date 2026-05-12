/**
 * G2 microphone acquisition through the Even Hub bridge — Phase 2 replacement
 * for the WebView `getUserMedia()` path (`phoneMic.ts`).
 *
 * The production WKWebView refuses `navigator.mediaDevices.getUserMedia` (see
 * Issue #7 + plan §1), so audio must come from `bridge.audioControl(true)` +
 * the `audioEvent.audioPcm` push channel (16 kHz S16LE PCM mono). This module
 * wraps that flow into a handle that:
 *
 *   - turns the bridge mic on once and off once, idempotently;
 *   - decodes each incoming `Uint8Array` chunk into an `Int16Array` so
 *     consumers (the WS client + the resampler) never have to think about
 *     byte order;
 *   - fans out chunks to multiple registered handlers — the WS client is the
 *     primary one but tests, telemetry, or a future local VAD layer can
 *     subscribe alongside without re-entering the bridge.
 *
 * Stop semantics mirror the mock bridge (`bridge.mock.ts`): once `stop()` has
 * resolved, any further `audioEvent.audioPcm` arriving from the bridge is
 * ignored — the unsubscribe is the source of truth, the `audioControl(false)`
 * call is just a courtesy to the device.
 */

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { bytesToSamplesLE } from '@even-rt/shared'

export type BridgeMicHandler = (samples: Int16Array) => void

export interface BridgeMicHandle {
  /** Turn the bridge mic off and release every PCM handler. Idempotent. */
  stop(): Promise<void>
  /**
   * Register a handler for each decoded PCM chunk. Returns an unsubscribe
   * function. Calling unsubscribe after `stop()` is a no-op.
   */
  onPcm(handler: BridgeMicHandler): () => void
}

/**
 * Open the G2 mic via the Even Hub bridge. The returned handle owns both the
 * `audioControl` lifetime and the `onEvenHubEvent` subscription; callers
 * **must** call `stop()` to release them.
 *
 * The hash-shaped error swallowing inside the bridge subscriber is
 * deliberate: a single malformed audio chunk should not poison subsequent
 * frames, and there is no recovery the caller can perform synchronously.
 * Decode errors are logged once and the chunk is dropped.
 */
export async function acquireBridgeMic(bridge: EvenAppBridge): Promise<BridgeMicHandle> {
  const handlers = new Set<BridgeMicHandler>()
  let stopped = false

  // Subscribe before flipping audioControl so the very first
  // `audioEvent.audioPcm` chunk emitted by the bridge cannot race past us
  // and reach a `stop()` early-out branch with the handler set empty.
  const unsubscribe = bridge.onEvenHubEvent((event) => {
    if (stopped) return
    const audio = event.audioEvent?.audioPcm
    if (audio === undefined) return
    let samples: Int16Array
    try {
      samples = bytesToSamplesLE(audio)
    } catch (err) {
      // Surface once for visibility — a real fault here is a bridge-side
      // regression that the operator wants to see during dev.
      console.warn('[bridgeMic] dropping malformed audio chunk:', (err as Error).message)
      return
    }
    for (const fn of handlers) {
      try {
        fn(samples)
      } catch (err) {
        console.warn('[bridgeMic] handler threw:', (err as Error).message)
      }
    }
  })

  // Real bridge resolves audioControl with `true` on success; treat anything
  // else as a failure to acquire the mic and propagate via rejection so the
  // caller can surface it as a permission/UX error.
  let ok: boolean
  try {
    ok = await bridge.audioControl(true)
  } catch (err) {
    unsubscribe()
    throw err
  }
  if (!ok) {
    unsubscribe()
    throw new Error('bridgeMic: audioControl(true) returned false')
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    handlers.clear()
    unsubscribe()
    try {
      await bridge.audioControl(false)
    } catch {
      // We've already detached our subscriber, so a failed mic-off is a
      // best-effort device cue, not a correctness issue here.
    }
  }

  function onPcm(handler: BridgeMicHandler): () => void {
    if (stopped) {
      // Match the unsubscribe-after-stop contract: returning a no-op is
      // friendlier than throwing and lets callers `stop().then(() => ...)`
      // without ordering anxiety.
      return () => undefined
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  return { stop, onPcm }
}

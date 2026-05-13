/**
 * Thin wrapper around `navigator.mediaDevices.getUserMedia({ audio: true })`
 * (design doc §15.2 step 4) that:
 *
 *  - normalizes permission/missing-device failures into a single typed error
 *    callers can branch on without parsing browser-specific `name` strings;
 *  - lets tests inject a fake `mediaDevices` without monkey-patching globals.
 *
 * @deprecated since 2026-05-12 — Phase 2 migration (docs/phase2-migration-plan.md §3 T7.4).
 *
 * The production Even Realities iOS WKWebView refuses `getUserMedia` with
 * `NotAllowedError` (see Issue #7). The replacement is `audio/bridgeMic.ts`
 * which acquires audio via the Even Hub bridge (`bridge.audioControl(true)`
 * + `audioEvent.audioPcm`).
 *
 * This file is retained for the §6 rollback gate (Discord #7 confirmation +
 * real-device validation of the WS path). It will be deleted in T7b after
 * both conditions are met. Do not call `acquirePhoneMic` from new code —
 * use the WS path via `createWebSocketRuntimeFactory` instead.
 */

export class MicPermissionDeniedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MicPermissionDeniedError'
  }
}

export interface AcquirePhoneMicOptions {
  /**
   * Defaults to `navigator.mediaDevices`. Tests can pass a fake; production
   * code should leave this undefined.
   */
  mediaDevices?: MediaDevices
}

function isPermissionLikeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const name = (err as { name?: unknown }).name
  if (typeof name !== 'string') return false
  // Per WebRTC spec, `NotAllowedError` is the user-denied case;
  // `NotFoundError` fires when no audio input device exists. Both manifest
  // identically to the user ("can't start mic"), so we collapse them.
  return name === 'NotAllowedError' || name === 'NotFoundError'
}

/** @deprecated Phase 2 (2026-05-12). Use \`acquireBridgeMic\` from
 * \`audio/bridgeMic.ts\` instead — \`getUserMedia\` is blocked in the iOS
 * WKWebView (Issue #7). This export is retained until T7b clears the §6
 * rollback gate (see file header). */
export async function acquirePhoneMic(opts: AcquirePhoneMicOptions = {}): Promise<MediaStream> {
  const devices: MediaDevices | undefined =
    opts.mediaDevices ??
    (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined)
  if (devices === undefined) {
    throw new Error('navigator.mediaDevices is not available in this context')
  }

  try {
    return await devices.getUserMedia({ audio: true })
  } catch (err) {
    if (isPermissionLikeError(err)) {
      const message = err instanceof Error ? err.message : 'mic permission denied'
      throw new MicPermissionDeniedError(message, err)
    }
    throw err
  }
}

/**
 * Stop every track on the stream. We swallow per-track exceptions so a single
 * misbehaving sender can't leave others running (the indicator only clears
 * when every track is in `ended` state).
 *
 * @deprecated Phase 2 (2026-05-12). Bridge mic teardown lives in
 * \`acquireBridgeMic\`'s returned \`stop()\`. Retained until T7b.
 */
export function stopMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // continue stopping the rest
    }
  }
}

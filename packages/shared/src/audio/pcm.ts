/**
 * 16-bit signed little-endian PCM helpers + linear-interpolation resampler
 * for the Phase 2 audio pipeline (see `docs/phase2-migration-plan.md` §3 T1.1).
 *
 * Why this lives in `packages/shared`:
 * - frontend resamples mic chunks 16 kHz → 24 kHz before encoding to base64
 *   and sending over the WS proxy (see §2.1).
 * - backend smoke tests reuse the same encoder/decoder when faking upstream
 *   `session.output_audio.delta` frames.
 * - the helpers are pure (no Web Audio / DOM / Node-only APIs) so they
 *   compile to both browser and node entrypoints.
 */

/**
 * Decode a Uint8Array of little-endian S16 samples into Int16Array.
 *
 * `buf.byteLength` must be even — odd lengths throw because we never want
 * a half sample dropped silently from a network frame.
 */
export function bytesToSamplesLE(buf: Uint8Array): Int16Array {
  if (buf.byteLength % 2 !== 0) {
    throw new Error(`bytesToSamplesLE: expected even byte length, got ${buf.byteLength}`)
  }
  // Copy into a fresh ArrayBuffer because the input may be a SharedArrayBuffer
  // view, a slice with non-aligned byteOffset, or read-only. Allocating once
  // keeps the Int16Array view stable and detached from the source.
  const out = new Int16Array(buf.byteLength / 2)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, /* littleEndian */ true)
  }
  return out
}

/** Encode Int16Array into a fresh Uint8Array of little-endian S16. */
export function samplesToBytesLE(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, /* littleEndian */ true)
  }
  return out
}

/**
 * Resample 16 kHz mono PCM16 samples to 24 kHz mono PCM16 using linear
 * interpolation.
 *
 * - Output length is `Math.floor(input.length * 3 / 2)` so that for every N
 *   input samples we produce 1.5 N output samples (matches the 16 kHz → 24 kHz
 *   rate ratio exactly when N is even). For odd N the last output sample is
 *   clamped to `input[N-1]` rather than interpolating past the end, which
 *   keeps consecutive resample() calls stitchable without a sample-of-silence
 *   gap.
 * - Pure function: no internal state, no module-level scratch buffers. The
 *   resampler is called per audio chunk (~100 ms = 1600 in / 2400 out samples)
 *   so the allocation cost is dominated by the chunk size itself.
 *
 * NOTE: linear interpolation introduces minor aliasing above ~12 kHz. The
 * translation model handles speech bandwidth (<8 kHz) cleanly so this is
 * acceptable for the MVP. If we ever need higher fidelity output (e.g. for
 * the M3+ audio-out path), swap this for a windowed sinc filter — the
 * function signature is stable.
 */
export function resample16to24(samples: Int16Array): Int16Array {
  const inN = samples.length
  if (inN === 0) return new Int16Array(0)
  const outN = Math.floor((inN * 3) / 2)
  if (outN === 0) {
    // N=1 case: floor(3/2) = 1, so we don't actually hit this branch. Guard
    // kept defensively in case the ratio constants change in future.
    return new Int16Array(0)
  }
  const out = new Int16Array(outN)
  for (let n = 0; n < outN; n += 1) {
    // Output sample n at 24 kHz corresponds to time n/24000 s; the matching
    // input position at 16 kHz is (n/24000) * 16000 = n * 2 / 3.
    const pos = (n * 2) / 3
    const i = Math.floor(pos)
    const frac = pos - i
    if (i + 1 < inN) {
      out[n] = Math.round(samples[i]! * (1 - frac) + samples[i + 1]! * frac)
    } else {
      // Edge clamp: only triggers for the trailing output sample when inN is
      // odd. Holding the last input sample is a 1-sample zero-order extension
      // and audibly indistinguishable from the interpolation it replaces.
      out[n] = samples[inN - 1]!
    }
  }
  return out
}

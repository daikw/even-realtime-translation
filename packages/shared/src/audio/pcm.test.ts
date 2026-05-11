import { describe, expect, it } from 'vitest'

import { bytesToSamplesLE, resample16to24, samplesToBytesLE } from './pcm.js'

describe('bytesToSamplesLE / samplesToBytesLE', () => {
  it('decodes the documented LE byte order', () => {
    // 0x00 0x01 → 0x0100 = 256. 0xFF 0xFF → -1. 0x00 0x80 → -32768 (S16 min).
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xff, 0x00, 0x80])
    expect(Array.from(bytesToSamplesLE(bytes))).toEqual([256, -1, -32768])
  })

  it('round-trips bytes → samples → bytes exactly', () => {
    // Cover positives, negatives, zero, and the S16 extremes.
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345])
    const bytes = samplesToBytesLE(samples)
    const decoded = bytesToSamplesLE(bytes)
    expect(Array.from(decoded)).toEqual(Array.from(samples))
  })

  it('round-trips a randomized 4 KiB buffer', () => {
    const samples = new Int16Array(2048)
    let seed = 0xc0ffee
    for (let i = 0; i < samples.length; i += 1) {
      // Linear congruential — deterministic, no Math.random dependency.
      seed = (seed * 1103515245 + 12345) & 0xffffffff
      samples[i] = ((seed >> 8) & 0xffff) - 0x8000
    }
    const decoded = bytesToSamplesLE(samplesToBytesLE(samples))
    expect(Array.from(decoded)).toEqual(Array.from(samples))
  })

  it('throws on odd-length byte input rather than silently dropping a half-sample', () => {
    const odd = new Uint8Array([0x01, 0x02, 0x03])
    expect(() => bytesToSamplesLE(odd)).toThrow(/even byte length/)
  })

  it('produces independent storage from the input buffer (no aliasing)', () => {
    // Passing a sliced Uint8Array with non-zero byteOffset used to be a
    // common source of buffer-view bugs. Mutating the original buffer after
    // decoding must not change the decoded samples.
    const backing = new Uint8Array([0xff, 0x00, 0x01, 0xff, 0xff])
    const view = backing.subarray(1, 5) // 4 bytes = 2 samples
    // LE: [0x00, 0x01] = 0x0100 = 256, [0xff, 0xff] = -1.
    const decoded = bytesToSamplesLE(view)
    backing[1] = 0xff
    backing[2] = 0xff
    expect(Array.from(decoded)).toEqual([256, -1])
  })

  it('handles the empty input case symmetrically', () => {
    expect(bytesToSamplesLE(new Uint8Array(0)).length).toBe(0)
    expect(samplesToBytesLE(new Int16Array(0)).length).toBe(0)
  })
})

describe('resample16to24', () => {
  it('produces 3/2 the input length for even N', () => {
    expect(resample16to24(new Int16Array(0)).length).toBe(0)
    expect(resample16to24(new Int16Array(2)).length).toBe(3)
    expect(resample16to24(new Int16Array(100)).length).toBe(150)
    expect(resample16to24(new Int16Array(1600)).length).toBe(2400) // 100 ms @ 16k → 100 ms @ 24k
  })

  it('floors output length to (N * 3) / 2 for odd N (no half-sample emitted)', () => {
    expect(resample16to24(new Int16Array(1)).length).toBe(1)
    expect(resample16to24(new Int16Array(3)).length).toBe(4)
    expect(resample16to24(new Int16Array(5)).length).toBe(7)
    expect(resample16to24(new Int16Array(11)).length).toBe(16)
  })

  it('preserves a DC offset (all-same input → all-same output)', () => {
    const dc = new Int16Array(64).fill(1234)
    const out = resample16to24(dc)
    for (const sample of out) {
      expect(sample).toBe(1234)
    }
  })

  it('linearly interpolates a ramp (max error ≤ 1 from rounding)', () => {
    // Input ramp 0..63 → expected output is the same ramp scaled to 24 kHz
    // grid: out[n] = round(input[n * 2/3]).
    const input = new Int16Array(64)
    for (let i = 0; i < input.length; i += 1) input[i] = i * 100
    const out = resample16to24(input)
    expect(out.length).toBe(96)
    for (let n = 0; n < out.length; n += 1) {
      const pos = (n * 2) / 3
      const i = Math.floor(pos)
      const frac = pos - i
      const expected =
        i + 1 < input.length
          ? Math.round(input[i]! * (1 - frac) + input[i + 1]! * frac)
          : input[input.length - 1]!
      expect(out[n]).toBe(expected)
    }
  })

  it('clamps the trailing sample to input[N-1] for odd N rather than reading past the end', () => {
    // For N=5 the resampler emits 7 samples; the last input position is
    // 6 * 2/3 = 4 exactly, so no clamp — but for N=3 the last position is
    // 3 * 2/3 = 2, also exact. For N=11 the last position is 15 * 2/3 = 10
    // (also exact), but for N=4 the last position is 5 * 2/3 = 3.33 which
    // would interpolate input[3] / input[4]; input[4] is out of bounds and
    // must clamp to input[3].
    const samples = new Int16Array([100, 200, 300, 400])
    const out = resample16to24(samples)
    expect(out.length).toBe(6)
    expect(out[out.length - 1]).toBe(samples[samples.length - 1])
  })

  it('preserves total energy approximately (sanity for sine-like signals)', () => {
    // A pure sine at 1 kHz over 64 ms (1024 input samples at 16 kHz) should
    // resample to 1536 output samples with similar amplitude distribution.
    const inN = 1024
    const input = new Int16Array(inN)
    for (let i = 0; i < inN; i += 1) {
      input[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * i) / 16000))
    }
    const out = resample16to24(input)
    expect(out.length).toBe(1536)
    // RMS within 2% of the input. Linear interpolation slightly attenuates
    // — empirically <0.5% for a 1 kHz tone — but we keep a generous tolerance
    // so this test isn't a tripwire on numerical noise.
    const rms = (arr: Int16Array): number => {
      let s = 0
      for (const v of arr) s += v * v
      return Math.sqrt(s / arr.length)
    }
    const ratio = rms(out) / rms(input)
    expect(ratio).toBeGreaterThan(0.98)
    expect(ratio).toBeLessThan(1.02)
  })
})

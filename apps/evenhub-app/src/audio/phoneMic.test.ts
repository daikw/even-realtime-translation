import { describe, expect, it, vi } from 'vitest'

import {
  MicPermissionDeniedError,
  acquirePhoneMic,
  stopMediaStream,
} from './phoneMic.js'

function makeMediaDevices(getUserMedia: MediaDevices['getUserMedia']): MediaDevices {
  return { getUserMedia } as unknown as MediaDevices
}

function makeStream(): { stream: MediaStream; tracks: { stop: ReturnType<typeof vi.fn> }[] } {
  const tracks: { stop: ReturnType<typeof vi.fn> }[] = [
    { stop: vi.fn() },
    { stop: vi.fn() },
  ]
  const stream = {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream
  return { stream, tracks }
}

describe('acquirePhoneMic', () => {
  it('returns the MediaStream from getUserMedia({ audio: true })', async () => {
    const { stream } = makeStream()
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockResolvedValueOnce(stream)
    const result = await acquirePhoneMic({ mediaDevices: makeMediaDevices(getUserMedia) })
    expect(result).toBe(stream)
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
  })

  it('wraps NotAllowedError as MicPermissionDeniedError', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockRejectedValueOnce(denied)
    await expect(
      acquirePhoneMic({ mediaDevices: makeMediaDevices(getUserMedia) }),
    ).rejects.toBeInstanceOf(MicPermissionDeniedError)
  })

  it('wraps NotFoundError as MicPermissionDeniedError', async () => {
    const missing = Object.assign(new Error('No mic'), { name: 'NotFoundError' })
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockRejectedValueOnce(missing)
    await expect(
      acquirePhoneMic({ mediaDevices: makeMediaDevices(getUserMedia) }),
    ).rejects.toBeInstanceOf(MicPermissionDeniedError)
  })

  it('re-throws unrelated errors as-is', async () => {
    const other = Object.assign(new Error('weird'), { name: 'AbortError' })
    const getUserMedia = vi
      .fn<MediaDevices['getUserMedia']>()
      .mockRejectedValueOnce(other)
    await expect(
      acquirePhoneMic({ mediaDevices: makeMediaDevices(getUserMedia) }),
    ).rejects.toBe(other)
  })

  it('throws when no mediaDevices is available', async () => {
    // We pass an undefined mediaDevices to simulate non-secure context / missing API.
    await expect(
      acquirePhoneMic({ mediaDevices: undefined as unknown as MediaDevices }),
    ).rejects.toBeInstanceOf(Error)
  })
})

describe('stopMediaStream', () => {
  it('stops every track on the stream', () => {
    const { stream, tracks } = makeStream()
    stopMediaStream(stream)
    for (const t of tracks) {
      expect(t.stop).toHaveBeenCalledTimes(1)
    }
  })

  it('does not throw when getTracks returns empty', () => {
    const empty = { getTracks: () => [] } as unknown as MediaStream
    expect(() => {
      stopMediaStream(empty)
    }).not.toThrow()
  })

  it('keeps stopping tracks even if one throws', () => {
    const t1 = {
      stop: vi.fn(() => {
        throw new Error('boom')
      }),
    }
    const t2 = { stop: vi.fn() }
    const stream = { getTracks: () => [t1, t2] } as unknown as MediaStream
    expect(() => {
      stopMediaStream(stream)
    }).not.toThrow()
    expect(t2.stop).toHaveBeenCalled()
  })
})

describe('MicPermissionDeniedError', () => {
  it('captures cause when provided', () => {
    const cause = new Error('underlying')
    const err = new MicPermissionDeniedError('mic-denied', cause)
    expect(err.name).toBe('MicPermissionDeniedError')
    expect(err.message).toBe('mic-denied')
    expect(err.cause).toBe(cause)
  })
})

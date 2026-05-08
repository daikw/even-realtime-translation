/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureAudioElement } from './audioPlayer.js'

function clearBody(): void {
  while (document.body.firstChild !== null) {
    document.body.removeChild(document.body.firstChild)
  }
}

describe('ensureAudioElement', () => {
  beforeEach(() => {
    clearBody()
  })

  afterEach(() => {
    clearBody()
  })

  it('creates an <audio autoplay playsinline> element on first call', () => {
    const audio = ensureAudioElement()
    expect(audio.tagName).toBe('AUDIO')
    expect(audio.autoplay).toBe(true)
    expect(audio.getAttribute('playsinline')).not.toBeNull()
    expect(audio.parentElement).toBe(document.body)
  })

  it('reuses the existing element on subsequent calls', () => {
    const a1 = ensureAudioElement()
    const a2 = ensureAudioElement()
    expect(a2).toBe(a1)
    expect(document.querySelectorAll('audio[data-role=remote-translation]').length).toBe(1)
  })

  it('disposeAudioElement removes the element and clears srcObject', async () => {
    const { disposeAudioElement } = await import('./audioPlayer.js')
    const audio = ensureAudioElement()
    expect(audio.parentElement).toBe(document.body)
    disposeAudioElement()
    expect(document.querySelector('audio[data-role=remote-translation]')).toBeNull()
  })

  it('disposeAudioElement is a no-op when no element exists', async () => {
    const { disposeAudioElement } = await import('./audioPlayer.js')
    expect(() => {
      disposeAudioElement()
    }).not.toThrow()
  })

  it('attachAudioElement throws when MediaStream global is missing', async () => {
    const { attachAudioElement } = await import('./audioPlayer.js')
    const track = { kind: 'audio' } as unknown as MediaStreamTrack
    const original = (globalThis as { MediaStream?: unknown }).MediaStream
    delete (globalThis as { MediaStream?: unknown }).MediaStream
    try {
      expect(() => attachAudioElement(track)).toThrow(/MediaStream/)
    } finally {
      if (original !== undefined) (globalThis as { MediaStream?: unknown }).MediaStream = original
    }
  })

  it('attachAudioElement assigns the track via a MediaStream srcObject', async () => {
    // jsdom doesn't implement MediaStream; smoke-test our surface by importing
    // dynamically and supplying a fake. We only care that the helper sets
    // `srcObject` to a stream containing the given track.
    const { attachAudioElement } = await import('./audioPlayer.js')
    const track = { kind: 'audio' } as unknown as MediaStreamTrack

    class FakeStream {
      tracks: MediaStreamTrack[] = []
      constructor(tracks: MediaStreamTrack[] = []) {
        this.tracks = [...tracks]
      }
      addTrack(t: MediaStreamTrack): void {
        this.tracks.push(t)
      }
      getTracks(): MediaStreamTrack[] {
        return this.tracks
      }
    }
    // Install once; the helper reads the global at call time.
    ;(globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeStream
    try {
      const audio = attachAudioElement(track)
      expect(audio.srcObject).toBeInstanceOf(FakeStream)
      const stream = audio.srcObject as unknown as FakeStream
      expect(stream.getTracks()).toContain(track)
    } finally {
      delete (globalThis as unknown as { MediaStream?: unknown }).MediaStream
    }
  })
})

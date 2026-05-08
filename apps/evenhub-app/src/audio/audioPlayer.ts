/**
 * Tiny DOM helper for the translated audio output stream (§14.1 step 10).
 *
 * The element is intentionally minimal:
 *  - autoplay + playsinline so iOS browsers don't take over with a fullscreen
 *    player when the page reloads in dev,
 *  - tagged with `data-role=remote-translation` so it's discoverable for
 *    teardown and easy to identify in DOM dumps,
 *  - volume left at 1.0; G2 routes through the phone's media volume.
 */
const AUDIO_ROLE_SELECTOR = 'audio[data-role=remote-translation]'

export function ensureAudioElement(): HTMLAudioElement {
  if (typeof document === 'undefined') {
    throw new Error('ensureAudioElement requires a DOM (window/document) context')
  }
  const existing = document.querySelector(AUDIO_ROLE_SELECTOR)
  if (existing instanceof HTMLAudioElement) {
    return existing
  }
  const audio = document.createElement('audio')
  audio.autoplay = true
  audio.setAttribute('playsinline', '')
  audio.setAttribute('data-role', 'remote-translation')
  audio.volume = 1.0
  document.body.appendChild(audio)
  return audio
}

/**
 * Attach a remote `MediaStreamTrack` (translated audio) to the singleton
 * `<audio>` element.
 *
 * We always wrap the track in a fresh `MediaStream`; assigning a bare track to
 * `srcObject` works on Chromium but is not portable. Returns the element so
 * callers can inspect or reposition it if needed.
 */
export function attachAudioElement(track: MediaStreamTrack): HTMLAudioElement {
  const audio = ensureAudioElement()
  const StreamCtor: typeof MediaStream | undefined =
    typeof MediaStream !== 'undefined'
      ? MediaStream
      : (globalThis as unknown as { MediaStream?: typeof MediaStream }).MediaStream
  if (StreamCtor === undefined) {
    throw new Error('MediaStream global is not available')
  }
  const stream = new StreamCtor([track])
  audio.srcObject = stream
  return audio
}

/** Detach the current stream and remove the element from the DOM. */
export function disposeAudioElement(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector(AUDIO_ROLE_SELECTOR)
  if (existing instanceof HTMLAudioElement) {
    existing.srcObject = null
    existing.remove()
  }
}

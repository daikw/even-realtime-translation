import { findSegmentBoundary, type SubtitleSegment } from '@even-rt/shared'

import { fitSubtitle } from './textFitter.js'

const DEFAULT_MAX_CHARS = 180
const DEFAULT_SEGMENT_MAX_CHARS = 60
const DEFAULT_UPDATE_INTERVAL_MS = 150

export interface SubtitleBufferOptions {
  /** Hard cap (in raw characters) for active + history retained in memory. */
  maxChars?: number
  /** Soft cap that triggers a forced segment finalization (`findSegmentBoundary`). */
  segmentMaxChars?: number
  /** Trailing-edge throttle window for `onRender` invocations. */
  updateIntervalMs?: number
  /** Sink for the rendered HUD text (post-fit). May return a Promise. */
  onRender: (text: string) => void | Promise<void>
}

/**
 * Buffer for streaming Realtime translation deltas.
 *
 * Owns three mutually exclusive responsibilities:
 *  1. **Append-only delta accumulation** — `append(delta)` concatenates onto
 *     the active segment.
 *  2. **Segment finalization** — every `append`/`setActive` looks for a
 *     sentence boundary via `findSegmentBoundary` and moves the matched prefix
 *     into history.
 *  3. **Throttled rendering** — `onRender` is fired on the trailing edge of a
 *     {@link SubtitleBufferOptions.updateIntervalMs} window with the most
 *     recent state (last finalized segment + active).
 *
 * Disposed buffers ignore subsequent mutations (no-op) so callers don't have
 * to guard their own teardown order.
 */
export class SubtitleBuffer {
  private readonly maxChars: number
  private readonly segmentMaxChars: number
  private readonly updateIntervalMs: number
  private readonly onRender: (text: string) => void | Promise<void>

  private active = ''
  private history: SubtitleSegment[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private disposed = false
  private nextSegmentId = 1

  constructor(opts: SubtitleBufferOptions) {
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS
    this.segmentMaxChars = opts.segmentMaxChars ?? DEFAULT_SEGMENT_MAX_CHARS
    this.updateIntervalMs = opts.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS
    this.onRender = opts.onRender
  }

  append(delta: string): void {
    if (this.disposed) return
    if (delta.length === 0) return
    this.active += delta
    this.harvestSegments()
    this.scheduleRender()
  }

  /**
   * Replace the active segment in one shot. Used for `input_transcript` events
   * where OpenAI keeps emitting an evolving prefix rather than pure deltas.
   */
  setActive(text: string): void {
    if (this.disposed) return
    this.active = text
    this.harvestSegments()
    this.scheduleRender()
  }

  /** Force the current active text into history (sentence-boundary override). */
  finalizeNow(): void {
    if (this.disposed) return
    if (this.active.length === 0) return
    this.pushSegment(this.active)
    this.active = ''
    this.scheduleRender()
  }

  getActive(): string {
    return this.active
  }

  getHistory(): SubtitleSegment[] {
    // Defensive copy — callers shouldn't be able to mutate internal history.
    return this.history.slice()
  }

  /** Reset both active and history. The next throttle tick renders an empty string. */
  clear(): void {
    if (this.disposed) return
    this.active = ''
    this.history = []
    this.scheduleRender()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirty = false
  }

  /**
   * Pull every confirmed segment out of `active` (could be more than one if
   * the burst contained multiple sentence terminators).
   */
  private harvestSegments(): void {
    while (this.active.length > 0) {
      const boundary = findSegmentBoundary(this.active, { maxChars: this.segmentMaxChars })
      if (boundary === null) break
      const head = this.active.slice(0, boundary + 1)
      const tail = this.active.slice(boundary + 1)
      this.pushSegment(head)
      this.active = tail
    }
    this.enforceMaxChars()
  }

  private pushSegment(text: string): void {
    if (text.length === 0) return
    const segment: SubtitleSegment = {
      id: `seg-${String(this.nextSegmentId++)}`,
      text,
      finalized: true,
      startedAt: Date.now(),
    }
    this.history.push(segment)
    this.enforceMaxChars()
  }

  /** Drop the oldest history entries until total retained chars ≤ maxChars. */
  private enforceMaxChars(): void {
    let total = this.active.length
    for (const seg of this.history) total += seg.text.length
    while (total > this.maxChars && this.history.length > 0) {
      const dropped = this.history.shift()
      if (dropped === undefined) break
      total -= dropped.text.length
    }
  }

  private scheduleRender(): void {
    if (this.disposed) return
    this.dirty = true
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.dirty || this.disposed) return
      this.dirty = false
      this.flushNow()
    }, this.updateIntervalMs)
  }

  private flushNow(): void {
    const recent = this.history[this.history.length - 1]?.text ?? ''
    // Combine the last finalized segment with the live active text. Both halves
    // are joined with `\n` so fitSubtitle can wrap the recent line independently
    // from the live one.
    const parts: string[] = []
    if (recent.length > 0) parts.push(recent)
    if (this.active.length > 0) parts.push(this.active)
    const raw = parts.join('\n')
    const text = fitSubtitle(raw)
    // Errors thrown by `onRender` (sync or async) are intentionally NOT caught
    // here — outer wiring (Task #7) is responsible for surfacing them. A
    // synchronous throw escapes the setTimeout callback, an async rejection
    // surfaces as an unhandledRejection on the host runtime.
    const result = this.onRender(text)
    if (result instanceof Promise) {
      // Touching `.then` keeps the promise live; without `.catch` the
      // rejection surfaces as `unhandledRejection`, matching the contract.
      void result
    }
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SubtitleBuffer, type SubtitleBufferOptions } from './subtitleBuffer.js'

type MakeBufferOverrides = Partial<Omit<SubtitleBufferOptions, 'onRender'>>

function makeBuffer(opts: MakeBufferOverrides = {}) {
  const onRender = vi.fn<(text: string) => void | Promise<void>>()
  const buf = new SubtitleBuffer({
    onRender,
    ...opts,
  })
  return { buf, onRender }
}

describe('SubtitleBuffer.append (throttle)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces rapid appends into a single onRender call within the window', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('he')
    buf.append('llo')
    buf.append(' wo')
    expect(onRender).not.toHaveBeenCalled()

    // Trailing edge fires after updateIntervalMs.
    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)
    // Active text should reflect ALL appends.
    expect(onRender.mock.calls[0]?.[0]).toContain('hello wo')

    buf.dispose()
  })

  it('does not call onRender on the leading edge (trailing-only)', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('a')
    expect(onRender).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(149)
    expect(onRender).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onRender).toHaveBeenCalledTimes(1)

    buf.dispose()
  })

  it('opens a new window for appends arriving after the trailing flush', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('a')
    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)

    buf.append('b')
    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(2)
    expect(onRender.mock.calls[1]?.[0]).toContain('ab')

    buf.dispose()
  })
})

describe('SubtitleBuffer segment finalization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('finalizes a Japanese sentence on 。 and moves it to history', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('こんにちは。')
    expect(buf.getActive()).toBe('')
    const history = buf.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0]?.text).toBe('こんにちは。')
    expect(history[0]?.finalized).toBe(true)

    // The render still shows the most recent finalized segment.
    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)
    expect(onRender.mock.calls[0]?.[0]).toContain('こんにちは。')

    buf.dispose()
  })

  it('keeps the residual after a boundary as the new active', () => {
    const { buf } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('Hi. Tail')
    expect(buf.getHistory()).toHaveLength(1)
    expect(buf.getHistory()[0]?.text).toBe('Hi.')
    // " Tail" remains active (leading space preserved by slicing).
    expect(buf.getActive().trimStart()).toBe('Tail')

    buf.dispose()
  })

  it('finalizeNow() forces the current active into history', () => {
    const { buf } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('no terminator yet')
    expect(buf.getHistory()).toHaveLength(0)
    buf.finalizeNow()
    expect(buf.getActive()).toBe('')
    expect(buf.getHistory()).toHaveLength(1)
    expect(buf.getHistory()[0]?.text).toBe('no terminator yet')

    buf.dispose()
  })

  it('finalizeNow() with no active is a no-op', () => {
    const { buf } = makeBuffer()
    buf.finalizeNow()
    expect(buf.getHistory()).toHaveLength(0)
    buf.dispose()
  })

  it('finalizes when active exceeds segmentMaxChars (no terminator)', () => {
    const { buf } = makeBuffer({ segmentMaxChars: 5 })

    buf.append('abcdefghij')
    // findSegmentBoundary returns the cutoff index when text > maxChars.
    expect(buf.getHistory()).toHaveLength(1)
    expect(buf.getHistory()[0]?.text.length).toBeGreaterThan(0)

    buf.dispose()
  })
})

describe('SubtitleBuffer.setActive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces the active segment without touching history', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('First.')
    expect(buf.getHistory()).toHaveLength(1)

    buf.setActive('input transcript so far')
    expect(buf.getActive()).toBe('input transcript so far')
    expect(buf.getHistory()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)
    const text = onRender.mock.calls[0]?.[0] ?? ''
    expect(text).toContain('input transcript so far')
    // Last finalized still surfaces in the render preamble.
    expect(text).toContain('First.')

    buf.dispose()
  })
})

describe('SubtitleBuffer.clear', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets history and active and renders an empty string on next flush', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('First.')
    buf.append('partial')
    expect(buf.getHistory()).toHaveLength(1)
    expect(buf.getActive().length).toBeGreaterThan(0)

    buf.clear()
    expect(buf.getHistory()).toHaveLength(0)
    expect(buf.getActive()).toBe('')

    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)
    expect(onRender.mock.calls[0]?.[0]).toBe('')

    buf.dispose()
  })
})

describe('SubtitleBuffer.dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels pending trailing-edge invocations', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('partial')
    buf.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(onRender).not.toHaveBeenCalled()
  })

  it('makes append/finalizeNow no-ops after disposal', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.dispose()
    buf.append('ignored')
    buf.finalizeNow()
    await vi.advanceTimersByTimeAsync(500)

    expect(onRender).not.toHaveBeenCalled()
    expect(buf.getActive()).toBe('')
    expect(buf.getHistory()).toHaveLength(0)
  })
})

describe('SubtitleBuffer.maxChars retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops the oldest history entries when total chars exceed maxChars', () => {
    const { buf } = makeBuffer({ maxChars: 12, segmentMaxChars: 60 })

    // 4 segments of "abc." (4 chars) each → 16 chars total > 12 cap.
    buf.append('abc.')
    buf.append('def.')
    buf.append('ghi.')
    buf.append('jkl.')
    const history = buf.getHistory()
    const total = history.reduce((acc, seg) => acc + seg.text.length, 0)
    expect(total).toBeLessThanOrEqual(12)
    // Oldest "abc." must have been dropped to fit the budget.
    expect(history.map((s) => s.text)).not.toContain('abc.')

    buf.dispose()
  })
})

describe('SubtitleBuffer render contents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the most recent finalized segment when active is empty', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('Hello.')
    await vi.advanceTimersByTimeAsync(150)
    expect(onRender).toHaveBeenCalledTimes(1)
    expect(onRender.mock.calls[0]?.[0]).toContain('Hello.')

    buf.dispose()
  })

  it('does not render anything when active is empty and history is empty', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('')
    await vi.advanceTimersByTimeAsync(150)
    // No characters were appended → nothing to flush.
    expect(onRender).not.toHaveBeenCalled()

    buf.dispose()
  })

  it('runs render text through fitSubtitle (joined with newlines)', async () => {
    const { buf, onRender } = makeBuffer({ updateIntervalMs: 150 })

    buf.append('連携の前提として、既存の入退室管理システムと接続したいです。')
    await vi.advanceTimersByTimeAsync(150)
    const text = onRender.mock.calls[0]?.[0] ?? ''
    expect(text.split('\n').length).toBeGreaterThan(1)

    buf.dispose()
  })
})

describe('SubtitleBuffer error propagation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps invoking onRender after a previous async rejection', async () => {
    // Verifies the buffer doesn't get stuck in a permanently-failed state
    // when onRender rejects: subsequent flushes keep firing. The actual
    // error-surfacing is the wiring layer's responsibility (Task #7).
    let calls = 0
    const onRender = vi.fn<(text: string) => Promise<void>>(() => {
      calls++
      // Reject every other call so the buffer sees both happy and failed paths.
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve()
    })
    const buf = new SubtitleBuffer({ updateIntervalMs: 150, onRender })

    // Suppress unhandledRejection noise from the deliberately-rejected promise.
    const noop = (): void => {}
    process.on('unhandledRejection', noop)

    try {
      buf.append('first')
      await vi.advanceTimersByTimeAsync(150)
      await Promise.resolve()

      buf.append(' second')
      await vi.advanceTimersByTimeAsync(150)
      await Promise.resolve()

      expect(onRender).toHaveBeenCalledTimes(2)
    } finally {
      process.off('unhandledRejection', noop)
      buf.dispose()
    }
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReconnectController } from './reconnect.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('ReconnectController', () => {
  it('runs the action immediately on first attempt (no delay)', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController({ maxAttempts: 3, baseDelayMs: 500 })
    const action = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const p = controller.scheduleNext(action)

    // attempt 1 uses delay 0 (500 * 2^(1-1) - well, design says 500/1000/2000;
    // we treat the first attempt as "schedule immediately, no backoff yet").
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(action).toHaveBeenCalledTimes(1)
    expect(controller.getAttempts()).toBe(1)
  })

  it('uses exponential backoff (500, 1000, 2000) for retries', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController({ maxAttempts: 4, baseDelayMs: 500 })

    // First attempt: succeed immediately.
    let calls = 0
    const failingAction = vi.fn<() => Promise<void>>(() => {
      calls += 1
      return Promise.reject(new Error('simulated failure'))
    })

    // Schedule first attempt (immediate)
    const p1 = controller.scheduleNext(failingAction).catch(() => {
      /* swallow */
    })
    await vi.advanceTimersByTimeAsync(0)
    await p1
    expect(calls).toBe(1)
    expect(controller.getAttempts()).toBe(1)

    // 2nd attempt should fire after 500ms.
    const p2 = controller.scheduleNext(failingAction).catch(() => {})
    // Not yet
    await vi.advanceTimersByTimeAsync(499)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await p2
    expect(calls).toBe(2)
    expect(controller.getAttempts()).toBe(2)

    // 3rd: 1000ms
    const p3 = controller.scheduleNext(failingAction).catch(() => {})
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    await p3
    expect(calls).toBe(3)
    expect(controller.getAttempts()).toBe(3)

    // 4th: 2000ms
    const p4 = controller.scheduleNext(failingAction).catch(() => {})
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toBe(3)
    await vi.advanceTimersByTimeAsync(1)
    await p4
    expect(calls).toBe(4)
    expect(controller.getAttempts()).toBe(4)
  })

  it('rejects when maxAttempts is exceeded', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController({ maxAttempts: 2, baseDelayMs: 100 })
    const action = vi.fn<() => Promise<void>>(() => Promise.resolve())

    const p1 = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(0)
    await p1

    const p2 = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(100)
    await p2

    expect(controller.getAttempts()).toBe(2)
    await expect(controller.scheduleNext(action)).rejects.toThrow(/max/i)
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('reset() returns attempts to zero and restarts backoff', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController({ maxAttempts: 3, baseDelayMs: 500 })
    const action = vi.fn<() => Promise<void>>(() => Promise.resolve())

    const p1 = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(0)
    await p1
    expect(controller.getAttempts()).toBe(1)

    controller.reset()
    expect(controller.getAttempts()).toBe(0)

    // After reset, the next attempt should fire immediately again.
    const p2 = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(0)
    await p2
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('dispose() cancels the pending timer and rejects scheduled action', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController({ maxAttempts: 5, baseDelayMs: 500 })
    const action = vi.fn<() => Promise<void>>(() => Promise.resolve())

    const p1 = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(0)
    await p1

    const p2 = controller.scheduleNext(action)

    controller.dispose()
    await expect(p2).rejects.toThrow(/dispose|cancel|abort/i)
    // Even if we advance time, the action must not run.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('rejects further scheduleNext calls after dispose()', async () => {
    const controller = new ReconnectController({ maxAttempts: 5, baseDelayMs: 500 })
    controller.dispose()
    await expect(controller.scheduleNext(() => Promise.resolve())).rejects.toThrow(/dispose/i)
  })

  it('throws when constructed with non-positive maxAttempts', () => {
    expect(() => new ReconnectController({ maxAttempts: 0, baseDelayMs: 500 })).toThrow()
    expect(() => new ReconnectController({ maxAttempts: -1, baseDelayMs: 500 })).toThrow()
  })

  it('uses default options when none are provided', async () => {
    vi.useFakeTimers()
    const controller = new ReconnectController()
    const action = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const p = controller.scheduleNext(action)
    await vi.advanceTimersByTimeAsync(0)
    await p
    expect(action).toHaveBeenCalledTimes(1)
    expect(controller.getAttempts()).toBe(1)
  })
})

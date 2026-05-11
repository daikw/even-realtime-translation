import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

import { HudDisplay, MAIN_TEXT_CONTAINER_ID } from './display.js'

interface MinimalBridge {
  createStartUpPageContainer: ReturnType<typeof vi.fn>
  textContainerUpgrade: ReturnType<typeof vi.fn>
}

function makeBridge(): MinimalBridge {
  return {
    createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
    textContainerUpgrade: vi.fn().mockResolvedValue(true),
  }
}

function asBridge(b: MinimalBridge): EvenAppBridge {
  // The display only touches two methods; cast keeps the test focused.
  return b as unknown as EvenAppBridge
}

describe('HudDisplay.setupPage', () => {
  it('calls createStartUpPageContainer exactly once', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge))

    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
    const arg = bridge.createStartUpPageContainer.mock.calls[0]?.[0] as unknown
    expect(arg).toBeInstanceOf(CreateStartUpPageContainer)
  })

  it('marks the text container with isEventCapture=1 so input events arrive', async () => {
    // Without this flag the firmware / simulator silently drop CLICK and swipe
    // input — regression guard for the M2 smoke fix.
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge))

    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    const arg = bridge.createStartUpPageContainer.mock.calls[0]?.[0] as {
      textObject?: Array<{ isEventCapture?: number }>
    }
    expect(arg.textObject?.[0]?.isEventCapture).toBe(1)
  })

  it('is idempotent: calling setupPage twice still creates only once', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge))

    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
  })

  it('throws when the SDK reports a non-success result', async () => {
    const bridge = makeBridge()
    bridge.createStartUpPageContainer.mockResolvedValueOnce(StartUpPageCreateResult.outOfMemory)
    const display = new HudDisplay(asBridge(bridge))

    await expect(display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })).rejects.toThrow(
      /outOfMemory|3/,
    )
  })
})

describe('HudDisplay.upgradeText (throttled)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires immediately on first call (leading edge) and only once per window', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    void display.upgradeText('hello')
    // Allow microtask + leading invocation to settle.
    await Promise.resolve()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    const first = bridge.textContainerUpgrade.mock.calls[0]?.[0] as unknown
    expect(first).toBeInstanceOf(TextContainerUpgrade)
    expect((first as TextContainerUpgrade).content).toBe('hello')

    // Within the same window, no extra calls.
    void display.upgradeText('he')
    void display.upgradeText('hel')
    void display.upgradeText('hell')
    await vi.advanceTimersByTimeAsync(50)
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
  })

  it('flushes only the latest text on the trailing edge', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    // Burst of 100 synchronous calls.
    for (let i = 0; i < 100; i++) {
      void display.upgradeText(`v${String(i)}`)
    }
    await Promise.resolve()
    // Leading edge fired with the first value.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(
      (bridge.textContainerUpgrade.mock.calls[0]?.[0] as TextContainerUpgrade).content,
    ).toBe('v0')

    await vi.advanceTimersByTimeAsync(150)
    // Trailing edge fires with the LAST queued value.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(2)
    expect(
      (bridge.textContainerUpgrade.mock.calls[1]?.[0] as TextContainerUpgrade).content,
    ).toBe('v99')
  })

  it('uses 150ms as the default throttle interval', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge))
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    void display.upgradeText('a')
    await Promise.resolve()
    void display.upgradeText('b')
    await vi.advanceTimersByTimeAsync(149)
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(2)
  })

  it('clear() upgrades with empty content', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    await display.clear()
    await Promise.resolve()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(
      (bridge.textContainerUpgrade.mock.calls[0]?.[0] as TextContainerUpgrade).content,
    ).toBe('')
  })

  it('dispose() cancels pending trailing edge invocations', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    void display.upgradeText('a')
    await Promise.resolve()
    void display.upgradeText('b') // queued for trailing edge
    display.dispose()
    await vi.advanceTimersByTimeAsync(500)

    // Only the leading-edge call should have fired.
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
  })

  it('upgradeText after dispose() is a no-op', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })
    display.dispose()

    await display.upgradeText('ignored')
    await vi.advanceTimersByTimeAsync(500)

    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })

  it('attaches the configured containerId to TextContainerUpgrade payloads', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })
    await display.setupPage({ containerId: 7 })

    void display.upgradeText('x')
    await Promise.resolve()
    const payload = bridge.textContainerUpgrade.mock.calls[0]?.[0] as TextContainerUpgrade
    expect(payload.containerID).toBe(7)
    expect(payload.content).toBe('x')
    expect(payload.contentOffset).toBe(0)
    expect(payload.contentLength).toBe('x'.length)
  })

  it('upgradeText before setupPage() throws', async () => {
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 150 })

    await expect(display.upgradeText('x')).rejects.toThrow(/setupPage/i)
  })

  it('intervalMs=0 acts as a passthrough: each upgradeText fires the SDK call', async () => {
    // F7: when SubtitleBuffer above us is already throttling, App constructs
    // HudDisplay with intervalMs=0 so we don't compound a 2nd trailing-edge
    // window. With intervalMs=0 the timer expires on the next macro-task,
    // freeing the next upgradeText to leading-edge fire immediately.
    const bridge = makeBridge()
    const display = new HudDisplay(asBridge(bridge), { intervalMs: 0 })
    await display.setupPage({ containerId: MAIN_TEXT_CONTAINER_ID })

    void display.upgradeText('a')
    await Promise.resolve()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(1)
    expect(
      (bridge.textContainerUpgrade.mock.calls[0]?.[0] as TextContainerUpgrade).content,
    ).toBe('a')

    // Advance timers past the 0ms cool-down so the throttle slot is free.
    await vi.advanceTimersByTimeAsync(1)

    void display.upgradeText('b')
    await Promise.resolve()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledTimes(2)
    expect(
      (bridge.textContainerUpgrade.mock.calls[1]?.[0] as TextContainerUpgrade).content,
    ).toBe('b')
  })
})

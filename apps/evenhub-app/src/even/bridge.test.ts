import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakeBridge = { id: 'fake-bridge' } as unknown

const waitForEvenAppBridgeMock = vi.fn<() => Promise<unknown>>()

vi.mock('@evenrealities/even_hub_sdk', () => ({
  waitForEvenAppBridge: () => waitForEvenAppBridgeMock(),
}))

import { EvenBridgeInitError, getBridge, initBridge, resetBridgeForTesting } from './bridge.js'

describe('initBridge', () => {
  beforeEach(() => {
    resetBridgeForTesting()
    waitForEvenAppBridgeMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the bridge when waitForEvenAppBridge resolves', async () => {
    waitForEvenAppBridgeMock.mockResolvedValueOnce(fakeBridge)

    const bridge = await initBridge()

    expect(bridge).toBe(fakeBridge)
    expect(waitForEvenAppBridgeMock).toHaveBeenCalledTimes(1)
  })

  it('returns the same instance on subsequent calls (idempotent)', async () => {
    waitForEvenAppBridgeMock.mockResolvedValueOnce(fakeBridge)

    const first = await initBridge()
    const second = await initBridge()

    expect(second).toBe(first)
    // Initializer must not be invoked twice.
    expect(waitForEvenAppBridgeMock).toHaveBeenCalledTimes(1)
  })

  it('exposes the resolved bridge via getBridge()', async () => {
    expect(getBridge()).toBeNull()
    waitForEvenAppBridgeMock.mockResolvedValueOnce(fakeBridge)

    await initBridge()

    expect(getBridge()).toBe(fakeBridge)
  })

  it('rejects with EvenBridgeInitError when the SDK never resolves before timeout', async () => {
    vi.useFakeTimers()
    // Pending forever.
    waitForEvenAppBridgeMock.mockImplementationOnce(() => new Promise<never>(() => {}))

    const promise = initBridge({ timeoutMs: 1000 })
    const expectation = expect(promise).rejects.toBeInstanceOf(EvenBridgeInitError)

    await vi.advanceTimersByTimeAsync(1000)
    await expectation
  })

  it('default timeout is 5000ms', async () => {
    vi.useFakeTimers()
    waitForEvenAppBridgeMock.mockImplementationOnce(() => new Promise<never>(() => {}))

    const promise = initBridge()

    await vi.advanceTimersByTimeAsync(4999)
    // Sanity: still pending.
    let settled = false
    void promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(promise).rejects.toBeInstanceOf(EvenBridgeInitError)
  })

  it('wraps SDK rejections in EvenBridgeInitError', async () => {
    waitForEvenAppBridgeMock.mockRejectedValueOnce(new Error('handshake failed'))

    await expect(initBridge()).rejects.toBeInstanceOf(EvenBridgeInitError)
  })

  it('allows re-initialization after resetBridgeForTesting()', async () => {
    waitForEvenAppBridgeMock.mockResolvedValueOnce(fakeBridge)
    await initBridge()

    resetBridgeForTesting()
    expect(getBridge()).toBeNull()

    const second = { id: 'bridge-2' } as unknown
    waitForEvenAppBridgeMock.mockResolvedValueOnce(second)
    const result = await initBridge()
    expect(result).toBe(second)
  })
})

describe('EvenBridgeInitError', () => {
  it('distinguishes timeout from failure via reason', () => {
    const t = new EvenBridgeInitError('timeout', 'bridge ready timeout')
    const f = new EvenBridgeInitError('failure', 'bridge handshake failed')

    expect(t.reason).toBe('timeout')
    expect(f.reason).toBe('failure')
    expect(t).toBeInstanceOf(Error)
    expect(t.name).toBe('EvenBridgeInitError')
  })
})

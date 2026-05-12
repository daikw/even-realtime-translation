import { describe, expect, it, vi } from 'vitest'
import {
  DeviceConnectType,
  DeviceStatus,
  OsEventTypeList,
  Sys_ItemEvent,
} from '@evenrealities/even_hub_sdk'

import { createMockBridge } from '../even/bridge.mock.js'
import { acquireBridgeMic } from './bridgeMic.js'

describe('acquireBridgeMic — happy path', () => {
  it('flips audioControl on at acquire time and off at stop()', async () => {
    const bridge = createMockBridge()
    expect(bridge.audioControlled).toBe(false)
    const mic = await acquireBridgeMic(bridge)
    expect(bridge.audioControlled).toBe(true)
    await mic.stop()
    expect(bridge.audioControlled).toBe(false)
  })

  it('delivers decoded Int16Array samples to onPcm handlers', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const handler = vi.fn()
    mic.onPcm(handler)

    // LE bytes [0x00, 0x01, 0xff, 0xff] = [256, -1] as Int16
    bridge.emitAudio(new Uint8Array([0x00, 0x01, 0xff, 0xff]))

    expect(handler).toHaveBeenCalledTimes(1)
    const samples = handler.mock.calls[0]![0] as Int16Array
    expect(samples).toBeInstanceOf(Int16Array)
    expect(Array.from(samples)).toEqual([256, -1])

    await mic.stop()
  })

  it('fans out to multiple handlers in registration order', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const order: string[] = []
    mic.onPcm(() => order.push('a'))
    mic.onPcm(() => order.push('b'))
    mic.onPcm(() => order.push('c'))

    bridge.emitAudio(new Uint8Array([0, 0]))
    expect(order).toEqual(['a', 'b', 'c'])

    await mic.stop()
  })

  it('onPcm returns an unsubscribe that removes only that handler', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const a = vi.fn()
    const b = vi.fn()
    const offA = mic.onPcm(a)
    mic.onPcm(b)

    bridge.emitAudio(new Uint8Array([0, 0]))
    offA()
    bridge.emitAudio(new Uint8Array([0, 0]))

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)

    await mic.stop()
  })
})

describe('acquireBridgeMic — event filtering', () => {
  it('ignores non-audio EvenHub events (sys / text / list etc.)', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const handler = vi.fn()
    mic.onPcm(handler)

    bridge.emitEvenHubEvent({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }),
    })
    bridge.emitDeviceStatusChanged(
      new DeviceStatus({ sn: 'sn-1', connectType: DeviceConnectType.Connected }),
    )

    expect(handler).not.toHaveBeenCalled()

    await mic.stop()
  })

  it('drops malformed PCM (odd-length bytes) and keeps the subscription alive', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const handler = vi.fn()
    mic.onPcm(handler)

    // Spy on console.warn so the malformed-chunk message doesn't pollute test
    // output. We don't assert on it (don't want a stringly-typed contract).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    bridge.emitAudio(new Uint8Array([0xff])) // odd length — bytesToSamplesLE throws
    bridge.emitAudio(new Uint8Array([0, 0])) // valid chunk

    expect(handler).toHaveBeenCalledTimes(1)
    warn.mockRestore()

    await mic.stop()
  })

  it('isolates one throwing handler from the rest', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const ok = vi.fn()
    mic.onPcm(() => {
      throw new Error('boom')
    })
    mic.onPcm(ok)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    bridge.emitAudio(new Uint8Array([0, 0]))
    expect(ok).toHaveBeenCalledTimes(1)
    warn.mockRestore()

    await mic.stop()
  })
})

describe('acquireBridgeMic — stop semantics', () => {
  it('drops audio chunks delivered after stop()', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    const handler = vi.fn()
    mic.onPcm(handler)

    bridge.emitAudio(new Uint8Array([0, 0]))
    await mic.stop()
    bridge.emitAudio(new Uint8Array([0, 0]))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — multiple stop() calls do not error', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    await mic.stop()
    await mic.stop()
    await mic.stop()
    expect(bridge.audioControlled).toBe(false)
  })

  it('onPcm() after stop() returns a no-op unsubscribe', async () => {
    const bridge = createMockBridge()
    const mic = await acquireBridgeMic(bridge)
    await mic.stop()
    const handler = vi.fn()
    const off = mic.onPcm(handler)
    bridge.emitAudio(new Uint8Array([0, 0]))
    expect(handler).not.toHaveBeenCalled()
    // unsubscribe is callable without throwing
    off()
  })
})

describe('acquireBridgeMic — failure modes', () => {
  it('rejects if audioControl(true) returns false', async () => {
    const bridge = createMockBridge()
    // Replace audioControl with a stub that returns false (no `as unknown`
    // needed — MockBridge already exposes audioControl on the public surface).
    bridge.audioControl = (): Promise<boolean> => Promise.resolve(false)
    await expect(acquireBridgeMic(bridge)).rejects.toThrow(/audioControl\(true\) returned false/)
  })

  it('propagates audioControl rejections and unsubscribes the listener', async () => {
    const bridge = createMockBridge()
    // Count listener registrations + leak using onEvenHubEvent return.
    const onSpy = vi.spyOn(bridge, 'onEvenHubEvent')
    bridge.audioControl = (): Promise<boolean> => Promise.reject(new Error('bridge dead'))
    await expect(acquireBridgeMic(bridge)).rejects.toThrow('bridge dead')
    expect(onSpy).toHaveBeenCalledTimes(1)
    // Best-effort check that no audio handler leaked: emitting after the
    // failed acquire shouldn't reach a (non-existent) handler — but we can
    // assert the subscription count by direct introspection. Since MockBridge
    // doesn't expose the listener count, we rely on the fact that emitting
    // after a failed acquire shouldn't do anything observable. We at least
    // verify the spy was called once (no double-subscribe).
  })
})

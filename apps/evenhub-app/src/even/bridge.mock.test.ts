import { describe, expect, it, vi } from 'vitest'
import {
  DeviceConnectType,
  DeviceStatus,
  OsEventTypeList,
  Sys_ItemEvent,
} from '@evenrealities/even_hub_sdk'

import { createMockBridge } from './bridge.mock.js'
import { subscribeInput } from './input.js'
import { subscribeLifecycle } from './lifecycle.js'
import { EvenStorage } from './storage.js'

describe('createMockBridge', () => {
  it('lets subscribeInput observe synthetic events end-to-end', () => {
    const bridge = createMockBridge()
    const handler = vi.fn()
    subscribeInput(bridge, handler)

    bridge.emitEvenHubEvent({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }),
    })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('routes launch source / device status / hub sysEvent into subscribeLifecycle', () => {
    const bridge = createMockBridge()
    const handler = vi.fn()
    subscribeLifecycle(bridge, handler)

    bridge.emitLaunchSource('appMenu')
    bridge.emitDeviceStatusChanged(
      new DeviceStatus({ sn: 'sn-1', connectType: DeviceConnectType.Connected }),
    )
    bridge.emitEvenHubEvent({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
    })

    expect(handler).toHaveBeenCalledTimes(3)
  })

  it('persists key/values for EvenStorage', async () => {
    const bridge = createMockBridge()
    const storage = new EvenStorage(bridge, 'test.')

    await storage.setString('k', 'v')
    expect(await storage.getString('k')).toBe('v')
    expect(bridge.storage.get('test.k')).toBe('v')
  })

  it('removes listeners after their unsubscribe is called', () => {
    const bridge = createMockBridge()
    const handler = vi.fn()
    const off = subscribeInput(bridge, handler)
    off()

    bridge.emitEvenHubEvent({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }),
    })

    expect(handler).not.toHaveBeenCalled()
  })

  describe('audioControl + emitAudio (Phase 2 T0.2)', () => {
    it('defaults to audioControlled=false', () => {
      const bridge = createMockBridge()
      expect(bridge.audioControlled).toBe(false)
    })

    it('audioControl(true) flips the state and audioControl(false) flips it back', async () => {
      const bridge = createMockBridge()
      await bridge.audioControl(true)
      expect(bridge.audioControlled).toBe(true)
      await bridge.audioControl(false)
      expect(bridge.audioControlled).toBe(false)
    })

    it('emitAudio is dropped while audioControl is off', () => {
      const bridge = createMockBridge()
      const handler = vi.fn()
      bridge.onEvenHubEvent(handler)
      bridge.emitAudio(new Uint8Array([1, 2, 3, 4]))
      expect(handler).not.toHaveBeenCalled()
    })

    it('emitAudio fans out audioEvent.audioPcm once audioControl is on', async () => {
      const bridge = createMockBridge()
      const handler = vi.fn()
      bridge.onEvenHubEvent(handler)
      await bridge.audioControl(true)
      const chunk = new Uint8Array([0x00, 0x01, 0xff, 0xff])
      bridge.emitAudio(chunk)
      expect(handler).toHaveBeenCalledTimes(1)
      const event = handler.mock.calls[0]![0] as { audioEvent?: { audioPcm: Uint8Array } }
      expect(event.audioEvent?.audioPcm).toEqual(chunk)
    })

    it('emitAudio post-stop (audioControl(false)) is silently dropped', async () => {
      const bridge = createMockBridge()
      const handler = vi.fn()
      bridge.onEvenHubEvent(handler)
      await bridge.audioControl(true)
      bridge.emitAudio(new Uint8Array([1, 2]))
      await bridge.audioControl(false)
      bridge.emitAudio(new Uint8Array([3, 4]))
      expect(handler).toHaveBeenCalledTimes(1)
    })
  })
})

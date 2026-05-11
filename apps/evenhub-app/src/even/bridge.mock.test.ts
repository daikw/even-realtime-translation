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
})

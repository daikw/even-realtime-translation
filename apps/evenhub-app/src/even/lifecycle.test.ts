import { describe, expect, it, vi } from 'vitest'
import {
  DeviceConnectType,
  DeviceStatus,
  OsEventTypeList,
  Sys_ItemEvent,
  type EvenAppBridge,
  type EvenHubEvent,
  type LaunchSource,
} from '@evenrealities/even_hub_sdk'

import { subscribeLifecycle, type AppLifecycleEvent } from './lifecycle.js'

interface MinimalBridge {
  onLaunchSource: ReturnType<typeof vi.fn>
  onDeviceStatusChanged: ReturnType<typeof vi.fn>
  onEvenHubEvent: ReturnType<typeof vi.fn>
}

function makeBridge(): {
  bridge: MinimalBridge
  emitLaunch: (source: LaunchSource) => void
  emitDevice: (status: DeviceStatus) => void
  emitHub: (event: EvenHubEvent) => void
  unsubscribeLaunch: ReturnType<typeof vi.fn>
  unsubscribeDevice: ReturnType<typeof vi.fn>
  unsubscribeHub: ReturnType<typeof vi.fn>
} {
  let launchCb: ((s: LaunchSource) => void) | null = null
  let deviceCb: ((s: DeviceStatus) => void) | null = null
  let hubCb: ((e: EvenHubEvent) => void) | null = null

  const unsubscribeLaunch = vi.fn(() => {
    launchCb = null
  })
  const unsubscribeDevice = vi.fn(() => {
    deviceCb = null
  })
  const unsubscribeHub = vi.fn(() => {
    hubCb = null
  })

  const onLaunchSource = vi.fn((cb: (s: LaunchSource) => void) => {
    launchCb = cb
    return unsubscribeLaunch
  })
  const onDeviceStatusChanged = vi.fn((cb: (s: DeviceStatus) => void) => {
    deviceCb = cb
    return unsubscribeDevice
  })
  const onEvenHubEvent = vi.fn((cb: (e: EvenHubEvent) => void) => {
    hubCb = cb
    return unsubscribeHub
  })

  return {
    bridge: { onLaunchSource, onDeviceStatusChanged, onEvenHubEvent },
    emitLaunch: (source) => {
      if (launchCb) launchCb(source)
    },
    emitDevice: (status) => {
      if (deviceCb) deviceCb(status)
    },
    emitHub: (event) => {
      if (hubCb) hubCb(event)
    },
    unsubscribeLaunch,
    unsubscribeDevice,
    unsubscribeHub,
  }
}

function asBridge(b: MinimalBridge): EvenAppBridge {
  return b as unknown as EvenAppBridge
}

describe('subscribeLifecycle', () => {
  it('forwards launchSource events as { kind: "launchSource" }', () => {
    const fixture = makeBridge()
    const handler = vi.fn<(e: AppLifecycleEvent) => void>()
    subscribeLifecycle(asBridge(fixture.bridge), handler)

    fixture.emitLaunch('appMenu')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0]).toEqual({ kind: 'launchSource', source: 'appMenu' })
  })

  it('forwards deviceStatusChanged events as { kind: "deviceStatusChanged" }', () => {
    const fixture = makeBridge()
    const handler = vi.fn<(e: AppLifecycleEvent) => void>()
    subscribeLifecycle(asBridge(fixture.bridge), handler)

    const status = new DeviceStatus({
      sn: 'sn-test',
      connectType: DeviceConnectType.Connected,
      batteryLevel: 80,
    })
    fixture.emitDevice(status)

    expect(handler).toHaveBeenCalledTimes(1)
    const event = handler.mock.calls[0]?.[0]
    expect(event?.kind).toBe('deviceStatusChanged')
    if (event?.kind === 'deviceStatusChanged') {
      expect(event.status).toBe(status)
    }
  })

  it('forwards FOREGROUND_ENTER / EXIT / ABNORMAL_EXIT / SYSTEM_EXIT sysEvents (best effort)', () => {
    const fixture = makeBridge()
    const handler = vi.fn<(e: AppLifecycleEvent) => void>()
    subscribeLifecycle(asBridge(fixture.bridge), handler)

    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
    })
    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }),
    })
    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT,
      }),
    })
    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({
        eventType: OsEventTypeList.SYSTEM_EXIT_EVENT,
        systemExitReasonCode: 7,
      }),
    })

    expect(handler).toHaveBeenCalledTimes(4)
    const kinds = handler.mock.calls.map((c) => c[0].kind)
    expect(kinds).toEqual([
      'foregroundEnter',
      'foregroundExit',
      'abnormalExit',
      'systemExit',
    ])
  })

  it('ignores hub events that are not lifecycle-related (e.g. clicks, IMU)', () => {
    const fixture = makeBridge()
    const handler = vi.fn<(e: AppLifecycleEvent) => void>()
    subscribeLifecycle(asBridge(fixture.bridge), handler)

    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.CLICK_EVENT }),
    })
    fixture.emitHub({ audioEvent: { audioPcm: new Uint8Array() } })
    fixture.emitHub({})

    expect(handler).not.toHaveBeenCalled()
  })

  it('returns a single unsubscribe that detaches all underlying listeners', () => {
    const fixture = makeBridge()
    const handler = vi.fn<(e: AppLifecycleEvent) => void>()
    const off = subscribeLifecycle(asBridge(fixture.bridge), handler)

    off()

    expect(fixture.unsubscribeLaunch).toHaveBeenCalledTimes(1)
    expect(fixture.unsubscribeDevice).toHaveBeenCalledTimes(1)
    expect(fixture.unsubscribeHub).toHaveBeenCalledTimes(1)

    fixture.emitLaunch('glassesMenu')
    fixture.emitDevice(DeviceStatus.createDefault('sn'))
    fixture.emitHub({
      sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
    })

    expect(handler).not.toHaveBeenCalled()
  })
})

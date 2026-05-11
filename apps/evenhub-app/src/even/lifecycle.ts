import {
  OsEventTypeList,
  type DeviceStatus,
  type EvenAppBridge,
  type LaunchSource,
  type Sys_ItemEvent,
} from '@evenrealities/even_hub_sdk'

/**
 * Lifecycle events surfaced to app code.
 *
 * Even Hub SDK v0.0.10 directly exposes only `onLaunchSource` and
 * `onDeviceStatusChanged`. Foreground/exit lifecycle is encoded as
 * `OsEventTypeList.FOREGROUND_ENTER_EVENT` etc. inside `onEvenHubEvent`'s
 * `sysEvent`, which we forward here on a best-effort basis.
 *
 * TODO(M3+): once the SDK adds dedicated foreground/abnormal-exit hooks,
 * migrate consumers off the sysEvent path so we don't double-deliver.
 */
export type AppLifecycleEvent =
  | { kind: 'launchSource'; source: LaunchSource }
  | { kind: 'deviceStatusChanged'; status: DeviceStatus }
  | { kind: 'foregroundEnter'; raw: Sys_ItemEvent }
  | { kind: 'foregroundExit'; raw: Sys_ItemEvent }
  | { kind: 'abnormalExit'; raw: Sys_ItemEvent }
  | { kind: 'systemExit'; raw: Sys_ItemEvent }

function mapSysLifecycle(
  sysEvent: Sys_ItemEvent,
): Extract<AppLifecycleEvent, { raw: Sys_ItemEvent }> | null {
  switch (sysEvent.eventType) {
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return { kind: 'foregroundEnter', raw: sysEvent }
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return { kind: 'foregroundExit', raw: sysEvent }
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return { kind: 'abnormalExit', raw: sysEvent }
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      return { kind: 'systemExit', raw: sysEvent }
    default:
      return null
  }
}

/**
 * Subscribe to all lifecycle signals (launch source, device status, foreground
 * transitions). Returns a single unsubscribe that detaches each underlying
 * listener.
 */
export function subscribeLifecycle(
  bridge: EvenAppBridge,
  handler: (event: AppLifecycleEvent) => void,
): () => void {
  const offLaunch = bridge.onLaunchSource((source) => {
    handler({ kind: 'launchSource', source })
  })
  const offDevice = bridge.onDeviceStatusChanged((status) => {
    handler({ kind: 'deviceStatusChanged', status })
  })
  const offHub = bridge.onEvenHubEvent((event) => {
    if (event.sysEvent === undefined) return
    const lifecycle = mapSysLifecycle(event.sysEvent)
    if (lifecycle === null) return
    handler(lifecycle)
  })

  return () => {
    offLaunch()
    offDevice()
    offHub()
  }
}

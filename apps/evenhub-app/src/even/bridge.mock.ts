import {
  StartUpPageCreateResult,
  type DeviceInfo,
  type DeviceStatus,
  type EvenAppBridge,
  type EvenHubEvent,
  type ImageRawDataUpdateResult,
  type LaunchSource,
  type UserInfo,
} from '@evenrealities/even_hub_sdk'

/**
 * In-memory test fake for {@link EvenAppBridge}. Useful for component-level
 * tests that need to exercise multiple even/* layers together without going
 * through `vi.mock`.
 *
 * **NOT for production builds.** The `*.mock.ts` filename keeps this out of
 * Vite's normal entrypoint graph; only test files import it explicitly.
 */
export interface MockBridge extends EvenAppBridge {
  /** Trigger an EvenHub event (sysEvent / textEvent / listEvent / audioEvent). */
  emitEvenHubEvent(event: EvenHubEvent): void
  /** Trigger a launch source signal. */
  emitLaunchSource(source: LaunchSource): void
  /** Trigger a device status change. */
  emitDeviceStatusChanged(status: DeviceStatus): void
  /** Read-only key/value snapshot of stored items (for assertions). */
  readonly storage: ReadonlyMap<string, string>
}

/**
 * Build an isolated mock bridge instance. Each call returns a fresh fake.
 *
 * Notes:
 * - All methods that the SDK declares as Promise-returning are still
 *   Promise-returning here, so `await` works as in production code.
 * - `getInstance()` style is intentionally not modeled; tests should pass the
 *   instance around explicitly.
 */
export function createMockBridge(): MockBridge {
  const storage = new Map<string, string>()
  const hubListeners = new Set<(event: EvenHubEvent) => void>()
  const launchListeners = new Set<(source: LaunchSource) => void>()
  const deviceListeners = new Set<(status: DeviceStatus) => void>()

  const fake = {
    _ready: true,
    get ready() {
      return true
    },

    callEvenApp(): Promise<unknown> {
      return Promise.resolve(null)
    },
    getUserInfo(): Promise<UserInfo> {
      return Promise.reject(new Error('createMockBridge: getUserInfo not implemented'))
    },
    getDeviceInfo(): Promise<DeviceInfo | null> {
      return Promise.resolve(null)
    },

    setLocalStorage(key: string, value: string): Promise<boolean> {
      storage.set(key, value)
      return Promise.resolve(true)
    },
    getLocalStorage(key: string): Promise<string> {
      return Promise.resolve(storage.get(key) ?? '')
    },

    createStartUpPageContainer(): Promise<StartUpPageCreateResult> {
      return Promise.resolve(StartUpPageCreateResult.success)
    },
    rebuildPageContainer(): Promise<boolean> {
      return Promise.resolve(true)
    },
    updateImageRawData(): Promise<ImageRawDataUpdateResult> {
      return Promise.reject(new Error('createMockBridge: updateImageRawData not implemented'))
    },
    textContainerUpgrade(): Promise<boolean> {
      return Promise.resolve(true)
    },
    audioControl(): Promise<boolean> {
      return Promise.resolve(true)
    },
    imuControl(): Promise<boolean> {
      return Promise.resolve(true)
    },
    shutDownPageContainer(): Promise<boolean> {
      return Promise.resolve(true)
    },

    onLaunchSource(callback: (source: LaunchSource) => void): () => void {
      launchListeners.add(callback)
      return () => {
        launchListeners.delete(callback)
      }
    },
    onDeviceStatusChanged(callback: (status: DeviceStatus) => void): () => void {
      deviceListeners.add(callback)
      return () => {
        deviceListeners.delete(callback)
      }
    },
    onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
      hubListeners.add(callback)
      return () => {
        hubListeners.delete(callback)
      }
    },
  }

  const mock = fake as unknown as MockBridge
  Object.defineProperty(mock, 'storage', {
    get: () => storage as ReadonlyMap<string, string>,
    enumerable: true,
  })
  ;(mock as unknown as { emitEvenHubEvent: (e: EvenHubEvent) => void }).emitEvenHubEvent = (
    event,
  ) => {
    for (const cb of hubListeners) cb(event)
  }
  ;(mock as unknown as { emitLaunchSource: (s: LaunchSource) => void }).emitLaunchSource = (
    source,
  ) => {
    for (const cb of launchListeners) cb(source)
  }
  ;(
    mock as unknown as { emitDeviceStatusChanged: (s: DeviceStatus) => void }
  ).emitDeviceStatusChanged = (status) => {
    for (const cb of deviceListeners) cb(status)
  }

  return mock
}

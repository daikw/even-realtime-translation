// Barrel re-exports for the Even Hub SDK wrapper layer.
//
// Production code should import from this entry point:
//   import { initBridge, HudDisplay, subscribeInput, ... } from '@/even'
// Tests can additionally pull `bridge.mock` directly when they need a fake.

export {
  EvenBridgeInitError,
  getBridge,
  initBridge,
  resetBridgeForTesting,
  type EvenBridgeInitErrorReason,
  type InitBridgeOptions,
} from './bridge.js'

export {
  HudDisplay,
  MAIN_TEXT_CONTAINER_ID,
  createHudDisplay,
  type HudDisplayOptions,
  type SetupPageOptions,
} from './display.js'

export { subscribeInput, type AppInputEvent, type AppInputEventKind } from './input.js'

export { subscribeLifecycle, type AppLifecycleEvent } from './lifecycle.js'

export { EvenStorage } from './storage.js'

// Barrel re-exports for the realtime translation client layer.
//
// Phase 2 (post-T7b): only the WebSocket transport remains. The legacy
// WebRTC client + SDP exchange were removed after the §6 rollback gate
// confirmed `getUserMedia` is permanently blocked in the iOS WKWebView
// (Issue #7, CONCLUSIVE_INFEASIBLE).
//
// Production code should import from this entry point:
//   import { createWebSocketRuntimeFactory, parseRealtimeEvent, ... } from '@/realtime'

export {
  isInputTranscriptDelta,
  isOutputTranscriptDelta,
  isServerError,
  isSessionCreated,
  isSessionUpdated,
  parseRealtimeEvent,
} from './eventParser.js'

export {
  buildSessionUpdateEvent,
  type OutputLanguageCode,
  type SessionUpdateClientEvent,
} from './language.js'

export { ReconnectController, type ReconnectControllerOptions } from './reconnect.js'

export {
  createWebSocketTranslationClient,
  type WebSocketTranslationClient,
  type WebSocketTranslationOpts,
  type WsConnectionState,
} from './websocketTranslationClient.js'

export {
  BackendError,
  MicPermissionError,
  type TargetLanguageCode,
  type TranslationRuntime,
  type TranslationRuntimeFactory,
  type TranslationRuntimeStartOpts,
} from './runtime.js'

export {
  createWebSocketRuntimeFactory,
  type CreateWebSocketRuntimeFactoryOpts,
} from './runtimeWs.js'

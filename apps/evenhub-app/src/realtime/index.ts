// Barrel re-exports for the OpenAI Realtime translation client layer.
//
// Production code should import from this entry point:
//   import { createWebRtcTranslationClient, parseRealtimeEvent, ... } from '@/realtime'

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

export { exchangeSdp, SdpExchangeError, type ExchangeSdpOptions } from './sdp.js'

export { ReconnectController, type ReconnectControllerOptions } from './reconnect.js'

export {
  createWebRtcTranslationClient,
  type WebRtcTranslationClient,
  type WebRtcTranslationOpts,
} from './webrtcTranslationClient.js'

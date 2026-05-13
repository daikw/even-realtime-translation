/**
 * WebSocket-transport implementation of {@link TranslationRuntime}. Wraps
 * bridgeMic + websocketTranslationClient so the App-side code never has to
 * know which transport is active (docs/phase2-migration-plan.md §3 T5.1).
 *
 * Lifecycle inside `start()`:
 *   1. `acquireBridgeMic(bridge)` — opens the G2 mic. Failures surface as
 *      `MicPermissionError` so App treats this the same as the legacy
 *      WebRTC `MicPermissionDeniedError`.
 *   2. `createWebSocketTranslationClient(...)` — opens the WS proxy to the
 *      backend.
 *   3. `client.start()` — sends `{type:'open', targetLanguage}` upstream;
 *      resolves once the relay has reported `connected`.
 *
 * Reconnect lives inside `websocketTranslationClient` (exponential backoff
 * via `ReconnectController`). The runtime maps its internal
 * `WsConnectionState` to the shared `ConnectionStatus` enum so the App
 * state machine sees a transport-agnostic surface.
 *
 * Stop semantics: `stop()` releases the mic and sends `{type:'close'}`
 * downstream — the relay then forwards `session.close` and holds the
 * 6 s grace period (T0.1 §10.3).
 */

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { acquireBridgeMic, type BridgeMicHandle } from '../audio/bridgeMic.js'
import {
  MicPermissionError,
  type TargetLanguageCode,
  type TranslationRuntime,
  type TranslationRuntimeFactory,
  type TranslationRuntimeStartOpts,
} from './runtime.js'
import {
  createWebSocketTranslationClient,
  type WebSocketTranslationClient,
  type WsConnectionState,
} from './websocketTranslationClient.js'

export interface CreateWebSocketRuntimeFactoryOpts {
  bridge: EvenAppBridge
  /** Resolved backend WS URL — absolute (`wss://host/...`) or path-relative
   * (`/api/realtime/ws`). Path-relative is resolved against the page origin
   * before being passed to the WebSocket constructor. */
  backendWsUrl: string
  /** Inject for tests; production uses the real `acquireBridgeMic`. */
  acquireMic?: (bridge: EvenAppBridge) => Promise<BridgeMicHandle>
  /** Inject the underlying WS client factory for tests. */
  createClient?: typeof createWebSocketTranslationClient
}

export function createWebSocketRuntimeFactory(
  opts: CreateWebSocketRuntimeFactoryOpts,
): TranslationRuntimeFactory {
  return {
    create(): TranslationRuntime {
      return new WebSocketRuntime(opts)
    },
  }
}

function resolveAbsoluteUrl(path: string): string {
  if (path.startsWith('ws://') || path.startsWith('wss://')) return path
  if (typeof location === 'undefined') {
    // Test environments (vitest jsdom) usually have `location`. Falling back
    // to `ws://localhost` keeps the unit-test path predictable.
    return `ws://localhost${path}`
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

function mapWsState(state: WsConnectionState): import('@even-rt/shared').ConnectionStatus {
  // The WS client emits its own enum; the App speaks the shared
  // ConnectionStatus. `disconnected` is not a state the WS client reaches
  // (its onclose path goes straight to reconnecting or failed) so we don't
  // need a mapping for it here.
  switch (state) {
    case 'idle':
      return 'idle'
    case 'connecting':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting'
    case 'failed':
      return 'failed'
  }
}

class WebSocketRuntime implements TranslationRuntime {
  private readonly opts: CreateWebSocketRuntimeFactoryOpts
  private micHandle: BridgeMicHandle | null = null
  private client: WebSocketTranslationClient | null = null
  private stopped = false
  private startPromise: Promise<void> | null = null

  constructor(opts: CreateWebSocketRuntimeFactoryOpts) {
    this.opts = opts
  }

  start(opts: TranslationRuntimeStartOpts): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.stopped) {
      return Promise.reject(new Error('WebSocketRuntime: already stopped'))
    }
    const p = this.openSession(opts).finally(() => {
      this.startPromise = null
    })
    this.startPromise = p
    return p
  }

  private async openSession(opts: TranslationRuntimeStartOpts): Promise<void> {
    const acquireMic = this.opts.acquireMic ?? acquireBridgeMic
    let mic: BridgeMicHandle
    try {
      mic = await acquireMic(this.opts.bridge)
    } catch (err) {
      // Any audioControl failure maps to a permission-style error so the App
      // can hoist it into `permission_required`. The bridge does not
      // distinguish "user denied" from "device busy", so we treat them
      // uniformly.
      throw new MicPermissionError('bridge audio acquisition failed', err)
    }
    this.micHandle = mic
    if (this.stopped) {
      await mic.stop()
      this.micHandle = null
      throw new Error('WebSocketRuntime: stopped during mic acquisition')
    }

    const createClient = this.opts.createClient ?? createWebSocketTranslationClient
    const client = createClient({
      backendUrl: resolveAbsoluteUrl(this.opts.backendWsUrl),
      targetLanguage: opts.targetLanguage,
      micHandle: mic,
      onOutputTranscriptDelta: opts.onOutputTranscriptDelta,
      onStateChange: (state) => {
        opts.onStateChange(mapWsState(state))
      },
      // Same conditional-spread pattern used elsewhere (exactOptionalPropertyTypes).
      ...(opts.onInputTranscriptDelta !== undefined
        ? { onInputTranscriptDelta: opts.onInputTranscriptDelta }
        : {}),
      ...(opts.onAudioDelta !== undefined ? { onAudioDelta: opts.onAudioDelta } : {}),
      ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
    })
    this.client = client

    try {
      await client.start()
    } catch (err) {
      // Clean up the mic + client on failed start so a retry from the App
      // layer doesn't double-subscribe to the bridge.
      await mic.stop().catch(() => undefined)
      this.micHandle = null
      this.client = null
      throw err instanceof Error ? err : new Error('ws client start failed')
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const client = this.client
    const mic = this.micHandle
    this.client = null
    this.micHandle = null
    if (client !== null) {
      try {
        await client.stop()
      } catch {
        /* swallow — best-effort teardown */
      }
    }
    if (mic !== null) {
      try {
        await mic.stop()
      } catch {
        /* swallow */
      }
    }
  }

  sendLanguageUpdate(target: TargetLanguageCode): void {
    this.client?.sendLanguageUpdate(target)
  }
}

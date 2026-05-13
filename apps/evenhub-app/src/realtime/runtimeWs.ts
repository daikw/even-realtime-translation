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
  BackendError,
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

function resolveAbsoluteUrl(input: string): string {
  if (input.startsWith('ws://') || input.startsWith('wss://')) return input
  // Use the URL constructor so slash-less inputs (e.g. `api/realtime/ws`)
  // resolve correctly against the page origin instead of being concatenated
  // raw (Codex review L-1).
  const base =
    typeof location === 'undefined' ? 'http://localhost' : location.origin
  const u = new URL(input, base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
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
    default: {
      // Exhaustiveness guard so a future WsConnectionState addition fails
      // compile here instead of silently surfacing as an unmapped enum
      // value (Codex review L-2).
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

/** Parse the WS client's `ws translation error [<code>]: <message>` shape
 * back into a typed BackendError. Returns null when the input doesn't
 * match — the caller then surfaces the raw Error as-is (Codex review H-4). */
function toBackendError(err: Error): BackendError | null {
  const match = err.message.match(/^ws translation error \[([^\]]+)\]: (.+)$/)
  if (match === null) return null
  return new BackendError(match[1]!, match[2]!, err)
}

class WebSocketRuntime implements TranslationRuntime {
  private readonly opts: CreateWebSocketRuntimeFactoryOpts
  private micHandle: BridgeMicHandle | null = null
  private client: WebSocketTranslationClient | null = null
  private stopped = false
  /** True once a `start()` Promise has fully resolved. A second `start()`
   * after success becomes a no-op (Codex review H-3); without this, the
   * caller could spin up a second mic + WS pair and orphan the first. */
  private started = false
  private startPromise: Promise<void> | null = null

  constructor(opts: CreateWebSocketRuntimeFactoryOpts) {
    this.opts = opts
  }

  start(opts: TranslationRuntimeStartOpts): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.stopped) {
      return Promise.reject(new Error('WebSocketRuntime: already stopped'))
    }
    if (this.started) return Promise.resolve()
    const p = this.openSession(opts)
      .then(() => {
        this.started = true
      })
      .finally(() => {
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
      await mic.stop().catch(() => undefined)
      this.micHandle = null
      throw new Error('WebSocketRuntime: stopped during mic acquisition')
    }

    // Client construction + start happen inside a single try block so any
    // failure (constructor throw, start() rejection) detaches *both* the
    // mic and the (possibly partly-open) client. The previous shape only
    // teared down the mic on start() rejection and let a constructor throw
    // leak the mic entirely (Codex review H-1 / H-2).
    const createClient = this.opts.createClient ?? createWebSocketTranslationClient
    let client: WebSocketTranslationClient
    try {
      client = createClient({
        backendUrl: resolveAbsoluteUrl(this.opts.backendWsUrl),
        targetLanguage: opts.targetLanguage,
        micHandle: mic,
        onOutputTranscriptDelta: opts.onOutputTranscriptDelta,
        onStateChange: (state) => {
          opts.onStateChange(mapWsState(state))
        },
        // Wrap onError so backend-side error frames become typed BackendError
        // instances that App.ts can branch on (Codex review H-4). The WS
        // client emits `ws translation error [<code>]: <message>` strings;
        // we parse them back into the typed shape here rather than touching
        // the client's wire format.
        onError: (err: Error) => {
          opts.onError?.(toBackendError(err) ?? err)
        },
        // Same conditional-spread pattern used elsewhere (exactOptionalPropertyTypes).
        ...(opts.onInputTranscriptDelta !== undefined
          ? { onInputTranscriptDelta: opts.onInputTranscriptDelta }
          : {}),
        ...(opts.onAudioDelta !== undefined ? { onAudioDelta: opts.onAudioDelta } : {}),
      })
    } catch (err) {
      await mic.stop().catch(() => undefined)
      this.micHandle = null
      throw err instanceof Error ? err : new Error('ws client construction failed')
    }
    this.client = client

    try {
      await client.start()
      // Re-check the stop signal that could have raced past `openSession`
      // while we awaited the WS handshake.
      if (this.stopped) {
        await client.stop().catch(() => undefined)
        await mic.stop().catch(() => undefined)
        this.client = null
        this.micHandle = null
        throw new Error('WebSocketRuntime: stopped during start')
      }
    } catch (err) {
      await client.stop().catch(() => undefined)
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

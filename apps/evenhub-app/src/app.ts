import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import {
  EvenBridgeInitError,
  HudDisplay,
  initBridge,
  subscribeInput,
  subscribeLifecycle,
} from './even/index.js'
import { createMockBridge } from './even/bridge.mock.js'
import {
  SubtitleBuffer,
  renderForStatus,
  type HudViewModel,
} from './hud/index.js'
import {
  ReconnectController,
  createWebRtcTranslationClient,
  type WebRtcTranslationClient,
} from './realtime/index.js'
import {
  TranslationApiError,
  createTranslationSession,
} from './backend/apiClient.js'
import {
  MicPermissionDeniedError,
  acquirePhoneMic,
  stopMediaStream,
} from './audio/phoneMic.js'
import { attachAudioElement, disposeAudioElement } from './audio/audioPlayer.js'
import type { AppConfig } from './config.js'
import { createStore, type Store } from './state/store.js'
import { appReducer } from './state/reducer.js'
import { INITIAL_STATE, type AppState } from './state/appState.js'
import type { AppAction } from './state/actions.js'
import { handleInputEvent } from './state/inputHandler.js'

const APP_VERSION = '0.1.0'
const DEVICE_ID = 'G2'
const TICK_INTERVAL_MS = 1000

/**
 * Boundary between the pure reducer/store and all the I/O the app needs:
 *
 *  - Even Hub bridge handshake + lifecycle/input subscriptions
 *  - HUD render fan-out from store changes
 *  - Translation session lifecycle (mic acquisition, backend call,
 *    WebRTC client start/stop)
 *  - Periodic tick that drives the elapsed clock
 *
 * The class is intentionally constructor-injected so tests can swap every
 * external dependency (bridge factory, mic acquirer, backend client, RTC
 * client factory) without `vi.mock`. `boot()` does only what `main.ts` would
 * inline; `start()`, `stop()`, `dispose()` are public for ad-hoc test driving.
 */

type BridgeFactory = () => Promise<EvenAppBridge>

type MicAcquirer = () => Promise<MediaStream>

type SessionCreator = (req: {
  backendUrl: string
  request: {
    targetLanguage: 'en' | 'ja' | 'es' | 'fr' | 'ko'
    sourceHint: AppState['languagePair']['source']
    userId: string
    client: { appVersion: string; device: string }
  }
}) => Promise<{ clientSecret: string; expiresAt?: string; model: string }>

type RtcClientFactory = (opts: {
  clientSecret: string
  sourceStream: MediaStream
  onOutputTranscriptDelta: (delta: { text: string }) => void
  onRemoteAudioTrack: (track: MediaStreamTrack) => void
  onStateChange: (state: RTCPeerConnectionState) => void
  onError: (err: Error) => void
  baseUrl?: string
  model?: string
}) => WebRtcTranslationClient

export interface AppDeps {
  bridgeFactory?: BridgeFactory
  mockBridgeFactory?: () => EvenAppBridge
  acquireMic?: MicAcquirer
  createSession?: SessionCreator
  createRtcClient?: RtcClientFactory
  attachAudio?: (track: MediaStreamTrack) => void
  detachAudio?: () => void
  /** Test seam — defaults to `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
  log?: (...args: unknown[]) => void
  /** ReconnectController policy. Defaults: 3 attempts, 500ms base delay. */
  reconnectMaxAttempts?: number
  reconnectBaseDelayMs?: number
}

interface ActiveSession {
  client: WebRtcTranslationClient
  mic: MediaStream
}

export class App {
  readonly store: Store<AppState, AppAction>
  private readonly cfg: AppConfig
  private readonly deps: Required<AppDeps>

  private bridge: EvenAppBridge | null = null
  private display: HudDisplay | null = null
  private subtitleBuffer: SubtitleBuffer | null = null
  private session: ActiveSession | null = null
  private tickHandle: unknown = null
  private renderUnsubscribe: (() => void) | null = null
  private inputUnsubscribe: (() => void) | null = null
  private lifecycleUnsubscribe: (() => void) | null = null
  private startInFlight = false
  private disposed = false
  // Reconnect: per-App lifetime. Created in constructor, reset on every
  // successful CONNECTED, disposed in App.dispose.
  private readonly reconnectController: ReconnectController
  // True while we are in a controller-driven retry attempt; lets startSession
  // throw rather than dispatch ERROR so the controller can schedule the next
  // attempt or surface `reconnect_failed`.
  private inRetryLoop = false

  constructor(cfg: AppConfig, deps: AppDeps = {}) {
    this.cfg = cfg
    this.store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)

    this.deps = {
      bridgeFactory: deps.bridgeFactory ?? (() => initBridge({ timeoutMs: 5000 })),
      mockBridgeFactory: deps.mockBridgeFactory ?? (() => createMockBridge()),
      acquireMic: deps.acquireMic ?? (() => acquirePhoneMic()),
      createSession: deps.createSession ?? createTranslationSession,
      createRtcClient: deps.createRtcClient ?? createWebRtcTranslationClient,
      attachAudio:
        deps.attachAudio ??
        ((track) => {
          attachAudioElement(track)
        }),
      detachAudio:
        deps.detachAudio ??
        (() => {
          disposeAudioElement()
        }),
      setIntervalImpl: deps.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms)),
      clearIntervalImpl:
        deps.clearIntervalImpl ??
        ((handle) => {
          clearInterval(handle as ReturnType<typeof setInterval>)
        }),
      now: deps.now ?? (() => Date.now()),
      log:
        deps.log ??
        ((...args) => {
          if (this.cfg.dev) {
            // Dev-only: never logs transcripts or audio data; only operational
            // signals (status changes, error codes).
            console.log('[evenhub-app]', ...args)
          }
        }),
      reconnectMaxAttempts: deps.reconnectMaxAttempts ?? 3,
      reconnectBaseDelayMs: deps.reconnectBaseDelayMs ?? 500,
    }

    this.reconnectController = new ReconnectController({
      maxAttempts: this.deps.reconnectMaxAttempts,
      baseDelayMs: this.deps.reconnectBaseDelayMs,
    })
  }

  /**
   * Boot sequence (§15.1). Returns when the bridge handshake + HUD container
   * are ready and the store is in `idle`. Throws if the bridge can't be
   * acquired (and mock fallback is disabled).
   */
  async boot(): Promise<void> {
    if (this.disposed) throw new Error('App.boot called after dispose')

    this.bridge = await this.acquireBridge()

    // SubtitleBuffer (below) already throttles at 150ms before we ever call
    // upgradeText, so configuring HudDisplay with another 150ms window would
    // compound to ~300ms worst-case latency (Codex M-3 / F7). Set intervalMs=0
    // to make the SDK call a passthrough; throttle responsibility lives in
    // exactly one place.
    this.display = new HudDisplay(this.bridge, { intervalMs: 0 })
    await this.display.setupPage({ containerId: 1 })

    this.subtitleBuffer = new SubtitleBuffer({
      onRender: (text) => {
        this.store.dispatch({ type: 'SUBTITLE_UPDATED', text })
      },
    })

    this.renderUnsubscribe = this.store.subscribe((state) => {
      this.renderHud(state)
    })

    this.inputUnsubscribe = subscribeInput(this.bridge, (event) => {
      handleInputEvent(event, this.store)
    })

    this.lifecycleUnsubscribe = subscribeLifecycle(this.bridge, (event) => {
      // Phase 1: only respond to abnormal exit. Foreground transitions are
      // logged but don't drive state — the SDK keeps the session alive and
      // the user pauses explicitly.
      if (event.kind === 'abnormalExit' || event.kind === 'systemExit') {
        this.store.dispatch({ type: 'STOP_REQUESTED' })
      }
    })

    // Subscribe to status transitions that need side effects (start/stop).
    this.store.subscribe((state) => {
      void this.onStatusChange(state)
    })

    this.tickHandle = this.deps.setIntervalImpl(() => {
      this.store.dispatch({ type: 'TICK', nowMs: this.deps.now() })
    }, TICK_INTERVAL_MS)

    this.store.dispatch({ type: 'BOOT_COMPLETED' })
  }

  /** Public test hook: drive a state transition then run side effects. */
  dispatch(action: AppAction): void {
    this.store.dispatch(action)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Stop any pending reconnect timer first so an in-flight attempt cannot
    // race with the rest of teardown.
    this.reconnectController.dispose()

    if (this.tickHandle !== null) {
      this.deps.clearIntervalImpl(this.tickHandle)
      this.tickHandle = null
    }

    this.renderUnsubscribe?.()
    this.inputUnsubscribe?.()
    this.lifecycleUnsubscribe?.()

    await this.shutdownSession()

    this.subtitleBuffer?.dispose()
    this.subtitleBuffer = null

    this.display?.dispose()
    this.display = null

    this.deps.detachAudio()

    if (this.bridge !== null) {
      try {
        await this.bridge.shutDownPageContainer(1)
      } catch (err) {
        this.deps.log('shutDownPageContainer failed', err)
      }
      this.bridge = null
    }
  }

  private async acquireBridge(): Promise<EvenAppBridge> {
    try {
      return await this.deps.bridgeFactory()
    } catch (err) {
      if (this.cfg.useMockBridge && err instanceof EvenBridgeInitError) {
        this.deps.log('Falling back to mock bridge:', err.reason)
        return this.deps.mockBridgeFactory()
      }
      throw err
    }
  }

  private renderHud(state: AppState): void {
    if (this.display === null) return
    const vm: HudViewModel = {
      status: state.status,
      languagePair: state.languagePair,
      connection: state.connection,
      elapsedSeconds: state.elapsedSeconds,
      subtitle: state.activeSubtitle,
    }
    const text = renderForStatus(vm)
    void this.display.upgradeText(text)
  }

  private prevStatus: AppState['status'] | null = null

  private async onStatusChange(state: AppState): Promise<void> {
    const prev = this.prevStatus
    if (prev === state.status) return
    this.prevStatus = state.status

    if (prev !== 'connecting' && state.status === 'connecting') {
      // First entry into connecting → kick off the actual session.
      await this.startSession()
      return
    }
    if (state.status === 'exiting') {
      // F8 / Codex M-4: dispose the subtitle buffer FIRST so any pending
      // 150ms-throttled render that would otherwise fire after the
      // 'Closing...' screen is cancelled. Subsequent append/clear calls on
      // the buffer are guaranteed no-ops post-dispose, which prevents an
      // empty subtitle from briefly overwriting the exit screen during
      // teardown microtasks.
      this.subtitleBuffer?.dispose()
      this.subtitleBuffer = null
      // Cancel any pending reconnect timer so we don't race with teardown.
      this.reconnectController.reset()
      await this.shutdownSession()
      this.store.dispatch({ type: 'EXITED' })
    }
  }

  private async startSession(): Promise<void> {
    if (this.startInFlight) return
    this.startInFlight = true
    try {
      const state = this.store.getState()

      let mic: MediaStream
      try {
        mic = await this.deps.acquireMic()
      } catch (err) {
        if (err instanceof MicPermissionDeniedError) {
          this.store.dispatch({ type: 'PERMISSION_DENIED', reason: 'mic' })
          return
        }
        if (this.inRetryLoop) {
          throw err instanceof Error ? err : new Error('mic acquisition failed')
        }
        this.store.dispatch({
          type: 'ERROR',
          code: 'mic_error',
          message: err instanceof Error ? err.message : 'mic acquisition failed',
        })
        return
      }

      // Build the request body separately so we never log it. clientSecret is
      // memory-only — never stored anywhere persistent (§10.1).
      const target = state.languagePair.target
      if (target === 'auto') {
        // Defensive guard: the rotation never lands on `auto`, but TypeScript
        // doesn't know that here.
        if (this.inRetryLoop) {
          stopMediaStream(mic)
          throw new Error('auto cannot be the target language')
        }
        this.store.dispatch({
          type: 'ERROR',
          code: 'invalid_target',
          message: 'auto cannot be the target language',
        })
        stopMediaStream(mic)
        return
      }

      let session: { clientSecret: string; expiresAt?: string; model: string }
      try {
        session = await this.deps.createSession({
          backendUrl: this.cfg.backendUrl,
          request: {
            targetLanguage: target,
            sourceHint: state.languagePair.source,
            userId: 'anonymous',
            client: { appVersion: APP_VERSION, device: DEVICE_ID },
          },
        })
      } catch (err) {
        if (this.inRetryLoop) {
          stopMediaStream(mic)
          throw err instanceof Error ? err : new Error('backend unavailable')
        }
        const code = err instanceof TranslationApiError ? err.code : 'backend_error'
        const message = err instanceof Error ? err.message : 'backend unavailable'
        this.store.dispatch({ type: 'ERROR', code, message })
        stopMediaStream(mic)
        return
      }

      const client = this.deps.createRtcClient({
        clientSecret: session.clientSecret,
        sourceStream: mic,
        onOutputTranscriptDelta: (delta) => {
          this.subtitleBuffer?.append(delta.text)
        },
        onRemoteAudioTrack: (track) => {
          this.deps.attachAudio(track)
        },
        onStateChange: (rtcState) => {
          if (rtcState === 'connected') {
            this.store.dispatch({ type: 'CONNECTED', startedAt: this.deps.now() })
            // Successful (re)connect — clear retry budget so a future drop
            // gets a full exponential-backoff window again.
            this.reconnectController.reset()
          } else if (rtcState === 'failed' || rtcState === 'disconnected') {
            this.store.dispatch({
              type: 'CONNECTION_STATE_CHANGED',
              state: rtcState === 'failed' ? 'failed' : 'disconnected',
            })
            // Only kick off reconnect once we've actually been live; the
            // reducer transitions to `reconnecting` only from live/paused, so
            // use the post-dispatch status as the gate.
            if (this.store.getState().status === 'reconnecting') {
              void this.scheduleReconnect()
            }
          }
        },
        onError: (err) => {
          // Observability-only hook. The single source of truth for transitioning
          // into `status: 'error'` is the App-side catch around `client.start()`
          // (and the dedicated mic / backend / target-language guards above).
          // Reducer ERROR idempotency means even if a legacy build still
          // reports here, the duplicate dispatch is a no-op — but we don't
          // dispatch from this hook to keep the contract single-pathed.
          this.deps.log('RTC error (observed)', err.name, err.message)
        },
        baseUrl: this.cfg.openaiBaseUrl,
        model: this.cfg.modelName,
      })

      this.session = { client, mic }

      try {
        await client.start()
      } catch (err) {
        this.deps.log('client.start failed', err)
        await this.shutdownSession()
        if (this.inRetryLoop) {
          // Let the controller surface the failure and decide whether to
          // schedule another attempt.
          throw err instanceof Error ? err : new Error('rtc start failed')
        }
        // Single source of truth for ERROR transitions out of start failures.
        // The reducer's ERROR idempotency makes it safe even if the underlying
        // orchestrator also reports the same error to the observer.
        const message = err instanceof Error ? err.message : 'rtc start failed'
        this.store.dispatch({ type: 'ERROR', code: 'rtc_error', message })
      }
    } finally {
      this.startInFlight = false
    }
  }

  /**
   * Drive a controller-managed reconnect attempt. Each attempt runs
   * `startSession()` in retry mode (failures throw rather than dispatch ERROR).
   * If the controller exhausts its budget, we surface a dedicated
   * `reconnect_failed` error so the HUD can distinguish loss-of-connection
   * exhaustion from the original drop.
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.disposed) return
    try {
      await this.reconnectController.scheduleNext(async () => {
        if (this.disposed) return
        if (this.store.getState().status !== 'reconnecting') return
        this.inRetryLoop = true
        try {
          await this.startSession()
        } finally {
          this.inRetryLoop = false
        }
      })
      // attempt resolved successfully; if onStateChange('connected') ran, the
      // reducer is already back in `live` and `reset()` cleared attempts.
    } catch (err) {
      if (this.disposed) return
      // Two failure modes:
      //   1. action threw (start/mic/backend rejected) → another retry is
      //      worth scheduling until the controller exhausts itself.
      //   2. controller already at maxAttempts → surface terminal error.
      const message = err instanceof Error ? err.message : 'reconnect failed'
      const exhausted = /max attempts/i.test(message)
      if (exhausted) {
        this.store.dispatch({
          type: 'ERROR',
          code: 'reconnect_failed',
          message: 'reconnect attempts exhausted',
        })
        return
      }
      // Still in budget → keep retrying.
      if (this.store.getState().status === 'reconnecting') {
        void this.scheduleReconnect()
      }
    }
  }

  private async shutdownSession(): Promise<void> {
    const session = this.session
    if (session === null) return
    this.session = null

    try {
      await session.client.stop()
    } catch (err) {
      this.deps.log('client.stop failed', err)
    }
    stopMediaStream(session.mic)
    this.subtitleBuffer?.clear()
    this.deps.detachAudio()
  }
}

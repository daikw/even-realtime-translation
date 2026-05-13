import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { ConnectionStatus } from '@even-rt/shared'

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
  BackendError,
  MicPermissionError,
  createWebSocketRuntimeFactory,
  type TranslationRuntime,
  type TranslationRuntimeFactory,
} from './realtime/index.js'
import type { AppConfig } from './config.js'
import { createStore, type Store } from './state/store.js'
import { appReducer } from './state/reducer.js'
import { INITIAL_STATE, type AppState } from './state/appState.js'
import type { AppAction } from './state/actions.js'
import { handleInputEvent } from './state/inputHandler.js'

const TICK_INTERVAL_MS = 1000

/**
 * Boundary between the pure reducer/store and all the I/O the app needs:
 *
 *  - Even Hub bridge handshake + lifecycle/input subscriptions
 *  - HUD render fan-out from store changes
 *  - Translation session lifecycle (delegated to a `TranslationRuntime`
 *    obtained from {@link AppDeps.translationRuntimeFactory})
 *  - Periodic tick that drives the elapsed clock
 *
 * Phase 2 migration (docs/phase2-migration-plan.md §3 T5.2): the per-piece
 * seams (`acquireMic`, `createSession`, `createRtcClient`, `attachAudio`,
 * `detachAudio`, `reconnectController`) were collapsed behind the
 * `TranslationRuntime` abstraction. Mic acquisition, transport, and
 * reconnect now live inside the runtime; App only wires callbacks into
 * the reducer and watches state transitions.
 *
 * The class is constructor-injected so tests can swap every external
 * dependency (bridge factory, runtime factory) without `vi.mock`.
 * `boot()` does only what `main.ts` would inline; `start()`, `stop()`,
 * `dispose()` are public for ad-hoc test driving.
 */

type BridgeFactory = () => Promise<EvenAppBridge>

export interface AppDeps {
  bridgeFactory?: BridgeFactory
  mockBridgeFactory?: () => EvenAppBridge
  /**
   * Factory for the per-session translation runtime. Defaults to
   * `createWebSocketRuntimeFactory({ bridge, backendWsUrl })` constructed
   * inside {@link App.boot} using the resolved {@link AppConfig.realtimeWsUrl}.
   *
   * Tests inject a fake factory whose runtimes expose hooks to fire
   * `onStateChange` / `onError` synchronously.
   */
  translationRuntimeFactory?: TranslationRuntimeFactory
  /** Test seam — defaults to `setInterval`. */
  setIntervalImpl?: (fn: () => void, ms: number) => unknown
  clearIntervalImpl?: (handle: unknown) => void
  /** Test seam — defaults to `Date.now`. */
  now?: () => number
  log?: (...args: unknown[]) => void
}

export class App {
  readonly store: Store<AppState, AppAction>
  private readonly cfg: AppConfig
  private readonly deps: Required<Omit<AppDeps, 'translationRuntimeFactory'>> & {
    translationRuntimeFactory: TranslationRuntimeFactory | null
  }

  private bridge: EvenAppBridge | null = null
  private display: HudDisplay | null = null
  private subtitleBuffer: SubtitleBuffer | null = null
  private runtime: TranslationRuntime | null = null
  private runtimeFactory: TranslationRuntimeFactory | null = null
  private tickHandle: unknown = null
  private renderUnsubscribe: (() => void) | null = null
  private inputUnsubscribe: (() => void) | null = null
  private lifecycleUnsubscribe: (() => void) | null = null
  private startInFlight = false
  private disposed = false

  constructor(cfg: AppConfig, deps: AppDeps = {}) {
    this.cfg = cfg
    this.store = createStore<AppState, AppAction>(appReducer, INITIAL_STATE)

    this.deps = {
      bridgeFactory: deps.bridgeFactory ?? (() => initBridge({ timeoutMs: 5000 })),
      mockBridgeFactory: deps.mockBridgeFactory ?? (() => createMockBridge()),
      translationRuntimeFactory: deps.translationRuntimeFactory ?? null,
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
    }
  }

  /**
   * Boot sequence (§15.1). Returns when the bridge handshake + HUD container
   * are ready and the store is in `idle`. Throws if the bridge can't be
   * acquired (and mock fallback is disabled).
   */
  async boot(): Promise<void> {
    if (this.disposed) throw new Error('App.boot called after dispose')

    this.bridge = await this.acquireBridge()

    // Resolve the runtime factory. Test injections take precedence; otherwise
    // construct the default WS factory once we have a bridge in hand.
    this.runtimeFactory =
      this.deps.translationRuntimeFactory ??
      createWebSocketRuntimeFactory({
        bridge: this.bridge,
        backendWsUrl: this.cfg.realtimeWsUrl,
      })

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
    // In mock mode we skip the real bridge entirely. The SDK auto-initialises
    // `window.EvenAppBridge` in browsers, which would make `waitForEvenAppBridge`
    // resolve even when no Flutter host is attached — and host calls would then
    // fail with opaque errors like "createStartUpPageContainer failed: invalid".
    if (this.cfg.useMockBridge) {
      this.deps.log('Using mock bridge (PUBLIC_USE_MOCK_BRIDGE=true)')
      return this.deps.mockBridgeFactory()
    }
    try {
      return await this.deps.bridgeFactory()
    } catch (err) {
      if (err instanceof EvenBridgeInitError) {
        this.deps.log('Bridge init failed:', err.reason)
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
      await this.shutdownSession()
      this.store.dispatch({ type: 'EXITED' })
    }
  }

  private async startSession(): Promise<void> {
    if (this.startInFlight) return
    this.startInFlight = true
    try {
      const state = this.store.getState()
      const target = state.languagePair.target
      if (target === 'auto') {
        // Defensive guard: the rotation never lands on `auto`, but TypeScript
        // doesn't know that here.
        this.store.dispatch({
          type: 'ERROR',
          code: 'invalid_target',
          message: 'auto cannot be the target language',
        })
        return
      }

      const factory = this.runtimeFactory
      if (factory === null) {
        this.store.dispatch({
          type: 'ERROR',
          code: 'not_ready',
          message: 'translation runtime not initialised',
        })
        return
      }

      // factory.create() AND runtime.start() are both wrapped in the same
      // try/catch so a synchronously-throwing factory cannot escape to the
      // void onStatusChange caller — that would surface as an unhandled
      // rejection without a dispatch.
      try {
        const runtime = factory.create()
        this.runtime = runtime
        await runtime.start({
          targetLanguage: target,
          sourceHint: state.languagePair.source,
          onOutputTranscriptDelta: (delta) => {
            this.subtitleBuffer?.append(delta.text)
          },
          onStateChange: (connState) => {
            this.handleConnectionState(connState)
          },
          onError: (err) => {
            this.handleRuntimeError(err)
          },
        })
      } catch (err) {
        // Either factory.create() threw or runtime.start() rejected. Tear
        // the runtime reference down (if any) and translate the error to a
        // reducer dispatch. Specific error subtypes route to dedicated
        // states; everything else lands on `ERROR { rtc_error }` for
        // backwards compatibility with the legacy code path.
        this.runtime = null
        if (err instanceof MicPermissionError) {
          this.store.dispatch({ type: 'PERMISSION_DENIED', reason: 'mic' })
          return
        }
        if (err instanceof BackendError) {
          this.store.dispatch({ type: 'ERROR', code: err.code, message: err.message })
          return
        }
        const message = err instanceof Error ? err.message : 'runtime start failed'
        this.store.dispatch({ type: 'ERROR', code: 'rtc_error', message })
      }
    } finally {
      this.startInFlight = false
    }
  }

  /**
   * Translate the runtime's transport-agnostic state into reducer actions.
   * The runtime emits `connected` when (re)connection succeeds — App treats
   * the first such event as `CONNECTED` so the reducer drives `connecting`
   * → `live`; later `connected` events similarly flip out of `reconnecting`.
   * `reconnecting` and `failed` are forwarded so the HUD layer can render
   * the right banner.
   */
  private handleConnectionState(state: ConnectionStatus): void {
    if (state === 'connected') {
      this.store.dispatch({ type: 'CONNECTED', startedAt: this.deps.now() })
      return
    }
    if (state === 'reconnecting') {
      this.store.dispatch({ type: 'CONNECTION_STATE_CHANGED', state: 'reconnecting' })
      return
    }
    if (state === 'failed') {
      // The reconnect controller inside the runtime has exhausted its budget.
      // Surface the same code the legacy code path used so downstream
      // observability + HUD copy don't have to branch on transport.
      this.store.dispatch({
        type: 'ERROR',
        code: 'reconnect_failed',
        message: 'reconnect attempts exhausted',
      })
    }
  }

  /**
   * Observability hook for runtime errors emitted *after* `start()` resolves.
   * Backend errors carry a code; we route them through `ERROR` so the HUD
   * surfaces the rate-limit / auth-error / upstream-error messaging. Generic
   * errors stay log-only — the reducer's single source of truth for
   * status='error' is the `startSession` catch + the typed branches here.
   */
  private handleRuntimeError(err: Error): void {
    if (err instanceof BackendError) {
      this.store.dispatch({ type: 'ERROR', code: err.code, message: err.message })
      return
    }
    this.deps.log('Runtime error (observed)', err.name, err.message)
  }

  private async shutdownSession(): Promise<void> {
    const runtime = this.runtime
    if (runtime === null) return
    this.runtime = null

    try {
      await runtime.stop()
    } catch (err) {
      this.deps.log('runtime.stop failed', err)
    }
    this.subtitleBuffer?.clear()
  }
}

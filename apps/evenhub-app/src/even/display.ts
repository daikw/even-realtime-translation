import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

/**
 * Default container id for the single-text HUD layout.
 *
 * §6.4 of the design doc only requires one text container in the M0-M2 PoC,
 * but apps that need finer layout can pass a different id via
 * {@link HudDisplay.setupPage}.
 */
export const MAIN_TEXT_CONTAINER_ID = 1

const DEFAULT_INTERVAL_MS = 150

export interface HudDisplayOptions {
  /**
   * Throttle window for `textContainerUpgrade` calls.
   *
   * Design doc §6.5 recommends 100~250ms; default mirrors §15.3 (150ms).
   */
  intervalMs?: number
}

export interface SetupPageOptions {
  containerId: number
}

/**
 * Throttle helper:
 * - Leading edge fires immediately on first call.
 * - Subsequent calls inside the window are coalesced; only the LATEST argument
 *   wins on the trailing edge.
 * - Returned function returns `void` because callers don't await the
 *   underlying SDK call here (the throttle is fire-and-forget per §6.5).
 */
function createThrottle<T>(intervalMs: number, fn: (val: T) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  let disposed = false

  const fire = (value: T): void => {
    void fn(value)
  }

  const handle = (value: T): void => {
    if (disposed) return

    if (timer === null) {
      // Leading edge: fire immediately, then open a cool-down window.
      fire(value)
      timer = setTimeout(() => {
        timer = null
        if (pending !== null) {
          const next = pending.value
          pending = null
          // Recurse so the trailing-edge value also opens its own window;
          // protects against a 3rd burst landing right at boundary.
          handle(next)
        }
      }, intervalMs)
    } else {
      // Inside cool-down: keep only the latest value.
      pending = { value }
    }
  }

  const dispose = (): void => {
    disposed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  return { handle, dispose }
}

export class HudDisplay {
  private readonly bridge: EvenAppBridge
  private readonly throttle: ReturnType<typeof createThrottle<string>>

  private containerId: number | null = null
  private setupPromise: Promise<void> | null = null
  private disposed = false

  constructor(bridge: EvenAppBridge, options: HudDisplayOptions = {}) {
    this.bridge = bridge
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.throttle = createThrottle<string>(intervalMs, (text) => this.flush(text))
  }

  /**
   * Create the start-up page container. Idempotent: subsequent calls reuse the
   * first invocation's promise.
   */
  setupPage(opts: SetupPageOptions): Promise<void> {
    if (this.setupPromise !== null) return this.setupPromise

    this.containerId = opts.containerId
    this.setupPromise = (async () => {
      const text = new TextContainerProperty({
        containerID: opts.containerId,
        // §6.4 layout: one full-width subtitle container. Concrete pixel
        // values are placeholders to be tuned with the device; the SDK call
        // already exercises the wire format we care about for M0-M2.
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        content: '',
      })
      const container = new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [text],
      })

      const result = await this.bridge.createStartUpPageContainer(container)
      // SDK normalizes both numeric and named results; treat anything other
      // than `success` (0) as a setup failure so callers can surface it.
      if (result !== StartUpPageCreateResult.success) {
        throw new Error(
          `createStartUpPageContainer failed: ${StartUpPageCreateResult[result] ?? String(result)}`,
        )
      }
    })()

    return this.setupPromise
  }

  /**
   * Queue a HUD text update. The SDK call is throttled to avoid flicker (§6.5).
   * Returns a Promise that resolves once the value has been queued (not when
   * the SDK call completes), so callers can `await` without serializing.
   */
  upgradeText(text: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.containerId === null) {
      return Promise.reject(new Error('HudDisplay.upgradeText called before setupPage()'))
    }
    this.throttle.handle(text)
    return Promise.resolve()
  }

  /** Convenience helper: blank the HUD. */
  clear(): Promise<void> {
    return this.upgradeText('')
  }

  /** Cancel pending trailing-edge invocations. Subsequent calls become no-ops. */
  dispose(): void {
    this.disposed = true
    this.throttle.dispose()
  }

  private async flush(text: string): Promise<void> {
    if (this.disposed) return
    if (this.containerId === null) return

    const upgrade = new TextContainerUpgrade({
      containerID: this.containerId,
      content: text,
      contentOffset: 0,
      contentLength: text.length,
    })
    await this.bridge.textContainerUpgrade(upgrade)
  }
}

/** Factory variant for callers that prefer functional style. */
export function createHudDisplay(bridge: EvenAppBridge, options?: HudDisplayOptions): HudDisplay {
  return new HudDisplay(bridge, options)
}

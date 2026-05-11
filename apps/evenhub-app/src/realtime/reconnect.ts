/**
 * Sequenced reconnect controller with exponential backoff.
 *
 * Attempts are 1-indexed. The k-th attempt (k>=1) is scheduled with a delay of
 * `baseDelayMs * 2^(k-2)` for k>=2 — i.e. attempt 1 fires immediately, attempt
 * 2 after `baseDelayMs`, attempt 3 after `2*baseDelayMs`, attempt 4 after
 * `4*baseDelayMs`, and so on. With the default `baseDelayMs=500` this gives
 * the sequence 0, 500, 1000, 2000, ... which matches design doc §15.2 / §6.3.
 *
 * The controller is intentionally minimal:
 * - It only owns timing and bookkeeping; the action passed to
 *   `scheduleNext` is the actual reconnect logic.
 * - Errors thrown by the action propagate; the controller does not silently
 *   swallow failures. Callers decide whether to call `scheduleNext` again.
 * - `dispose()` cancels any pending timer and makes future `scheduleNext`
 *   calls reject deterministically.
 */

export interface ReconnectControllerOptions {
  maxAttempts?: number
  baseDelayMs?: number
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 500

export class ReconnectController {
  private readonly maxAttempts: number
  private readonly baseDelayMs: number

  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private disposed = false

  constructor(options: ReconnectControllerOptions = {}) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    if (maxAttempts <= 0) {
      throw new Error(`ReconnectController: maxAttempts must be > 0, got ${String(maxAttempts)}`)
    }
    if (baseDelayMs < 0) {
      throw new Error(
        `ReconnectController: baseDelayMs must be >= 0, got ${String(baseDelayMs)}`,
      )
    }
    this.maxAttempts = maxAttempts
    this.baseDelayMs = baseDelayMs
  }

  /**
   * Schedule the next reconnect attempt. Resolves once `action` resolves,
   * rejects if `action` throws, the controller is disposed, or `maxAttempts`
   * has already been reached.
   */
  scheduleNext(action: () => Promise<void>): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('ReconnectController: disposed'))
    }
    if (this.attempts >= this.maxAttempts) {
      return Promise.reject(
        new Error(
          `ReconnectController: max attempts reached (${String(this.maxAttempts)})`,
        ),
      )
    }

    // attempt index that this call will represent once it fires
    const nextAttempt = this.attempts + 1
    // attempt 1 -> 0ms ; attempt k>=2 -> baseDelay * 2^(k-2)
    const delay = nextAttempt === 1 ? 0 : this.baseDelayMs * 2 ** (nextAttempt - 2)

    return new Promise<void>((resolve, reject) => {
      this.pendingReject = reject
      this.timer = setTimeout(() => {
        this.timer = null
        this.pendingReject = null
        this.attempts = nextAttempt
        action().then(resolve, reject)
      }, delay)
    })
  }

  reset(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingReject !== null) {
      const reject = this.pendingReject
      this.pendingReject = null
      reject(new Error('ReconnectController: reset'))
    }
    this.attempts = 0
  }

  getAttempts(): number {
    return this.attempts
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingReject !== null) {
      const reject = this.pendingReject
      this.pendingReject = null
      reject(new Error('ReconnectController: disposed'))
    }
  }
}

import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

/** Distinguishes a wait-timeout from an SDK-level failure. */
export type EvenBridgeInitErrorReason = 'timeout' | 'failure'

export class EvenBridgeInitError extends Error {
  readonly reason: EvenBridgeInitErrorReason

  constructor(reason: EvenBridgeInitErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EvenBridgeInitError'
    this.reason = reason
  }
}

const DEFAULT_TIMEOUT_MS = 5000

let cachedBridge: EvenAppBridge | null = null
// Guards against parallel callers triggering multiple SDK handshakes.
let pending: Promise<EvenAppBridge> | null = null

export interface InitBridgeOptions {
  timeoutMs?: number
}

/**
 * Wait for the Even App bridge to become ready, with a timeout.
 *
 * Idempotent: a successful call caches the bridge instance and subsequent
 * invocations resolve to the cached value without re-running the SDK
 * handshake. Use {@link resetBridgeForTesting} to clear the cache in tests.
 */
export async function initBridge(opts: InitBridgeOptions = {}): Promise<EvenAppBridge> {
  if (cachedBridge !== null) return cachedBridge
  if (pending !== null) return pending

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const handshake = (async (): Promise<EvenAppBridge> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const bridge = await new Promise<EvenAppBridge>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new EvenBridgeInitError(
              'timeout',
              `Even bridge did not become ready within ${String(timeoutMs)}ms`,
            ),
          )
        }, timeoutMs)

        waitForEvenAppBridge().then(
          (b) => {
            resolve(b)
          },
          (err: unknown) => {
            reject(
              new EvenBridgeInitError('failure', 'waitForEvenAppBridge rejected', { cause: err }),
            )
          },
        )
      })
      cachedBridge = bridge
      return bridge
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      pending = null
    }
  })()

  pending = handshake
  return handshake
}

/** Returns the cached bridge instance, or `null` before {@link initBridge} resolves. */
export function getBridge(): EvenAppBridge | null {
  return cachedBridge
}

/** Test-only escape hatch to reset module-level state between cases. */
export function resetBridgeForTesting(): void {
  cachedBridge = null
  pending = null
}

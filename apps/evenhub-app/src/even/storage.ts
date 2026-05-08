import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const DEFAULT_PREFIX = 'g2t.'

/**
 * Thin wrapper over `bridge.setLocalStorage` / `getLocalStorage` adding:
 * - key prefixing to namespace this app's data
 * - JSON helpers with fallback on parse failure / missing key
 *
 * The SDK returns the empty string (`''`) for unknown keys, so we treat empty
 * results as "not found" and fall back to the caller-provided default.
 */
export class EvenStorage {
  private readonly bridge: EvenAppBridge
  private readonly prefix: string

  constructor(bridge: EvenAppBridge, prefix: string = DEFAULT_PREFIX) {
    this.bridge = bridge
    this.prefix = prefix
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`
  }

  async getString(key: string, fallback: string = ''): Promise<string> {
    const raw = await this.bridge.getLocalStorage(this.fullKey(key))
    return raw === '' ? fallback : raw
  }

  async setString(key: string, value: string): Promise<boolean> {
    return this.bridge.setLocalStorage(this.fullKey(key), value)
  }

  async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.bridge.getLocalStorage(this.fullKey(key))
    if (raw === '') return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  async setJson<T>(key: string, value: T): Promise<boolean> {
    return this.bridge.setLocalStorage(this.fullKey(key), JSON.stringify(value))
  }
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

import { EvenStorage } from './storage.js'

interface MinimalBridge {
  setLocalStorage: ReturnType<typeof vi.fn<(key: string, value: string) => Promise<boolean>>>
  getLocalStorage: ReturnType<typeof vi.fn<(key: string) => Promise<string>>>
}

function makeBridge(): MinimalBridge {
  const store = new Map<string, string>()
  return {
    setLocalStorage: vi.fn(async (key: string, value: string): Promise<boolean> => {
      store.set(key, value)
      return Promise.resolve(true)
    }),
    getLocalStorage: vi.fn(async (key: string): Promise<string> => {
      return Promise.resolve(store.get(key) ?? '')
    }),
  }
}

function asBridge(b: MinimalBridge): EvenAppBridge {
  return b as unknown as EvenAppBridge
}

describe('EvenStorage', () => {
  let bridge: MinimalBridge
  let storage: EvenStorage

  beforeEach(() => {
    bridge = makeBridge()
    storage = new EvenStorage(asBridge(bridge))
  })

  describe('JSON helpers', () => {
    it('round-trips a typed value through setJson / getJson', async () => {
      interface Pref {
        lang: string
        volume: number
      }
      const value: Pref = { lang: 'ja', volume: 42 }

      await storage.setJson('pref', value)
      const restored = await storage.getJson<Pref>('pref', { lang: 'en', volume: 0 })

      expect(restored).toEqual(value)
    })

    it('returns the fallback when the key has never been written', async () => {
      const fallback = { hello: 'world' }
      const result = await storage.getJson('missing', fallback)
      expect(result).toBe(fallback)
    })

    it('returns the fallback when stored content is not valid JSON', async () => {
      // Pre-populate with invalid JSON to simulate a corrupt write.
      await bridge.setLocalStorage('g2t.broken', 'not-json{')
      const fallback = { ok: true }
      const result = await storage.getJson('broken', fallback)
      expect(result).toBe(fallback)
    })

    it('treats an empty string from the bridge as "not found"', async () => {
      // Default mock returns '' for unknown keys; ensure we don't try to
      // JSON.parse '' which would throw.
      const fallback = { default: true }
      const result = await storage.getJson('never-set', fallback)
      expect(result).toBe(fallback)
    })

    it('setJson returns the SDK boolean unchanged', async () => {
      bridge.setLocalStorage.mockResolvedValueOnce(false)
      const ok = await storage.setJson('x', { a: 1 })
      expect(ok).toBe(false)
    })
  })

  describe('string helpers', () => {
    it('round-trips through setString / getString', async () => {
      await storage.setString('greeting', 'hello')
      expect(await storage.getString('greeting')).toBe('hello')
    })

    it('returns "" by default when the key is missing', async () => {
      expect(await storage.getString('missing')).toBe('')
    })

    it('returns the provided fallback when the key is missing', async () => {
      expect(await storage.getString('missing', 'alt')).toBe('alt')
    })
  })

  describe('prefix', () => {
    it('prepends the default "g2t." prefix to all keys', async () => {
      await storage.setString('foo', 'bar')
      expect(bridge.setLocalStorage).toHaveBeenCalledWith('g2t.foo', 'bar')

      await storage.getString('foo')
      expect(bridge.getLocalStorage).toHaveBeenLastCalledWith('g2t.foo')
    })

    it('honors a custom prefix', async () => {
      const custom = new EvenStorage(asBridge(bridge), 'app.')
      await custom.setString('k', 'v')
      expect(bridge.setLocalStorage).toHaveBeenCalledWith('app.k', 'v')
    })

    it('treats prefix="" as no-prefix', async () => {
      const noPrefix = new EvenStorage(asBridge(bridge), '')
      await noPrefix.setString('k', 'v')
      expect(bridge.setLocalStorage).toHaveBeenCalledWith('k', 'v')
    })
  })
})

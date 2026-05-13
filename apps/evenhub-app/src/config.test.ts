import { describe, expect, it } from 'vitest'

import { loadAppConfig } from './config.js'

describe('loadAppConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadAppConfig({} as ImportMetaEnv)
    expect(cfg.useMockBridge).toBe(false)
    expect(cfg.dev).toBe(false)
    expect(cfg.realtimeWsUrl).toBe('/api/realtime/ws')
  })

  it('treats PUBLIC_USE_MOCK_BRIDGE="true" as enabling the mock bridge', () => {
    const cfg = loadAppConfig({
      PUBLIC_USE_MOCK_BRIDGE: 'true',
    } as unknown as ImportMetaEnv)
    expect(cfg.useMockBridge).toBe(true)
  })

  it('only "true" enables the mock bridge — falsy strings stay false', () => {
    for (const v of ['false', '0', '', 'no']) {
      const cfg = loadAppConfig({
        PUBLIC_USE_MOCK_BRIDGE: v,
      } as unknown as ImportMetaEnv)
      expect(cfg.useMockBridge).toBe(false)
    }
  })

  it('reflects vite DEV flag', () => {
    const cfg = loadAppConfig({ DEV: true } as unknown as ImportMetaEnv)
    expect(cfg.dev).toBe(true)
  })

  it('ignores unrelated keys', () => {
    const cfg = loadAppConfig({
      SOMETHING_ELSE: 'x',
    } as unknown as ImportMetaEnv)
    expect(cfg.realtimeWsUrl).toBe('/api/realtime/ws')
  })

  it('reads PUBLIC_REALTIME_WS_URL when set', () => {
    const cfg = loadAppConfig({
      PUBLIC_REALTIME_WS_URL: 'wss://example.com/realtime',
    } as unknown as ImportMetaEnv)
    expect(cfg.realtimeWsUrl).toBe('wss://example.com/realtime')
  })

  it('falls back to /api/realtime/ws when PUBLIC_REALTIME_WS_URL is empty', () => {
    const cfg = loadAppConfig({
      PUBLIC_REALTIME_WS_URL: '',
    } as unknown as ImportMetaEnv)
    expect(cfg.realtimeWsUrl).toBe('/api/realtime/ws')
  })
})

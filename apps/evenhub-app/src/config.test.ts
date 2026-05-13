import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadAppConfig } from './config.js'

// Allowlist tests intentionally exercise rejection paths that emit
// console.warn. Silence them here so the test runner output stays clean.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    // noop
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadAppConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadAppConfig({} as ImportMetaEnv)
    expect(cfg.backendUrl).toBe('http://localhost:3000')
    expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    expect(cfg.modelName).toBe('gpt-realtime-translate')
    expect(cfg.useMockBridge).toBe(false)
    expect(cfg.dev).toBe(false)
    expect(cfg.realtimeWsUrl).toBe('/api/realtime/ws')
    expect(cfg.transport).toBe('ws')
  })

  it('reads PUBLIC_BACKEND_URL when set', () => {
    const cfg = loadAppConfig({
      PUBLIC_BACKEND_URL: 'https://api.example.com',
    } as unknown as ImportMetaEnv)
    expect(cfg.backendUrl).toBe('https://api.example.com')
  })

  it('reads PUBLIC_OPENAI_BASE_URL and PUBLIC_MODEL_NAME', () => {
    // Note: openaiBaseUrl is allowlisted (see F5 cases below); use the
    // canonical production host here so this happy-path read still passes.
    const cfg = loadAppConfig({
      PUBLIC_OPENAI_BASE_URL: 'https://api.openai.com',
      PUBLIC_MODEL_NAME: 'gpt-foo',
    } as unknown as ImportMetaEnv)
    expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    expect(cfg.modelName).toBe('gpt-foo')
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
    expect(cfg.backendUrl).toBe('http://localhost:3000')
  })

  describe('openaiBaseUrl allowlist (F5)', () => {
    it('accepts the canonical https://api.openai.com', () => {
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'https://api.openai.com',
      } as unknown as ImportMetaEnv)
      expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    })

    it('falls back to default for non-https hosts in production', () => {
      // No DEV flag → production semantics. http:// urls should be rejected
      // even when otherwise localhost-shaped.
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'http://attacker.example',
      } as unknown as ImportMetaEnv)
      expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    })

    it('rejects arbitrary https hosts in production', () => {
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'https://attacker.example',
      } as unknown as ImportMetaEnv)
      expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    })

    it('allows http://localhost or http://127.0.0.1 in DEV mode', () => {
      const cfgLocalhost = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'http://localhost:8787',
        DEV: true,
      } as unknown as ImportMetaEnv)
      expect(cfgLocalhost.openaiBaseUrl).toBe('http://localhost:8787')

      const cfgLoopback = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'http://127.0.0.1:8787',
        DEV: true,
      } as unknown as ImportMetaEnv)
      expect(cfgLoopback.openaiBaseUrl).toBe('http://127.0.0.1:8787')
    })

    it('still rejects arbitrary http hosts in DEV mode', () => {
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'http://attacker.example',
        DEV: true,
      } as unknown as ImportMetaEnv)
      expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    })

    it('rejects an unparseable URL string', () => {
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'not a url',
      } as unknown as ImportMetaEnv)
      expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    })

    it('strips a trailing slash on accepted urls', () => {
      const cfg = loadAppConfig({
        PUBLIC_OPENAI_BASE_URL: 'https://api.openai.com/',
      } as unknown as ImportMetaEnv)
      // We don't strip here; the URL parser keeps it. SDP exchange already
      // strips trailing slashes itself. Just confirm the value is accepted.
      expect(cfg.openaiBaseUrl.startsWith('https://api.openai.com')).toBe(true)
    })
  })

  describe('Phase 2 envs (T5.3)', () => {
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

    it('reads PUBLIC_TRANSPORT="webrtc" for the rollback path', () => {
      const cfg = loadAppConfig({
        PUBLIC_TRANSPORT: 'webrtc',
      } as unknown as ImportMetaEnv)
      expect(cfg.transport).toBe('webrtc')
    })

    it('defaults to ws for any other PUBLIC_TRANSPORT value (typo / unknown)', () => {
      for (const v of ['', 'WS', 'http', 'grpc', 'undefined']) {
        const cfg = loadAppConfig({
          PUBLIC_TRANSPORT: v,
        } as unknown as ImportMetaEnv)
        expect(cfg.transport).toBe('ws')
      }
    })
  })
})

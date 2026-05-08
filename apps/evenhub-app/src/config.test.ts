import { describe, expect, it } from 'vitest'

import { loadAppConfig } from './config.js'

describe('loadAppConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadAppConfig({} as ImportMetaEnv)
    expect(cfg.backendUrl).toBe('http://localhost:3000')
    expect(cfg.openaiBaseUrl).toBe('https://api.openai.com')
    expect(cfg.modelName).toBe('gpt-realtime-translate')
    expect(cfg.useMockBridge).toBe(false)
    expect(cfg.dev).toBe(false)
  })

  it('reads PUBLIC_BACKEND_URL when set', () => {
    const cfg = loadAppConfig({
      PUBLIC_BACKEND_URL: 'https://api.example.com',
    } as unknown as ImportMetaEnv)
    expect(cfg.backendUrl).toBe('https://api.example.com')
  })

  it('reads PUBLIC_OPENAI_BASE_URL and PUBLIC_MODEL_NAME', () => {
    const cfg = loadAppConfig({
      PUBLIC_OPENAI_BASE_URL: 'https://oai.proxy.example',
      PUBLIC_MODEL_NAME: 'gpt-foo',
    } as unknown as ImportMetaEnv)
    expect(cfg.openaiBaseUrl).toBe('https://oai.proxy.example')
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
})

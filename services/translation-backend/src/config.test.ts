import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  const baseEnv = {
    OPENAI_API_KEY: 'sk-test',
    SAFETY_ID_SALT: 'salt',
  }

  it('returns parsed config with required env vars set', () => {
    const cfg = loadConfig({ ...baseEnv })
    expect(cfg.openaiApiKey).toBe('sk-test')
    expect(cfg.safetyIdSalt).toBe('salt')
    expect(cfg.port).toBe(3000)
    expect(cfg.allowedOrigins).toEqual(['http://localhost:5173'])
  })

  it('throws when OPENAI_API_KEY is missing', () => {
    expect(() => loadConfig({ SAFETY_ID_SALT: 'salt' })).toThrow(/OPENAI_API_KEY/)
  })

  it('throws when OPENAI_API_KEY is empty string', () => {
    expect(() => loadConfig({ OPENAI_API_KEY: '', SAFETY_ID_SALT: 'salt' })).toThrow(
      /OPENAI_API_KEY/,
    )
  })

  it('throws when SAFETY_ID_SALT is missing', () => {
    expect(() => loadConfig({ OPENAI_API_KEY: 'sk-test' })).toThrow(/SAFETY_ID_SALT/)
  })

  it('parses BACKEND_PORT when given', () => {
    const cfg = loadConfig({ ...baseEnv, BACKEND_PORT: '4000' })
    expect(cfg.port).toBe(4000)
  })

  it('throws when BACKEND_PORT is not a number', () => {
    expect(() => loadConfig({ ...baseEnv, BACKEND_PORT: 'not-a-number' })).toThrow(
      /BACKEND_PORT/,
    )
  })

  it('throws when BACKEND_PORT is out of range', () => {
    expect(() => loadConfig({ ...baseEnv, BACKEND_PORT: '70000' })).toThrow(/BACKEND_PORT/)
    expect(() => loadConfig({ ...baseEnv, BACKEND_PORT: '0' })).toThrow(/BACKEND_PORT/)
  })

  it('parses ALLOWED_ORIGINS as comma-separated list and trims whitespace', () => {
    const cfg = loadConfig({
      ...baseEnv,
      ALLOWED_ORIGINS: 'http://localhost:5173, https://example.com',
    })
    expect(cfg.allowedOrigins).toEqual(['http://localhost:5173', 'https://example.com'])
  })

  it('drops empty entries from ALLOWED_ORIGINS', () => {
    const cfg = loadConfig({
      ...baseEnv,
      ALLOWED_ORIGINS: 'http://localhost:5173,,',
    })
    expect(cfg.allowedOrigins).toEqual(['http://localhost:5173'])
  })
})

/**
 * Backend runtime configuration sourced from environment variables.
 *
 * `loadConfig()` is intentionally pure (env passed explicitly) so it is unit
 * testable without mutating `process.env`. The CLI entry in `index.ts` calls
 * `dotenv.config()` first and then passes `process.env`.
 */
export interface Config {
  port: number
  openaiApiKey: string
  safetyIdSalt: string
  allowedOrigins: string[]
}

const DEFAULT_PORT = 3000
const DEFAULT_ALLOWED_ORIGIN = 'http://localhost:5173'

function readRequiredString(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key]
  if (raw === undefined || raw === '') {
    throw new Error(`${key} is required`)
  }
  return raw
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.BACKEND_PORT
  if (raw === undefined || raw === '') return DEFAULT_PORT
  const parsed = Number.parseInt(raw, 10)
  // Reject non-integers, negative, zero, and out-of-range TCP ports.
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535 || String(parsed) !== raw) {
    throw new Error(`BACKEND_PORT must be an integer between 1 and 65535, got "${raw}"`)
  }
  return parsed
}

function readAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const raw = env.ALLOWED_ORIGINS
  if (raw === undefined || raw === '') return [DEFAULT_ALLOWED_ORIGIN]
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    openaiApiKey: readRequiredString(env, 'OPENAI_API_KEY'),
    safetyIdSalt: readRequiredString(env, 'SAFETY_ID_SALT'),
    port: readPort(env),
    allowedOrigins: readAllowedOrigins(env),
  }
}

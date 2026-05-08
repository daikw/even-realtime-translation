/**
 * Runtime config loaded from Vite-injected `import.meta.env`.
 *
 * Vars are bucketed into:
 *  - **Backend URL** (`PUBLIC_BACKEND_URL`) — where the WebView fetches its
 *    short-lived client secret. Default targets the local Fastify dev server.
 *  - **OpenAI base URL** (`PUBLIC_OPENAI_BASE_URL`) — endpoint the WebRTC
 *    SDP exchange targets. Overridable for proxying / staging environments.
 *  - **Model name** (`PUBLIC_MODEL_NAME`) — translation model id.
 *  - **Mock bridge flag** (`PUBLIC_USE_MOCK_BRIDGE`) — when set to `"true"`,
 *    `boot()` skips the Even Hub SDK handshake and uses an in-memory mock so
 *    `pnpm dev` works in a normal browser without the Even host wrapper.
 *
 * Only `PUBLIC_*` env vars are exposed to the client by `vite.config.ts`'s
 * `envPrefix`, so we don't accidentally leak server-side secrets here.
 */
export interface AppConfig {
  backendUrl: string
  openaiBaseUrl: string
  modelName: string
  useMockBridge: boolean
  dev: boolean
}

const DEFAULT_BACKEND_URL = 'http://localhost:3000'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL_NAME = 'gpt-realtime-translate'

interface MaybeEnv {
  PUBLIC_BACKEND_URL?: string
  PUBLIC_OPENAI_BASE_URL?: string
  PUBLIC_MODEL_NAME?: string
  PUBLIC_USE_MOCK_BRIDGE?: string
  DEV?: boolean
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // Skip empty strings — `import.meta.env` may carry `''` for unset vars in
  // some setups, and we want defaults to win in that case.
  return value.length === 0 ? fallback : value
}

export function loadAppConfig(env: ImportMetaEnv = import.meta.env): AppConfig {
  const e = env as unknown as MaybeEnv
  return {
    backendUrl: readString(e.PUBLIC_BACKEND_URL, DEFAULT_BACKEND_URL),
    openaiBaseUrl: readString(e.PUBLIC_OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL),
    modelName: readString(e.PUBLIC_MODEL_NAME, DEFAULT_MODEL_NAME),
    useMockBridge: e.PUBLIC_USE_MOCK_BRIDGE === 'true',
    dev: e.DEV === true,
  }
}

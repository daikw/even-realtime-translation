/**
 * Runtime config loaded from Vite-injected `import.meta.env`.
 *
 * Vars:
 *  - **Mock bridge flag** (`PUBLIC_USE_MOCK_BRIDGE`) — when set to `"true"`,
 *    `boot()` skips the Even Hub SDK handshake and uses an in-memory mock so
 *    `pnpm dev` works in a normal browser without the Even host wrapper.
 *  - **Realtime WS URL** (`PUBLIC_REALTIME_WS_URL`) — Phase 2 backend WS
 *    relay path. Default `/api/realtime/ws` resolves same-origin via the
 *    Vite proxy.
 *
 * Phase 2 (post-T7b) drops the legacy `PUBLIC_BACKEND_URL` /
 * `PUBLIC_OPENAI_BASE_URL` / `PUBLIC_MODEL_NAME` / `PUBLIC_TRANSPORT`
 * envs — the WebRTC client_secret path that consumed them was removed
 * after the §6 rollback gate confirmed `getUserMedia` is permanently
 * blocked in the iOS WKWebView (Issue #7).
 *
 * Only `PUBLIC_*` env vars are exposed to the client by `vite.config.ts`'s
 * `envPrefix`, so we don't accidentally leak server-side secrets here.
 */
export interface AppConfig {
  useMockBridge: boolean
  dev: boolean
  realtimeWsUrl: string
}

const DEFAULT_REALTIME_WS_URL = '/api/realtime/ws'

interface MaybeEnv {
  PUBLIC_USE_MOCK_BRIDGE?: string
  PUBLIC_REALTIME_WS_URL?: string
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
    useMockBridge: e.PUBLIC_USE_MOCK_BRIDGE === 'true',
    dev: e.DEV === true,
    realtimeWsUrl: readString(e.PUBLIC_REALTIME_WS_URL, DEFAULT_REALTIME_WS_URL),
  }
}

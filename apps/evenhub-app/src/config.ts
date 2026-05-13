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
 *  - **Realtime WS URL** (`PUBLIC_REALTIME_WS_URL`) — Phase 2 backend WS
 *    relay path. Default `/api/realtime/ws` resolves same-origin via the
 *    Vite proxy (see docs/phase2-migration-plan.md §3 T5.3).
 *  - **Transport** (`PUBLIC_TRANSPORT`) — Phase 2 transport selector
 *    (`'ws'` | `'webrtc'`). Default `'ws'`. Set to `'webrtc'` to roll back
 *    to the legacy `getUserMedia` + `RTCPeerConnection` path while it still
 *    exists (deprecated, see §6).
 *
 * Only `PUBLIC_*` env vars are exposed to the client by `vite.config.ts`'s
 * `envPrefix`, so we don't accidentally leak server-side secrets here.
 */
export type TransportKind = 'ws' | 'webrtc'

export interface AppConfig {
  backendUrl: string
  openaiBaseUrl: string
  modelName: string
  useMockBridge: boolean
  dev: boolean
  realtimeWsUrl: string
  transport: TransportKind
}

const DEFAULT_BACKEND_URL = 'http://localhost:3000'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL_NAME = 'gpt-realtime-translate'
const DEFAULT_REALTIME_WS_URL = '/api/realtime/ws'
const DEFAULT_TRANSPORT: TransportKind = 'ws'

interface MaybeEnv {
  PUBLIC_BACKEND_URL?: string
  PUBLIC_OPENAI_BASE_URL?: string
  PUBLIC_MODEL_NAME?: string
  PUBLIC_USE_MOCK_BRIDGE?: string
  PUBLIC_REALTIME_WS_URL?: string
  PUBLIC_TRANSPORT?: string
  DEV?: boolean
}

function readString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  // Skip empty strings — `import.meta.env` may carry `''` for unset vars in
  // some setups, and we want defaults to win in that case.
  return value.length === 0 ? fallback : value
}

/**
 * Allowlist for the OpenAI base URL (F5 / Sec M-3).
 *
 * `PUBLIC_OPENAI_BASE_URL` is build-time injected by Vite and consumed by
 * {@link import('./realtime/sdp.js').exchangeSdp} when POSTing the SDP offer
 * along with the short-lived client secret. A poisoned env var (build-time
 * injection, supply-chain attack) could otherwise redirect the offer + secret
 * to an attacker-controlled host.
 *
 * Policy:
 * - Production (`DEV !== true`): only `https://api.openai.com` is accepted.
 * - Development (`DEV === true`): `http://localhost*` and `http://127.0.0.1*`
 *   are also accepted to allow local proxies / staging.
 * - Anything else falls back to the canonical default with a console.warn.
 */
function validateOpenaiBaseUrl(raw: string, dev: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    console.warn(
      '[config] PUBLIC_OPENAI_BASE_URL is not a valid URL; falling back to',
      DEFAULT_OPENAI_BASE_URL,
    )
    return DEFAULT_OPENAI_BASE_URL
  }

  // Canonical production target.
  if (parsed.protocol === 'https:' && parsed.host === 'api.openai.com') {
    return raw
  }

  if (dev) {
    // Allow loopback proxies during local dev only.
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return raw
    }
  }

  console.warn(
    '[config] PUBLIC_OPENAI_BASE_URL host not in allowlist; falling back to',
    DEFAULT_OPENAI_BASE_URL,
  )
  return DEFAULT_OPENAI_BASE_URL
}

function readTransport(value: unknown): TransportKind {
  if (value === 'webrtc') return 'webrtc'
  if (value === 'ws') return 'ws'
  // Anything else (unset, typo) defaults to the Phase 2 path. Rolling back
  // to WebRTC must be an explicit env opt-in.
  return DEFAULT_TRANSPORT
}

export function loadAppConfig(env: ImportMetaEnv = import.meta.env): AppConfig {
  const e = env as unknown as MaybeEnv
  const dev = e.DEV === true
  const rawOpenaiBaseUrl = readString(e.PUBLIC_OPENAI_BASE_URL, DEFAULT_OPENAI_BASE_URL)
  return {
    backendUrl: readString(e.PUBLIC_BACKEND_URL, DEFAULT_BACKEND_URL),
    openaiBaseUrl: validateOpenaiBaseUrl(rawOpenaiBaseUrl, dev),
    modelName: readString(e.PUBLIC_MODEL_NAME, DEFAULT_MODEL_NAME),
    useMockBridge: e.PUBLIC_USE_MOCK_BRIDGE === 'true',
    dev,
    realtimeWsUrl: readString(e.PUBLIC_REALTIME_WS_URL, DEFAULT_REALTIME_WS_URL),
    transport: readTransport(e.PUBLIC_TRANSPORT),
  }
}

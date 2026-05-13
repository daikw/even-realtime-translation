/**
 * SDP exchange against the OpenAI Realtime translations endpoint
 * (`/v1/realtime/translations/calls`, design doc §14.1).
 *
 * @deprecated since 2026-05-12 — Phase 2 migration (docs/phase2-migration-plan.md §3 T7.3).
 *
 * SDP exchange is WebRTC-only. The Phase 2 WS path does not perform an SDP
 * handshake. This file ships alongside `webrtcTranslationClient.ts` and
 * will be deleted in T7b after the §6 rollback gate.
 *
 * The client posts a raw SDP offer with `Content-Type: application/sdp` and a
 * `Bearer ${clientSecret}` header; the response body is the SDP answer in
 * `text/plain`. We deliberately keep this module fetch-only so it stays
 * trivially testable and reusable across the WebRTC client and any future
 * renegotiation flow.
 *
 * TODO (API contract verification):
 * The path `/v1/realtime/translations/calls` and the `?model=` query
 * parameter follow the OpenAI Realtime *Translation* preview spec from the
 * design doc. They have NOT yet been confirmed against a live session. When
 * running the manual smoke checklist in `docs/test-plan.md` ("API contract
 * smoke"), capture the actual request URL, response status, and any
 * differences between request/response bodies; update DEFAULT_BASE_URL +
 * the path here if upstream has renamed the endpoint.
 */

const DEFAULT_BASE_URL = 'https://api.openai.com'
const DEFAULT_MODEL = 'gpt-realtime-translate'

export interface ExchangeSdpOptions {
  offerSdp: string
  clientSecret: string
  baseUrl?: string
  model?: string
  /**
   * Dependency-injected `fetch`. Tests pass a mock; production code can leave
   * this unset and use the global. We avoid binding to `globalThis.fetch` at
   * module-load time so the mock can be injected per call.
   */
  fetchImpl?: typeof fetch
}

export class SdpExchangeError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SdpExchangeError'
    this.status = status
  }
}

/**
 * Defensive scheme/host check (F5 / Sec M-3). The primary allowlist lives in
 * loadAppConfig (apps/evenhub-app/src/config.ts) so misconfiguration is
 * surfaced at boot, but we also enforce here so callers that bypass the
 * config layer (e.g. tests, future renegotiation paths) can't accidentally
 * exfiltrate the client secret to an attacker-controlled origin.
 */
function isAcceptableBaseUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  // Allow http loopback so local dev / proxies still work; never allow
  // arbitrary http hosts.
  if (parsed.protocol === 'http:') {
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  }
  return false
}

/** @deprecated Phase 2 (2026-05-12). SDP exchange is WebRTC-only; the WS
 * path does not perform an SDP handshake. Retained until T7b clears the
 * §6 rollback gate (see file header). */
export async function exchangeSdp(opts: ExchangeSdpOptions): Promise<string> {
  const candidate = opts.baseUrl ?? DEFAULT_BASE_URL
  const safeBaseUrl = isAcceptableBaseUrl(candidate) ? candidate : DEFAULT_BASE_URL
  const baseUrl = safeBaseUrl.replace(/\/+$/, '')
  const model = opts.model ?? DEFAULT_MODEL
  const url = `${baseUrl}/v1/realtime/translations/calls?model=${encodeURIComponent(model)}`
  const fetchImpl = opts.fetchImpl ?? fetch

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.clientSecret}`,
      'Content-Type': 'application/sdp',
    },
    body: opts.offerSdp,
  })

  if (!response.ok) {
    // CRITICAL: never echo the client secret. Body might contain useful
    // debugging info but could also surface request-level data; we keep just
    // the status so callers can decide retry policy without leaking secrets
    // into logs.
    throw new SdpExchangeError(
      response.status,
      `SDP exchange failed with status ${String(response.status)}`,
    )
  }

  return await response.text()
}

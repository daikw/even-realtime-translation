/**
 * SDP exchange against the OpenAI Realtime translations endpoint
 * (`/v1/realtime/translations/calls`, design doc §14.1).
 *
 * The client posts a raw SDP offer with `Content-Type: application/sdp` and a
 * `Bearer ${clientSecret}` header; the response body is the SDP answer in
 * `text/plain`. We deliberately keep this module fetch-only so it stays
 * trivially testable and reusable across the WebRTC client and any future
 * renegotiation flow.
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

export async function exchangeSdp(opts: ExchangeSdpOptions): Promise<string> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
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

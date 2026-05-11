import type { RealtimeServerEvent } from '@even-rt/shared'

/**
 * Parser for OpenAI Realtime server events delivered over the `oai-events`
 * data channel. The wire format is JSON-per-message; we narrow each payload
 * onto the {@link RealtimeServerEvent} discriminated union and reject anything
 * we don't recognise so callers don't have to repeat the validation.
 *
 * The parser is intentionally strict and silent: malformed JSON, payloads of
 * the wrong shape, and unknown `type` values all return `null`. Callers are
 * expected to log/observe at the boundary; we don't throw because the data
 * channel is best-effort and a single bad frame must not tear down the call.
 *
 * TODO (API contract verification):
 * The event names below — `session.input_transcript.delta`,
 * `session.output_transcript.delta`, `session.created`, `session.updated`,
 * `error` — follow the OpenAI Realtime *Translation* preview spec referenced
 * by the design doc (§6.3 / §14.1 / §21). They have NOT yet been confirmed
 * against the production endpoint with a live `gpt-realtime-translate`
 * session. When running the manual smoke checklist in
 * `docs/test-plan.md` ("API contract smoke"), capture the actual `type`
 * values seen on the wire and update this switch + the shared
 * {@link RealtimeServerEvent} discriminant if upstream has renamed any.
 *
 * Until then, see {@link logUnknownEvent} below: any unrecognised `type`
 * landing on the channel is logged once in dev mode so the discrepancy
 * surfaces during real-API smoke testing.
 */

type SessionCreated = Extract<RealtimeServerEvent, { type: 'session.created' }>
type SessionUpdated = Extract<RealtimeServerEvent, { type: 'session.updated' }>
type InputTranscriptDelta = Extract<
  RealtimeServerEvent,
  { type: 'session.input_transcript.delta' }
>
type OutputTranscriptDelta = Extract<
  RealtimeServerEvent,
  { type: 'session.output_transcript.delta' }
>
type ServerError = Extract<RealtimeServerEvent, { type: 'error' }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface MaybeDevEnv {
  DEV?: boolean
}

/**
 * Best-effort dev-only log for events whose `type` does not map onto
 * {@link RealtimeServerEvent}. Production builds skip this entirely so the
 * channel stays silent under normal load. Exposed for unit tests that want
 * to verify the log contract without depending on Vite's runtime env.
 */
export function logUnknownRealtimeEvent(
  type: string,
  env: MaybeDevEnv = ((import.meta as unknown as { env?: MaybeDevEnv }).env ?? {}),
): void {
  if (env.DEV !== true) return
  // Use console.debug so it can be filtered out of HUD logs but is still
  // visible during dev/Playwright smoke. Never include the full payload —
  // the data channel may carry partial transcripts and we don't want them in
  // dev consoles either.
  console.debug('[realtime] unknown server event type:', type)
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

function parseDeltaEvent<T extends 'session.input_transcript.delta' | 'session.output_transcript.delta'>(
  type: T,
  obj: Record<string, unknown>,
): { type: T; delta: string; itemId?: string } | null {
  const delta = pickString(obj, 'delta')
  if (delta === undefined) return null
  const itemId = pickString(obj, 'itemId')
  // Use a conditional spread so itemId is omitted entirely when absent;
  // exactOptionalPropertyTypes forbids `itemId: undefined`.
  return itemId === undefined ? { type, delta } : { type, delta, itemId }
}

export function parseRealtimeEvent(raw: string): RealtimeServerEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isPlainObject(parsed)) return null

  const type = parsed['type']
  if (typeof type !== 'string') return null

  switch (type) {
    case 'session.created': {
      const sessionId = pickString(parsed, 'sessionId')
      if (sessionId === undefined) return null
      return { type: 'session.created', sessionId }
    }
    case 'session.updated':
      return { type: 'session.updated' }
    case 'session.input_transcript.delta':
      return parseDeltaEvent('session.input_transcript.delta', parsed)
    case 'session.output_transcript.delta':
      return parseDeltaEvent('session.output_transcript.delta', parsed)
    case 'error': {
      const code = pickString(parsed, 'code')
      const message = pickString(parsed, 'message')
      if (code === undefined || message === undefined) return null
      return { type: 'error', code, message }
    }
    default:
      // Surface the unfamiliar `type` so the smoke checklist can confirm
      // whether the OpenAI preview has renamed an event. Strictly dev-only.
      logUnknownRealtimeEvent(type)
      return null
  }
}

export function isSessionCreated(ev: RealtimeServerEvent): ev is SessionCreated {
  return ev.type === 'session.created'
}

export function isSessionUpdated(ev: RealtimeServerEvent): ev is SessionUpdated {
  return ev.type === 'session.updated'
}

export function isInputTranscriptDelta(ev: RealtimeServerEvent): ev is InputTranscriptDelta {
  return ev.type === 'session.input_transcript.delta'
}

export function isOutputTranscriptDelta(ev: RealtimeServerEvent): ev is OutputTranscriptDelta {
  return ev.type === 'session.output_transcript.delta'
}

export function isServerError(ev: RealtimeServerEvent): ev is ServerError {
  return ev.type === 'error'
}

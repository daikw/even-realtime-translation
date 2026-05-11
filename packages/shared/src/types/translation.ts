/**
 * Smallest unit of progress emitted by the OpenAI Realtime translation
 * pipeline. Multiple deltas are concatenated into a {@link SubtitleSegment}.
 */
export interface TranscriptDelta {
  text: string
  /** OpenAI item id, when available. Used to correlate deltas to a transcript item. */
  itemId?: string
  /** Wall-clock timestamp (ms since epoch) when the delta was received locally. */
  createdAt: number
}

/** Stable, displayable unit of subtitle text the G2 renderer consumes. */
export interface SubtitleSegment {
  id: string
  text: string
  /** True when no further deltas should be appended (sentence boundary, silence, etc.). */
  finalized: boolean
  /** Wall-clock timestamp (ms since epoch) when the segment started. */
  startedAt: number
}

interface SessionCreatedEvent {
  type: 'session.created'
  sessionId: string
}

interface SessionUpdatedEvent {
  type: 'session.updated'
}

interface InputTranscriptDeltaEvent {
  type: 'session.input_transcript.delta'
  delta: string
  itemId?: string
}

interface OutputTranscriptDeltaEvent {
  type: 'session.output_transcript.delta'
  delta: string
  itemId?: string
}

interface ServerErrorEvent {
  type: 'error'
  code: string
  message: string
}

/**
 * Discriminated union of OpenAI Realtime server events the WebView listens for
 * over the `oai-events` data channel. Subset relevant to the translation PoC.
 */
export type RealtimeServerEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | InputTranscriptDeltaEvent
  | OutputTranscriptDeltaEvent
  | ServerErrorEvent

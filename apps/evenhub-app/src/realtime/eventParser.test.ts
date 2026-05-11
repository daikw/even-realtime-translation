import { describe, expect, it, vi } from 'vitest'

import {
  isInputTranscriptDelta,
  isOutputTranscriptDelta,
  isServerError,
  isSessionCreated,
  isSessionUpdated,
  logUnknownRealtimeEvent,
  parseRealtimeEvent,
} from './eventParser.js'

describe('parseRealtimeEvent', () => {
  it('parses session.created', () => {
    const ev = parseRealtimeEvent(JSON.stringify({ type: 'session.created', sessionId: 's1' }))
    expect(ev).toEqual({ type: 'session.created', sessionId: 's1' })
  })

  it('parses session.updated', () => {
    const ev = parseRealtimeEvent(JSON.stringify({ type: 'session.updated' }))
    expect(ev).toEqual({ type: 'session.updated' })
  })

  it('parses session.input_transcript.delta with itemId', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: 'hello', itemId: 'i1' }),
    )
    expect(ev).toEqual({
      type: 'session.input_transcript.delta',
      delta: 'hello',
      itemId: 'i1',
    })
  })

  it('parses session.output_transcript.delta without itemId', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'session.output_transcript.delta', delta: 'こん' }),
    )
    expect(ev).toEqual({ type: 'session.output_transcript.delta', delta: 'こん' })
  })

  it('parses error event', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'error', code: 'rate_limited', message: 'slow down' }),
    )
    expect(ev).toEqual({ type: 'error', code: 'rate_limited', message: 'slow down' })
  })

  it('returns null for invalid JSON', () => {
    expect(parseRealtimeEvent('not-json{')).toBeNull()
  })

  it('returns null for non-object payload', () => {
    expect(parseRealtimeEvent('"string"')).toBeNull()
    expect(parseRealtimeEvent('null')).toBeNull()
    expect(parseRealtimeEvent('42')).toBeNull()
    expect(parseRealtimeEvent('[]')).toBeNull()
  })

  it('returns null when type is missing or not a string', () => {
    expect(parseRealtimeEvent(JSON.stringify({}))).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify({ type: 123 }))).toBeNull()
  })

  it('returns null for unknown type', () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: 'session.unknown' }))).toBeNull()
  })

  it('returns null when delta event is missing required fields', () => {
    expect(
      parseRealtimeEvent(JSON.stringify({ type: 'session.output_transcript.delta' })),
    ).toBeNull()
    expect(
      parseRealtimeEvent(
        JSON.stringify({ type: 'session.input_transcript.delta', delta: 42 }),
      ),
    ).toBeNull()
  })

  it('returns null when session.created is missing sessionId', () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: 'session.created' }))).toBeNull()
  })

  it('returns null when error event misses fields', () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: 'error', code: 'x' }))).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify({ type: 'error', message: 'x' }))).toBeNull()
  })

  it('drops itemId when not a string', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'session.output_transcript.delta', delta: 'x', itemId: 99 }),
    )
    expect(ev).toEqual({ type: 'session.output_transcript.delta', delta: 'x' })
  })
})

describe('type guards', () => {
  it('isSessionCreated narrows', () => {
    const ev = parseRealtimeEvent(JSON.stringify({ type: 'session.created', sessionId: 's' }))
    expect(ev).not.toBeNull()
    if (ev !== null && isSessionCreated(ev)) {
      expect(ev.sessionId).toBe('s')
    } else {
      throw new Error('expected session.created')
    }
  })

  it('isSessionUpdated narrows', () => {
    const ev = parseRealtimeEvent(JSON.stringify({ type: 'session.updated' }))
    expect(ev).not.toBeNull()
    expect(ev !== null && isSessionUpdated(ev)).toBe(true)
  })

  it('isInputTranscriptDelta narrows', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'session.input_transcript.delta', delta: 'd' }),
    )
    expect(ev).not.toBeNull()
    if (ev !== null && isInputTranscriptDelta(ev)) {
      expect(ev.delta).toBe('d')
    } else {
      throw new Error('expected input transcript')
    }
  })

  it('isOutputTranscriptDelta narrows', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'session.output_transcript.delta', delta: 'd' }),
    )
    expect(ev).not.toBeNull()
    if (ev !== null && isOutputTranscriptDelta(ev)) {
      expect(ev.delta).toBe('d')
    } else {
      throw new Error('expected output transcript')
    }
  })

  it('isServerError narrows', () => {
    const ev = parseRealtimeEvent(
      JSON.stringify({ type: 'error', code: 'c', message: 'm' }),
    )
    expect(ev).not.toBeNull()
    if (ev !== null && isServerError(ev)) {
      expect(ev.code).toBe('c')
      expect(ev.message).toBe('m')
    } else {
      throw new Error('expected error event')
    }
  })

  it('guards return false on unrelated events', () => {
    const ev = parseRealtimeEvent(JSON.stringify({ type: 'session.updated' }))
    expect(ev).not.toBeNull()
    if (ev === null) throw new Error('unreachable')
    expect(isSessionCreated(ev)).toBe(false)
    expect(isInputTranscriptDelta(ev)).toBe(false)
    expect(isOutputTranscriptDelta(ev)).toBe(false)
    expect(isServerError(ev)).toBe(false)
  })
})

describe('logUnknownRealtimeEvent (dev-only)', () => {
  it('emits console.debug when DEV is true', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {
      // noop
    })
    logUnknownRealtimeEvent('something.new', { DEV: true })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]?.[0]).toContain('unknown server event type')
    expect(spy.mock.calls[0]?.[1]).toBe('something.new')
    spy.mockRestore()
  })

  it('is silent when DEV is false', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {
      // noop
    })
    logUnknownRealtimeEvent('something.new', { DEV: false })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('is silent when DEV is undefined (production default)', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {
      // noop
    })
    logUnknownRealtimeEvent('something.new', {})
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

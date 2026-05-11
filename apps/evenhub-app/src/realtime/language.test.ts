import { describe, expect, it } from 'vitest'

import { buildSessionUpdateEvent } from './language.js'

describe('buildSessionUpdateEvent', () => {
  it('builds the OpenAI session.update payload for a concrete language', () => {
    expect(buildSessionUpdateEvent('ja')).toEqual({
      type: 'session.update',
      session: { audio: { output: { language: 'ja' } } },
    })
  })

  it('supports each non-auto language code', () => {
    for (const code of ['en', 'ja', 'es', 'fr', 'ko'] as const) {
      const ev = buildSessionUpdateEvent(code)
      expect(ev.session.audio.output.language).toBe(code)
    }
  })

  it("throws when target language is 'auto' (output language must be concrete)", () => {
    expect(() => buildSessionUpdateEvent('auto')).toThrow(/auto/i)
  })

  it('produces a JSON-serialisable payload', () => {
    const ev = buildSessionUpdateEvent('en')
    const serialised = JSON.stringify(ev)
    expect(JSON.parse(serialised)).toEqual(ev)
  })
})

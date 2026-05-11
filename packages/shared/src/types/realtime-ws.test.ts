import { describe, expect, it } from 'vitest'

import type {
  ClientWsAudio,
  ClientWsClose,
  ClientWsLanguage,
  ClientWsMessage,
  ClientWsOpen,
  ServerWsAudioDelta,
  ServerWsError,
  ServerWsMessage,
  ServerWsSessionCreated,
  ServerWsTranscriptDelta,
} from './realtime-ws.js'

describe('realtime-ws client→server protocol', () => {
  it('admits the documented client message shapes via the union', () => {
    const messages: ClientWsMessage[] = [
      { type: 'open', targetLanguage: 'ja' } satisfies ClientWsOpen,
      { type: 'audio', pcm: 'AAAA' } satisfies ClientWsAudio,
      { type: 'language', target: 'en' } satisfies ClientWsLanguage,
      { type: 'close' } satisfies ClientWsClose,
    ]
    expect(messages).toHaveLength(4)
  })

  it('narrows by discriminant', () => {
    const msgs: ClientWsMessage[] = [
      { type: 'open', targetLanguage: 'ja' },
      { type: 'audio', pcm: 'AAAA' },
      { type: 'language', target: 'fr' },
      { type: 'close' },
    ]
    const seen: string[] = []
    for (const m of msgs) {
      switch (m.type) {
        case 'open':
          seen.push(`open:${m.targetLanguage}`)
          break
        case 'audio':
          seen.push(`audio:${m.pcm.length}`)
          break
        case 'language':
          seen.push(`language:${m.target}`)
          break
        case 'close':
          seen.push('close')
          break
      }
    }
    expect(seen).toEqual(['open:ja', 'audio:4', 'language:fr', 'close'])
  })
})

describe('realtime-ws server→client protocol', () => {
  it('admits the documented server message shapes via the union', () => {
    const messages: ServerWsMessage[] = [
      {
        type: 'session.created',
        meta: {
          upstreamSessionId: 'sess_abc',
          model: 'gpt-realtime-translate',
          targetLanguage: 'ja',
        },
      } satisfies ServerWsSessionCreated,
      {
        type: 'transcript.delta',
        source: 'input',
        text: 'Hello',
        itemId: 'item_1',
      } satisfies ServerWsTranscriptDelta,
      { type: 'transcript.delta', source: 'output', text: 'こんにちは' },
      { type: 'audio.delta', pcm: 'BBBB' } satisfies ServerWsAudioDelta,
      { type: 'error', code: 'rate_limited', message: 'slow down' } satisfies ServerWsError,
    ]
    expect(messages).toHaveLength(5)
  })

  it('allows session.created meta.upstreamSessionId to be optional', () => {
    const msg: ServerWsSessionCreated = {
      type: 'session.created',
      meta: { model: 'gpt-realtime-translate', targetLanguage: 'en' },
    }
    expect(msg.meta.upstreamSessionId).toBeUndefined()
  })

  it('discriminates input vs output transcript via source', () => {
    const msgs: ServerWsTranscriptDelta[] = [
      { type: 'transcript.delta', source: 'input', text: 'hi' },
      { type: 'transcript.delta', source: 'output', text: 'こんにちは' },
    ]
    expect(msgs.filter((m) => m.source === 'input')).toHaveLength(1)
    expect(msgs.filter((m) => m.source === 'output')).toHaveLength(1)
  })
})

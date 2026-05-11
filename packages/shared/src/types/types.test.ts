import { describe, expect, it } from 'vitest'

import type { ApiError, TranslationSessionRequest, TranslationSessionResponse } from './api.js'
import type { AppState, AppStatus, ConnectionStatus, LanguageCode, LanguagePair } from './state.js'
import type {
  RealtimeServerEvent,
  SubtitleSegment,
  TranscriptDelta,
} from './translation.js'

describe('shared types', () => {
  it('AppStatus accepts every documented state', () => {
    const states: AppStatus[] = [
      'booting',
      'permission_required',
      'idle',
      'connecting',
      'live',
      'paused',
      'reconnecting',
      'error',
      'exiting',
    ]
    expect(states).toHaveLength(9)
  })

  it('ConnectionStatus accepts every documented state', () => {
    const states: ConnectionStatus[] = [
      'idle',
      'connecting',
      'connected',
      'disconnected',
      'reconnecting',
      'failed',
    ]
    expect(states).toHaveLength(6)
  })

  it('LanguageCode and LanguagePair are usable', () => {
    const pair: LanguagePair = { source: 'auto', target: 'ja' }
    const target: LanguageCode = 'en'
    expect(pair.source).toBe('auto')
    expect(target).toBe('en')
  })

  it('AppState combines status, language pair, and connection state', () => {
    const state: AppState = {
      status: 'live',
      languagePair: { source: 'auto', target: 'ja' },
      connection: 'connected',
    }
    expect(state.status).toBe('live')
    expect(state.connection).toBe('connected')
  })

  it('TranscriptDelta and SubtitleSegment carry the documented fields', () => {
    const delta: TranscriptDelta = { text: 'hi', createdAt: 0 }
    const seg: SubtitleSegment = { id: 's1', text: 'hi', finalized: false, startedAt: 0 }
    expect(delta.text).toBe('hi')
    expect(seg.id).toBe('s1')
  })

  it('RealtimeServerEvent narrows by type discriminant', () => {
    const events: RealtimeServerEvent[] = [
      { type: 'session.created', sessionId: 'sess_1' },
      { type: 'session.updated' },
      { type: 'session.input_transcript.delta', delta: 'hello' },
      { type: 'session.output_transcript.delta', delta: 'こんにちは' },
      { type: 'error', code: 'oops', message: 'oh no' },
    ]
    for (const e of events) {
      switch (e.type) {
        case 'session.created':
          expect(e.sessionId).toBeTypeOf('string')
          break
        case 'session.updated':
          expect(e.type).toBe('session.updated')
          break
        case 'session.input_transcript.delta':
        case 'session.output_transcript.delta':
          expect(e.delta).toBeTypeOf('string')
          break
        case 'error':
          expect(e.code).toBeTypeOf('string')
          break
      }
    }
  })

  it('TranslationSession request/response/error shapes compile', () => {
    const req: TranslationSessionRequest = {
      targetLanguage: 'ja',
      sourceHint: 'auto',
      userId: 'anonymous',
      client: { appVersion: '0.1.0', device: 'G2' },
    }
    const res: TranslationSessionResponse = {
      clientSecret: 'secret',
      expiresAt: '2026-05-08T12:34:56Z',
      model: 'gpt-realtime-translate',
    }
    const err: ApiError = { error: { code: 'rate_limited', message: 'slow down' } }
    expect(req.targetLanguage).toBe('ja')
    expect(res.clientSecret).toBe('secret')
    expect(err.error.code).toBe('rate_limited')
  })
})

import { describe, expect, it } from 'vitest'

import { findSegmentBoundary } from './segmentBoundary.js'

describe('findSegmentBoundary', () => {
  it('returns null when no boundary marker exists and the text is under maxChars', () => {
    expect(findSegmentBoundary('hello world', { maxChars: 100 })).toBeNull()
  })

  it('returns the index of a Japanese full stop', () => {
    const text = 'こんにちは。'
    const idx = findSegmentBoundary(text, { maxChars: 100 })
    expect(idx).toBe(text.length - 1)
    expect(text.charAt(idx ?? -1)).toBe('。')
  })

  it('returns the last boundary when several candidates exist (segment maximisation)', () => {
    const text = 'First. Second! Third? Tail'
    const idx = findSegmentBoundary(text, { maxChars: 100 })
    expect(idx).toBe(text.indexOf('?'))
  })

  it('detects fullwidth ! and ? markers', () => {
    expect(findSegmentBoundary('本当に！', { maxChars: 100 })).toBe('本当に！'.length - 1)
    expect(findSegmentBoundary('そうですか？', { maxChars: 100 })).toBe('そうですか？'.length - 1)
  })

  it('detects fullwidth period (．)', () => {
    const text = 'ok．'
    expect(findSegmentBoundary(text, { maxChars: 100 })).toBe(text.length - 1)
  })

  it('returns the index of a newline', () => {
    const text = 'line one\nrest'
    expect(findSegmentBoundary(text, { maxChars: 100 })).toBe(text.indexOf('\n'))
  })

  it('returns the cutoff index when maxChars is exceeded (halfwidth-equivalent)', () => {
    const text = 'abcdefghij'
    // maxChars=5 半角 → index 4 までで確定 (含む)
    expect(findSegmentBoundary(text, { maxChars: 5 })).toBe(4)
  })

  it('counts fullwidth as 2 when applying maxChars', () => {
    const text = 'あいうえお' // width 10
    // maxChars=4 → "あい" で width 4 達成 → 末尾 index 1
    expect(findSegmentBoundary(text, { maxChars: 4 })).toBe(1)
  })

  it('prefers an explicit punctuation boundary over a maxChars cutoff when both apply', () => {
    const text = 'hi. tail tail tail tail'
    // maxChars=10 では index 9 で切れるが、'.' は index 2 にある → 句読点は探索範囲内なら採用
    const idx = findSegmentBoundary(text, { maxChars: 10 })
    expect(idx).toBe(2)
  })

  it('returns null for empty input', () => {
    expect(findSegmentBoundary('', { maxChars: 24 })).toBeNull()
  })
})

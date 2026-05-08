import { describe, expect, it } from 'vitest'

import { breakLines, truncate } from './lineBreak.js'

describe('breakLines', () => {
  it('returns empty array for empty input', () => {
    expect(breakLines('', { maxCharsPerLine: 24, maxLines: 5 })).toEqual([])
  })

  it('returns single line when text fits within line width', () => {
    expect(breakLines('Hello world', { maxCharsPerLine: 24, maxLines: 5 })).toEqual(['Hello world'])
  })

  it('honours explicit newline characters', () => {
    expect(breakLines('first line\nsecond line', { maxCharsPerLine: 24, maxLines: 5 })).toEqual([
      'first line',
      'second line',
    ])
  })

  it('breaks English text on word boundaries (spaces) when exceeding line width', () => {
    const result = breakLines('the quick brown fox jumps over the lazy dog', {
      maxCharsPerLine: 12,
      maxLines: 5,
    })
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(12)
    }
    // No word should be split mid-token.
    expect(result.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
  })

  it('breaks Japanese text after punctuation (、。・) when possible', () => {
    const result = breakLines('連携の前提として、既存の入退室管理システムと接続したいです。', {
      maxCharsPerLine: 24,
      maxLines: 5,
    })
    expect(result.length).toBeGreaterThan(1)
    // 第一行が句読点で終わっていることを確認 (24半角換算なので 12 文字以内に '、' が来る)
    expect(result[0]?.endsWith('、')).toBe(true)
  })

  it('truncates with ellipsis when the text exceeds maxLines', () => {
    const longText = 'word '.repeat(200).trim()
    const result = breakLines(longText, { maxCharsPerLine: 12, maxLines: 3 })
    expect(result).toHaveLength(3)
    expect(result[2]?.endsWith('…')).toBe(true)
  })

  it('counts halfwidth as 1 and other characters as 2', () => {
    // maxCharsPerLine 6 (半角換算) → 全角 3 文字までで折り返す
    const result = breakLines('あいうえお', { maxCharsPerLine: 6, maxLines: 5 })
    // 各行の全角は 3 文字まで
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(3)
    }
    expect(result.join('')).toBe('あいうえお')
  })

  it('handles mixed halfwidth and fullwidth content', () => {
    const result = breakLines('ABあいうえお', { maxCharsPerLine: 6, maxLines: 5 })
    // "AB" = width 2, "あ" = width 2 → "ABあ" fits (width 4); adding "い" exceeds 6, so wrap.
    expect(result[0]).toBe('ABあい')
    expect(result.join('')).toBe('ABあいうえお')
  })

  it('breaks long single token without spaces when no boundary is available', () => {
    const result = breakLines('abcdefghijklmnop', { maxCharsPerLine: 5, maxLines: 5 })
    expect(result.join('')).toBe('abcdefghijklmnop')
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(5)
    }
  })

  it('returns empty array for non-positive maxCharsPerLine or maxLines', () => {
    expect(breakLines('hello', { maxCharsPerLine: 0, maxLines: 3 })).toEqual([])
    expect(breakLines('hello', { maxCharsPerLine: 12, maxLines: 0 })).toEqual([])
  })

  it('preserves empty paragraphs from leading/trailing/double newlines', () => {
    expect(breakLines('\nhi', { maxCharsPerLine: 12, maxLines: 5 })).toEqual(['', 'hi'])
    expect(breakLines('hi\n\nworld', { maxCharsPerLine: 12, maxLines: 5 })).toEqual([
      'hi',
      '',
      'world',
    ])
  })

  it('shrinks the last line when ellipsis would otherwise overflow', () => {
    // 5 paragraphs of "あいうえ" each (width 8). maxCharsPerLine = 8 → each fits one line.
    // maxLines 3 → keep 3, append ellipsis. Last line width 8 + ellipsis 2 > 8 → strip.
    const text = ['あいうえ', 'あいうえ', 'あいうえ', 'あいうえ', 'あいうえ'].join('\n')
    const result = breakLines(text, { maxCharsPerLine: 8, maxLines: 3 })
    expect(result).toHaveLength(3)
    expect(result[2]?.endsWith('…')).toBe(true)
    // Width of the truncated last line including '…' must not exceed maxCharsPerLine.
    const lastLine = result[2] ?? ''
    let w = 0
    for (const ch of lastLine) w += ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? 1 : 2
    expect(w).toBeLessThanOrEqual(8)
  })
})

describe('truncate', () => {
  it('returns input unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('returns empty string for empty input', () => {
    expect(truncate('', 5)).toBe('')
  })

  it('truncates and appends ellipsis when exceeding halfwidth budget', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcd…')
  })

  it('treats fullwidth characters as width 2', () => {
    // budget = 6 半角. "あい" = 4. + "う" = 6 (収まる). "あいう" exact fit.
    expect(truncate('あいう', 6)).toBe('あいう')
    // budget = 5: "あい" = 4, + "…" の幅は 2 なので削る → "あ" + "…" = width 4
    expect(truncate('あいう', 5)).toBe('あ…')
  })
})

import { describe, expect, it } from 'vitest'

import {
  MAX_CHARS_PER_LINE,
  MAX_LINES,
  fitSubtitle,
  fitSubtitleLines,
} from './textFitter.js'

describe('textFitter constants', () => {
  it('exposes the G2 layout caps used elsewhere in the HUD layer', () => {
    expect(MAX_CHARS_PER_LINE).toBe(24)
    expect(MAX_LINES).toBe(5)
  })
})

describe('fitSubtitleLines', () => {
  it('returns empty array for empty input', () => {
    expect(fitSubtitleLines('')).toEqual([])
  })

  it('keeps short text on a single line', () => {
    expect(fitSubtitleLines('Hello world')).toEqual(['Hello world'])
  })

  it('wraps long English text on word boundaries', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const lines = fitSubtitleLines(text)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      // halfwidth-equivalent display width must not exceed MAX_CHARS_PER_LINE
      let width = 0
      for (const ch of line) {
        width += ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? 1 : 2
      }
      expect(width).toBeLessThanOrEqual(MAX_CHARS_PER_LINE)
    }
  })

  it('wraps Japanese text after punctuation', () => {
    const lines = fitSubtitleLines(
      '連携の前提として、既存の入退室管理システムと接続したいです。',
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]?.endsWith('、')).toBe(true)
  })

  it('truncates with ellipsis when exceeding MAX_LINES', () => {
    const long = 'word '.repeat(200).trim()
    const lines = fitSubtitleLines(long)
    expect(lines).toHaveLength(MAX_LINES)
    expect(lines[MAX_LINES - 1]?.endsWith('…')).toBe(true)
  })

  it('treats fullwidth characters as 2 columns (mixed width)', () => {
    // "AB" + 11 fullwidth = width 2 + 22 = 24, exactly at the limit
    const lines = fitSubtitleLines('ABあいうえおかきくけこさ')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('ABあいうえおかきくけこさ')
  })
})

describe('fitSubtitle', () => {
  it('returns empty string for empty input', () => {
    expect(fitSubtitle('')).toBe('')
  })

  it('joins fitted lines with \\n', () => {
    const text = 'line one\nline two'
    expect(fitSubtitle(text)).toBe('line one\nline two')
  })

  it('keeps newline-separated structure for wrapped CJK', () => {
    const out = fitSubtitle('連携の前提として、既存の入退室管理システムと接続したいです。')
    expect(out.split('\n').length).toBeGreaterThan(1)
  })
})

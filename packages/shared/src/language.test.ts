import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LANGUAGE_PAIR,
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  isLanguageCode,
  nextTargetLanguage,
} from './language.js'

describe('SUPPORTED_LANGUAGES', () => {
  it('contains the MVP language set including auto', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['auto', 'en', 'ja', 'es', 'fr', 'ko'])
  })

  it('has matching label for every code', () => {
    for (const code of SUPPORTED_LANGUAGES) {
      expect(LANGUAGE_LABELS[code]).toBeTypeOf('string')
      expect(LANGUAGE_LABELS[code].length).toBeGreaterThan(0)
    }
  })

  it('uses native script labels for ja and ko', () => {
    expect(LANGUAGE_LABELS.ja).toBe('日本語')
    expect(LANGUAGE_LABELS.ko).toBe('한국어')
  })
})

describe('DEFAULT_LANGUAGE_PAIR', () => {
  it('defaults to auto -> ja', () => {
    expect(DEFAULT_LANGUAGE_PAIR).toEqual({ source: 'auto', target: 'ja' })
  })
})

describe('isLanguageCode', () => {
  it.each(['auto', 'en', 'ja', 'es', 'fr', 'ko'])('accepts %s', (code) => {
    expect(isLanguageCode(code)).toBe(true)
  })

  it.each([null, undefined, '', 'EN', 'jp', 42, {}, []])('rejects %p', (value) => {
    expect(isLanguageCode(value)).toBe(false)
  })
})

describe('nextTargetLanguage', () => {
  it('cycles forward through en -> ja -> es -> fr -> ko -> en (auto excluded)', () => {
    expect(nextTargetLanguage('en', 'next')).toBe('ja')
    expect(nextTargetLanguage('ja', 'next')).toBe('es')
    expect(nextTargetLanguage('es', 'next')).toBe('fr')
    expect(nextTargetLanguage('fr', 'next')).toBe('ko')
    expect(nextTargetLanguage('ko', 'next')).toBe('en')
  })

  it('cycles backward through ko -> fr -> es -> ja -> en -> ko', () => {
    expect(nextTargetLanguage('ko', 'prev')).toBe('fr')
    expect(nextTargetLanguage('fr', 'prev')).toBe('es')
    expect(nextTargetLanguage('es', 'prev')).toBe('ja')
    expect(nextTargetLanguage('ja', 'prev')).toBe('en')
    expect(nextTargetLanguage('en', 'prev')).toBe('ko')
  })

  it('treats auto as if it were not in the rotation and lands on the first target language', () => {
    expect(nextTargetLanguage('auto', 'next')).toBe('en')
    expect(nextTargetLanguage('auto', 'prev')).toBe('ko')
  })
})

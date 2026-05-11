import type { LanguageCode, LanguagePair } from './types/state.js'

export const SUPPORTED_LANGUAGES = ['auto', 'en', 'ja', 'es', 'fr', 'ko'] as const satisfies readonly LanguageCode[]

export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  auto: 'Auto',
  en: 'English',
  ja: '日本語',
  es: 'Español',
  fr: 'Français',
  ko: '한국어',
}

export const DEFAULT_LANGUAGE_PAIR: LanguagePair = { source: 'auto', target: 'ja' }

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Concrete target languages a user can rotate through with Swipe up / down on
 * the G2. `auto` is intentionally excluded — it only makes sense as a source
 * hint, not as an output target.
 */
const TARGET_ROTATION = ['en', 'ja', 'es', 'fr', 'ko'] as const satisfies readonly LanguageCode[]

export function nextTargetLanguage(
  current: LanguageCode,
  direction: 'next' | 'prev',
): LanguageCode {
  const rotation: readonly LanguageCode[] = TARGET_ROTATION
  const index = rotation.indexOf(current)
  if (index === -1) {
    // current === 'auto' or otherwise outside the rotation: fall back to the edge.
    return direction === 'next' ? rotation[0]! : rotation[rotation.length - 1]!
  }
  const offset = direction === 'next' ? 1 : -1
  const next = (index + offset + rotation.length) % rotation.length
  return rotation[next]!
}

import type { AppStatus, ConnectionStatus, LanguageCode, LanguagePair } from '@even-rt/shared'

import { fitSubtitle } from './textFitter.js'

/**
 * View-model consumed by {@link formatHudText} (and the screen renderers).
 *
 * Kept independent of {@link import('@even-rt/shared').AppState} so the HUD
 * layer can decide which fields to surface (e.g. derived `elapsedSeconds`,
 * optional `hint`).
 */
export interface HudViewModel {
  status: AppStatus
  languagePair: LanguagePair
  connection: ConnectionStatus
  elapsedSeconds: number
  subtitle: string
  hint?: string
}

/**
 * Short uppercase labels used in the status bar. We intentionally keep this
 * mapping local to the HUD layer because the canonical
 * `LANGUAGE_LABELS` (e.g. "日本語") wouldn't fit the 24-column G2 grid.
 */
const SHORT_LANGUAGE_LABELS: Record<LanguageCode, string> = {
  auto: 'AUTO',
  en: 'EN',
  ja: 'JA',
  es: 'ES',
  fr: 'FR',
  ko: 'KO',
}

function shortLabel(code: LanguageCode): string {
  return SHORT_LANGUAGE_LABELS[code]
}

/**
 * Convert seconds to `mm:ss` with zero-padding. Floors fractional inputs and
 * clamps negative values to `00:00`.
 *
 * `mm` is allowed to grow past 99 (e.g. `61:01`) — the design example bar
 * always reserves the right edge for elapsed and we want to surface long
 * sessions correctly during M0-M2 manual testing.
 */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const total = Math.floor(seconds)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${pad2(mm)}:${pad2(ss)}`
}

function pad2(n: number): string {
  return n < 10 ? `0${String(n)}` : String(n)
}

function statusBadge(status: AppStatus): string {
  switch (status) {
    case 'live':
      return 'LIVE ●'
    case 'paused':
      return 'PAUSED ⏸'
    case 'connecting':
      return 'CONNECTING…'
    case 'reconnecting':
      return 'RECONNECT…'
    case 'error':
      return 'ERROR ⚠'
    default:
      return ''
  }
}

function statusBar(vm: HudViewModel): string {
  const lang = `${shortLabel(vm.languagePair.source)}→${shortLabel(vm.languagePair.target)}`
  const badge = statusBadge(vm.status)
  const elapsed = formatElapsed(vm.elapsedSeconds)
  // Format mirrors §6.4 example: `EN→JA  LIVE ●  00:42`. When the badge is
  // empty (e.g. status === 'idle') we collapse the extra separator so we don't
  // burn columns on a blank cell.
  return badge.length === 0
    ? `${lang}  ${elapsed}`
    : `${lang}  ${badge}  ${elapsed}`
}

/**
 * Compose the full HUD text: status bar, wrapped subtitle body, and (optional)
 * hint. Sections are joined with `\n`. When `subtitle` is empty the body is
 * omitted entirely so the bar doesn't end with a stray blank line.
 */
export function formatHudText(vm: HudViewModel): string {
  const sections: string[] = [statusBar(vm)]
  const body = fitSubtitle(vm.subtitle)
  if (body.length > 0) sections.push(body)
  if (vm.hint !== undefined && vm.hint.length > 0) sections.push(vm.hint)
  return sections.join('\n')
}

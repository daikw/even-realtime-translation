import type { LanguageCode, LanguagePair } from '@even-rt/shared'
import { truncate } from '@even-rt/shared'

import { formatHudText, type HudViewModel } from './layout.js'
import { MAX_CHARS_PER_LINE } from './textFitter.js'

/**
 * Short uppercase labels (mirrors `layout.ts`). Duplicated locally to avoid
 * exporting an internal helper from `layout.ts`; the table is tiny and
 * change-rate-low.
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

/** Startup screen (§12.1). */
export function renderStartupScreen(): string {
  return 'G2 Translate\nPress to start\nSwipe: language'
}

/** Permission screen (§12.1). */
export function renderPermissionScreen(): string {
  return 'Allow mic on phone\nto start translation.'
}

/** Connecting screen showing the active language pair (§12.1). */
export function renderConnectingScreen(pair: LanguagePair): string {
  return `Connecting...\n${shortLabel(pair.source)} → ${shortLabel(pair.target)}`
}

/** Live subtitle screen — delegates to {@link formatHudText}. */
export function renderLiveScreen(vm: HudViewModel): string {
  return formatHudText(vm)
}

/** Paused screen (§12.1). */
export function renderPausedScreen(): string {
  return 'Paused\nPress to resume\nDouble press to exit'
}

/** Reconnecting screen (§7.3). */
export function renderReconnectingScreen(): string {
  return 'Reconnecting...'
}

/**
 * Error screen with optional reason injected on line 2. Long reasons are
 * truncated to {@link MAX_CHARS_PER_LINE} so we don't blow past the G2 grid.
 * An empty reason falls back to the canonical "Check phone app" copy from
 * §12.1.
 */
export function renderErrorScreen(reason: string): string {
  const middle = reason.length === 0 ? 'Check phone app' : truncate(reason, MAX_CHARS_PER_LINE)
  return `Connection failed\n${middle}\nPress retry`
}

/** Exiting screen — shown briefly during shutdown. */
export function renderExitingScreen(): string {
  return 'Closing...'
}

/**
 * Map an {@link HudViewModel} to the appropriate screen renderer based on
 * `status`. The HUD layer uses this as the single entry point so callers
 * (Task #7 wiring) don't have to switch on status themselves.
 */
export function renderForStatus(vm: HudViewModel): string {
  switch (vm.status) {
    case 'booting':
    case 'idle':
      return renderStartupScreen()
    case 'permission_required':
      return renderPermissionScreen()
    case 'connecting':
      return renderConnectingScreen(vm.languagePair)
    case 'live':
      return renderLiveScreen(vm)
    case 'paused':
      return renderPausedScreen()
    case 'reconnecting':
      return renderReconnectingScreen()
    case 'error':
      return renderErrorScreen('')
    case 'exiting':
      return renderExitingScreen()
  }
}

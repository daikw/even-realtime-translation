// Barrel re-exports for the HUD layer (G2 subtitle rendering only — no DOM).
//
// Production code should import from this entry point:
//   import { SubtitleBuffer, formatHudText, renderForStatus } from '@/hud'
// Task #7 will wire `SubtitleBuffer.onRender` into `HudDisplay.upgradeText`.

export {
  MAX_CHARS_PER_LINE,
  MAX_LINES,
  fitSubtitle,
  fitSubtitleLines,
} from './textFitter.js'

export {
  formatElapsed,
  formatHudText,
  type HudViewModel,
} from './layout.js'

export {
  renderConnectingScreen,
  renderErrorScreen,
  renderExitingScreen,
  renderForStatus,
  renderLiveScreen,
  renderPausedScreen,
  renderPermissionScreen,
  renderReconnectingScreen,
  renderStartupScreen,
} from './screens.js'

export {
  SubtitleBuffer,
  type SubtitleBufferOptions,
} from './subtitleBuffer.js'

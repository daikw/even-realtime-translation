import { describe, expect, it } from 'vitest'

import type { HudViewModel } from './layout.js'
import {
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

function vm(overrides: Partial<HudViewModel> = {}): HudViewModel {
  return {
    status: 'live',
    languagePair: { source: 'en', target: 'ja' },
    connection: 'connected',
    elapsedSeconds: 5,
    subtitle: 'Hello',
    hint: 'Press pause / Swipe lang',
    ...overrides,
  }
}

describe('static screen renderers', () => {
  it('renders the startup screen with title and hints', () => {
    expect(renderStartupScreen()).toBe('G2 Translate\nPress to start\nSwipe: language')
  })

  it('renders the permission screen', () => {
    expect(renderPermissionScreen()).toBe('Allow mic on phone\nto start translation.')
  })

  it('renders the connecting screen with the language pair', () => {
    expect(renderConnectingScreen({ source: 'en', target: 'ja' })).toBe(
      'Connecting...\nEN → JA',
    )
  })

  it('renders connecting screen with auto source', () => {
    expect(renderConnectingScreen({ source: 'auto', target: 'ja' })).toBe(
      'Connecting...\nAUTO → JA',
    )
  })

  it('renders the paused screen', () => {
    expect(renderPausedScreen()).toBe('Paused\nPress to resume\nDouble press to exit')
  })

  it('renders the reconnecting screen', () => {
    expect(renderReconnectingScreen()).toBe('Reconnecting...')
  })

  it('renders the exiting screen', () => {
    expect(renderExitingScreen()).toBe('Closing...')
  })
})

describe('renderErrorScreen', () => {
  it('renders the canonical 3-line error message when no reason given', () => {
    expect(renderErrorScreen('')).toBe('Connection failed\nCheck phone app\nPress retry')
  })

  it('embeds short reasons on the second line', () => {
    const out = renderErrorScreen('timeout')
    const lines = out.split('\n')
    expect(lines[0]).toBe('Connection failed')
    expect(lines[1]).toContain('timeout')
    expect(lines[lines.length - 1]).toBe('Press retry')
  })

  it('truncates very long reasons to MAX_CHARS_PER_LINE columns', () => {
    const long = 'something very specific went wrong with the underlying transport layer'
    const out = renderErrorScreen(long)
    const lines = out.split('\n')
    // Truncated reason ends with ellipsis when over budget.
    expect(lines[1]?.endsWith('…')).toBe(true)
  })
})

describe('renderLiveScreen', () => {
  it('delegates to formatHudText (status bar + body + hint)', () => {
    const out = renderLiveScreen(vm())
    const lines = out.split('\n')
    expect(lines[0]).toBe('EN→JA  LIVE ●  00:05')
    expect(lines[1]).toBe('Hello')
    expect(lines[lines.length - 1]).toBe('Press pause / Swipe lang')
  })
})

describe('renderForStatus', () => {
  it('booting → startup screen', () => {
    expect(renderForStatus(vm({ status: 'booting' }))).toBe(renderStartupScreen())
  })

  it('permission_required → permission screen', () => {
    expect(renderForStatus(vm({ status: 'permission_required' }))).toBe(
      renderPermissionScreen(),
    )
  })

  it('idle → startup screen (G2 returns to the start prompt)', () => {
    expect(renderForStatus(vm({ status: 'idle' }))).toBe(renderStartupScreen())
  })

  it('connecting → connecting screen with current language pair', () => {
    const out = renderForStatus(vm({ status: 'connecting' }))
    expect(out).toBe(renderConnectingScreen({ source: 'en', target: 'ja' }))
  })

  it('live → live screen', () => {
    const view = vm({ status: 'live' })
    expect(renderForStatus(view)).toBe(renderLiveScreen(view))
  })

  it('paused → paused screen', () => {
    expect(renderForStatus(vm({ status: 'paused' }))).toBe(renderPausedScreen())
  })

  it('reconnecting → reconnecting screen', () => {
    expect(renderForStatus(vm({ status: 'reconnecting' }))).toBe(
      renderReconnectingScreen(),
    )
  })

  it('error → error screen', () => {
    const out = renderForStatus(vm({ status: 'error' }))
    expect(out.startsWith('Connection failed')).toBe(true)
  })

  it('exiting → exiting screen', () => {
    expect(renderForStatus(vm({ status: 'exiting' }))).toBe(renderExitingScreen())
  })
})

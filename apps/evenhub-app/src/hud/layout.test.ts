import { describe, expect, it } from 'vitest'

import {
  formatElapsed,
  formatHudText,
  type HudViewModel,
} from './layout.js'

function vm(overrides: Partial<HudViewModel> = {}): HudViewModel {
  return {
    status: 'live',
    languagePair: { source: 'en', target: 'ja' },
    connection: 'connected',
    elapsedSeconds: 42,
    subtitle: 'Hello world',
    ...overrides,
  }
}

describe('formatElapsed', () => {
  it('formats zero as 00:00', () => {
    expect(formatElapsed(0)).toBe('00:00')
  })

  it('zero-pads single-digit seconds', () => {
    expect(formatElapsed(7)).toBe('00:07')
  })

  it('formats 42 seconds as 00:42', () => {
    expect(formatElapsed(42)).toBe('00:42')
  })

  it('rolls over minutes (3661 → 61:01)', () => {
    expect(formatElapsed(3661)).toBe('61:01')
  })

  it('clamps negative values to 00:00', () => {
    expect(formatElapsed(-5)).toBe('00:00')
  })

  it('floors fractional seconds', () => {
    expect(formatElapsed(42.9)).toBe('00:42')
  })
})

describe('formatHudText status bar', () => {
  it('renders the LIVE badge with EN→JA label and elapsed', () => {
    const out = formatHudText(vm())
    const lines = out.split('\n')
    expect(lines[0]).toBe('EN→JA  LIVE ●  00:42')
  })

  it("uses 'AUTO' when source is 'auto'", () => {
    const out = formatHudText(vm({ languagePair: { source: 'auto', target: 'ja' } }))
    expect(out.split('\n')[0]).toBe('AUTO→JA  LIVE ●  00:42')
  })

  it('renders PAUSED badge', () => {
    const out = formatHudText(vm({ status: 'paused' }))
    expect(out.split('\n')[0]).toContain('PAUSED ⏸')
  })

  it('renders CONNECTING badge', () => {
    const out = formatHudText(vm({ status: 'connecting' }))
    expect(out.split('\n')[0]).toContain('CONNECTING…')
  })

  it('renders RECONNECT badge for reconnecting', () => {
    const out = formatHudText(vm({ status: 'reconnecting' }))
    expect(out.split('\n')[0]).toContain('RECONNECT…')
  })

  it('renders ERROR badge', () => {
    const out = formatHudText(vm({ status: 'error' }))
    expect(out.split('\n')[0]).toContain('ERROR ⚠')
  })

  it('omits badge for booting/idle/exiting (no badge text)', () => {
    const out = formatHudText(vm({ status: 'idle', subtitle: 'x' }))
    // status bar must not contain any of the well-known badges.
    const bar = out.split('\n')[0] ?? ''
    expect(bar).not.toMatch(/LIVE|PAUSED|CONNECTING|RECONNECT|ERROR/)
    // Still contains the language label and elapsed.
    expect(bar).toContain('EN→JA')
    expect(bar).toContain('00:42')
  })
})

describe('formatHudText body', () => {
  it('runs the subtitle through fitSubtitle (wrapping CJK punctuation)', () => {
    const out = formatHudText(
      vm({ subtitle: '連携の前提として、既存の入退室管理システムと接続したいです。' }),
    )
    const lines = out.split('\n')
    // First line is the status bar; body starts at index 1.
    expect(lines.length).toBeGreaterThan(2)
    expect(lines[1]?.endsWith('、')).toBe(true)
  })

  it('handles empty subtitle (no body lines, but status bar still present)', () => {
    const out = formatHudText(vm({ subtitle: '' }))
    const lines = out.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('LIVE ●')
  })
})

describe('formatHudText hint', () => {
  it('appends the hint as the last line when provided', () => {
    const out = formatHudText(vm({ subtitle: 'hi', hint: 'Press pause / Swipe lang' }))
    const lines = out.split('\n')
    expect(lines[lines.length - 1]).toBe('Press pause / Swipe lang')
  })

  it('omits the hint section when not provided', () => {
    const out = formatHudText(vm({ subtitle: 'hi' }))
    const lines = out.split('\n')
    expect(lines).toEqual([expect.stringContaining('LIVE'), 'hi'])
  })
})

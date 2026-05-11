import { breakLines } from '@even-rt/shared'

/**
 * Maximum halfwidth-equivalent columns we render per line on the G2 (§6.4).
 *
 * The spec calls out 20–28 chars; 24 is the middle-of-the-road value that
 * matches the example renderings in the design doc.
 */
export const MAX_CHARS_PER_LINE = 24

/**
 * Maximum number of subtitle body lines (§6.4: 3–5 lines). Status bar and the
 * operation hint live outside this budget — see `layout.formatHudText`.
 */
export const MAX_LINES = 5

/**
 * Wrap `text` to the G2 subtitle grid and return the resulting lines.
 *
 * Empty input yields an empty array. Lines exceeding {@link MAX_LINES} are
 * collapsed and the last line is suffixed with `…` by `breakLines`.
 */
export function fitSubtitleLines(text: string): string[] {
  if (text.length === 0) return []
  return breakLines(text, {
    maxCharsPerLine: MAX_CHARS_PER_LINE,
    maxLines: MAX_LINES,
  })
}

/**
 * Convenience wrapper around {@link fitSubtitleLines} that returns a
 * newline-joined string ready for `textContainerUpgrade`.
 */
export function fitSubtitle(text: string): string {
  return fitSubtitleLines(text).join('\n')
}

/**
 * Width helpers and line-break logic tuned for the Even G2 HUD (§6.4).
 *
 * The width model is intentionally simple: ASCII printable characters count as
 * 1, every other character (CJK, kana, emoji, etc.) counts as 2. This is good
 * enough for fitting subtitles into the ~24 char/line G2 grid without pulling
 * in `east-asian-width` data.
 */

const ELLIPSIS = '…'

/** Returns true for U+0020..U+007E (printable ASCII). */
function isHalfwidth(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= 0x20 && code <= 0x7e
}

export function charWidth(ch: string): number {
  return isHalfwidth(ch) ? 1 : 2
}

export function stringWidth(text: string): number {
  let total = 0
  for (const ch of text) {
    total += charWidth(ch)
  }
  return total
}

/**
 * Display width of `…`. We treat it as halfwidth in pure-ASCII strings (so it
 * blends with Latin text) and fullwidth otherwise (matches CJK font metrics).
 */
function ellipsisWidthFor(text: string): number {
  for (const ch of text) {
    if (!isHalfwidth(ch)) return 2
  }
  return 1
}

/**
 * Characters considered preferred line-break points. ASCII space allows
 * English word wrapping, while the JP punctuation set keeps Japanese subtitles
 * from breaking mid-clause.
 */
const SOFT_BREAK_CHARS = new Set<string>([' ', '\t', '、', '。', '・', '　'])

interface BreakLinesOptions {
  maxCharsPerLine: number
  maxLines: number
}

/**
 * Wraps `text` into lines that fit within `maxCharsPerLine` (in halfwidth
 * units) and at most `maxLines` lines. Prefers word/punctuation boundaries.
 * If the input would exceed `maxLines`, the last emitted line ends with `…`.
 */
export function breakLines(text: string, opts: BreakLinesOptions): string[] {
  if (text.length === 0) return []
  const { maxCharsPerLine, maxLines } = opts
  if (maxCharsPerLine <= 0 || maxLines <= 0) return []

  const out: string[] = []
  // Honour explicit newlines: the spec calls them out as hard segment boundaries.
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      out.push('')
      continue
    }
    out.push(...wrapParagraph(paragraph, maxCharsPerLine))
  }

  if (out.length <= maxLines) return out

  const truncated = out.slice(0, maxLines)
  const lastIndex = truncated.length - 1
  const lastLine = truncated[lastIndex] ?? ''
  truncated[lastIndex] = appendEllipsis(lastLine, maxCharsPerLine, ellipsisWidthFor(text))
  return truncated
}

function wrapParagraph(paragraph: string, maxCharsPerLine: number): string[] {
  const lines: string[] = []
  const chars = Array.from(paragraph)
  let current = ''
  let currentWidth = 0
  // Index inside `current` of the most recent break-friendly char (e.g. space).
  // We track it so we can roll back to a clean boundary when the next char overflows.
  let lastBreakInLine = -1

  for (const ch of chars) {
    const w = charWidth(ch)
    if (currentWidth + w > maxCharsPerLine) {
      if (lastBreakInLine >= 0) {
        const head = current.slice(0, lastBreakInLine + 1)
        const tail = current.slice(lastBreakInLine + 1)
        lines.push(stripTrailingBreak(head))
        current = tail
        currentWidth = stringWidth(current)
        lastBreakInLine = -1
      } else {
        lines.push(current)
        current = ''
        currentWidth = 0
        lastBreakInLine = -1
      }
    }
    current += ch
    currentWidth += w
    if (SOFT_BREAK_CHARS.has(ch)) {
      lastBreakInLine = current.length - 1
    }
  }
  if (current.length > 0) lines.push(current)
  // Collapse the leading whitespace that wrapping can introduce when we break
  // right after a soft-break char.
  return lines.map((line, i) => (i === 0 ? line : line.replace(/^[ \t]+/, '')))
}

function stripTrailingBreak(text: string): string {
  // Keep punctuation like 、。・ at the end (they are part of the clause), but
  // drop trailing ASCII spaces — they would otherwise consume display width
  // for nothing.
  return text.replace(/[ \t]+$/, '')
}

function appendEllipsis(line: string, maxCharsPerLine: number, ellipsisWidth: number): string {
  if (line.endsWith(ELLIPSIS)) return line
  let result = line
  while (stringWidth(result) + ellipsisWidth > maxCharsPerLine && result.length > 0) {
    result = sliceLastChar(result)
  }
  return result + ELLIPSIS
}

function sliceLastChar(text: string): string {
  const arr = Array.from(text)
  arr.pop()
  return arr.join('')
}

/**
 * Truncate `text` so its halfwidth-equivalent display width is at most
 * `maxChars`. If truncation occurs, the result ends with `…`.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length === 0) return ''
  if (maxChars <= 0) return ''
  if (stringWidth(text) <= maxChars) return text

  const ellipsisWidth = ellipsisWidthFor(text)
  const budget = maxChars - ellipsisWidth
  if (budget <= 0) return ELLIPSIS
  let result = ''
  let width = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (width + w > budget) break
    result += ch
    width += w
  }
  return result + ELLIPSIS
}

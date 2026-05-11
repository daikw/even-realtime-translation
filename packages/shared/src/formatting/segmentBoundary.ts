import { charWidth } from './lineBreak.js'

/**
 * Characters that finalise a subtitle segment. Mirrors §6.5: "句点 / period /
 * question mark / 改行 / 文字数上限" — line breaks and the maxChars cutoff are
 * handled separately below.
 */
const SENTENCE_TERMINATORS = new Set<string>(['。', '．', '.', '!', '?', '！', '？'])

interface FindSegmentBoundaryOptions {
  maxChars: number
}

/**
 * Returns the inclusive end index of the next confirmed segment in `text`, or
 * null if no boundary has been reached.
 *
 * When several candidates exist within the search window the LAST one wins
 * (segment maximisation). A maxChars cutoff is only used when no punctuation
 * or newline appeared before the budget was exhausted.
 */
export function findSegmentBoundary(
  text: string,
  opts: FindSegmentBoundaryOptions,
): number | null {
  if (text.length === 0) return null
  const { maxChars } = opts
  if (maxChars <= 0) return null

  let width = 0
  let lastPunctuationIndex = -1
  let cutoffIndex = -1
  let exceeded = false

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i)
    const w = charWidth(ch)
    const nextWidth = width + w
    if (nextWidth > maxChars) {
      exceeded = true
      break
    }
    width = nextWidth
    cutoffIndex = i
    if (ch === '\n' || SENTENCE_TERMINATORS.has(ch)) {
      lastPunctuationIndex = i
    }
  }

  if (lastPunctuationIndex >= 0) return lastPunctuationIndex
  if (exceeded) return cutoffIndex
  return null
}

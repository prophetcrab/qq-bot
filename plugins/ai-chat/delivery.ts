/** Reply sanitizing and splitting. */

/** Remove leaked context labels from a reply (defense in depth beside the host sanitizer). */
export function sanitizeReplyText(text: string): string {
  return String(text ?? '')
    .replace(/^\s*[\[【](?:背景|当前消息|群聊背景|历史|上下文)[\]】]\s*(?:AI|[^：\n]{0,40})?\s*[:：]?\s*/u, '')
    .replace(/[\[【]\s*(?:背景|当前消息|群聊背景|最近群聊背景|历史|上下文)\s*[\]】]/gu, '')
    .replace(/^\s*AI\s*[:：]\s*/u, '')
    .trim()
}

/** Split long replies on newline boundaries. */
export function splitReply(text: string, max: number): string[] {
  const limit = Math.max(100, Math.trunc(max))
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).replace(/^\n+/u, '')
  }
  if (rest !== '') parts.push(rest)
  return parts.filter((part) => part !== '')
}

export type ReplyMode = 'short' | 'casual' | 'reaction' | 'normal'

/**
 * Pick a lightweight expression mode before generation. Mode only nudges the
 * model; it never truncates the reply or removes the character's quirks.
 */
export function chooseReplyMode(
  input: { question?: boolean; images?: boolean } = {},
  random: () => number = Math.random,
): ReplyMode {
  const value = random()
  if (input.question === true || input.images === true) {
    if (value < 0.55) return 'normal'
    if (value < 0.85) return 'casual'
    return 'short'
  }
  if (value < 0.4) return 'short'
  if (value < 0.7) return 'casual'
  if (value < 0.9) return 'reaction'
  return 'normal'
}

/**
 * Segment a reply for chat rhythm. Long replies always split on the existing
 * maximum; short/casual replies may split once at sentence punctuation.
 */
export function segmentReply(
  text: string,
  mode: ReplyMode,
  max: number,
  random: () => number = Math.random,
): string[] {
  const base = splitReply(text, max)
  if (base.length > 1) return base
  const clean = String(text ?? '').trim()
  if (clean === '' || mode === 'reaction' || clean.length < 24) return base
  if (mode !== 'casual' && random() > 0.35) return base
  const pieces = clean.split(/(?<=[。！？!?；;])\s*/u).map((part) => part.trim()).filter((part) => part.length >= 3)
  if (pieces.length < 2) return base
  const first = pieces.shift() as string
  const second = pieces.join('')
  return [first, second].filter((part) => part !== '')
}

/** Human-ish pause before the first QQ message. */
export function replyDelayMs(mode: ReplyMode, text: string, random: () => number = Math.random): number {
  const base = mode === 'reaction' ? 260 : mode === 'short' ? 380 : mode === 'casual' ? 540 : 650
  return Math.min(2400, Math.round(base + Math.min(1200, String(text ?? '').length * 18) + random() * 420))
}

/** Short pause between two outgoing segments. */
export function segmentDelayMs(random: () => number = Math.random): number {
  return Math.round(260 + random() * 420)
}

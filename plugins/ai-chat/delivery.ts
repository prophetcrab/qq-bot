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

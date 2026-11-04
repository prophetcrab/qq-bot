/** Reply sanitizing and splitting. */

/** Remove leaked context labels from a reply (defense in depth beside the host sanitizer). */
export function sanitizeReplyText(text: string): string {
  return String(text ?? '')
    .replace(/^\s*[\[【](?:背景|当前消息|群聊背景|历史|上下文)[\]】]\s*(?:AI|[^：\n]{0,40})?\s*[:：]?\s*/u, '')
    .replace(/[\[【]\s*(?:背景|当前消息|群聊背景|最近群聊背景|历史|上下文)\s*[\]】]/gu, '')
    .replace(/^\s*AI\s*[:：]\s*/u, '')
    .trim()
}

const SENTENCE_PATTERN = /[^。！？!?…\n]+[。！？!?…]?/gu
const CLAUSE_PATTERN = /[^，,；;：:—]+[，,；;：:—]?/gu
const TARGET_BUBBLE_CHARS = 42

function splitLongSentence(text: string, maxChars: number): string[] {
  const clauses = (text.match(CLAUSE_PATTERN) ?? []).map((part) => part.trim()).filter(Boolean)
  if (clauses.length === 0) {
    const chunks: string[] = []
    for (let start = 0; start < text.length; start += maxChars) chunks.push(text.slice(start, start + maxChars))
    return chunks
  }
  const units: string[] = []
  let current = ''
  for (const clause of clauses) {
    if (clause.length > maxChars) {
      if (current !== '') { units.push(current); current = '' }
      for (let start = 0; start < clause.length; start += maxChars) units.push(clause.slice(start, start + maxChars))
    } else if (current !== '' && current.length + clause.length > maxChars) {
      units.push(current)
      current = clause
    } else {
      current += clause
    }
  }
  if (current !== '') units.push(current)
  return units
}

function sentenceUnits(text: string, maxChars: number): string[] {
  const units: string[] = []
  for (const sentence of (text.match(SENTENCE_PATTERN) ?? []).map((part) => part.trim()).filter(Boolean)) {
    if (sentence.length <= maxChars) units.push(sentence)
    else units.push(...splitLongSentence(sentence, maxChars))
  }
  return units
}

function partitionUnits(units: string[], maxParts: number): string[] {
  if (units.length <= maxParts) return units
  const total = units.reduce((sum, unit) => sum + unit.length, 0)
  let low = Math.max(...units.map((unit) => unit.length))
  let high = total
  const groupsNeeded = (limit: number): number => {
    let groups = 1
    let current = 0
    for (const unit of units) {
      if (current + unit.length > limit && current > 0) {
        groups += 1
        current = 0
      }
      current += unit.length
    }
    return groups
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (groupsNeeded(middle) <= maxParts) high = middle
    else low = middle + 1
  }
  const groups: string[] = []
  let current = ''
  for (const unit of units) {
    if (current !== '' && current.length + unit.length > low) {
      groups.push(current)
      current = ''
    }
    current += unit
  }
  if (current !== '') groups.push(current)
  return groups
}

function hardChunks(text: string, limit: number): string[] {
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

/** Split a reply on blank lines/newlines and sentences; 1-3 short bubbles for normal chat. */
export function splitReply(text: string, max: number): string[] {
  const limit = Math.max(100, Math.trunc(max))
  const value = String(text ?? '').trim()
  if (value === '') return []
  if (value.length > limit) return hardChunks(value, limit)

  const units: string[] = []
  for (const line of value.split(/\n+/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    units.push(...sentenceUnits(trimmed, TARGET_BUBBLE_CHARS))
  }
  if (units.length === 0) return [value]
  return partitionUnits(units, 3)
}

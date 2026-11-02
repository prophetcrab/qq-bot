/** Pure background formatting helpers. */
import type { HistoryMessage } from './types.js'

/** Background text sent to DSH (oldest first). */
export function buildBackground(list: HistoryMessage[], limit: number): string {
  return list
    .slice(-Math.max(0, limit))
    .map((message) => message.role === 'assistant'
      ? `- AI：${message.text}`
      : `- ${typeof message.name === 'string' && message.name.trim() !== '' ? message.name.trim() : '群友'}：${message.text}`)
    .join('\n')
}

/** Deduplicated image URLs from recent background messages. */
export function collectBackgroundImages(list: HistoryMessage[], limit: number): string[] {
  const urls: string[] = []
  for (const item of list.slice(-20)) {
    for (const url of item.images ?? []) {
      if (!urls.includes(url)) urls.push(url)
    }
  }
  return urls.slice(-Math.max(0, limit))
}


/** Upper bound for completed multi-turn messages (user + assistant). */
export const MAX_CONVERSATION_MESSAGES = 20

/**
 * Completed conversation turns in one thread: include messages up to the last
 * assistant reply, but never trail behind a dead user-only tail. This keeps
 * the request a real dialogue instead of a pile of unanswered group messages.
 */
export function conversationFor(list: HistoryMessage[], threadId: string | undefined, maxMessages = MAX_CONVERSATION_MESSAGES): HistoryMessage[] {
  if (typeof threadId !== 'string' || threadId === '') return []
  const relevant = list.filter((message) => message.threadId === threadId)
  let lastAssistant = -1
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    if (relevant[index].role === 'assistant') {
      lastAssistant = index
      break
    }
  }
  if (lastAssistant < 0) return []
  return relevant.slice(Math.max(0, lastAssistant - maxMessages + 1), lastAssistant + 1)
}

/** Pure background formatting helpers. */
import type { HistoryMessage } from './types.js'

/** Background text sent to DSH (oldest first). */
export function buildBackground(list: HistoryMessage[], limit: number): string {
  return list
    .slice(-Math.max(0, limit))
    .map((message) => message.role === 'assistant' ? `- AI：${message.text}` : `- ${message.name ?? '群友'}：${message.text}`)
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

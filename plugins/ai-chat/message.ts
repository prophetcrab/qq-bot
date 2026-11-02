/** Message rendering, mention/quote detection. */
import { collectImageUrls } from './media.js'
import type { MentionInfo, QuoteInfo } from './types.js'

/** Whether the current message replies to the bot. */
export function isReplyToSelf(session: any, selfId: string): boolean {
  const quote = session?.quote
  const candidates = [
    quote?.user?.id,
    quote?.userId,
    quote?.author?.id,
    quote?.member?.user?.id,
    session?.quoteUserId,
  ]
  return candidates.some((candidate) => candidate !== undefined && candidate !== null && String(candidate) === selfId)
}

/** Collect @ targets, distinguishing the bot itself from other people / @all. */
export function collectMentions(session: any, selfId: string): MentionInfo {
  const elements = Array.isArray(session?.elements) ? session.elements : []
  const others: string[] = []
  let self = false
  let all = false
  for (const element of elements) {
    if (element?.type !== 'at') continue
    const id = String(element?.attrs?.id ?? element?.attrs?.qq ?? '')
    if (id === selfId) {
      self = true
      continue
    }
    if (id === 'all') {
      all = true
      continue
    }
    if (id !== '') others.push(String(element?.attrs?.name ?? id))
  }
  return { self, others, all }
}

/** Render a message for the model while keeping @ targets. */
export function describeSessionForModel(session: any, selfId: string): string {
  const elements = Array.isArray(session?.elements) ? session.elements : []
  if (elements.length === 0) return typeof session?.content === 'string' ? session.content.trim() : ''
  const parts: string[] = []
  for (const element of elements) {
    const type = element?.type
    if (type === 'text') {
      const value = element?.attrs?.content
      if (typeof value === 'string' && value !== '') parts.push(value)
    } else if (type === 'at') {
      const id = String(element?.attrs?.id ?? element?.attrs?.qq ?? '')
      if (id === selfId) parts.push('@你')
      else if (id === 'all') parts.push('@全体成员')
      else parts.push(`@${String(element?.attrs?.name ?? (id || '某人'))}`)
    } else if (type === 'img' || type === 'image') {
      parts.push('[图片]')
    } else if (type === 'face') {
      parts.push('[表情]')
    } else if (type === 'audio' || type === 'record') {
      parts.push('[语音]')
    } else if (type === 'video') {
      parts.push('[视频]')
    } else if (type === 'file') {
      parts.push('[文件]')
    } else if (type === 'quote' || type === 'reply') {
      parts.push('[回复]')
    }
  }
  return parts.join('').trim()
}

/** Read the message the current message is replying to (OneBot quote). */
export function extractQuote(session: any, selfId: string, imageLimit: number): QuoteInfo | null {
  const raw = session?.quote
  if (raw === null || raw === undefined) return null
  const quote = typeof raw === 'string' ? { content: raw } : raw
  const elements = Array.isArray(quote.elements) ? quote.elements : []
  const text = describeSessionForModel({ elements, content: quote.content }, selfId).trim()
  const imageUrls = collectImageUrls({ elements, content: quote.content }, Math.max(0, imageLimit))
  const user = quote.user ?? quote.author ?? null
  const userId = String(user?.id ?? quote.userId ?? '')
  const userName = String(user?.name ?? user?.nickname ?? quote.userName ?? userId ?? '某人')
  if (text === '' && imageUrls.length === 0) return null
  return { userName, text, imageUrls, fromSelf: userId !== '' && userId === selfId }
}

export function senderName(session: any): string {
  return String(session?.author?.name ?? session?.username ?? session?.userId ?? '群友')
}

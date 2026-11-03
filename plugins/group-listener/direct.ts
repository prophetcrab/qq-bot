import type { TriggerReason } from './types.ts'

const DIRECT_FALLBACK_TEXT = '我在，怎么了？'

export interface DirectTarget {
  messageId?: string
  userId?: string
}

/**
 * Direct triggers always answer the exact message that mentioned/replied to
 * the bot. The sender and message id come from the queue item, never from the
 * model's output.
 */
export function ensureDirectSpeak(reason: TriggerReason, speak: any, target: DirectTarget = {}): any {
  const direct = reason === 'mention' || reason === 'reply'
  if (!direct) return speak
  const messageId = typeof target.messageId === 'string' ? target.messageId : ''
  const userId = typeof target.userId === 'string' ? target.userId : ''
  const replyType = reason === 'reply'
    ? (messageId !== '' ? 'quote' : 'normal')
    : (userId !== '' ? 'at' : messageId !== '' ? 'quote' : 'normal')
  return {
    enabled: true,
    kind: 'reply',
    replyType,
    target: {
      messageIds: messageId !== '' ? [messageId] : [],
      userIds: userId !== '' ? [userId] : [],
    },
  }
}

export function directFallbackText(reason: TriggerReason): string {
  return reason === 'mention' || reason === 'reply' ? DIRECT_FALLBACK_TEXT : ''
}

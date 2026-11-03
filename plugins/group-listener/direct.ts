import type { TriggerReason } from './types.js'

const DIRECT_FALLBACK_TEXT = '我在，怎么了？'

/** Direct triggers must produce text; action-only or disabled results are invalid. */
export function ensureDirectSpeak(reason: TriggerReason, speak: any): any {
  const direct = reason === 'mention' || reason === 'reply'
  if (!direct) return speak
  if (speak?.enabled === true && speak.kind === 'reply' && speak.replyType === 'action') {
    return { ...speak, replyType: 'normal' }
  }
  if (speak?.enabled === true) return speak
  return { enabled: true, kind: 'statement', replyType: null, target: { messageIds: [], userIds: [] } }
}

export function directFallbackText(reason: TriggerReason): string {
  return reason === 'mention' || reason === 'reply' ? DIRECT_FALLBACK_TEXT : ''
}

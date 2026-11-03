import { h } from 'koishi'
import type { Envelope, QueueItem } from './types.ts'

export interface SendResult {
  sent: boolean
  parts: number
  messageIds: string[]
  replyType?: string
  error?: string
}

export async function sendReply(item: QueueItem, speak: any, text: string): Promise<SendResult> {
  const session = item.session
  const groupId = String(session.guildId ?? session.channelId ?? '')

  if (speak.replyType === 'action') {
    try {
      const internal = session.bot?.internal
      if (typeof internal?.call !== 'function') throw new Error('send_poke unavailable')
      await internal.call('send_poke', { group_id: Number(groupId), user_id: Number(speak.target?.userIds?.[0]) })
      return { sent: true, parts: 0, messageIds: [], replyType: 'action' }
    } catch (error: any) {
      return { sent: false, parts: 0, messageIds: [], replyType: 'action', error: String(error?.message ?? error) }
    }
  }

  let content: any = text
  if (speak.replyType === 'quote' && speak.target?.messageIds?.[0]) {
    content = h('quote', { id: speak.target.messageIds[0] }) + text
  }
  if (speak.replyType === 'at' && speak.target?.userIds?.[0]) {
    content = h('at', { id: speak.target.userIds[0] }) + text
  }

  try {
    const sent = await session.send(content)
    const parts = Array.isArray(sent) ? sent.length : 1
    return {
      sent: true,
      parts,
      messageIds: Array.from({ length: parts }, (_, index) => `${item.loopId}_${index}`),
      replyType: speak.replyType,
    }
  } catch (error: any) {
    return { sent: false, parts: 0, messageIds: [], replyType: speak.replyType, error: String(error?.message ?? error) }
  }
}

export function appendBotMessage(buffer: Envelope[], groupId: string, loopId: string, text: string, selfId: string, limit: number): void {
  if (text === '') return
  const now = Date.now()
  buffer.push({
    id: `bot_${loopId}_${buffer.length}`,
    groupId,
    sender: { qq: selfId, nickname: '机器人' },
    sentAt: { iso: new Date(now).toISOString(), unix: Math.floor(now / 1000) },
    receivedAt: new Date().toISOString(),
    content: { text, quote: null, forward: null, attachments: [] },
    fromSelf: true,
  })
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
}

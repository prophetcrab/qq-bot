import { h } from 'koishi'
import type { Envelope, QueueItem } from './types.ts'

export interface SendResult {
  sent: boolean
  parts: number
  messageIds: string[]
  replyType?: string
  failedParts?: number
  bubbles?: string[]
  error?: string
}

export interface SendTiming {
  minDelayMs: number
  maxDelayMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function bubbleDelay(text: string, timing: SendTiming): number {
  const natural = timing.minDelayMs + text.length * 15
  return Math.min(timing.maxDelayMs, Math.max(timing.minDelayMs, natural))
}

function normalizeParts(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : [input]
  return list.map((part) => String(part).trim()).filter(Boolean).slice(0, 3)
}

/** Send a planned batch of 1-3 short bubbles with human-paced gaps. */
export async function sendReply(item: QueueItem, speak: any, input: string | string[], timing: SendTiming): Promise<SendResult> {
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

  const parts = normalizeParts(input)
  if (parts.length === 0) return { sent: false, parts: 0, messageIds: [], replyType: speak.replyType, error: 'empty reply' }

  const messageIds: string[] = []
  const bubbles: string[] = []
  let failedParts = 0
  let lastError = ''
  for (let index = 0; index < parts.length; index += 1) {
    await sleep(bubbleDelay(parts[index], timing))
    let content: any = parts[index]
    if (index === 0 && speak.replyType === 'quote' && speak.target?.messageIds?.[0]) {
      content = h('quote', { id: speak.target.messageIds[0] }) + content
    }
    if (index === 0 && speak.replyType === 'at' && speak.target?.userIds?.[0]) {
      content = h('at', { id: speak.target.userIds[0] }) + content
    }
    try {
      await session.send(content)
      messageIds.push(`${item.loopId}_${index}`)
      bubbles.push(parts[index])
    } catch (error: any) {
      failedParts += 1
      lastError = String(error?.message ?? error)
    }
  }
  return {
    sent: messageIds.length > 0,
    parts: messageIds.length,
    messageIds,
    bubbles,
    replyType: speak.replyType,
    ...(failedParts > 0 ? { failedParts, error: lastError } : {}),
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

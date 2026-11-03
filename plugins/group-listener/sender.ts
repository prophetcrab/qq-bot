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
  firstMinDelayMs: number
  firstMaxDelayMs: number
  minDelayMs: number
  maxDelayMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function bubbleDelay(text: string, minDelayMs: number, maxDelayMs: number): number {
  const natural = minDelayMs + text.length * 20
  return Math.min(maxDelayMs, Math.max(minDelayMs, natural))
}

function normalizeParts(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : [input]
  const parts: string[] = []
  for (const item of list) {
    for (const line of String(item).split(/\n+/u)) {
      const part = line.trim()
      if (part !== '') parts.push(part)
      if (parts.length >= 3) return parts
    }
  }
  return parts
}

/** Send a planned batch of 1-3 short bubbles with human-paced gaps. */
export async function sendReply(item: QueueItem, speak: any, input: string | string[], timing: SendTiming): Promise<SendResult> {
  const session = item.session
  const groupId = String(session.guildId ?? session.channelId ?? '')

  if (speak.replyType === 'action') {
    try {
      const internal = session.bot?.internal
      const group = Number(groupId)
      const user = Number(speak.target?.userIds?.[0])
      if (!Number.isInteger(group) || group <= 0) throw new Error('invalid group id')
      if (!Number.isInteger(user) || user <= 0) throw new Error('invalid target user id')
      if (typeof internal?._request !== 'function') throw new Error('send_poke unavailable')
      const response = await internal._request('send_poke', { group_id: group, user_id: user })
      if (response !== null && typeof response === 'object' && response.retcode !== undefined && Number(response.retcode) !== 0) {
        throw new Error(String(response.wording ?? response.message ?? `send_poke retcode ${response.retcode}`))
      }
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
    const isFirst = index === 0
    await sleep(isFirst
      ? bubbleDelay(parts[index], timing.firstMinDelayMs, timing.firstMaxDelayMs)
      : bubbleDelay(parts[index], timing.minDelayMs, timing.maxDelayMs))
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

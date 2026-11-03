import type { Envelope, Participant, Sender } from './types.ts'

const MAX_TEXT = 2000
const MAX_FORWARD_MESSAGES = 20

function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}
function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function formatLocal(unix: number): string {
  return new Date(unix * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
function timeOf(source: any): { iso: string; unix: number } {
  const raw = source.event?.time ?? source.timestamp ?? Date.now() / 1000
  const value = Number(raw)
  const unix = Number.isFinite(value) ? (value < 1e12 ? Math.floor(value) : Math.floor(value / 1000)) : Math.floor(Date.now() / 1000)
  return { iso: new Date(unix * 1000).toISOString(), unix }
}
function senderOf(source: any): Sender {
  const raw = object(source.event?.sender)
  const author = object(source.author)
  const qq = String(raw.user_id ?? raw.userId ?? author.id ?? source.userId ?? '')
  const nickname = string(raw.card) || string(raw.nickname) || string(author.name) || string(author.nickname) || string(source.username) || qq || '群友'
  return { qq, nickname }
}

function contentOf(source: any): Envelope['content'] {
  const raw = object(source)
  const elements = Array.isArray(raw.elements) ? raw.elements : Array.isArray(raw.message) ? raw.message : []
  const attachments: Array<{ type: string; summary: string; url?: string }> = []
  let text = ''
  for (const item of elements) {
    const element = object(item)
    const type = string(element.type)
    const attrs = object(element.attrs)
    if (type === 'text') text += string(attrs.content) || string(element.text)
    else if (type === 'at') text += string(attrs.id) === 'all' ? '@全体成员' : `@${string(attrs.name) || string(attrs.id) || '某人'}`
    else if (['image', 'img', 'face', 'record', 'video', 'file'].includes(type)) {
      const summary = type === 'image' || type === 'img' ? '图片' : type === 'face' ? '表情' : type === 'record' ? '语音' : type === 'video' ? '视频' : '文件'
      const url = type === 'image' || type === 'img' ? string(attrs.src ?? attrs.url ?? attrs.file) : ''
      attachments.push({ type, summary, ...(url.startsWith('http://') || url.startsWith('https://') ? { url } : {}) })
    }
  }
  if (text === '') text = string(raw.text) || string(raw.content)
  const quote = raw.quote !== undefined && raw.quote !== null ? object(raw.quote) : null
  const forward = raw.forward !== undefined && raw.forward !== null ? object(raw.forward) : null
  return {
    text: text.slice(0, MAX_TEXT),
    quote: quote === null ? null : { sender: senderOf(quote), sentAt: timeOf(quote), content: contentOf(quote) },
    forward,
    attachments,
  }
}

export function normalizeEnvelope(session: any, groupId: string): Envelope {
  return {
    id: String(session.messageId ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    groupId,
    sender: senderOf(session),
    sentAt: timeOf(session),
    receivedAt: new Date().toISOString(),
    content: contentOf(session),
  }
}

export function participantsOf(entries: Envelope[]): Participant[] {
  const seen = new Set<string>()
  const result: Participant[] = []
  for (const entry of entries) {
    if (entry.fromSelf === true || entry.sender.qq === '' || seen.has(entry.sender.qq)) continue
    seen.add(entry.sender.qq)
    result.push({ qq: entry.sender.qq, nickname: entry.sender.nickname })
  }
  return result
}

export function renderEnvelope(envelope: Envelope): string {
  const lines = [`[${formatLocal(envelope.sentAt.unix)}] ${envelope.sender.nickname}(${envelope.sender.qq})：${envelope.content.text || ''}`]
  for (const attachment of envelope.content.attachments) lines.push(`  [${attachment.summary}]`)
  const quote = object(envelope.content.quote)
  if (quote.sender) lines.push(`  ↳ 引用 ${quote.sender.nickname ?? quote.sender.qq}(${quote.sender.qq ?? ''})：${string(quote.content?.text)}`)
  const forward = object(envelope.content.forward)
  const messages = Array.isArray(forward.messages) ? forward.messages : Array.isArray(forward.content) ? forward.content : []
  if (messages.length > 0) {
    lines.push(`  ↳ 转发记录《${string(forward.title) || '聊天记录'}》：`)
    for (const item of messages.slice(0, MAX_FORWARD_MESSAGES)) {
      const message = object(item)
      const time = formatLocal(Number(message.time) || 0)
      const name = string(message.sender?.nickname) || string(message.sender?.name) || '群友'
      const qq = string(message.sender?.user_id) || string(message.sender?.qq) || ''
      lines.push(`    [${time}] ${name}(${qq})：${string(message.content) || string(message.message) || ''}`)
    }
  }
  return lines.join('\n')
}

export function renderMaterial(entries: Envelope[]): string {
  return entries.map(renderEnvelope).join('\n')
}

export function focusText(entries: Envelope[], currentId: string, targetIds: string[] = []): string {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const current = byId.get(currentId)
  const targets = [...new Set(targetIds)].map((id) => byId.get(id)).filter((entry): entry is Envelope => entry !== undefined)
  const lines: string[] = []
  if (current !== undefined) lines.push(`【当前触发消息】${renderEnvelope(current)}`)
  if (targets.length > 0) lines.push(`【回复目标消息】\n${targets.map(renderEnvelope).join('\n')}`)
  return lines.join('\n\n')
}

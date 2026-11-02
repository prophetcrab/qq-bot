/** Group message listener: buffer, trigger, per-group queue and data flow loop. */
import { Context, Schema, h } from 'koishi'
import { mkdirSync, readFileSync, writeFileSync, watchFile } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const name = 'group-listener'
export const inject: string[] = []

export interface Config {
  enabled: boolean
  groupOnly: boolean
  bufferSize: number
  countTrigger: number
  timeTriggerMinutes: number
  cooldownReplyMs: number
  cooldownNoReplyMs: number
  maxConcurrentGroups: number
  discoveryFile: string
  stateFile: string
  endpoint: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用群聊监听'),
  groupOnly: Schema.boolean().default(true).description('只监听群聊'),
  bufferSize: Schema.number().default(100).min(20).max(200).description('每群素材缓冲上限'),
  countTrigger: Schema.number().default(5).min(1).max(100).description('新增消息数触发阈值'),
  timeTriggerMinutes: Schema.number().default(30).min(1).max(240).description('时间触发窗口（分钟）'),
  cooldownReplyMs: Schema.number().default(25000).min(0).max(300000).description('发言后的群冷却'),
  cooldownNoReplyMs: Schema.number().default(7000).min(0).max(300000).description('不发言后的群冷却'),
  maxConcurrentGroups: Schema.number().default(3).min(1).max(20).description('群间并发的最大群数'),
  discoveryFile: Schema.string().default('data/state/ai.json').description('DSH AI 发现文件'),
  stateFile: Schema.string().default('data/state/group-listener-status.json').description('监听诊断状态文件'),
  endpoint: Schema.string().default('').description('DSH 地址；留空读取 discoveryFile'),
})

interface Sender { qq: string; nickname: string; card?: string }
interface Envelope {
  id: string; groupId: string; sender: Sender; sentAt: { iso: string; unix: number }; receivedAt: string
  content: { text: string; quote: any; forward: any; attachments: Array<{ type: string; summary: string }> }
  fromSelf?: boolean
}
interface QueueItem { loopId: string; reason: 'mention' | 'reply' | 'count' | 'time'; triggerMessageIds: string[]; session: any; enqueuedAt: number; priority: 'urgent' | 'normal' }
interface GroupState {
  buffer: Envelope[]
  unprocessed: number
  lastTriggerAt: number
  senders: Set<string>
  cooldownUntil: number
  running: boolean
  active: string | null
  queue: { urgent: QueueItem | null; normal: QueueItem | null }
  lastLoop: any
  lastSession: any
}

const MAX_TEXT = 2000
const formatLocal = (unix: number): string => new Date(unix * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const obj = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as any : {}
const str = (v: unknown): string => typeof v === 'string' ? v.trim() : ''
const clamp = (v: unknown, min: number, max: number): number => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : 0

function senderOf(session: any): Sender {
  const raw = obj(session.event?.sender)
  const author = obj(session.author)
  const qq = String(raw.user_id ?? raw.userId ?? author.id ?? session.userId ?? '')
  const nickname = str(raw.card) || str(raw.nickname) || str(author.name) || str(author.nickname) || str(session.username) || qq || '群友'
  return { qq, nickname }
}
function timeOf(session: any): { iso: string; unix: number } {
  const raw = session.event?.time ?? session.timestamp ?? Date.now() / 1000
  const n = Number(raw)
  const unix = Number.isFinite(n) ? (n < 1e12 ? Math.floor(n) : Math.floor(n / 1000)) : Math.floor(Date.now() / 1000)
  return { iso: new Date(unix * 1000).toISOString(), unix }
}
function elements(session: any): any[] {
  if (Array.isArray(session.elements)) return session.elements
  const event = obj(session.event)
  return Array.isArray(event.message) ? event.message : []
}
function contentOf(raw: any): Envelope['content'] {
  const source = obj(raw)
  const attachments: Array<{ type: string; summary: string }> = []
  let text = ''
  for (const item of Array.isArray(source.elements) ? source.elements : Array.isArray(source.message) ? source.message : []) {
    const e = obj(item); const type = str(e.type); const attrs = obj(e.attrs)
    if (type === 'text') text += str(attrs.content) || str(e.text)
    else if (type === 'at') text += str(attrs.id) === 'all' ? '@全体成员' : `@${str(attrs.name) || str(attrs.id) || '某人'}`
    else if (['image', 'img', 'face', 'record', 'video', 'file'].includes(type)) attachments.push({ type, summary: type === 'image' || type === 'img' ? '图片' : type === 'face' ? '表情' : type === 'record' ? '语音' : type === 'video' ? '视频' : '文件' })
  }
  if (text === '') text = str(source.text) || str(source.content)
  const quote = source.quote !== undefined && source.quote !== null ? obj(source.quote) : null
  const forward = source.forward !== undefined && source.forward !== null ? obj(source.forward) : null
  return { text: text.slice(0, MAX_TEXT), quote: quote === null ? null : { sender: senderOf(quote), sentAt: timeOf(quote), content: contentOf(quote) }, forward, attachments }
}
function normalize(session: any, groupId: string): Envelope {
  const time = timeOf(session)
  return { id: String(session.messageId ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`), groupId, sender: senderOf(session), sentAt: time, receivedAt: new Date().toISOString(), content: contentOf(session) }
}
function renderEnvelope(e: Envelope, depth = 0): string {
  const indent = '  '.repeat(depth)
  const lines = [`${indent}[${formatLocal(e.sentAt.unix)}] ${e.sender.nickname}(${e.sender.qq})：${e.content.text || ''}`]
  for (const a of e.content.attachments) lines.push(`${indent}  [${a.summary}]`)
  const quote = obj(e.content.quote)
  if (quote.sender) {
    lines.push(`${indent}  ↳ 引用 ${quote.sender.nickname ?? quote.sender.qq}(${quote.sender.qq ?? ''})：${str(quote.content?.text)}`)
  }
  const forward = obj(e.content.forward)
  const messages = Array.isArray(forward.messages) ? forward.messages : Array.isArray(forward.content) ? forward.content : []
  if (messages.length > 0) {
    lines.push(`${indent}  ↳ 转发记录《${str(forward.title) || '聊天记录'}》：`)
    for (const item of messages.slice(0, 20)) {
      const m = obj(item)
      lines.push(`${indent}    [${formatLocal(Number(m.time) || 0)}] ${str(m.sender?.nickname) || str(m.sender?.name) || '群友'}(${str(m.sender?.user_id) || str(m.sender?.qq) || ''})：${str(m.content) || str(m.message) || ''}`)
    }
  }
  void depth
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('group-listener')
  const discoveryPath = resolve(process.cwd(), config.discoveryFile)
  const statePath = resolve(process.cwd(), config.stateFile)
  const groups = new Map<string, GroupState>()
  const recentLoops: any[] = []
  const global = { active: 0, waiting: 0 }
  let endpoint = config.endpoint
  const readDiscovery = (): string => {
    if (endpoint !== '') return endpoint
    try { const parsed = JSON.parse(readFileSync(discoveryPath, 'utf8')); if (typeof parsed.endpoint === 'string') endpoint = parsed.endpoint } catch { /* noop */ }
    return endpoint
  }
  try { watchFile(discoveryPath, { interval: 2000 }, () => { endpoint = config.endpoint; readDiscovery() }) } catch { /* noop */ }
  const base = (): string => { const value = readDiscovery(); if (value === '') return ''; try { return new URL(value).origin } catch { return '' } }
  const api = async (path: string, body: any): Promise<any> => {
    const origin = base()
    if (origin === '') return { ok: false, error: 'DSH endpoint not ready' }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000); timer.unref?.()
    try {
      const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      const data = await response.json().catch(() => null)
      return data !== null && typeof data === 'object' ? data : { ok: false, error: `HTTP ${response.status}` }
    } catch (error: any) { return { ok: false, error: String(error?.message ?? error) } } finally { clearTimeout(timer) }
  }
  const stateOf = (key: string): GroupState => {
    let state = groups.get(key)
    if (state === undefined) {
      state = { buffer: [], unprocessed: 0, lastTriggerAt: Date.now(), senders: new Set(), cooldownUntil: 0, running: false, active: null, queue: { urgent: null, normal: null }, lastLoop: null, lastSession: null }
      groups.set(key, state)
    }
    return state
  }
  const persist = (): void => {
    const groupsView: Record<string, any> = {}
    for (const [id, g] of groups) groupsView[id] = { bufferSize: g.buffer.length, unprocessed: g.unprocessed, running: g.running, active: g.active, cooldownUntil: g.cooldownUntil, queue: { urgent: g.queue.urgent?.reason ?? null, normal: g.queue.normal?.reason ?? null }, lastLoop: g.lastLoop }
    const payload = { updatedAt: new Date().toISOString(), global: { ...global, groups: groups.size }, groups: groupsView, loops: recentLoops.slice(-30) }
    try { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8') } catch { /* diagnostics only */ }
  }
  const resetCounters = (g: GroupState): void => { g.unprocessed = 0; g.lastTriggerAt = Date.now(); g.senders.clear() }
  const enqueueDirect = (key: string, messageId: string, session: any, reason: 'mention' | 'reply'): void => {
    const g = stateOf(key)
    const item = { loopId: `loop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, reason, triggerMessageIds: [messageId], session, enqueuedAt: Date.now(), priority: 'urgent' as const }
    if (g.queue.urgent !== null) g.queue.urgent.triggerMessageIds = [...new Set([...g.queue.urgent.triggerMessageIds, messageId])]
    else g.queue.urgent = item
    g.queue.normal = null
    resetCounters(g); persist(); void wake(key)
  }
  const enqueueNormal = (key: string, messageId: string, session: any, reason: 'count' | 'time'): void => {
    const g = stateOf(key)
    if (g.queue.urgent !== null) return
    if (g.queue.normal !== null) { g.queue.normal.triggerMessageIds = [...new Set([...g.queue.normal.triggerMessageIds, messageId])]; return }
    g.queue.normal = { loopId: `loop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, reason, triggerMessageIds: [messageId], session, enqueuedAt: Date.now(), priority: 'normal' }
    resetCounters(g); persist(); void wake(key)
  }
  const materialOf = (g: GroupState, item: QueueItem): string => {
    const target = item.triggerMessageIds[item.triggerMessageIds.length - 1]
    const index = g.buffer.findIndex((entry) => entry.id === target)
    const list = index >= 0 ? g.buffer.slice(Math.max(0, index - config.bufferSize + 1), index + 1) : g.buffer.slice(-config.bufferSize)
    return list.map(renderEnvelope).join('\n')
  }
  const appendBot = (g: GroupState, key: string, loopId: string, text: string, at: number): void => {
    if (text === '') return
    g.buffer.push({ id: `bot_${loopId}_${g.buffer.length}`, groupId: key, sender: { qq: String((ctx as any).bots?.[0]?.selfId ?? ''), nickname: '机器人' }, sentAt: { iso: new Date(at).toISOString(), unix: Math.floor(at / 1000) }, receivedAt: new Date().toISOString(), content: { text, quote: null, forward: null, attachments: [] }, fromSelf: true })
    if (g.buffer.length > config.bufferSize) g.buffer.splice(0, g.buffer.length - config.bufferSize)
  }
  const sendReply = async (item: QueueItem, speak: any, text: string): Promise<any> => {
    const session = item.session
    const groupId = String(session.guildId ?? session.channelId ?? '')
    if (speak.replyType === 'action') {
      try {
        const internal = session.bot?.internal
        if (typeof internal?.call === 'function') await internal.call('send_poke', { group_id: Number(groupId), user_id: Number(speak.target?.userIds?.[0]) })
        else throw new Error('send_poke unavailable')
        return { sent: true, parts: 0, messageIds: [], replyType: 'action' }
      } catch (error: any) { return { sent: false, parts: 0, messageIds: [], replyType: 'action', error: String(error?.message ?? error) } }
    }
    let content: any = text
    if (speak.replyType === 'quote' && speak.target?.messageIds?.[0]) content = h('quote', { id: speak.target.messageIds[0] }) + text
    if (speak.replyType === 'at' && speak.target?.userIds?.[0]) content = h('at', { id: speak.target.userIds[0] }) + text
    try {
      const sent = await session.send(content)
      const parts = Array.isArray(sent) ? sent.length : 1
      return { sent: true, parts, messageIds: Array.from({ length: parts }, (_, i) => `${item.loopId}_${i}`), replyType: speak.replyType }
    } catch (error: any) { return { sent: false, parts: 0, messageIds: [], replyType: speak.replyType, error: String(error?.message ?? error) } }
  }
  const runLoop = async (key: string, item: QueueItem): Promise<void> => {
    const g = stateOf(key)
    g.active = item.loopId; global.active += 1; persist()
    const material = materialOf(g, item)
    const startedAt = Date.now()
    let speak: any = { enabled: false }
    let reply = ''
    let sendResult: any = { sent: false, reason: 'no_speak' }
    try {
      const analysis = await api('/qqbot/group/analyze', { loopId: item.loopId, groupId: key, trigger: { reason: item.reason, messageId: item.triggerMessageIds[item.triggerMessageIds.length - 1] }, material })
      if (analysis?.ok === true) speak = analysis.speak ?? { enabled: false }
      if (speak.enabled === true) {
        const composed = await api('/qqbot/group/compose', { loopId: item.loopId, groupId: key, material, speak })
        if (composed?.ok === true && typeof composed.text === 'string') {
          reply = composed.text.trim()
          if (speak.replyType === 'action' || reply !== '') sendResult = await sendReply(item, speak, reply)
        } else sendResult = { sent: false, reason: 'compose_failed', error: composed?.error }
      }
    } catch (error: any) { sendResult = { sent: false, reason: 'loop_failed', error: String(error?.message ?? error) } }
    if (sendResult.sent === true) appendBot(g, key, item.loopId, reply, Date.now())
    const stateResult = await api('/qqbot/group/state-update', { loopId: item.loopId, groupId: key, material, speak, sendResult })
    const finishedAt = Date.now()
    const loop = { at: new Date().toISOString(), loopId: item.loopId, groupId: key, trigger: item.reason, materialCount: g.buffer.length, speak, reply, sendResult, stateUpdate: stateResult, analysisMs: finishedAt - startedAt }
    g.lastLoop = loop; recentLoops.push(loop); if (recentLoops.length > 30) recentLoops.shift()
    g.cooldownUntil = finishedAt + (sendResult.sent === true ? config.cooldownReplyMs : config.cooldownNoReplyMs)
    g.active = null; global.active = Math.max(0, global.active - 1); persist()
  }
  const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
  const wake = async (key: string): Promise<void> => {
    const g = stateOf(key)
    if (g.running) return
    g.running = true
    try {
      for (;;) {
        const item = g.queue.urgent ?? g.queue.normal
        if (item === undefined || item === null) break
        if (g.queue.urgent === item) g.queue.urgent = null
        else g.queue.normal = null
        if (item.priority === 'normal' && Date.now() < g.cooldownUntil) {
          await sleep(Math.min(30000, Math.max(1, g.cooldownUntil - Date.now())))
          if (g.queue.urgent !== null) continue
          if (Date.now() < g.cooldownUntil) { continue }
        }
        while (global.active >= config.maxConcurrentGroups) await sleep(100)
        await runLoop(key, item)
      }
    } finally { g.running = false; persist() }
  }

  ctx.middleware(async (session, next) => {
    if (!config.enabled) return next()
    if (session.userId === session.selfId || session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()
    const key = String(session.guildId ?? session.channelId ?? '')
    if (key === '') return next()
    const content = str(session.content) || str(session.elements?.find((e: any) => e.type === 'text')?.attrs?.content)
    if (content.startsWith('/')) return next()
    const g = stateOf(key)
    g.lastSession = session
    const envelope = normalize(session, key)
    g.buffer.push(envelope); if (g.buffer.length > config.bufferSize) g.buffer.splice(0, g.buffer.length - config.bufferSize)
    g.unprocessed += 1; g.senders.add(envelope.sender.qq)
    const mentioned = Array.isArray(session.elements) && session.elements.some((e: any) => e.type === 'at' && String(e.attrs?.id ?? e.attrs?.qq ?? '') === String(session.selfId))
    const replied = String((session.quote as any)?.user?.id ?? (session.quote as any)?.userId ?? '') === String(session.selfId)
    if (mentioned || replied) enqueueDirect(key, envelope.id, session, mentioned ? 'mention' : 'reply')
    else if (g.unprocessed >= config.countTrigger) enqueueNormal(key, envelope.id, session, 'count')
    persist()
    return next()
  })
  const ticker = setInterval(() => {
    const now = Date.now()
    for (const [key, g] of groups) {
      if (g.running || g.unprocessed === 0 || g.senders.size < 2) continue
      if (now - g.lastTriggerAt < config.timeTriggerMinutes * 60 * 1000) continue
      const latest = g.buffer[g.buffer.length - 1]
      if (latest !== undefined && g.lastSession !== null) enqueueNormal(key, latest.id, g.lastSession, 'time')
    }
  }, 15000); ticker.unref?.()
  ctx.on('dispose', () => clearInterval(ticker))
}

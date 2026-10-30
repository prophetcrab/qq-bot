/**
 * AI 群聊插件。
 *
 * - 每个 (群, QQ) 的长期画像由 DSH 侧维护并在系统提示词第二段注入
 * - 群聊最近最多 100 条作为背景上下文；只针对当前消息回复
 * - 触发规则：@机器人 / 回复机器人 必定触发；否则按 replyProbability 随机；
 *   对某人回复后，接下来 followUpMinutes 分钟内此人的消息继续回复
 * - 支持把当前消息里的图片送给 DSH 多模态模型
 */
import { Context, Schema, h } from 'koishi'
import { mkdirSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const name = 'ai-chat'
export const inject: string[] = []

export interface Config {
  enabled: boolean
  replyProbability: number
  followUpMinutes: number
  groupOnly: boolean
  historyLimit: number
  maxReplyChars: number
  timeoutMs: number
  endpoint: string
  discoveryFile: string
  stateFile: string
  settingsFile: string
  systemPrompt: string
  imageLimit: number
  imageMaxBytes: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 AI 聊天'),
  replyProbability: Schema.number().default(0.15).min(0).max(1)
    .description('未被 @ / 回复 时的随机回复概率（0~1）'),
  followUpMinutes: Schema.number().default(3).min(0).max(60)
    .description('回复某人后，多少分钟内继续回复此人的消息'),
  groupOnly: Schema.boolean().default(true).description('是否只处理群聊'),
  historyLimit: Schema.number().default(100).min(0).max(200)
    .description('向上保留并发送的群聊背景消息条数（最多 100 条）'),
  maxReplyChars: Schema.number().default(1200).min(100).max(4000)
    .description('单条回复最大字符数（超长自动分条）'),
  timeoutMs: Schema.number().default(120000).min(5000).max(600000)
    .description('调用 DSH AI 桥的超时时间'),
  endpoint: Schema.string().default('').description('DSH AI 桥地址；留空则读取 discoveryFile'),
  discoveryFile: Schema.string().default('data/ai.json').description('DSH 写入的 AI 桥发现文件（相对项目根目录）'),
  stateFile: Schema.string().default('data/ai-chat-state.json').description('AI 监听/回复诊断状态文件（相对项目根目录）'),
  settingsFile: Schema.string().default('data/ai-settings.json').description('DSH 面板写入的运行时回复设置（概率/跟进/上下文）'),
  systemPrompt: Schema.string().default('').description('额外系统提示词；留空使用 DSH 侧默认'),
  imageLimit: Schema.number().default(4).min(0).max(6).description('每条消息最多读取的图片数'),
  imageMaxBytes: Schema.number().default(6 * 1024 * 1024).min(1024 * 1024).max(10 * 1024 * 1024)
    .description('单张图片最大字节数'),
})

interface HistoryMessage {
  role: 'user' | 'assistant'
  name?: string
  text: string
}

interface Discovery {
  endpoint?: string
  provider?: string
  model?: string
}

interface InboundImage {
  mediaType: string
  data: string
}

interface RuntimeSettings {
  enabled: boolean
  replyProbability: number
  followUpMinutes: number
  historyLimit: number
}

function clampNumber(value: any, fallback: number, min: number, max: number, truncate = false): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const bounded = Math.min(max, Math.max(min, number))
  return truncate ? Math.trunc(bounded) : Math.round(bounded * 1000) / 1000
}

function loadRuntimeSettings(file: string, config: Config): RuntimeSettings {
  const fallback: RuntimeSettings = {
    enabled: config.enabled,
    replyProbability: clampNumber(config.replyProbability, 0.15, 0, 1),
    followUpMinutes: clampNumber(config.followUpMinutes, 3, 0, 60, true),
    historyLimit: clampNumber(config.historyLimit, 100, 0, 200, true),
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      enabled: parsed.enabled === undefined ? fallback.enabled : parsed.enabled === true,
      replyProbability: clampNumber(parsed.replyProbability, fallback.replyProbability, 0, 1),
      followUpMinutes: clampNumber(parsed.followUpMinutes, fallback.followUpMinutes, 0, 60, true),
      historyLimit: clampNumber(parsed.historyLimit, fallback.historyLimit, 0, 200, true),
    }
  } catch {
    return fallback
  }
}

function readDiscovery(file: string): Discovery | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.endpoint === 'string' && parsed.endpoint !== '') {
      return {
        endpoint: parsed.endpoint,
        provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
      }
    }
  } catch {
    // file missing / not yet written
  }
  return null
}

/** 按长度/换行把长回复拆成 QQ 可发送的片段。 */
export function splitReply(text: string, max: number): string[] {
  const limit = Math.max(100, Math.trunc(max))
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).replace(/^\n+/u, '')
  }
  if (rest !== '') parts.push(rest)
  return parts.filter((part) => part !== '')
}

function hasMention(session: any, selfId: string): boolean {
  const elements = Array.isArray(session.elements) ? session.elements : []
  return elements.some((element: any) => element?.type === 'at' && String(element?.attrs?.id ?? '') === selfId)
}

/** 是否在回复机器人的消息（引用消息的发送者是机器人）。 */
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

function senderName(session: any): string {
  return String(session?.author?.name ?? session?.username ?? session?.userId ?? '群友')
}

/** Image URLs present on the current message. */
export function collectImageUrls(session: any, limit: number): string[] {
  const elements = Array.isArray(session?.elements) ? session.elements : []
  const urls: string[] = []
  for (const element of elements) {
    if (element?.type !== 'image' && element?.type !== 'img') continue
    const raw = element?.attrs?.src ?? element?.attrs?.url ?? element?.attrs?.file
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!/^https?:\/\//iu.test(url)) continue
    if (!urls.includes(url)) urls.push(url)
    if (urls.length >= limit) break
  }
  return urls
}

function mediaTypeOf(contentType: string | null, url: string): string {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp' || type === 'image/gif') return type
  const match = /\.(jpe?g|png|webp|gif)(?:\?|$)/iu.exec(url)
  if (match !== null) {
    const ext = match[1].toLowerCase()
    if (ext === 'jpg') return 'image/jpeg'
    return `image/${ext}`
  }
  return 'image/jpeg'
}

/** Download current-message images for multimodal inference. */
export async function downloadImages(session: any, config: Config, fetchImpl: typeof fetch = fetch): Promise<InboundImage[]> {
  const urls = collectImageUrls(session, Math.max(0, config.imageLimit))
  const images: InboundImage[] = []
  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      timer.unref?.()
      let response: Response
      try {
        response = await fetchImpl(url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (response.ok !== true) continue
      const type = mediaTypeOf(response.headers.get('content-type'), url)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0 || buffer.byteLength > config.imageMaxBytes) continue
      images.push({ mediaType: type, data: buffer.toString('base64') })
    } catch {
      // ignore a broken image; text still goes through
    }
  }
  return images
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ai-chat')
  const history = new Map<string, HistoryMessage[]>()
  const replyQueues = new Map<string, Promise<void>>()
  const followUntil = new Map<string, number>()
  const discoveryPath = resolve(process.cwd(), config.discoveryFile)
  const statePath = resolve(process.cwd(), config.stateFile)
  const settingsPath = resolve(process.cwd(), config.settingsFile)
  let discovery: Discovery | null = readDiscovery(discoveryPath)
  let runtime = loadRuntimeSettings(settingsPath, config)

  const state: any = { replyProbability: runtime.replyProbability, followUpMinutes: runtime.followUpMinutes, lastInbound: null, lastReply: null, updatedAt: null }
  const persistState = (): void => {
    try {
      state.updatedAt = new Date().toISOString()
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } catch {
      // diagnostics only
    }
  }

  try {
    watchFile(settingsPath, { interval: 1000 }, () => {
      runtime = loadRuntimeSettings(settingsPath, config)
      logger.info('AI 回复设置已更新：概率 %s / 跟进 %s 分钟 / 上下文 %s 条', runtime.replyProbability, runtime.followUpMinutes, runtime.historyLimit)
    }).unref?.()
  } catch {
    // ignore
  }

  try {
    watchFile(discoveryPath, { interval: 2000 }, () => {
      const next = readDiscovery(discoveryPath)
      if (next !== null) {
        discovery = next
        logger.info('AI 桥已就绪：%s (%s/%s)', next.endpoint, next.provider ?? '?', next.model ?? '?')
      }
    }).unref?.()
  } catch {
    // ignore
  }

  const endpointOf = (): string | null => {
    if (config.endpoint !== '') return config.endpoint
    discovery = readDiscovery(discoveryPath) ?? discovery
    return discovery?.endpoint ?? null
  }

  const keyOf = (session: any): string => String(session?.guildId ?? session?.channelId ?? session?.userId ?? 'unknown')
  const followKey = (session: any): string => `${keyOf(session)}:${String(session?.userId ?? '')}`

  const pushHistory = (key: string, message: HistoryMessage): void => {
    const list = history.get(key) ?? []
    list.push(message)
    const cap = Math.max(2, runtime.historyLimit * 2 + 2)
    if (list.length > cap) list.splice(0, list.length - cap)
    history.set(key, list)
  }

  const buildRequestMessages = (key: string, current: HistoryMessage): HistoryMessage[] => {
    const background = (history.get(key) ?? []).slice(-Math.max(0, runtime.historyLimit))
    return [
      ...background.map((item) => ({
        role: item.role,
        text: `[背景] ${item.role === 'assistant' ? 'AI' : item.name ?? '群友'}：${item.text}`,
      })),
      { role: 'user', text: `[当前消息] ${current.name ?? '群友'}：${current.text}` },
    ]
  }

  ctx.middleware(async (session, next) => {
    if (!runtime.enabled) return next()
    if (session.userId === session.selfId) return next()
    if (session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()

    const elements = Array.isArray(session.elements) ? session.elements : []
    const rawText = h.select(elements, 'text').join('').trim()
    const content = rawText !== '' ? rawText : (typeof session.content === 'string' ? session.content.trim() : '')
    const key = keyOf(session)
    const name = senderName(session)
    const isCommand = content.startsWith('/')
    const imageUrls = collectImageUrls(session, config.imageLimit)

    const mentioned = hasMention(session, String(session.selfId))
    const replied = isReplyToSelf(session, String(session.selfId))
    const forced = mentioned || replied
    const inFollowUp = (followUntil.get(followKey(session)) ?? 0) > Date.now()
    const hasContent = content !== '' || imageUrls.length > 0
    const userBusy = replyQueues.has(followKey(session))
    const randomHit = !forced && !inFollowUp && !userBusy && hasContent && Math.random() < runtime.replyProbability
    const shouldReply = !isCommand && hasContent && (forced || inFollowUp || userBusy || randomHit)
    const reason = forced ? (mentioned ? 'mention' : 'reply') : inFollowUp ? 'follow-up' : userBusy ? 'queued' : randomHit ? 'probability' : 'none'

    state.lastInbound = {
      at: new Date().toISOString(),
      groupId: key,
      userId: String(session.userId ?? ''),
      sender: name,
      text: content.slice(0, 200),
      mention: mentioned,
      replyToBot: replied,
      followUp: inFollowUp,
      images: imageUrls.length,
      replyProbability: runtime.replyProbability,
      shouldReply,
      reason,
    }
    persistState()

    if (!shouldReply) {
      if (content !== '' && !isCommand && content.length <= 2000) {
        pushHistory(key, { role: 'user', name, text: content })
      }
      return next()
    }

    const userKey = followKey(session)
    await enqueueReply(userKey, () => processReply({ session, key, name, content, imageUrls }))
    return
  })

  /** Run a task after this person's previous reply attempt, without blocking others. */
  function enqueueReply(userKey: string, task: () => Promise<void>): Promise<void> {
    const previous = replyQueues.get(userKey) ?? Promise.resolve()
    const next = previous.then(task, task).finally(() => {
      if (replyQueues.get(userKey) === next) replyQueues.delete(userKey)
    })
    replyQueues.set(userKey, next)
    return next
  }

  async function processReply({ session, key, name, content, imageUrls }: any): Promise<void> {
    const prompt = content !== '' ? content : '（对方发送了图片但没有文字）'
    const endpoint = endpointOf()
    if (endpoint === null) {
      await session.send('AI 还没有连接上 DSH（请在 DSH 面板确认 AI 状态，或重启 Koishi）')
      return
    }
    const current: HistoryMessage = { role: 'user', name, text: prompt }
    const messages = buildRequestMessages(key, current)
    try {
      const images = imageUrls.length > 0 ? await downloadImages(session, config) : []
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(5000, config.timeoutMs))
      timer.unref?.()
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages,
            images,
            groupId: key,
            userId: String(session.userId ?? ''),
            userName: name,
            ...(config.systemPrompt !== '' ? { system: config.systemPrompt } : {}),
          }),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      const data: any = await response.json().catch(() => null)
      if (data === null || data.ok !== true || typeof data.reply !== 'string') {
        const error = String(data?.error ?? `HTTP ${response.status}`)
        logger.warn('AI 回复失败：%s', error)
        state.lastReply = { at: new Date().toISOString(), ok: false, error: error.slice(0, 200) }
        persistState()
        await session.send(`AI 暂时不可用：${error.slice(0, 200)}`)
        return
      }
      const reply = String(data.reply).trim()
      if (reply === '') return
      const followMs = runtime.followUpMinutes * 60 * 1000
      if (followMs > 0) followUntil.set(followKey(session), Date.now() + followMs)
      pushHistory(key, current)
      pushHistory(key, { role: 'assistant', text: reply })
      state.lastReply = { at: new Date().toISOString(), ok: true, replyPreview: reply.slice(0, 200), followUpUntil: followUntil.get(followKey(session)) ?? null }
      persistState()
      for (const part of splitReply(reply, config.maxReplyChars)) {
        await session.send(part)
      }
      logger.debug('AI 回复群 %s：%s', key, reply.slice(0, 120))
    } catch (error: any) {
      const message = String(error?.message ?? error)
      logger.warn('AI 调用异常：%s', message)
      state.lastReply = { at: new Date().toISOString(), ok: false, error: message.slice(0, 200) }
      persistState()
      await session.send(`AI 调用失败：${message.slice(0, 200)}`)
    }
  }
}
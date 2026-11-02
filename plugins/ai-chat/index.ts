/**
 * AI 群聊插件（编排入口）。
 *
 * 触发策略、上下文、媒体下载、DSH HTTP 网关、发送策略分别位于同级模块。
 */
import { Context } from 'koishi'
import { mkdirSync, watchFile, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadRuntimeSettings, readDiscovery } from './config.js'
import type { Config } from './config.js'
import { sanitizeReplyText, splitReply } from './delivery.js'
import { collectMentions, describeSessionForModel, extractQuote, isReplyToSelf, senderName } from './message.js'
import { collectImageUrls, downloadImageUrls } from './media.js'
import { postAi } from './gateway.js'
import type { AiPayload } from './gateway.js'
import { decideTrigger } from './trigger.js'
import { buildBackground, collectBackgroundImages } from './context.js'
import type { Discovery, HistoryMessage, PendingBatch } from './types.js'

export { Config } from './config.js'
export { sanitizeReplyText, splitReply } from './delivery.js'
export { collectMentions, describeSessionForModel, extractQuote, isReplyToSelf } from './message.js'
export { collectImageUrls, downloadImageUrls, downloadImages } from './media.js'

export const name = 'ai-chat'
export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ai-chat')
  const history = new Map<string, HistoryMessage[]>()
  const replyQueues = new Map<string, Promise<void>>()
  const batches = new Map<string, PendingBatch>()
  const followUntil = new Map<string, number>()
  const discoveryPath = resolve(process.cwd(), config.discoveryFile)
  const statePath = resolve(process.cwd(), config.stateFile)
  const settingsPath = resolve(process.cwd(), config.settingsFile)
  let discovery: Discovery | null = readDiscovery(discoveryPath)
  let runtime = loadRuntimeSettings(settingsPath, config)

  const state: any = {
    replyProbability: runtime.replyProbability,
    followUpMinutes: runtime.followUpMinutes,
    batchWindowMs: runtime.batchWindowMs,
    batchMaxWaitMs: runtime.batchMaxWaitMs,
    lastInbound: null,
    lastReply: null,
    updatedAt: null,
  }
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
      logger.info('AI 回复设置已更新：概率 %s / 跟进 %s 分钟 / 上下文 %s 条 / 合并 %s–%s ms', runtime.replyProbability, runtime.followUpMinutes, runtime.historyLimit, runtime.batchWindowMs, runtime.batchMaxWaitMs)
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

  const backgroundFor = (key: string): string => buildBackground(history.get(key) ?? [], runtime.historyLimit)
  const backgroundImagesFor = (key: string): string[] => collectBackgroundImages(history.get(key) ?? [], config.imageLimit)

  const scheduleBatch = (userKey: string): void => {
    const batch = batches.get(userKey)
    if (batch === undefined) return
    clearTimeout(batch.timer)
    const now = Date.now()
    const windowMs = Math.max(0, runtime.batchWindowMs)
    const maxWaitMs = Math.max(windowMs, runtime.batchMaxWaitMs)
    const deadline = Math.min(now + windowMs, batch.firstAt + maxWaitMs)
    if (deadline <= now) {
      flushBatch(userKey)
      return
    }
    batch.timer = setTimeout(() => { flushBatch(userKey) }, deadline - now)
    batch.timer.unref?.()
  }

  const flushBatch = (userKey: string): void => {
    const batch = batches.get(userKey)
    if (batch === undefined) return
    clearTimeout(batch.timer)
    batches.delete(userKey)
    if (batch.texts.length === 0 && batch.imageUrls.length === 0) return
    const content = batch.texts.join('\n')
    void enqueueReply(userKey, () => processReply({
      session: batch.lastSession,
      key: batch.key,
      name: batch.name,
      content: content !== '' ? content : '（对方发送了图片但没有文字）',
      imageUrls: batch.imageUrls,
      texts: batch.texts.length > 0 ? batch.texts : ['（对方发送了图片但没有文字）'],
    }))
  }

  ctx.middleware(async (session, next) => {
    if (!runtime.enabled) return next()
    if (session.userId === session.selfId) return next()
    if (session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()

    const elements = Array.isArray(session.elements) ? session.elements : []
    const displayContent = describeSessionForModel(session, String(session.selfId))
    const content = displayContent !== '' ? displayContent : (typeof session.content === 'string' ? session.content.trim() : '')
    const key = keyOf(session)
    const name = senderName(session)
    const isCommand = content.startsWith('/')
    const imageUrls = collectImageUrls(session, config.imageLimit)
    const userKey = followKey(session)
    const activeBatch = batches.get(userKey)
    if (!isCommand && activeBatch !== undefined && (content !== '' || imageUrls.length > 0)) {
      if (content !== '') activeBatch.texts.push(content)
      for (const url of imageUrls) if (!activeBatch.imageUrls.includes(url)) activeBatch.imageUrls.push(url)
      activeBatch.imageUrls = activeBatch.imageUrls.slice(0, config.imageLimit)
      activeBatch.lastSession = session
      activeBatch.name = name
      scheduleBatch(userKey)
      return
    }

    const mentions = collectMentions(session, String(session.selfId))
    const mentioned = mentions.self
    const replied = isReplyToSelf(session, String(session.selfId))
    const inFollowUp = (followUntil.get(followKey(session)) ?? 0) > Date.now()
    const hasContent = content !== '' || imageUrls.length > 0
    const userBusy = replyQueues.has(followKey(session))
    const trigger = decideTrigger({
      isCommand,
      hasContent,
      mentioned,
      replied,
      inFollowUp,
      userBusy,
      replyProbability: runtime.replyProbability,
    })
    const shouldReply = trigger.shouldReply
    const reason = trigger.reason

    state.lastInbound = {
      at: new Date().toISOString(),
      groupId: key,
      userId: String(session.userId ?? ''),
      sender: name,
      text: content.slice(0, 200),
      mention: mentioned,
      mentions: mentions.others,
      mentionAll: mentions.all,
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
        pushHistory(key, { role: 'user', name, text: content, ...(imageUrls.length > 0 ? { images: imageUrls } : {}) })
      }
      return next()
    }

    if (runtime.batchWindowMs > 0) {
      batches.set(userKey, {
        texts: content !== '' ? [content] : [],
        imageUrls: [...imageUrls],
        lastSession: session,
        key,
        name,
        firstAt: Date.now(),
        timer: null,
      })
      scheduleBatch(userKey)
      return
    }
    await enqueueReply(userKey, () => processReply({ session, key, name, content, imageUrls, texts: [content] }))
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

  async function processReply({ session, key, name, content, imageUrls, texts }: any): Promise<void> {
    const prompt = content !== '' ? content : '（对方发送了图片但没有文字）'
    const endpoint = endpointOf()
    if (endpoint === null) {
      await session.send('AI 还没有连接上 DSH（请在 DSH 面板确认 AI 状态，或重启 Koishi）')
      return
    }
    const current: HistoryMessage = { role: 'user', name, text: prompt }
    const messages: HistoryMessage[] = [{ role: 'user', text: prompt }]
    const background = backgroundFor(key)
    const shareMentions = collectMentions(session, String(session.selfId))
    const replyToBot = isReplyToSelf(session, String(session.selfId))
    try {
      const currentUrls = Array.isArray(imageUrls) ? imageUrls : []
      const quote = extractQuote(session, String(session.selfId), config.imageLimit)
      const backgroundUrls = backgroundImagesFor(key).filter((url) => !currentUrls.includes(url) && !(quote?.imageUrls ?? []).includes(url))
      const images = currentUrls.length > 0 ? await downloadImageUrls(currentUrls, config) : []
      const backgroundImages = backgroundUrls.length > 0 ? await downloadImageUrls(backgroundUrls, config) : []
      const quotedUrls = (quote?.imageUrls ?? []).filter((url) => !currentUrls.includes(url))
      const quotedImages = quotedUrls.length > 0 ? await downloadImageUrls(quotedUrls, config) : []
      const payload: AiPayload = {
        apiVersion: 1,
        messages,
        background,
        images,
        backgroundImages,
        quotedImages,
        quote: quote === null ? null : {
          userName: quote.userName,
          text: quote.text,
          fromSelf: quote.fromSelf,
          imageCount: quotedImages.length,
        },
        groupId: key,
        userId: String(session.userId ?? ''),
        userName: name,
        mentionSelf: shareMentions.self,
        mentionOthers: shareMentions.others,
        mentionAll: shareMentions.all,
        replyToBot,
        ...(config.systemPrompt !== '' ? { system: config.systemPrompt } : {}),
      }
      const bridge = await postAi(endpoint, payload, config)
      if (bridge.ok !== true) throw new Error(bridge.error ?? 'AI bridge request failed')
      const data: any = bridge.data

      if (data !== null && data.ok !== true && (data.code === 'BUSY' || data.retryable === true)) {
        const reason = String(data.error ?? '模型服务繁忙')
        logger.warn('AI 服务繁忙，本次不发送错误提示：%s', reason)
        state.lastReply = { at: new Date().toISOString(), ok: false, busy: true, error: reason.slice(0, 200) }
        persistState()
        return
      }
      if (data !== null && data.ok === true && data.skipped === true) {
        const reason = String(data.reason ?? '人设判断不需要回复')
        logger.info('AI 自检决定不回复：%s', reason)
        const historyTexts = Array.isArray(texts) && texts.length > 0 ? texts : [current.text]
        for (const text of historyTexts) pushHistory(key, { role: 'user', name, text })
        state.lastReply = { at: new Date().toISOString(), ok: true, skipped: true, reason: reason.slice(0, 200) }
        persistState()
        return
      }
      if (data === null || data.ok !== true || typeof data.reply !== 'string') {
        const error = String(data?.error ?? `HTTP ${bridge.status}`)
        logger.warn('AI 回复失败：%s', error)
        state.lastReply = { at: new Date().toISOString(), ok: false, error: error.slice(0, 200) }
        persistState()
        await session.send(`AI 暂时不可用：${error.slice(0, 200)}`)
        return
      }
      const reply = sanitizeReplyText(String(data.reply).trim())
      if (reply === '') return
      const followMs = runtime.followUpMinutes * 60 * 1000
      if (followMs > 0) followUntil.set(followKey(session), Date.now() + followMs)
      const historyTexts = Array.isArray(texts) && texts.length > 0 ? texts : [current.text]
      const historyImages = Array.isArray(imageUrls) ? imageUrls : []
      historyTexts.forEach((text, index) => {
        pushHistory(key, { role: 'user', name, text, ...(index === 0 && historyImages.length > 0 ? { images: historyImages } : {}) })
      })
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
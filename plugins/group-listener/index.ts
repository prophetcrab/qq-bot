/** Group message listener: buffer, trigger, per-group queue and data flow loop. */
import { Context } from 'koishi'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Config } from './config.ts'
import { directFallbackText, ensureDirectSpeak } from './direct.ts'
import { focusText, normalizeEnvelope } from './envelope.ts'
import { gameCommandOf } from './game-commands.ts'
import { sendGameResult } from '../shared/game-result.ts'
import { GroupNameResolver } from './group-names.ts'
import { loadKeywords, matchKeyword } from './keywords.ts'
import { collectImagePlan, downloadImagePlan } from './images.ts'
import { appendEnvelope, createGroupState, enqueueDirect, enqueueNormal, focusedMaterial, materialSnapshot, peekNext, queueView, randomCountThreshold, resetCounters, takeItem } from './queue.ts'
import { appendBotMessage, sendReply } from './sender.ts'
import { DshTransport } from '../shared/dsh-transport.ts'
import type { GroupState, QueueItem } from './types.ts'

export const name = 'group-listener'
export const inject: string[] = []
export { Config } from './config.ts'
export { directFallbackText, ensureDirectSpeak } from './direct.ts'

const TICK_MS = 15_000
const RETENTION_MS = 30_000

/** A tiny semaphore so group workers cannot exceed maxConcurrentGroups. */
class GroupSemaphore {
  active = 0
  private waiters: Array<() => void> = []

  private readonly limit: number

  constructor(limit: number) { this.limit = limit }

  get waiting(): number { return this.waiters.length }

  async acquire(): Promise<void> {
    if (this.waiters.length === 0 && this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.active = Math.max(0, this.active - 1)
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('group-listener')
  const statePath = resolve(process.cwd(), config.stateFile)
  const groups = new Map<string, GroupState>()
  const recentLoops: any[] = []
  const semaphore = new GroupSemaphore(config.maxConcurrentGroups)
  const names = new GroupNameResolver()
  const transport = new DshTransport({ endpoint: config.endpoint, discoveryFile: config.discoveryFile, timeoutMs: config.requestTimeoutMs })
  const keywords = loadKeywords(config.personaFile)
  const global = { get active() { return semaphore.active }, get waiting() { return semaphore.waiting } }

  const nextThreshold = (): number => randomCountThreshold(config.minCountTrigger, config.maxCountTrigger)

  const stateOf = (key: string): GroupState => {
    let state = groups.get(key)
    if (state === undefined) {
      state = createGroupState(nextThreshold())
      groups.set(key, state)
    }
    return state
  }

  const persist = (): void => {
    const groupsView: Record<string, any> = {}
    for (const [id, group] of groups) {
      groupsView[id] = {
        name: group.name,
        bufferSize: group.buffer.length,
        unprocessed: group.unprocessed,
        countThreshold: group.countThreshold,
        running: group.running,
        active: group.active,
        phase: group.phase,
        lastPhase: group.lastPhase,
        cooldownUntil: group.cooldownUntil,
        queue: queueView(group),
        lastLoop: group.lastLoop,
      }
    }
    const payload = { updatedAt: new Date().toISOString(), global: { active: global.active, waiting: global.waiting, groups: groups.size }, groups: groupsView, loops: recentLoops.slice(-30) }
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch {
      // Diagnostics must never break message handling.
    }
  }

  const runLoop = async (key: string, item: QueueItem): Promise<void> => {
    const group = stateOf(key)
    group.active = item.loopId
    group.lastPhase = null
    group.phase = 'analyze'
    persist()
    const snapshot = materialSnapshot(group, item, Math.min(config.analysisWindow, config.bufferSize))
    const imagePlan = collectImagePlan(item.session, group.buffer, config.imageLimit)
    const images = await downloadImagePlan(imagePlan, config.imageMaxBytes)
    const triggerId = item.triggerMessageIds[item.triggerMessageIds.length - 1]
    const analyzeMaterial = [focusText(snapshot.entries, triggerId), snapshot.text].filter(Boolean).join('\n\n')
    const startedAt = Date.now()
    let speak: any = { enabled: false }
    let toolCalls: any[] = []
    let reply = ''
    let sendResult: any = { sent: false, reason: 'no_speak' }
    try {
      const analysis = await transport.post('/qqbot/group/analyze', {
        apiVersion: 1,
        loopId: item.loopId,
        groupId: key,
        trigger: { reason: item.reason, messageId: item.triggerMessageIds[item.triggerMessageIds.length - 1] },
        material: analyzeMaterial,
        participants: snapshot.participants,
        images: images.current,
        quotedImages: images.quoted,
        backgroundImages: images.background,
      })
      if (analysis?.ok === true) speak = analysis.speak ?? { enabled: false }
      const senderQq = String(item.session?.userId ?? item.session?.author?.id ?? '')
      speak = ensureDirectSpeak(item.reason, speak, { messageId: triggerId, userId: senderQq })
      if (speak.enabled === true && speak.replyType === 'action') {
        group.phase = 'send'
        persist()
        sendResult = await sendReply(item, speak, [], { firstMinDelayMs: config.firstBubbleDelayMinMs, firstMaxDelayMs: config.firstBubbleDelayMaxMs, minDelayMs: config.bubbleDelayMinMs, maxDelayMs: config.bubbleDelayMaxMs })
      } else if (speak.enabled === true) {
        group.phase = 'compose'
        persist()
        const visible = new Set(snapshot.entries.map((entry) => entry.id))
        const targetIds = Array.isArray(speak.target?.messageIds) ? speak.target.messageIds : []
        const rawFocus = Array.isArray(speak.focus?.messageIds) ? speak.focus.messageIds : []
        const focusIds = rawFocus.filter((id: string) => visible.has(id)).slice(0, 4)
        const contextIds = focusIds.length > 0 ? focusIds : targetIds
        if (Array.isArray(speak.quote?.messageIds)) {
          speak.quote.messageIds = speak.quote.messageIds.filter((id: string) => visible.has(id)).slice(0, 1)
          if (speak.quote.messageIds.length === 0) delete speak.quote
        }
        const focused = focusedMaterial(snapshot.entries, contextIds, 4, 12)
        const composeMaterial = [focusText(snapshot.entries, triggerId, contextIds), focused.text].filter(Boolean).join('\n\n')
        const composed = await transport.post('/qqbot/group/compose', {
          apiVersion: 1,
          loopId: item.loopId,
          groupId: key,
          material: composeMaterial,
          participants: focused.participants,
          images: images.current,
          quotedImages: images.quoted,
          backgroundImages: images.background,
          speak,
        })
        if (composed?.ok === true) {
          toolCalls = Array.isArray(composed.toolCalls) ? composed.toolCalls.slice(0, 2) : []
          const planned = Array.isArray(composed.parts) && composed.parts.length > 0 ? composed.parts : [composed.text]
          const cleaned = planned.map((part: unknown) => typeof part === 'string' ? part.trim() : '').filter(Boolean).slice(0, 3)
          if (cleaned.length === 0) {
            const fallback = directFallbackText(item.reason)
            if (fallback !== '') cleaned.push(fallback)
          }
          reply = cleaned.join('\n')
          if (speak.replyType === 'action' || cleaned.length > 0) {
            group.phase = 'send'
            persist()
            sendResult = await sendReply(item, speak, cleaned, { firstMinDelayMs: config.firstBubbleDelayMinMs, firstMaxDelayMs: config.firstBubbleDelayMaxMs, minDelayMs: config.bubbleDelayMinMs, maxDelayMs: config.bubbleDelayMaxMs })
          }
        } else {
          group.phase = 'send'
          persist()
          reply = directFallbackText(item.reason)
          sendResult = reply !== ''
            ? await sendReply(item, speak, [reply], { firstMinDelayMs: config.firstBubbleDelayMinMs, firstMaxDelayMs: config.firstBubbleDelayMaxMs, minDelayMs: config.bubbleDelayMinMs, maxDelayMs: config.bubbleDelayMaxMs })
            : { sent: false, reason: 'compose_failed', error: composed?.error }
        }
      }
    } catch (error: any) {
      sendResult = { sent: false, reason: 'loop_failed', error: String(error?.message ?? error) }
    }

    if (sendResult.sent === true) {
      const selfId = String(item.session?.selfId ?? (ctx as any).bots?.[0]?.selfId ?? '')
      for (const bubble of sendResult.bubbles ?? [reply]) appendBotMessage(group.buffer, key, item.loopId, bubble, selfId, config.bufferSize)
    }

    group.phase = 'state_update'
    persist()
    const visibleIds = new Set(snapshot.entries.map((entry) => entry.id))
    const stateIds = [...new Set([
      ...(Array.isArray(speak.focus?.messageIds) ? speak.focus.messageIds : []).filter((id: string) => visibleIds.has(id)),
      ...(Array.isArray(speak.target?.messageIds) ? speak.target.messageIds : []).filter((id: string) => visibleIds.has(id)),
    ])].slice(0, 4)
    const stateMaterial = focusedMaterial(snapshot.entries, stateIds, 3, 10)
    const stateResult = await transport.post('/qqbot/group/state-update', {
      apiVersion: 1,
      loopId: item.loopId,
      groupId: key,
      material: stateMaterial.text || snapshot.text,
      participants: stateMaterial.participants.length > 0 ? stateMaterial.participants : snapshot.participants,
      speak,
      sendResult,
    })
    const finishedAt = Date.now()
    const loop = {
      at: new Date().toISOString(),
      loopId: item.loopId,
      groupId: key,
      trigger: item.reason,
      materialCount: snapshot.count,
      imageCount: images.current.length + images.quoted.length + images.background.length,
      toolCalls,
      speak,
      reply,
      sendResult,
      stateUpdate: stateResult,
      durationMs: finishedAt - startedAt,
    }
    group.lastLoop = loop
    recentLoops.push(loop)
    if (recentLoops.length > 30) recentLoops.shift()
    group.cooldownUntil = finishedAt + (sendResult.sent === true ? config.cooldownReplyMs : config.cooldownNoReplyMs)
    group.active = null
    group.phase = null
    group.lastPhase = 'state_update'
    persist()
    logger.debug?.('group loop %s: %s', item.loopId, sendResult.sent === true ? 'sent' : 'silent')
  }

  const wake = async (key: string): Promise<void> => {
    const group = stateOf(key)
    if (group.running) return
    group.running = true
    try {
      for (;;) {
        const item = peekNext(group)
        if (item === null) break
        if (item.priority === 'normal' && item.reason !== 'keyword' && Date.now() < group.cooldownUntil) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(RETENTION_MS, Math.max(1, group.cooldownUntil - Date.now()))))
          continue
        }
        await semaphore.acquire()
        try {
          const current = peekNext(group)
          if (current !== item) continue
          takeItem(group, item)
          await runLoop(key, item)
        } finally {
          semaphore.release()
          persist()
        }
      }
    } finally {
      group.running = false
      group.active = null
      if (group.phase !== null) group.lastPhase = group.phase
      group.phase = null
      persist()
    }
  }

  const applyGroupName = (group: GroupState, name: string): void => {
    if (name !== '' && group.name === '') group.name = name
  }

  // Koishi's built-in help plugin claims /help and /帮助 before a normal
  // middleware. Game commands must run first so /help shows the game registry.
  ctx.middleware(async (session, next) => {
    if (!config.enabled) return next()
    if (session.userId === session.selfId || session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()
    const key = String(session.guildId ?? session.channelId ?? '')
    if (key === '') return next()
    const access = (ctx as any).access
    if (access !== null && access !== undefined) {
      if (typeof access.isInboundAllowed === 'function' && !access.isInboundAllowed(session)) return next()
      if (typeof access.isQuietBlocked === 'function' && access.isQuietBlocked(session)) return next()
    }
    const command = gameCommandOf(String(session.content ?? ''))
    if (command === null) return next()
    const nickname = String((session as any).author?.name ?? (session as any).username ?? session.userId ?? '')
    const result = await transport.post('/qqbot/game/command', {
      groupId: key,
      userId: String(session.userId ?? ''),
      nickname,
      command,
    })
    if (result?.ok === true) await sendGameResult(session, result)
    else await session.send('指令服务暂时不可用，请稍后再试。')
  }, true)

  ctx.middleware(async (session, next) => {
    if (!config.enabled) return next()
    if (session.userId === session.selfId || session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()
    const key = String(session.guildId ?? session.channelId ?? '')
    if (key === '') return next()
    const content = String(session.content ?? '')
    if (content.startsWith('/')) return next()

    const group = stateOf(key)
    group.lastSession = session
    const rawName = String((session as any).guildName ?? (session as any).event?.guild?.name ?? '').trim()
    if (rawName !== '') {
      names.set(key, rawName)
      group.name = rawName
    } else if (group.name === '') {
      const cached = names.getCached(key)
      if (cached !== undefined) applyGroupName(group, cached)
      else void names.resolve(session.bot, key).then((name) => { applyGroupName(group, name); persist() })
    }

    const envelope = normalizeEnvelope(session, key)
    appendEnvelope(group, envelope, config.bufferSize)
    group.unprocessed += 1
    group.senders.add(envelope.sender.qq)

    const mentioned = Array.isArray(session.elements) && session.elements.some((element: any) => element.type === 'at' && String(element.attrs?.id ?? element.attrs?.qq ?? '') === String(session.selfId))
    const replied = String((session.quote as any)?.user?.id ?? (session.quote as any)?.userId ?? '') === String(session.selfId)
    if (mentioned || replied) {
      enqueueDirect(group, envelope.id, session, mentioned ? 'mention' : 'reply')
      resetCounters(group, nextThreshold())
      void wake(key)
    } else if (matchKeyword(envelope.content.text, keywords) !== null) {
      const queued = enqueueNormal(group, envelope.id, session, 'keyword')
      if (queued !== null) {
        resetCounters(group, nextThreshold())
        void wake(key)
      }
    } else if (group.unprocessed >= group.countThreshold) {
      const queued = enqueueNormal(group, envelope.id, session, 'count')
      if (queued !== null) {
        resetCounters(group, nextThreshold())
        void wake(key)
      }
    }
    persist()
    return next()
  })

  const initialNames = setTimeout(() => {
    const bot = (ctx as any).bots?.[0]
    if (bot === undefined) return
    void names.fill(groups, bot).then((changed) => { if (changed) persist() })
  }, 4000)
  initialNames.unref?.()

  const ticker = setInterval(() => {
    const now = Date.now()
    for (const [key, group] of groups) {
      if (group.running || group.unprocessed === 0 || group.senders.size < 2) continue
      if (now - group.lastTriggerAt < config.timeTriggerMinutes * 60 * 1000) continue
      const latest = group.buffer[group.buffer.length - 1]
      if (latest !== undefined && group.lastSession !== null) {
        const queued = enqueueNormal(group, latest.id, group.lastSession, 'time')
        if (queued !== null) {
          resetCounters(group, nextThreshold())
          void wake(key)
        }
      }
    }
  }, TICK_MS)
  ticker.unref?.()

  ctx.on('dispose', () => {
    clearInterval(ticker)
    clearTimeout(initialNames)
  })
}

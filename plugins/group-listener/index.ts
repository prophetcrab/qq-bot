/** Group message listener: buffer, trigger, per-group queue and data flow loop. */
import { Context } from 'koishi'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Config } from './config.ts'
import { directFallbackText, ensureDirectSpeak } from './direct.ts'
import { normalizeEnvelope } from './envelope.ts'
import { GroupNameResolver } from './group-names.ts'
import { appendEnvelope, createGroupState, enqueueDirect, enqueueNormal, materialSnapshot, peekNext, queueView, takeItem } from './queue.ts'
import { appendBotMessage, sendReply } from './sender.ts'
import { DshTransport } from './transport.ts'
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
  const transport = new DshTransport({ endpoint: config.endpoint, discoveryFile: config.discoveryFile })
  const global = { get active() { return semaphore.active }, get waiting() { return semaphore.waiting } }

  const stateOf = (key: string): GroupState => {
    let state = groups.get(key)
    if (state === undefined) {
      state = createGroupState()
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
        running: group.running,
        active: group.active,
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
    const snapshot = materialSnapshot(group, item, config.bufferSize)
    const startedAt = Date.now()
    let speak: any = { enabled: false }
    let reply = ''
    let sendResult: any = { sent: false, reason: 'no_speak' }
    try {
      const analysis = await transport.post('/qqbot/group/analyze', {
        apiVersion: 1,
        loopId: item.loopId,
        groupId: key,
        trigger: { reason: item.reason, messageId: item.triggerMessageIds[item.triggerMessageIds.length - 1] },
        material: snapshot.text,
        participants: snapshot.participants,
      })
      if (analysis?.ok === true) speak = analysis.speak ?? { enabled: false }
      speak = ensureDirectSpeak(item.reason, speak)
      if (speak.enabled === true) {
        const composed = await transport.post('/qqbot/group/compose', {
          apiVersion: 1,
          loopId: item.loopId,
          groupId: key,
          material: snapshot.text,
          participants: snapshot.participants,
          speak,
        })
        if (composed?.ok === true && typeof composed.text === 'string') {
          reply = composed.text.trim()
          if (reply === '') reply = directFallbackText(item.reason)
          if (speak.replyType === 'action' || reply !== '') sendResult = await sendReply(item, speak, reply)
        } else {
          reply = directFallbackText(item.reason)
          sendResult = reply !== ''
            ? await sendReply(item, speak, reply)
            : { sent: false, reason: 'compose_failed', error: composed?.error }
        }
      }
    } catch (error: any) {
      sendResult = { sent: false, reason: 'loop_failed', error: String(error?.message ?? error) }
    }

    if (sendResult.sent === true) {
      const selfId = String(item.session?.selfId ?? (ctx as any).bots?.[0]?.selfId ?? '')
      appendBotMessage(group.buffer, key, item.loopId, reply, selfId, config.bufferSize)
    }

    const stateResult = await transport.post('/qqbot/group/state-update', {
      apiVersion: 1,
      loopId: item.loopId,
      groupId: key,
      material: snapshot.text,
      participants: snapshot.participants,
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
        if (item.priority === 'normal' && Date.now() < group.cooldownUntil) {
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
      persist()
    }
  }

  const applyGroupName = (group: GroupState, name: string): void => {
    if (name !== '' && group.name === '') group.name = name
  }

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
      void wake(key)
    } else if (group.unprocessed >= config.countTrigger) {
      const queued = enqueueNormal(group, envelope.id, session, 'count')
      if (queued !== null) void wake(key)
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
        if (queued !== null) void wake(key)
      }
    }
  }, TICK_MS)
  ticker.unref?.()

  ctx.on('dispose', () => {
    clearInterval(ticker)
    clearTimeout(initialNames)
  })
}

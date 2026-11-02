/**
 * Event runtime core and Koishi service.
 *
 * The runtime owns events, threads, semantic-interest matching, attention,
 * group budgets and delayed batch activation. AI generation stays in ai-chat;
 * semantic interests are written by the DSH host and read from a shared file.
 */

import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Schema, Service } from 'koishi'
import { EventStore, ThreadTracker } from './events.js'
import { GroupActorRegistry, ActivationScheduler } from './scheduler.js'
import { SemanticInterestStore } from './interests.js'
import { ToolRegistry } from './tools.js'
import { ExtensionRegistry } from './extensions.js'
import { attentionReplyChance, evaluateAttention } from './attention.js'
import type { AttentionResult, BotEvent, Thread } from './types.js'
import type { InterestHit } from './interests.js'

export * from './types.js'
export * from './events.js'
export * from './scheduler.js'
export * from './lexicon.js'
export * from './interests.js'
export * from './attention.js'
export * from './episodes.js'
export * from './tools.js'
export * from './extensions.js'

export const name = 'runtime'
export const inject: string[] = []

export interface Config {
  /** Reserved for a later fully-shadow scheduler mode. */
  shadow: boolean
  minIntervalMs: number
  maxPerWindow: number
  windowMs: number
  /** Semantic interests written by the AI host. */
  interestsFile: string
  /** AI settings file shared with ai-chat; budget fields are hot-reloaded. */
  settingsFile: string
}

export const Config: Schema<Config> = Schema.object({
  shadow: Schema.boolean().default(true).description('保留开关；当前只提供核心服务'),
  minIntervalMs: Schema.number().default(10000).min(0).max(600000).description('同群普通回复最小间隔（毫秒）'),
  maxPerWindow: Schema.number().default(10).min(1).max(100).description('同群窗口内最多普通回复数'),
  windowMs: Schema.number().default(600000).min(1000).max(3600000).description('群预算滑动窗口（毫秒）'),
  interestsFile: Schema.string().default('data/state/interests.json').description('语义兴趣文件（AI Host 写入）'),
  settingsFile: Schema.string().default('data/config/ai-settings.json').description('AI 设置文件（群预算热更新）'),
})

export interface ObserveInput {
  messageId: string
  groupId: string
  userId: string
  userName: string
  text: string
  quoteMessageId?: string | null
  at?: number
  mentionSelf?: boolean
  replyToBot?: boolean
}

export interface Observation {
  event: BotEvent
  thread: Thread
  interestHits: InterestHit[]
  keywordScore: number
  attention: AttentionResult
  forced: boolean
}

declare module 'koishi' {
  interface Context {
    qqbotRuntime: RuntimeService
  }
}

export class RuntimeService extends Service<Config> {
  static inject: string[] = []
  readonly events = new EventStore()
  readonly threads = new ThreadTracker()
  readonly scheduler = new ActivationScheduler()
  readonly groups: GroupActorRegistry
  readonly interests = new SemanticInterestStore()
  readonly tools = new ToolRegistry()
  readonly extensions = new ExtensionRegistry()
  private readonly lastMessageAt = new Map<string, number>()
  private readonly lastReplyAt = new Map<string, number>()
  private readonly lastReplyByThread = new Map<string, number>()
  private readonly activationListeners = new Set<(events: BotEvent[]) => void>()
  private readonly interestsPath: string
  private readonly settingsPath: string
  private readonly ticker: ReturnType<typeof setInterval>
  private lastPruneAt = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qqbotRuntime', true)
    this.config = Object.assign({
      shadow: true,
      minIntervalMs: 10000,
      maxPerWindow: 10,
      windowMs: 600000,
      interestsFile: 'data/state/interests.json',
      settingsFile: 'data/config/ai-settings.json',
    }, config)
    this.settingsPath = resolve(process.cwd(), this.config.settingsFile)
    this.interestsPath = resolve(process.cwd(), this.config.interestsFile)
    const budget = this.readBudgetSettings()
    this.groups = new GroupActorRegistry({
      minIntervalMs: budget.minIntervalMs ?? this.config.minIntervalMs,
      maxPerWindow: budget.maxPerWindow ?? this.config.maxPerWindow,
      windowMs: budget.windowMs ?? this.config.windowMs,
    })
    this.loadInterests()
    this.ticker = setInterval(() => this.tick(), 50)
    this.ticker.unref?.()
    try {
      watchFile(this.settingsPath, { interval: 1000 }, () => this.reloadBudget())
      watchFile(this.interestsPath, { interval: 1000 }, () => this.loadInterests())
    } catch {
      // files are created by the host later; watchers are best-effort
    }
    ctx.on('dispose', () => {
      clearInterval(this.ticker)
      try {
        unwatchFile(this.settingsPath)
        unwatchFile(this.interestsPath)
      } catch { /* ignore */ }
    })
  }

  /** Subscribe to events whose activation time has arrived. */
  onActivation(listener: (events: BotEvent[]) => void): () => void {
    this.activationListeners.add(listener)
    return () => this.activationListeners.delete(listener)
  }

  /** Put an event on the runtime's delay queue. */
  scheduleEvent(eventId: string, notBefore: number, deadline: number | null = null): boolean {
    const event = this.events.get(eventId)
    if (event === null) return false
    const next = this.events.update(eventId, { notBefore, deadline, state: 'scheduled' })
    if (next === null) return false
    this.scheduler.schedule(next)
    return true
  }

  cancelEvent(eventId: string): void {
    this.scheduler.cancel(eventId)
  }

  /** Read the editable group budget from the shared AI settings file. */
  private readBudgetSettings(): { minIntervalMs?: number; maxPerWindow?: number; windowMs?: number } {
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return {}
      const read = (key: string): number | undefined => {
        const value = Number(parsed[key])
        return Number.isFinite(value) ? value : undefined
      }
      return {
        minIntervalMs: read('minIntervalMs'),
        maxPerWindow: read('maxPerWindow'),
        windowMs: read('windowMs'),
      }
    } catch {
      return {}
    }
  }

  private reloadBudget(): void {
    const budget = this.readBudgetSettings()
    this.groups.configure({
      minIntervalMs: budget.minIntervalMs ?? this.config.minIntervalMs,
      maxPerWindow: budget.maxPerWindow ?? this.config.maxPerWindow,
      windowMs: budget.windowMs ?? this.config.windowMs,
    })
  }

  /** Reload semantic interests written by the AI host. */
  private loadInterests(): void {
    try {
      this.interests.restore(JSON.parse(readFileSync(this.interestsPath, 'utf8')))
    } catch {
      // missing/corrupt state means no interests yet
    }
  }

  private tick(): void {
    const now = Date.now()
    if (now - this.lastPruneAt >= 60_000) {
      this.lastPruneAt = now
      this.interests.prune(now)
    }
    const due = this.scheduler.due(now)
    if (due.length === 0) return
    for (const listener of this.activationListeners) listener(due)
  }

  /** Convert every inbound message into an event and compute its attention. */
  observeMessage(input: ObserveInput): Observation {
    const now = input.at ?? Date.now()
    const thread = this.threads.assign({
      messageId: input.messageId,
      groupId: input.groupId,
      senderId: input.userId,
      at: now,
      quoteMessageId: input.quoteMessageId ?? null,
    })
    const interestHits = this.interests.match(input.text, input.groupId)
    const keywordScore = interestHits.reduce((sum, hit) => sum + hit.weight * hit.confidence, 0)
    const previous = this.lastMessageAt.get(input.groupId)
    this.lastMessageAt.set(input.groupId, now)
    const forced = input.mentionSelf === true || input.replyToBot === true
    const lastReply = this.lastReplyAt.get(input.groupId)
    const threadReply = this.lastReplyByThread.get(thread.id)
    const event = this.events.create({
      kind: forced ? 'message.direct' : 'message.observed',
      groupId: input.groupId,
      threadId: thread.id,
      actorIds: [input.userId],
      evidenceMessageIds: [input.messageId],
      now,
      notBefore: now,
      priority: forced ? 100 : 0,
      state: 'linked',
      payload: { text: input.text, userName: input.userName, quoteMessageId: input.quoteMessageId ?? null },
    })
    const attention = evaluateAttention({
      forced,
      direct: forced,
      keywordScore,
      threadContinuity: thread.messageIds.length > 1 ? 1 : 0,
      question: /[?？]|吗|怎么|为什么|如何|能不能|是不是/u.test(input.text),
      silenceMs: previous === undefined ? 0 : now - previous,
      recentlyReplied: lastReply !== undefined && now - lastReply < 30_000,
      budgetExhausted: !this.groups.get(input.groupId).canSpeak(now),
    })
    if (threadReply !== undefined) event.payload.lastThreadReplyAt = threadReply
    return { event, thread, interestHits, keywordScore, attention, forced }
  }

  /** Decide whether the current event may produce a reply. */
  shouldReply(observation: Observation, replyProbability: number, random: () => number = Math.random): boolean {
    if (observation.attention.decision === 'forced') return true
    if (observation.attention.reasons.includes('budget-exhausted')) return false
    return random() < attentionReplyChance(observation.attention.decision, replyProbability)
  }

  /** Record an outbound reply so budgets/attention can see it next time. */
  recordReply(groupId: string, threadId: string | null, at = Date.now()): void {
    this.groups.get(groupId).recordSpeech(at)
    this.lastReplyAt.set(groupId, at)
    if (threadId !== null) this.lastReplyByThread.set(threadId, at)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(RuntimeService, config)
}

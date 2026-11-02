/**
 * Event runtime core and Koishi service.
 *
 * Phase 2 exposes the runtime to ai-chat. The existing AI generation and
 * delivery path stays intact; only event/thread/keyword/attention/budget
 * decisions move into the runtime.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Context, Schema, Service } from 'koishi'
import { EventStore, ThreadTracker } from './events.js'
import { GroupActorRegistry, ActivationScheduler } from './scheduler.js'
import { DynamicLexicon } from './lexicon.js'
import { ToolRegistry } from './tools.js'
import { ExtensionRegistry } from './extensions.js'
import { attentionReplyChance, evaluateAttention } from './attention.js'
import type { AttentionResult, BotEvent, KeywordHit, LexiconKey, Thread } from './types.js'

export * from './types.js'
export * from './events.js'
export * from './scheduler.js'
export * from './lexicon.js'
export * from './attention.js'
export * from './episodes.js'
export * from './tools.js'
export * from './extensions.js'

export const name = 'runtime'
export const inject: string[] = []

export interface Config {
  /** Reserved for a later fully-shadow scheduler mode. */
  shadow: boolean
  /** Minimum gap between normal replies in one group. */
  minIntervalMs: number
  /** Maximum normal replies per group window. */
  maxPerWindow: number
  /** Sliding window for maxPerWindow. */
  windowMs: number
  /** Persisted dynamic keyword lexicon. */
  stateFile: string
}

export const Config: Schema<Config> = Schema.object({
  shadow: Schema.boolean().default(true).description('保留开关；当前只提供核心服务'),
  minIntervalMs: Schema.number().default(10000).min(0).max(600000).description('同群普通回复最小间隔（毫秒）'),
  maxPerWindow: Schema.number().default(10).min(1).max(100).description('同群窗口内最多普通回复数'),
  windowMs: Schema.number().default(600000).min(1000).max(3600000).description('群预算滑动窗口（毫秒）'),
  stateFile: Schema.string().default('data/state/runtime-lexicon.json').description('动态关键词持久化文件'),
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
  keywordHits: KeywordHit[]
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
  readonly lexicon = new DynamicLexicon()
  readonly tools = new ToolRegistry()
  readonly extensions = new ExtensionRegistry()
  private readonly lastMessageAt = new Map<string, number>()
  private readonly lastReplyAt = new Map<string, number>()
  private readonly lastReplyByThread = new Map<string, number>()
  private readonly activationListeners = new Set<(events: BotEvent[]) => void>()
  private readonly statePath: string
  private readonly ticker: ReturnType<typeof setInterval>
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qqbotRuntime', true)
    this.config = Object.assign({
      shadow: true,
      minIntervalMs: 10000,
      maxPerWindow: 10,
      windowMs: 600000,
      stateFile: 'data/state/runtime-lexicon.json',
    }, config)
    this.groups = new GroupActorRegistry({
      minIntervalMs: this.config.minIntervalMs,
      maxPerWindow: this.config.maxPerWindow,
      windowMs: this.config.windowMs,
    })
    this.statePath = resolve(process.cwd(), this.config.stateFile)
    this.loadLexicon()
    this.ticker = setInterval(() => this.tick(), 50)
    this.ticker.unref?.()
    ctx.on('dispose', () => {
      clearInterval(this.ticker)
      if (this.saveTimer !== null) clearTimeout(this.saveTimer)
      this.saveNow()
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

  /** Persist the lexicon immediately (called on dispose or by tests). */
  saveNow(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      writeFileSync(this.statePath, `${JSON.stringify({ version: 1, sets: this.lexicon.exportState() }, null, 2)}\n`, 'utf8')
    } catch {
      // persistence is best-effort
    }
  }

  private loadLexicon(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.sets)) {
        this.lexicon.restoreState(parsed.sets)
      }
    } catch {
      // missing/corrupt state starts empty
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, 800)
    this.saveTimer.unref?.()
  }

  private tick(): void {
    const due = this.scheduler.due(Date.now())
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
    const keys: LexiconKey[] = [
      { scope: 'group', owner: input.groupId },
      { scope: 'thread', owner: thread.id },
    ]
    const keywordHits = this.lexicon.match(input.text, keys)
    const keywordScore = keywordHits.reduce((sum, hit) => sum + hit.weight * hit.confidence, 0)
    if (!input.text.startsWith('/')) {
      for (const key of keys) this.lexicon.learn(input.text, key, now)
      this.scheduleSave()
    }
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
    return { event, thread, keywordHits, keywordScore, attention, forced }
  }

  /** Decide whether the current event may produce a reply. */
  shouldReply(observation: Observation, replyProbability: number, random: () => number = Math.random): boolean {
    if (observation.attention.decision === 'forced') return true
    if (observation.attention.reasons.includes('budget-exhausted')) return false
    const chance = attentionReplyChance(observation.attention.decision, replyProbability)
    return random() < chance
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

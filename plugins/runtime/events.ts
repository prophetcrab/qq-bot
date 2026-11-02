/** Event store and thread tracking. */

import { randomUUID } from 'node:crypto'
import type { BotEvent, EventInput, MessageInput, Thread } from './types.js'

/** In-memory event store; persistence is a later phase. */
export class EventStore {
  private readonly events = new Map<string, BotEvent>()

  create(input: EventInput): BotEvent {
    const now = input.now
    const event: BotEvent = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      groupId: input.groupId,
      threadId: input.threadId ?? null,
      actorIds: input.actorIds ?? [],
      evidenceMessageIds: input.evidenceMessageIds ?? [],
      createdAt: now,
      updatedAt: now,
      notBefore: input.notBefore ?? now,
      deadline: input.deadline ?? null,
      priority: input.priority ?? 0,
      state: input.state ?? 'captured',
      payload: input.payload ?? {},
    }
    this.events.set(event.id, event)
    return event
  }

  get(id: string): BotEvent | null {
    return this.events.get(id) ?? null
  }

  update(id: string, patch: Partial<BotEvent>, now = Date.now()): BotEvent | null {
    const current = this.events.get(id)
    if (current === undefined) return null
    const next = { ...current, ...patch, updatedAt: now }
    this.events.set(id, next)
    return next
  }

  list(filter: { groupId?: string; state?: BotEvent['state'] } = {}): BotEvent[] {
    return [...this.events.values()].filter((event) => {
      if (filter.groupId !== undefined && event.groupId !== filter.groupId) return false
      if (filter.state !== undefined && event.state !== filter.state) return false
      return true
    })
  }
}

export interface ThreadTrackerOptions {
  /** Messages in one group within this gap reuse the latest thread. */
  threadGapMs?: number
}

/** Assigns incoming messages to threads by reply links or a short time gap. */
export class ThreadTracker {
  private readonly gap: number
  private readonly threads = new Map<string, Thread>()
  private readonly byMessage = new Map<string, string>()
  private readonly latestByGroup = new Map<string, string>()
  private sequence = 0

  constructor(options: ThreadTrackerOptions = {}) {
    this.gap = options.threadGapMs ?? 5 * 60 * 1000
  }

  assign(input: MessageInput): Thread {
    const linked = input.quoteMessageId !== undefined && input.quoteMessageId !== null
      ? this.byMessage.get(input.quoteMessageId)
      : undefined
    const latest = this.latestByGroup.get(input.groupId)
    const latestThread = latest === undefined ? undefined : this.threads.get(latest)
    let thread: Thread
    if (linked !== undefined) {
      thread = this.threads.get(linked) as Thread
    } else if (latestThread !== undefined && input.at - latestThread.lastAt <= this.gap) {
      thread = latestThread
    } else {
      this.sequence += 1
      thread = {
        id: `${input.groupId}:thread:${this.sequence}`,
        groupId: input.groupId,
        messageIds: [],
        participants: [],
        startedAt: input.at,
        lastAt: input.at,
      }
      this.threads.set(thread.id, thread)
    }
    thread.messageIds.push(input.messageId)
    thread.lastAt = Math.max(thread.lastAt, input.at)
    if (!thread.participants.includes(input.senderId)) thread.participants.push(input.senderId)
    this.byMessage.set(input.messageId, thread.id)
    this.latestByGroup.set(input.groupId, thread.id)
    return thread
  }

  get(id: string): Thread | null {
    return this.threads.get(id) ?? null
  }

  list(groupId?: string): Thread[] {
    return [...this.threads.values()].filter((thread) => groupId === undefined || thread.groupId === groupId)
  }
}

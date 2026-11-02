/** Delayed event activation, per-group budgets and fair group actors. */

import type { BotEvent } from './types.js'

interface Entry {
  event: BotEvent
  nextAt: number
}

/** A small priority queue keyed by nextAt, then priority. */
export class ActivationScheduler {
  private readonly entries = new Map<string, Entry>()

  schedule(event: BotEvent): void {
    this.entries.set(event.id, { event, nextAt: event.notBefore })
  }

  cancel(id: string): boolean {
    return this.entries.delete(id)
  }

  snooze(id: string, until: number): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    entry.nextAt = Math.max(until, entry.event.notBefore)
    entry.event.state = 'snoozed'
    entry.event.updatedAt = entry.nextAt
    return true
  }

  /** Pick eligible events; expired events are marked and dropped. */
  due(now: number, limit = 32): BotEvent[] {
    const expired: string[] = []
    for (const [id, entry] of this.entries) {
      if (entry.event.deadline !== null && now > entry.event.deadline) {
        entry.event.state = 'expired'
        entry.event.updatedAt = now
        expired.push(id)
      }
    }
    for (const id of expired) this.entries.delete(id)

    const ready = [...this.entries.values()]
      .filter((entry) => entry.nextAt <= now)
      .sort((left, right) => right.event.priority - left.event.priority || left.nextAt - right.nextAt)
      .slice(0, Math.max(0, limit))
    const picked: BotEvent[] = []
    for (const entry of ready) {
      this.entries.delete(entry.event.id)
      entry.event.state = 'eligible'
      entry.event.updatedAt = now
      picked.push(entry.event)
    }
    return picked
  }

  nextAt(): number | null {
    let value: number | null = null
    for (const entry of this.entries.values()) {
      if (value === null || entry.nextAt < value) value = entry.nextAt
    }
    return value
  }

  size(): number {
    return this.entries.size
  }
}

export interface BudgetOptions {
  minIntervalMs?: number
  maxPerWindow?: number
  windowMs?: number
}

/** Per-group speech budget: cooldown plus a sliding window. */
export class GroupActor {
  readonly groupId: string
  private readonly minIntervalMs: number
  private readonly maxPerWindow: number
  private readonly windowMs: number
  private readonly speeches: number[] = []

  constructor(groupId: string, options: BudgetOptions = {}) {
    this.groupId = groupId
    this.minIntervalMs = options.minIntervalMs ?? 20_000
    this.maxPerWindow = options.maxPerWindow ?? 3
    this.windowMs = options.windowMs ?? 10 * 60 * 1000
  }

  private trim(now: number): void {
    const from = now - this.windowMs
    while (this.speeches.length > 0 && this.speeches[0] < from) this.speeches.shift()
  }

  canSpeak(now: number): boolean {
    this.trim(now)
    const last = this.speeches[this.speeches.length - 1]
    if (last !== undefined && now - last < this.minIntervalMs) return false
    return this.speeches.length < this.maxPerWindow
  }

  recordSpeech(now: number): void {
    this.trim(now)
    this.speeches.push(now)
  }

  recentCount(now: number): number {
    this.trim(now)
    return this.speeches.length
  }
}

/** One actor per group, kept independent so one busy group cannot starve another. */
export class GroupActorRegistry {
  private readonly actors = new Map<string, GroupActor>()
  private readonly options: BudgetOptions

  constructor(options: BudgetOptions = {}) {
    this.options = options
  }

  get(groupId: string): GroupActor {
    const existing = this.actors.get(groupId)
    if (existing !== undefined) return existing
    const actor = new GroupActor(groupId, this.options)
    this.actors.set(groupId, actor)
    return actor
  }

  list(): GroupActor[] {
    return [...this.actors.values()]
  }
}

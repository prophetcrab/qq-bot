import { participantsOf, renderMaterial } from './envelope.ts'
import type { Envelope, GroupState, Participant, QueueItem, QueuePriority, TriggerReason } from './types.ts'

export function createGroupState(countThreshold: number): GroupState {
  return {
    name: '',
    buffer: [],
    unprocessed: 0,
    countThreshold,
    lastTriggerAt: Date.now(),
    senders: new Set(),
    cooldownUntil: 0,
    running: false,
    active: null,
    phase: null,
    queue: { urgent: null, normal: null },
    lastLoop: null,
    lastSession: null,
  }
}

function loopId(): string {
  return `loop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

function queueItem(reason: TriggerReason, messageId: string, session: any, priority: QueuePriority): QueueItem {
  return { loopId: loopId(), reason, triggerMessageIds: [messageId], session, enqueuedAt: Date.now(), priority }
}

export function resetCounters(group: GroupState, countThreshold: number): void {
  group.unprocessed = 0
  group.countThreshold = countThreshold
  group.lastTriggerAt = Date.now()
  group.senders.clear()
}

/** Pick a fresh 3-10 style threshold for the next counting cycle. */
export function randomCountThreshold(min: number, max: number, random: () => number = Math.random): number {
  const low = Math.min(min, max)
  const high = Math.max(min, max)
  return low + Math.floor(random() * (high - low + 1))
}

export function enqueueDirect(group: GroupState, messageId: string, session: any, reason: 'mention' | 'reply'): QueueItem {
  const item = queueItem(reason, messageId, session, 'urgent')
  if (group.queue.urgent !== null) {
    group.queue.urgent.triggerMessageIds = [...new Set([...group.queue.urgent.triggerMessageIds, messageId])]
  } else {
    group.queue.urgent = item
  }
  group.queue.normal = null
  return item
}


export function enqueueNormal(group: GroupState, messageId: string, session: any, reason: 'count' | 'time' | 'keyword'): QueueItem | null {
  if (group.queue.urgent !== null) return null
  if (group.queue.normal !== null) {
    group.queue.normal.triggerMessageIds = [...new Set([...group.queue.normal.triggerMessageIds, messageId])]
    return null
  }
  const item = queueItem(reason, messageId, session, 'normal')
  group.queue.normal = item
  return item
}

export function peekNext(group: GroupState): QueueItem | null {
  return group.queue.urgent ?? group.queue.normal
}

export function takeItem(group: GroupState, item: QueueItem): void {
  if (group.queue.urgent === item) group.queue.urgent = null
  else if (group.queue.normal === item) group.queue.normal = null
}

export function appendEnvelope(group: GroupState, envelope: Envelope, limit: number): void {
  group.buffer.push(envelope)
  if (group.buffer.length > limit) group.buffer.splice(0, group.buffer.length - limit)
}

export interface MaterialSnapshot {
  text: string
  participants: Participant[]
  count: number
  entries: Envelope[]
}

export function materialSnapshot(group: GroupState, item: QueueItem, limit: number): MaterialSnapshot {
  const target = item.triggerMessageIds[item.triggerMessageIds.length - 1]
  const index = group.buffer.findIndex((entry) => entry.id === target)
  const entries = index >= 0
    ? group.buffer.slice(Math.max(0, index - limit + 1), index + 1)
    : group.buffer.slice(-limit)
  return { text: renderMaterial(entries), participants: participantsOf(entries), count: entries.length, entries }
}

/** Keep only the target messages and their nearby context for generation. */
export function focusedMaterial(entries: Envelope[], targetIds: string[], radius = 4, max = 12): MaterialSnapshot {
  const source = Array.isArray(entries) ? entries : []
  const wanted = new Set((Array.isArray(targetIds) ? targetIds : []).filter((id) => typeof id === 'string'))
  const indexes = new Set<number>()
  if (wanted.size > 0) {
    source.forEach((entry, index) => {
      if (!wanted.has(entry.id)) return
      for (let at = Math.max(0, index - radius); at <= Math.min(source.length - 1, index + radius); at += 1) indexes.add(at)
    })
  }
  if (indexes.size === 0) {
    for (let at = Math.max(0, source.length - 6); at < source.length; at += 1) indexes.add(at)
  }
  const selected = [...indexes].sort((a, b) => a - b).slice(0, max).map((index) => source[index])
  return { text: renderMaterial(selected), participants: participantsOf(selected), count: selected.length, entries: selected }
}

export function queueView(group: GroupState): { urgent: string | null; normal: string | null } {
  return { urgent: group.queue.urgent?.reason ?? null, normal: group.queue.normal?.reason ?? null }
}

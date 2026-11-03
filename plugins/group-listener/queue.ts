import { participantsOf, renderMaterial } from './envelope.js'
import type { Envelope, GroupState, Participant, QueueItem, QueuePriority, TriggerReason } from './types.js'

export function createGroupState(): GroupState {
  return {
    name: '',
    buffer: [],
    unprocessed: 0,
    lastTriggerAt: Date.now(),
    senders: new Set(),
    cooldownUntil: 0,
    running: false,
    active: null,
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

function resetCounters(group: GroupState): void {
  group.unprocessed = 0
  group.lastTriggerAt = Date.now()
  group.senders.clear()
}

export function enqueueDirect(group: GroupState, messageId: string, session: any, reason: 'mention' | 'reply'): QueueItem {
  const item = queueItem(reason, messageId, session, 'urgent')
  if (group.queue.urgent !== null) {
    group.queue.urgent.triggerMessageIds = [...new Set([...group.queue.urgent.triggerMessageIds, messageId])]
  } else {
    group.queue.urgent = item
  }
  group.queue.normal = null
  resetCounters(group)
  return item
}

export function enqueueNormal(group: GroupState, messageId: string, session: any, reason: 'count' | 'time'): QueueItem | null {
  if (group.queue.urgent !== null) return null
  if (group.queue.normal !== null) {
    group.queue.normal.triggerMessageIds = [...new Set([...group.queue.normal.triggerMessageIds, messageId])]
    return null
  }
  const item = queueItem(reason, messageId, session, 'normal')
  group.queue.normal = item
  resetCounters(group)
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
}

export function materialSnapshot(group: GroupState, item: QueueItem, limit: number): MaterialSnapshot {
  const target = item.triggerMessageIds[item.triggerMessageIds.length - 1]
  const index = group.buffer.findIndex((entry) => entry.id === target)
  const entries = index >= 0
    ? group.buffer.slice(Math.max(0, index - limit + 1), index + 1)
    : group.buffer.slice(-limit)
  return { text: renderMaterial(entries), participants: participantsOf(entries), count: entries.length }
}

export function queueView(group: GroupState): { urgent: string | null; normal: string | null } {
  return { urgent: group.queue.urgent?.reason ?? null, normal: group.queue.normal?.reason ?? null }
}

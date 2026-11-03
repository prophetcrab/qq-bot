/** Shared wire and in-memory types for the group listener. */

export type TriggerReason = 'mention' | 'reply' | 'count' | 'time' | 'keyword'
export type QueuePriority = 'urgent' | 'normal'

export interface Sender {
  qq: string
  nickname: string
}

export interface Envelope {
  id: string
  groupId: string
  sender: Sender
  sentAt: { iso: string; unix: number }
  receivedAt: string
  content: {
    text: string
    quote: unknown
    forward: unknown
    attachments: Array<{ type: string; summary: string; url?: string }>
  }
  fromSelf?: boolean
}

export interface QueueItem {
  loopId: string
  reason: TriggerReason
  triggerMessageIds: string[]
  session: any
  enqueuedAt: number
  priority: QueuePriority
}

export interface GroupState {
  name: string
  buffer: Envelope[]
  unprocessed: number
  countThreshold: number
  lastTriggerAt: number
  senders: Set<string>
  cooldownUntil: number
  running: boolean
  active: string | null
  phase: string | null
  lastPhase: string | null
  queue: { urgent: QueueItem | null; normal: QueueItem | null }
  lastLoop: any
  lastSession: any
}

export interface Participant {
  qq: string
  nickname: string
}

/** Shared runtime types. Pure data only; no Koishi or network imports. */

export type EventState =
  | 'captured'
  | 'classified'
  | 'linked'
  | 'scheduled'
  | 'eligible'
  | 'deliberating'
  | 'replied'
  | 'skipped'
  | 'snoozed'
  | 'expired'

export interface BotEvent {
  id: string
  kind: string
  groupId: string
  threadId: string | null
  actorIds: string[]
  evidenceMessageIds: string[]
  createdAt: number
  updatedAt: number
  notBefore: number
  deadline: number | null
  priority: number
  state: EventState
  payload: Record<string, unknown>
}

export interface EventInput {
  id?: string
  kind: string
  groupId: string
  threadId?: string | null
  actorIds?: string[]
  evidenceMessageIds?: string[]
  now: number
  notBefore?: number
  deadline?: number | null
  priority?: number
  state?: EventState
  payload?: Record<string, unknown>
}

export interface MessageInput {
  messageId: string
  groupId: string
  senderId: string
  at: number
  quoteMessageId?: string | null
}

export interface Thread {
  id: string
  groupId: string
  messageIds: string[]
  participants: string[]
  startedAt: number
  lastAt: number
}

export type LexiconScope = 'global' | 'group' | 'thread' | 'persona' | 'activity' | 'game' | 'tool'

export interface LexiconKey {
  scope: LexiconScope
  owner: string
}

export type KeywordStatus = 'active' | 'pinned' | 'suppressed'

export interface KeywordTerm {
  text: string
  aliases: string[]
  weight: number
  confidence: number
  source: string
  firstSeenAt: number
  lastSeenAt: number
  expiresAt: number | null
  status: KeywordStatus
}

export interface KeywordHit {
  key: LexiconKey
  text: string
  matched: string
  weight: number
  confidence: number
}

export interface AttentionInput {
  forced?: boolean
  direct?: boolean
  keywordScore?: number
  threadContinuity?: number
  question?: boolean
  silenceMs?: number
  recentlyReplied?: boolean
  budgetExhausted?: boolean
}

export type AttentionDecision = 'forced' | 'high' | 'medium' | 'low'

export interface AttentionResult {
  score: number
  decision: AttentionDecision
  reasons: string[]
}

export interface ToolSpec {
  name: string
  description: string
  permissions: string[]
  timeoutMs: number
  sideEffect: boolean
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
}

export interface ToolContext {
  groupId: string
  threadId: string | null
  permissions: string[]
  now: number
}

export type ToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

export type EpisodeAction =
  | { type: 'reply'; text: string }
  | { type: 'wait'; until: number; reason?: string }
  | { type: 'observe'; reason?: string }
  | { type: 'tool'; tool: string; args: Record<string, unknown> }
  | { type: 'expire'; reason?: string }

export type EpisodeStatus =
  | 'pending'
  | 'thinking'
  | 'acting'
  | 'awaiting_observation'
  | 'waiting'
  | 'done'
  | 'expired'
  | 'failed'

export interface EpisodeStep {
  at: number
  action: EpisodeAction
  observation?: ToolResult
}

export interface Episode {
  id: string
  groupId: string
  threadId: string | null
  eventId: string
  status: EpisodeStatus
  steps: EpisodeStep[]
  startedAt: number
  deadline: number
  maxSteps: number
  final?: string
  reason?: string
}

export interface EpisodeInput {
  id: string
  groupId: string
  threadId?: string | null
  eventId: string
  now: number
  deadline: number
  maxSteps?: number
}

export interface EpisodeStepInput {
  episode: Episode
  observation?: ToolResult
}

export interface Reasoner {
  next(input: EpisodeStepInput): Promise<EpisodeAction>
}

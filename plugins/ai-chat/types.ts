/** Shared AI-chat types. */
export interface HistoryMessage {
  role: 'user' | 'assistant'
  name?: string
  text: string
  threadId?: string
  images?: string[]
}

export interface Discovery {
  endpoint?: string
  provider?: string
  model?: string
}

export interface InboundImage {
  mediaType: string
  data: string
}

export interface RuntimeSettings {
  enabled: boolean
  replyProbability: number
  followUpMinutes: number
  historyLimit: number
  batchWindowMs: number
  batchMaxWaitMs: number
}

export interface PendingBatch {
  texts: string[]
  imageUrls: string[]
  lastSession: any
  key: string
  name: string
  threadId?: string
  interestLabels: string[]
  eventId: string
  firstAt: number
}

export interface MentionInfo {
  self: boolean
  others: string[]
  all: boolean
}

export interface QuoteInfo {
  userName: string
  text: string
  imageUrls: string[]
  fromSelf: boolean
}

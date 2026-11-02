/** Pure trigger policy: should this message get an AI reply? */
export interface TriggerInput {
  isCommand: boolean
  hasContent: boolean
  mentioned: boolean
  replied: boolean
  inFollowUp: boolean
  userBusy: boolean
  replyProbability: number
}

export interface TriggerResult {
  shouldReply: boolean
  forced: boolean
  randomHit: boolean
  reason: 'mention' | 'reply' | 'follow-up' | 'queued' | 'probability' | 'none'
}

export function decideTrigger(input: TriggerInput): TriggerResult {
  const forced = input.mentioned || input.replied
  const randomHit = !forced && !input.inFollowUp && !input.userBusy && input.hasContent
    && Math.random() < input.replyProbability
  const shouldReply = !input.isCommand && input.hasContent && (forced || input.inFollowUp || input.userBusy || randomHit)
  const reason = forced
    ? (input.mentioned ? 'mention' : 'reply')
    : input.inFollowUp ? 'follow-up' : input.userBusy ? 'queued' : randomHit ? 'probability' : 'none'
  return { shouldReply, forced, randomHit, reason }
}

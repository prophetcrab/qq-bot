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
  reason: 'mention' | 'reply' | 'follow-up' | 'probability' | 'none'
}

/**
 * Decide whether a message gets a reply.
 *
 * Only an explicit @mention or a reply to the bot is forced. The follow-up
 * window and an in-flight reply queue merely widen eligibility; they must not
 * turn every message into a new reply, otherwise a talkative group gets one
 * answer per sentence and different speakers get merged into one stream.
 *
 * @param {TriggerInput} input
 * @param {() => number} [random] test seam
 */
export function decideTrigger(input: TriggerInput, random: () => number = Math.random): TriggerResult {
  const forced = input.mentioned || input.replied
  // A recent exchange with the bot raises the chance a little, but never to
  // certainty. Explicit triggers above remain guaranteed.
  const probability = input.inFollowUp
    ? Math.min(1, input.replyProbability * 2)
    : input.replyProbability
  const randomHit = !forced && !input.userBusy && input.hasContent && random() < probability
  const shouldReply = !input.isCommand && input.hasContent && (forced || randomHit)
  const reason: TriggerResult['reason'] = forced
    ? (input.mentioned ? 'mention' : 'reply')
    : randomHit ? (input.inFollowUp ? 'follow-up' : 'probability') : 'none'
  return { shouldReply, forced, randomHit, reason }
}

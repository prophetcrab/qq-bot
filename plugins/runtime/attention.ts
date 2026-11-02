/** Pure attention scoring: keywords and context only raise salience. */

import type { AttentionInput, AttentionResult } from './types.js'

export interface AttentionThresholds {
  high: number
  medium: number
}

const DEFAULT_THRESHOLDS: AttentionThresholds = { high: 0.5, medium: 0.3 }

export function evaluateAttention(
  input: AttentionInput,
  thresholds: AttentionThresholds = DEFAULT_THRESHOLDS,
): AttentionResult {
  const reasons: string[] = []
  if (input.forced === true) {
    reasons.push('forced')
    return { score: 1, decision: 'forced', reasons }
  }
  if (input.budgetExhausted === true) {
    reasons.push('budget-exhausted')
    return { score: 0, decision: 'low', reasons }
  }
  let score = 0
  if (input.direct === true) {
    score += 0.25
    reasons.push('direct')
  }
  const keywordScore = Math.max(0, input.keywordScore ?? 0)
  if (keywordScore > 0) {
    score += Math.min(0.3, keywordScore * 0.3)
    reasons.push('keyword')
  }
  const continuity = Math.max(0, Math.min(1, input.threadContinuity ?? 0))
  if (continuity > 0) {
    score += continuity * 0.15
    reasons.push('thread')
  }
  if (input.question === true) {
    score += 0.1
    reasons.push('question')
  }
  if ((input.silenceMs ?? 0) >= 5 * 60 * 1000) {
    score += 0.1
    reasons.push('silence')
  }
  if (input.recentlyReplied === true) {
    score -= 0.2
    reasons.push('recent-penalty')
  }
  score = Math.max(0, Math.min(1, score))
  const decision = score >= thresholds.high ? 'high' : score >= thresholds.medium ? 'medium' : 'low'
  return { score, decision, reasons }
}


/**
 * Convert a deliberate probability into a tiered reply chance.
 *
 * High attention triples the configured probability, medium doubles it and low
 * halves it. A configured probability of 1 still means "always", which keeps
 * the manual test switch deterministic.
 */
export function attentionReplyChance(
  decision: AttentionResult['decision'],
  replyProbability: number,
): number {
  if (!Number.isFinite(replyProbability)) return 0
  const probability = Math.max(0, Math.min(1, replyProbability))
  if (decision === 'forced') return 1
  if (probability >= 1) return 1
  if (probability <= 0) return 0
  if (decision === 'high') return Math.min(1, probability * 3)
  if (decision === 'medium') return Math.min(1, probability * 2)
  return probability * 0.5
}

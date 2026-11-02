/** Pure attention scoring: keywords and context only raise salience. */

import type { AttentionInput, AttentionResult } from './types.js'

export interface AttentionThresholds {
  high: number
  medium: number
}

const DEFAULT_THRESHOLDS: AttentionThresholds = { high: 0.65, medium: 0.35 }

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

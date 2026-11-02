/** Episode state machine and bounded ReAct loop. */

import type {
  Episode,
  EpisodeAction,
  EpisodeInput,
  EpisodeStep,
  Reasoner,
  ToolResult,
} from './types.js'
import type { ToolRegistry } from './tools.js'

export interface EpisodeDependencies {
  reasoner: Reasoner
  tools: ToolRegistry
  now?: () => number
}

export interface EpisodeRunResult {
  episode: Episode
  result: 'reply' | 'wait' | 'observe' | 'expired' | 'step-limit' | 'failed'
  reply?: string
}

export async function runEpisode(input: EpisodeInput, deps: EpisodeDependencies): Promise<EpisodeRunResult> {
  const now = deps.now ?? Date.now
  const episode: Episode = {
    id: input.id,
    groupId: input.groupId,
    threadId: input.threadId ?? null,
    eventId: input.eventId,
    status: 'pending',
    steps: [],
    startedAt: input.now,
    deadline: input.deadline,
    maxSteps: input.maxSteps ?? 4,
  }
  let observation: ToolResult | undefined
  while (episode.steps.length < episode.maxSteps) {
    if (now() > episode.deadline) {
      episode.status = 'expired'
      return { episode, result: 'expired' }
    }
    episode.status = 'thinking'
    let action: EpisodeAction
    try {
      action = await deps.reasoner.next({ episode, observation })
    } catch (error) {
      episode.status = 'failed'
      episode.reason = String((error as Error)?.message ?? error)
      return { episode, result: 'failed' }
    }
    const step: EpisodeStep = { at: now(), action }
    episode.steps.push(step)
    if (action.type === 'reply') {
      episode.status = 'done'
      episode.final = action.text
      return { episode, result: 'reply', reply: action.text }
    }
    if (action.type === 'wait') {
      episode.status = 'waiting'
      episode.reason = action.reason
      return { episode, result: 'wait' }
    }
    if (action.type === 'observe') {
      episode.status = 'done'
      episode.reason = action.reason ?? 'observe'
      return { episode, result: 'observe' }
    }
    if (action.type === 'expire') {
      episode.status = 'expired'
      episode.reason = action.reason
      return { episode, result: 'expired' }
    }
    episode.status = 'awaiting_observation'
    const result = await deps.tools.invoke(action.tool, action.args, {
      groupId: episode.groupId,
      threadId: episode.threadId,
      permissions: [],
      now: now(),
    })
    step.observation = result
    observation = result
  }
  episode.status = 'failed'
  episode.reason = 'step-limit'
  return { episode, result: 'step-limit' }
}

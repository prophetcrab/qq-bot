/**
 * Event runtime core.
 *
 * This plugin intentionally does not install a message middleware yet. Phase 1
 * ships the testable runtime primitives used by group-listener.
 * live message path until the scheduler is wired in a separate migration.
 */

import { Context, Schema } from 'koishi'
import { EventStore, ThreadTracker } from './events.js'
import { GroupActorRegistry, ActivationScheduler } from './scheduler.js'
import { DynamicLexicon } from './lexicon.js'
import { ToolRegistry } from './tools.js'
import { ExtensionRegistry } from './extensions.js'

export * from './types.js'
export * from './events.js'
export * from './scheduler.js'
export * from './lexicon.js'
export * from './attention.js'
export * from './episodes.js'
export * from './tools.js'
export * from './extensions.js'

export const name = 'runtime'
export const inject: string[] = []

export interface Config {
  shadow: boolean
}

export const Config: Schema<Config> = Schema.object({
  shadow: Schema.boolean().default(true).description('只构建运行时对象，不接管消息链路'),
})

export interface RuntimeCore {
  events: EventStore
  threads: ThreadTracker
  scheduler: ActivationScheduler
  groups: GroupActorRegistry
  lexicon: DynamicLexicon
  tools: ToolRegistry
  extensions: ExtensionRegistry
}

export function createRuntimeCore(): RuntimeCore {
  return {
    events: new EventStore(),
    threads: new ThreadTracker(),
    scheduler: new ActivationScheduler(),
    groups: new GroupActorRegistry(),
    lexicon: new DynamicLexicon(),
    tools: new ToolRegistry(),
    extensions: new ExtensionRegistry(),
  }
}

export function apply(ctx: Context, config: Config): void {
  const runtime = createRuntimeCore()
  ctx.logger('runtime').debug('runtime core ready (shadow=%s)', config.shadow)
  // Phase 2 will expose this to group-listener and install the scheduler middleware.
  void runtime
}

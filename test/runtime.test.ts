import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventStore, ThreadTracker } from '../plugins/runtime/events.ts'
import { ActivationScheduler, GroupActor } from '../plugins/runtime/scheduler.ts'
import { DynamicLexicon, scopeKey } from '../plugins/runtime/lexicon.ts'
import { evaluateAttention } from '../plugins/runtime/attention.ts'
import { runEpisode } from '../plugins/runtime/episodes.ts'
import { ToolRegistry } from '../plugins/runtime/tools.ts'
import { ExtensionRegistry } from '../plugins/runtime/extensions.ts'
import type { EpisodeAction, Reasoner, ToolSpec } from '../plugins/runtime/types.ts'

test('EventStore: create, update and filter', () => {
  const store = new EventStore()
  const event = store.create({ kind: 'message.observed', groupId: 'g1', now: 1000 })
  assert.equal(event.state, 'captured')
  assert.equal(store.get(event.id)?.groupId, 'g1')
  assert.equal(store.update(event.id, { state: 'scheduled' }, 1100)?.state, 'scheduled')
  assert.equal(store.list({ state: 'scheduled' }).length, 1)
  assert.equal(store.list({ groupId: 'g2' }).length, 0)
})

test('ThreadTracker: same group gap reuses, reply links and gap splits', () => {
  const tracker = new ThreadTracker({ threadGapMs: 60_000 })
  const a = tracker.assign({ messageId: 'm1', groupId: 'g1', senderId: 'u1', at: 0 })
  const b = tracker.assign({ messageId: 'm2', groupId: 'g1', senderId: 'u2', at: 1000 })
  assert.equal(b.id, a.id)
  const c = tracker.assign({ messageId: 'm3', groupId: 'g1', senderId: 'u1', at: 200_000 })
  assert.notEqual(c.id, a.id)
  const linked = tracker.assign({ messageId: 'm4', groupId: 'g1', senderId: 'u3', at: 20_000, quoteMessageId: 'm2' })
  assert.equal(linked.id, a.id)
  assert.deepEqual(tracker.get(a.id)?.participants, ['u1', 'u2', 'u3'])
})

test('ActivationScheduler: notBefore, deadline and priority', () => {
  const store = new EventStore()
  const scheduler = new ActivationScheduler()
  const low = store.create({ kind: 'message.observed', groupId: 'g1', now: 0, notBefore: 1000, priority: 1 })
  const high = store.create({ kind: 'message.direct', groupId: 'g1', now: 0, notBefore: 1000, priority: 10 })
  const expired = store.create({ kind: 'timer.fired', groupId: 'g1', now: 0, notBefore: 1000, deadline: 500 })
  scheduler.schedule(low)
  scheduler.schedule(high)
  scheduler.schedule(expired)
  assert.equal(scheduler.due(0).length, 0)
  const due = scheduler.due(1000)
  assert.deepEqual(due.map((event) => event.kind), ['message.direct', 'message.observed'])
  assert.equal(store.get(expired.id)?.state, 'expired')
})

test('ActivationScheduler: snooze delays and state is marked', () => {
  const store = new EventStore()
  const scheduler = new ActivationScheduler()
  const event = store.create({ kind: 'message.observed', groupId: 'g1', now: 0, notBefore: 0 })
  scheduler.schedule(event)
  assert.equal(scheduler.snooze(event.id, 5000), true)
  assert.equal(store.get(event.id)?.state, 'snoozed')
  assert.equal(scheduler.due(1000).length, 0)
  assert.equal(scheduler.due(5000).length, 1)
})

test('GroupActor: cooldown and window budget', () => {
  const actor = new GroupActor('g1', { minIntervalMs: 100, maxPerWindow: 2, windowMs: 1000 })
  assert.equal(actor.canSpeak(0), true)
  actor.recordSpeech(0)
  assert.equal(actor.canSpeak(50), false)
  assert.equal(actor.canSpeak(100), true)
  actor.recordSpeech(100)
  assert.equal(actor.canSpeak(200), false)
  assert.equal(actor.canSpeak(1101), true)
})

test('DynamicLexicon: scoped matches, aliases and keyword score', () => {
  const lexicon = new DynamicLexicon()
  const global = { scope: 'global' as const, owner: 'bot' }
  const group = { scope: 'group' as const, owner: 'g1' }
  lexicon.add(global, '小说', { weight: 1, confidence: 1 })
  lexicon.add(group, '外挂', { weight: 0.6, confidence: 1, aliases: ['辅助脚本'] })
  const hits = lexicon.match('最近在写小说，也看到辅助脚本', [global, group])
  assert.equal(hits.length, 2)
  assert.ok(lexicon.score('写小说', [global]) > 0)
  assert.equal(lexicon.score('写小说', [group]), 0)
})

test('DynamicLexicon: learn, decay and expire', () => {
  const lexicon = new DynamicLexicon({ halfLifeMs: 1000, minWeight: 0.06 })
  const key = { scope: 'thread' as const, owner: 'g1:t1' }
  const learned = lexicon.learn('备案和合规问题很重要', key, 0)
  assert.ok(learned.some((term) => term.text === '备案'))
  const before = lexicon.score('备案', [key])
  lexicon.decay(5000)
  assert.ok(lexicon.score('备案', [key]) < before)
  lexicon.add(key, '临时词', { expiresAt: 10 }, 0)
  lexicon.decay(20)
  assert.equal(lexicon.score('临时词', [key]), 0)
})

test('DynamicLexicon: pinned terms survive decay, suppressed terms do not match', () => {
  const lexicon = new DynamicLexicon({ halfLifeMs: 10, minWeight: 0.06 })
  const key = { scope: 'persona' as const, owner: 'p1' }
  lexicon.add(key, '长期兴趣', { weight: 1, confidence: 1 }, 0)
  lexicon.pin(key, '长期兴趣')
  lexicon.decay(100)
  assert.ok(lexicon.score('长期兴趣', [key]) > 0)
  lexicon.add(key, '屏蔽词', { weight: 1, confidence: 1 }, 0)
  lexicon.suppress(key, '屏蔽词')
  assert.equal(lexicon.score('屏蔽词', [key]), 0)
})

test('Attention: forced, keyword boost, budget and penalties', () => {
  assert.equal(evaluateAttention({ forced: true }).decision, 'forced')
  const high = evaluateAttention({ direct: true, keywordScore: 1, question: true, threadContinuity: 1 })
  assert.ok(high.score >= 0.65)
  assert.equal(high.decision, 'high')
  assert.equal(evaluateAttention({ keywordScore: 0, budgetExhausted: true }).decision, 'low')
  const penalized = evaluateAttention({ recentlyReplied: true })
  assert.ok(penalized.reasons.includes('recent-penalty'))
})

test('ToolRegistry: invoke, permission, unknown and timeout', async () => {
  const tools = new ToolRegistry()
  const echo: ToolSpec = {
    name: 'echo',
    description: 'echo',
    permissions: ['group'],
    timeoutMs: 100,
    sideEffect: false,
    execute: async (args) => args.text,
  }
  tools.register(echo)
  const now = 1
  assert.deepEqual(await tools.invoke('echo', { text: 'hi' }, { groupId: 'g', threadId: null, permissions: ['group'], now }), { ok: true, result: 'hi' })
  assert.equal((await tools.invoke('echo', {}, { groupId: 'g', threadId: null, permissions: [], now })).ok, false)
  assert.equal((await tools.invoke('missing', {}, { groupId: 'g', threadId: null, permissions: [], now })).ok, false)
  tools.register({ ...echo, name: 'slow', timeoutMs: 10, execute: () => new Promise((resolve) => setTimeout(() => resolve('late'), 50)) })
  const slow = await tools.invoke('slow', {}, { groupId: 'g', threadId: null, permissions: ['group'], now })
  assert.equal(slow.ok, false)
})

test('Episode: tool observation feeds the next reasoner step and reply wins', async () => {
  const tools = new ToolRegistry()
  tools.register({
    name: 'lookup',
    description: 'lookup',
    permissions: [],
    timeoutMs: 100,
    sideEffect: false,
    execute: async () => 'found',
  })
  const actions: EpisodeAction[] = [
    { type: 'tool', tool: 'lookup', args: {} },
    { type: 'reply', text: 'answer' },
  ]
  const reasoner: Reasoner = {
    next: async ({ observation }) => {
      if (observation !== undefined) assert.deepEqual(observation, { ok: true, result: 'found' })
      return actions.shift() as EpisodeAction
    },
  }
  const result = await runEpisode({ id: 'e1', groupId: 'g1', eventId: 'ev1', now: 0, deadline: 1000 }, { reasoner, tools, now: () => 1 })
  assert.equal(result.result, 'reply')
  assert.equal(result.reply, 'answer')
  assert.equal(result.episode.steps.length, 2)
})

test('Episode: wait, observe, expire and step limit are explicit results', async () => {
  const tools = new ToolRegistry()
  const now = () => 0
  const make = (action: EpisodeAction): Reasoner => ({ next: async () => action })
  const wait = await runEpisode({ id: 'e2', groupId: 'g', eventId: 'e', now: 0, deadline: 1000 }, { reasoner: make({ type: 'wait', until: 10 }), tools, now })
  assert.equal(wait.result, 'wait')
  const observe = await runEpisode({ id: 'e3', groupId: 'g', eventId: 'e', now: 0, deadline: 1000 }, { reasoner: make({ type: 'observe' }), tools, now })
  assert.equal(observe.result, 'observe')
  const expire = await runEpisode({ id: 'e4', groupId: 'g', eventId: 'e', now: 0, deadline: 1000 }, { reasoner: make({ type: 'expire' }), tools, now })
  assert.equal(expire.result, 'expired')
  let calls = 0
  const looping: Reasoner = { next: async () => { calls += 1; return { type: 'tool', tool: 'missing', args: {} } } }
  const limited = await runEpisode({ id: 'e5', groupId: 'g', eventId: 'e', now: 0, deadline: 1000, maxSteps: 2 }, { reasoner: looping, tools, now })
  assert.equal(limited.result, 'step-limit')
  assert.equal(calls, 2)
})

test('ExtensionRegistry: game/activity/life source registration and cleanup', () => {
  const registry = new ExtensionRegistry()
  registry.registerGame({
    id: 'guess', name: '猜数字', commands: ['guess'], permissions: [],
    createSession: () => ({}), reduce: (state) => state, render: () => 'guess', onTimeout: () => null,
  })
  registry.registerActivity({ id: 'writing', title: '写作', phases: ['draft'], durationMs: 1000, progressRules: [] })
  registry.registerLifeSource({ id: 'clock', tick: () => null })
  assert.equal(registry.listGames().length, 1)
  assert.equal(registry.listActivities().length, 1)
  assert.equal(registry.listLifeSources().length, 1)
  registry.clear()
  assert.equal(registry.listGames().length, 0)
})

test('scopeKey: stable key format', () => {
  assert.equal(scopeKey({ scope: 'group', owner: 'g1' }), 'group:g1')
})

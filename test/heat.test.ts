import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TopicHeatStore } from '../plugins/runtime/interests.ts'

test('TopicHeatStore: reply heats a topic, touch refreshes it and prune forgets it', () => {
  const heat = new TopicHeatStore(1000)
  const now = 1_000_000
  heat.record('g1', ['龙图'], now)
  assert.deepEqual(heat.active('g1', ['龙图'], now + 500), ['龙图'])
  heat.touch('g1', ['龙图'], now + 800)
  assert.deepEqual(heat.active('g1', ['龙图'], now + 1500), ['龙图'])
  heat.prune(now + 2000)
  assert.deepEqual(heat.active('g1', ['龙图'], now + 2000), [])
})

test('TopicHeatStore: heat is scoped to one group and other topics do not match', () => {
  const heat = new TopicHeatStore(60_000)
  heat.record('g1', ['龙图'], 1000)
  assert.deepEqual(heat.active('g2', ['龙图'], 2000), [])
  assert.deepEqual(heat.active('g1', ['音乐'], 2000), [])
})

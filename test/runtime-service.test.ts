import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { App } from 'koishi'
import * as runtime from '../plugins/runtime/index.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('RuntimeService: scheduler ticker emits due events', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-service-'))
  const app = new App({ prefix: ['/'] })
  app.plugin(runtime as any, {
    shadow: false,
    minIntervalMs: 0,
    maxPerWindow: 100,
    windowMs: 60000,
    interestsFile: join(dir, 'interests.json'),
    settingsFile: join(dir, 'ai-settings.json'),
  })
  await app.start()
  t.after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }) })
  const service = (app as any).qqbotRuntime as runtime.RuntimeService
  const event = service.events.create({ kind: 'timer.fired', groupId: 'g1', now: Date.now() })
  const seen: string[] = []
  service.onActivation((events) => { for (const item of events) seen.push(item.id) })
  service.scheduleEvent(event.id, Date.now() + 10, Date.now() + 1000)
  await sleep(120)
  assert.deepEqual(seen, [event.id])
})

test('RuntimeService: matches semantic interests written by the host', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-interests-'))
  const interestsFile = join(dir, 'interests.json')
  await writeFile(interestsFile, JSON.stringify({
    version: 1,
    interests: [{
      groupId: 'g1', label: '龙图', aliases: ['龙图表情包'], summary: '群友喜欢龙图',
      weight: 0.8, confidence: 0.9, expiresAt: Date.now() + 60000, lastSeenAt: Date.now(), source: 'llm',
    }],
  }))
  const app = new App({ prefix: ['/'] })
  app.plugin(runtime as any, {
    shadow: false,
    minIntervalMs: 0,
    maxPerWindow: 100,
    windowMs: 60000,
    interestsFile,
    settingsFile: join(dir, 'ai-settings.json'),
  })
  await app.start()
  t.after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }) })
  const service = (app as any).qqbotRuntime as runtime.RuntimeService
  const observation = service.observeMessage({
    messageId: 'm1', groupId: 'g1', userId: 'u1', userName: '小明', text: '这个龙图表情包不错', at: Date.now(),
  })
  assert.equal(observation.interestHits.length, 1)
  assert.ok(observation.keywordScore > 0)
  assert.equal(observation.interestHits[0].label, '龙图')
})

test('RuntimeService: group budget hot-reloads from ai-settings.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-budget-'))
  const settingsFile = join(dir, 'ai-settings.json')
  await writeFile(settingsFile, JSON.stringify({ minIntervalMs: 0, maxPerWindow: 100, windowMs: 60000 }))
  const app = new App({ prefix: ['/'] })
  app.plugin(runtime as any, {
    shadow: false,
    minIntervalMs: 0,
    maxPerWindow: 100,
    windowMs: 60000,
    interestsFile: join(dir, 'interests.json'),
    settingsFile,
  })
  await app.start()
  t.after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }) })
  const service = (app as any).qqbotRuntime as runtime.RuntimeService
  const actor = service.groups.get('g1')
  actor.recordSpeech(Date.now())
  assert.equal(actor.canSpeak(Date.now() + 1000), true)
  await writeFile(settingsFile, JSON.stringify({ minIntervalMs: 60000, maxPerWindow: 1, windowMs: 60000 }))
  await sleep(1200)
  const reloaded = service.groups.get('g1')
  reloaded.recordSpeech(Date.now())
  assert.equal(reloaded.canSpeak(Date.now() + 1000), false)
})


test('RuntimeService: a recent reply in the same thread doubles the reply chance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-followup-'))
  const app = new App({ prefix: ['/'] })
  app.plugin(runtime as any, {
    shadow: false, minIntervalMs: 0, maxPerWindow: 100, windowMs: 60000,
    interestsFile: join(dir, 'interests.json'), settingsFile: join(dir, 'ai-settings.json'),
  })
  await app.start()
  t.after(async () => { await app.stop(); await rm(dir, { recursive: true, force: true }) })
  const service = (app as any).qqbotRuntime as runtime.RuntimeService
  const now = Date.now()
  const first = service.observeMessage({ messageId: 'm1', groupId: 'g1', userId: 'u1', userName: 'A', text: '你好', at: now })
  service.recordReply('g1', first.thread.id, now + 1)
  const next = service.observeMessage({
    messageId: 'm2', groupId: 'g1', userId: 'u1', userName: 'A', text: '继续', at: now + 2, followUpMinutes: 3,
  })
  assert.equal(next.followUp, true)
  assert.equal(service.shouldReply(next, 0.2, () => 0.3), true)
  const other = service.observeMessage({
    messageId: 'm3', groupId: 'g2', userId: 'u2', userName: 'B', text: '你好', at: now + 2, followUpMinutes: 3,
  })
  assert.equal(other.followUp, false)
  assert.equal(service.shouldReply(other, 0.2, () => 0.3), false)
})

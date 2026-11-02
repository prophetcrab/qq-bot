import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
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
    stateFile: join(dir, 'lexicon.json'),
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

test('RuntimeService: lexicon survives save/load', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-runtime-persist-'))
  const stateFile = join(dir, 'lexicon.json')
  const first = new App({ prefix: ['/'] })
  first.plugin(runtime as any, { shadow: false, minIntervalMs: 0, maxPerWindow: 100, windowMs: 60000, stateFile })
  await first.start()
  const firstService = (first as any).qqbotRuntime as runtime.RuntimeService
  firstService.lexicon.add({ scope: 'group', owner: 'g1' }, '龙图', { weight: 1, confidence: 1 }, Date.now())
  firstService.saveNow()
  await first.stop()

  const second = new App({ prefix: ['/'] })
  second.plugin(runtime as any, { shadow: false, minIntervalMs: 0, maxPerWindow: 100, windowMs: 60000, stateFile })
  await second.start()
  t.after(async () => { await second.stop(); await rm(dir, { recursive: true, force: true }) })
  const secondService = (second as any).qqbotRuntime as runtime.RuntimeService
  assert.ok(secondService.lexicon.score('看龙图', [{ scope: 'group', owner: 'g1' }]) > 0)
})

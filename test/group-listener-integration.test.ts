import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as groupListener from '../plugins/group-listener/index.ts'

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-listener-'))
  const personaFile = join(dir, 'persona.json')
  writeFileSync(personaFile, JSON.stringify({ keywords: ['股票', '期货', '漫画'] }), 'utf8')
  const discoveryFile = join(dir, 'data', 'state', 'ai.json')
  mkdirSync(dirname(discoveryFile), { recursive: true })
  writeFileSync(discoveryFile, JSON.stringify({ endpoint: 'http://127.0.0.1:9/qqbot/ai/chat' }), 'utf8')
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: any) => {
    const target = String(url)
    calls.push(target)
    if (target.endsWith('/qqbot/game/command')) return { ok: true, status: 200, json: async () => ({ ok: true, replies: ['注册成功'] }) } as any
    if (target.endsWith('/analyze')) return { ok: true, status: 200, json: async () => ({ ok: true, speak: { enabled: false } }) } as any
    if (target.endsWith('/compose')) return { ok: true, status: 200, json: async () => ({ ok: true, text: '收到我在。', parts: ['收到', '我在。'] }) } as any
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as any
  }) as typeof fetch
  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: '10000' })
  app.plugin(groupListener as any, {
    discoveryFile,
    personaFile,
    stateFile: join(dir, 'status.json'),
    minCountTrigger: 100,
    maxCountTrigger: 100,
    cooldownReplyMs: 1,
    cooldownNoReplyMs: 1,
    firstBubbleDelayMinMs: 0,
    firstBubbleDelayMaxMs: 0,
    bubbleDelayMinMs: 0,
    bubbleDelayMaxMs: 0,
  })
  await app.start()
  t.after(async () => {
    globalThis.fetch = originalFetch
    await app.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return { app, calls, stateFile: join(dir, 'status.json') }
}

test('a mention wakes the queue worker and sends a reply', async (t) => {
  const { app, calls, stateFile } = await setup(t)
  await app.mock.client('20000', 'g1').receive('<at id="10000"/> 你好')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(calls.some((url) => url.endsWith('/analyze')))
  assert.ok(calls.some((url) => url.endsWith('/compose')))
  assert.ok(calls.some((url) => url.endsWith('/state-update')))
  const status = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(status.loops.length, 1)
  assert.equal(status.loops[0].sendResult.sent, true)
  assert.equal(status.loops[0].sendResult.parts, 2)
  assert.equal(status.loops[0].speak.kind, 'reply')
  assert.equal(status.loops[0].speak.replyType, 'at')
  assert.deepEqual(status.loops[0].speak.target.userIds, ['20000'])
  assert.equal(status.loops[0].speak.target.messageIds.length, 1)

  const analyzeBefore = calls.filter((url) => url.endsWith('/analyze')).length
  await app.mock.client('20000', 'g1').receive('今天股票又跌了')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const analyzeAfter = calls.filter((url) => url.endsWith('/analyze')).length
  assert.ok(analyzeAfter > analyzeBefore, 'a persona keyword must trigger analysis')
  const afterKeyword = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(afterKeyword.loops.some((loop: any) => loop.trigger === 'keyword'))
})

test('slash registration bypasses the LLM analyze/compose loop', async (t) => {
  const { app, calls } = await setup(t)
  await app.mock.client('20000', 'g1').receive('/注册')
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(calls.some((url) => url.endsWith('/qqbot/game/command')))
  assert.equal(calls.filter((url) => url.endsWith('/analyze')).length, 0)
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as aiChat from '../plugins/ai-chat/index.ts'

const SELF_ID = '10000'
const GROUP = '123456'
const USER = '20000'
const USER_B = '20001'
const IMAGE_URL = 'https://img.example.test/photo.png'

interface SetupResult { app: any; calls: any[]; imageRequests: string[] }

async function setup(t: TestContext, config: Record<string, any> = {}, runtimeSettings: Record<string, any> = {}): Promise<SetupResult> {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-ai-'))
  const discoveryFile = join(dir, 'data', 'ai.json')
  mkdirSync(dirname(discoveryFile), { recursive: true })
  writeFileSync(discoveryFile, JSON.stringify({
    endpoint: 'http://127.0.0.1:9/qqbot/ai/chat',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
  }), 'utf8')
  const settingsFile = join(dir, 'data', 'ai-settings.json')
  if (Object.keys(runtimeSettings).length > 0) writeFileSync(settingsFile, JSON.stringify(runtimeSettings), 'utf8')

  const calls: any[] = []
  const imageRequests: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    const target = String(url)
    if (target.startsWith(IMAGE_URL)) {
      imageRequests.push(target)
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => Buffer.from([137, 80, 78, 71]),
      } as any
    }
    calls.push({ url: target, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, reply: '这是 AI 的回复', provider: 'deepseek-account', model: 'deepseek-flash' }),
    } as any
  }) as typeof fetch

  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: SELF_ID })
  app.plugin(aiChat as any, {
    discoveryFile,
    settingsFile,
    stateFile: join(dir, 'ai-chat-state.json'),
    replyProbability: 0,
    batchWindowMs: 0,
    ...config,
  })
  await app.start()
  t.after(async () => {
    globalThis.fetch = originalFetch
    await app.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return { app, calls, imageRequests }
}

test('群消息进入上下文，@机器人 触发时把背景 + 当前消息发给 DSH', async (t) => {
  const { app, calls } = await setup(t)
  await app.mock.client(USER, GROUP).receive('今天天气不错')
  await app.mock.client(USER, GROUP).receive('你们在聊什么')
  const replies = await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 总结一下`)
  assert.deepEqual(replies, ['这是 AI 的回复'])
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/qqbot\/ai\/chat/u)
  const sent = calls[0].body.messages
  assert.equal(sent.length, 1)
  assert.ok(sent[0].text.includes('总结一下'))
  assert.ok(!sent[0].text.includes('[背景]'))
  assert.match(calls[0].body.background, /今天天气不错/u)
  assert.match(calls[0].body.background, /你们在聊什么/u)
  assert.equal(calls[0].body.groupId, GROUP)
  assert.equal(calls[0].body.userId, USER)
  assert.equal(typeof calls[0].body.userName, 'string')
})

test('/ai 前缀不触发 AI', async (t) => {
  const { app, calls } = await setup(t)
  const replies = await app.mock.client(USER, GROUP).receive('/ai 你好')
  assert.deepEqual(replies, [])
  assert.equal(calls.length, 0)
})

test('概率为 0 时普通消息只记录上下文，不回复', async (t) => {
  const { app, calls } = await setup(t)
  const replies = await app.mock.client(USER, GROUP).receive('随便聊聊')
  assert.deepEqual(replies, [])
  assert.equal(calls.length, 0)
})

test('概率为 1 时普通消息自动回复', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 1 })
  const replies = await app.mock.client(USER, GROUP).receive('今天群里好热闹')
  assert.deepEqual(replies, ['这是 AI 的回复'])
  assert.equal(calls.length, 1)
  assert.ok(calls[0].body.messages[0].text.includes('今天群里好热闹'))
})

test('回复某人后，3 分钟内继续回复此人的消息', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 0, followUpMinutes: 3 })
  await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 第一句`)
  assert.equal(calls.length, 1)
  const follow = await app.mock.client(USER, GROUP).receive('接着说')
  assert.deepEqual(follow, ['这是 AI 的回复'])
  assert.equal(calls.length, 2)
  const other = await app.mock.client(USER_B, GROUP).receive('另一个人的消息')
  assert.deepEqual(other, [])
  assert.equal(calls.length, 2)
})

test('引用机器人的消息必定触发', async (t) => {
  assert.equal(aiChat.isReplyToSelf({ quote: { user: { id: SELF_ID } } }, SELF_ID), true)
  assert.equal(aiChat.isReplyToSelf({ quote: { userId: Number(SELF_ID) } }, SELF_ID), true)
  assert.equal(aiChat.isReplyToSelf({ quote: { user: { id: USER } } }, SELF_ID), false)
  assert.equal(aiChat.isReplyToSelf({}, SELF_ID), false)
})

test('最多只把最近 100 条背景消息发给 DSH', async (t) => {
  const { app, calls } = await setup(t, { historyLimit: 100 })
  for (let index = 0; index < 105; index += 1) {
    await app.mock.client(USER, GROUP).receive(`背景消息 ${index}`)
  }
  await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 只看当前这条`)
  assert.equal(calls.length, 1)
  const messages = calls[0].body.messages
  assert.equal(messages.length, 1)
  assert.ok(messages[0].text.includes('只看当前这条'))
  const background = calls[0].body.background
  assert.ok(background.includes('背景消息 5'))
  assert.ok(!background.includes('背景消息 0'))
  assert.ok(background.includes('背景消息 104'))
  assert.equal(background.split('\n').length, 100)
})

test('当前消息带图片时把图片数据一起发给 DSH', async (t) => {
  const { app, calls, imageRequests } = await setup(t)
  const replies = await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/><img src="${IMAGE_URL}"/> 看图`)
  assert.deepEqual(replies, ['这是 AI 的回复'])
  assert.equal(calls.length, 1)
  assert.equal(imageRequests.length, 1)
  assert.equal(calls[0].body.images.length, 1)
  assert.equal(calls[0].body.images[0].mediaType, 'image/png')
  assert.equal(typeof calls[0].body.images[0].data, 'string')
})

test('AI 返回错误时给出友好提示', async (t) => {
  const { app } = await setup(t)
  globalThis.fetch = (async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: '模型返回错误：AUTH' }),
  })) as any
  const replies = await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 在吗`)
  assert.equal(replies.length, 1)
  assert.match(replies[0], /AI 暂时不可用/u)
})

test('splitReply 按长度拆分长回复', () => {
  const parts = aiChat.splitReply('a'.repeat(2500), 1000)
  assert.deepEqual(parts.map((p) => p.length), [1000, 1000, 500])
})


/** Replace fetch with a delayed endpoint-only implementation for concurrency tests. */
function installDelayedFetch(delayMs: number): any[] {
  const calls: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).includes('/qqbot/ai/chat')) return { ok: false, status: 404, json: async () => null } as any
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    calls.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ ok: true, reply: '并发回复' }) } as any
  }) as typeof fetch
  return calls
}

test('不同人的消息并发处理，不再出现“上一条还在处理”', async (t) => {
  const { app } = await setup(t, { replyProbability: 1 })
  const calls = installDelayedFetch(80)
  const [first, second] = await Promise.all([
    app.mock.client(USER, GROUP).receive('我是 A'),
    app.mock.client(USER_B, GROUP).receive('我是 B'),
  ])
  assert.deepEqual(first, ['并发回复'])
  assert.deepEqual(second, ['并发回复'])
  assert.equal(calls.length, 2)
  assert.ok(![...first, ...second].some((reply) => String(reply).includes('上一条')))
})

test('同一个人连续消息按队列顺序处理，但不会提示上一条正在处理', async (t) => {
  const { app } = await setup(t, { replyProbability: 1 })
  const calls = installDelayedFetch(60)
  const [first, second] = await Promise.all([
    app.mock.client(USER, GROUP).receive('第一句'),
    app.mock.client(USER, GROUP).receive('第二句'),
  ])
  assert.deepEqual(first, ['并发回复'])
  assert.deepEqual(second, ['并发回复'])
  assert.equal(calls.length, 2)
  assert.ok(![...first, ...second].some((reply) => String(reply).includes('上一条')))
})


test('面板写入的运行时设置优先于 koishi.yml 配置', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 0 }, { enabled: true, replyProbability: 1, followUpMinutes: 3, historyLimit: 100 })
  const replies = await app.mock.client(USER, GROUP).receive('设置文件触发的消息')
  assert.deepEqual(replies, ['这是 AI 的回复'])
  assert.equal(calls.length, 1)
})


test('sanitizeReplyText: 清掉回复开头的上下文标签', () => {
  assert.equal(aiChat.sanitizeReplyText('[背景] AI：你好'), '你好')
  assert.equal(aiChat.sanitizeReplyText('[当前消息] 小明：你好'), '你好')
  assert.equal(aiChat.sanitizeReplyText('正常回复 [图片]'), '正常回复 [图片]')
})


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('同一个人连续消息合并为一次回复（批量窗口）', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 1, batchWindowMs: 80, batchMaxWaitMs: 300 })
  await app.mock.client(USER, GROUP).receive('第一句')
  await app.mock.client(USER, GROUP).receive('第二句')
  await app.mock.client(USER, GROUP).receive('第三句')
  await sleep(180)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.messages[0].text, /第一句/u)
  assert.match(calls[0].body.messages[0].text, /第二句/u)
  assert.match(calls[0].body.messages[0].text, /第三句/u)
})

test('@触发后连续补充消息也只回复一次', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 0, batchWindowMs: 80, batchMaxWaitMs: 300 })
  await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 第一句`)
  await app.mock.client(USER, GROUP).receive('第二句补充')
  await sleep(180)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.messages[0].text, /第二句补充/u)
})

test('不同人的批量消息互不合并', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 1, batchWindowMs: 80, batchMaxWaitMs: 300 })
  await app.mock.client(USER, GROUP).receive('A 的消息')
  await app.mock.client(USER_B, GROUP).receive('B 的消息')
  await sleep(180)
  assert.equal(calls.length, 2)
})


test('运行时设置可以热切换批量窗口', async (t) => {
  const { app, calls } = await setup(
    t,
    { replyProbability: 1, batchWindowMs: 0, batchMaxWaitMs: 0 },
    { replyProbability: 1, followUpMinutes: 3, historyLimit: 100, batchWindowMs: 80, batchMaxWaitMs: 300 },
  )
  await app.mock.client(USER, GROUP).receive('批量第一条')
  await app.mock.client(USER, GROUP).receive('批量第二条')
  await sleep(180)
  assert.equal(calls.length, 1)
  assert.match(calls[0].body.messages[0].text, /批量第一条/u)
  assert.match(calls[0].body.messages[0].text, /批量第二条/u)
})


test('collectMentions / describeSessionForModel：区分 @自己、@别人、@全体', () => {
  const session = {
    selfId: SELF_ID,
    elements: [
      { type: 'at', attrs: { id: '999', name: '小明' } },
      { type: 'text', attrs: { content: ' 你好' } },
    ],
  }
  assert.deepEqual(aiChat.collectMentions(session, SELF_ID), { self: false, others: ['小明'], all: false })
  assert.equal(aiChat.describeSessionForModel(session, SELF_ID), '@小明 你好')
  const selfSession = { selfId: SELF_ID, elements: [{ type: 'at', attrs: { id: SELF_ID } }, { type: 'text', attrs: { content: ' 在吗' } }] }
  assert.equal(aiChat.collectMentions(selfSession, SELF_ID).self, true)
  assert.equal(aiChat.describeSessionForModel(selfSession, SELF_ID), '@你 在吗')
  const allSession = { selfId: SELF_ID, elements: [{ type: 'at', attrs: { id: 'all' } }] }
  assert.equal(aiChat.collectMentions(allSession, SELF_ID).all, true)
  assert.equal(aiChat.describeSessionForModel(allSession, SELF_ID), '@全体成员')
})

test('@别人且没有 @机器人 时不触发回复', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 1 })
  const replies = await app.mock.client(USER, GROUP).receive('<at id="999" name="小明"/> 晚上开黑吗')
  assert.deepEqual(replies, [])
  assert.equal(calls.length, 0)
})

test('@全体成员不会触发概率回复', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 1 })
  const replies = await app.mock.client(USER, GROUP).receive('<at id="all"/> 大家晚上好')
  assert.deepEqual(replies, [])
  assert.equal(calls.length, 0)
})

test('跟进窗口内 @别人 也不会插话', async (t) => {
  const { app, calls } = await setup(t, { replyProbability: 0, followUpMinutes: 3 })
  await app.mock.client(USER, GROUP).receive(`<at id="${SELF_ID}"/> 第一句`)
  assert.equal(calls.length, 1)
  const other = await app.mock.client(USER, GROUP).receive('<at id="999" name="小明"/> 你晚上来吗')
  assert.deepEqual(other, [])
  assert.equal(calls.length, 1)
})

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  Config,
  DEFAULT_MESSAGE_LIMIT,
  DEFAULT_MESSAGES_PATH,
  MAX_QUERY_MESSAGES,
  apply,
  clampMessageLimit,
  createMessageBuffer,
  describeElements,
  messageFromSession,
} from '../plugins/health/index.ts'

/** 与 DSH 侧共享的默认配置（测试不通过 loader，手动给全量字段）。 */
function makeConfig(overrides: Record<string, any> = {}): any {
  return {
    path: '/api/qqbot/health',
    contactsPath: '/api/qqbot/contacts',
    messagesPath: DEFAULT_MESSAGES_PATH,
    messageLimit: DEFAULT_MESSAGE_LIMIT,
    accessFile: join(tmpdir(), 'qqbot-health-missing-access.json'),
    ...overrides,
  }
}

/** 极简 fake Context：只实现 health 插件用到的 server.get / on / bots / qqbot。 */
function createFakeContext() {
  const routes = new Map<string, (koa: any) => any>()
  const listeners = new Map<string, Array<(payload: any) => any>>()
  const ctx = {
    bots: [] as any[],
    qqbot: {
      stats: {
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        messagesReceived: 0,
        messagesSent: 0,
        noticesReceived: 0,
        welcomesSent: 0,
      },
    },
    server: {
      get(path: string, handler: (koa: any) => any) {
        routes.set(path, handler)
      },
    },
    on(event: string, handler: (payload: any) => any) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
  }
  const emitSession = (session: any) => {
    for (const handler of listeners.get('internal/session') ?? []) handler(session)
  }
  const emitBeforeSend = (session: any) => {
    for (const handler of listeners.get('before-send') ?? []) handler(session)
  }
  return { ctx, routes, emitSession, emitBeforeSend }
}

function fakeSession(overrides: Record<string, any> = {}): any {
  return {
    type: 'message-created',
    selfId: '10000',
    isDirect: false,
    guildId: '123456',
    channelId: '123456',
    userId: '20000',
    content: '/echo hi',
    messageId: 'm1',
    user: { name: 'Alice' },
    elements: [{ type: 'text', attrs: { content: '/echo hi' } }],
    ...overrides,
  }
}

test('describeElements：text / at / 富媒体占位符 / 未知类型', () => {
  assert.equal(describeElements([]), '')
  assert.equal(describeElements(undefined), '')
  assert.equal(describeElements(null), '')
  assert.equal(describeElements('not-an-array'), '')
  assert.equal(describeElements([null, 42]), '')

  assert.equal(describeElements([{ type: 'text', attrs: { content: 'hello' } }]), 'hello')
  assert.equal(
    describeElements([
      { type: 'text', attrs: { content: 'hi ' } },
      { type: 'at', attrs: { id: '10000' } },
      { type: 'text', attrs: { content: ' bye' } },
    ]),
    'hi @10000 bye',
  )

  // at：名称优先，其次 QQ 号
  assert.equal(describeElements([{ type: 'at', attrs: { id: '123', name: 'Alice' } }]), '@Alice')
  assert.equal(describeElements([{ type: 'at', attrs: { qq: '456' } }]), '@456')
  assert.equal(describeElements([{ type: 'at', attrs: {} }]), '@')

  // 富媒体占位符
  assert.equal(describeElements([{ type: 'image', attrs: { url: 'x' } }]), '[图片]')
  assert.equal(describeElements([{ type: 'face', attrs: { id: '1' } }]), '[表情]')
  assert.equal(describeElements([{ type: 'record', attrs: {} }]), '[语音]')
  assert.equal(describeElements([{ type: 'video', attrs: {} }]), '[视频]')
  assert.equal(describeElements([{ type: 'file', attrs: { name: 'a.txt' } }]), '[文件]')
  assert.equal(describeElements([{ type: 'reply', attrs: { id: '9' } }]), '[回复]')
  // 其他 -> [type]
  assert.equal(describeElements([{ type: 'markdown' }, { type: 'button' }]), '[markdown][button]')
  // 空 text 不产生内容
  assert.equal(describeElements([{ type: 'text', attrs: { content: '' } }]), '')
})

test('createMessageBuffer：250 条只保留最新 200 条，total 累计，正序返回', () => {
  const buffer = createMessageBuffer(200)
  assert.equal(buffer.limit, 200)
  assert.equal(buffer.size, 0)
  assert.equal(buffer.total, 0)
  assert.equal(buffer.updatedAt, null)

  let last: any
  for (let index = 1; index <= 250; index += 1) {
    last = buffer.push({
      scene: 'group',
      targetId: '123456',
      groupId: '123456',
      userId: '20000',
      userName: 'Alice',
      content: `msg-${index}`,
    })
  }

  assert.equal(buffer.size, 200)
  assert.equal(buffer.total, 250)
  assert.equal(last.id, 250)
  assert.equal(last.direction, 'in')
  assert.match(last.time, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(buffer.updatedAt, last.time)

  const messages = buffer.list(200)
  assert.equal(messages.length, 200)
  // 已被裁剪掉最旧的 50 条
  assert.equal(messages[0].content, 'msg-51')
  assert.equal(messages[0].id, 51)
  assert.equal(messages.at(-1)?.content, 'msg-250')
  // 正序（旧 -> 新）
  assert.deepEqual(messages.slice(0, 3).map((message) => message.content), ['msg-51', 'msg-52', 'msg-53'])

  // list 只取尾部，且 count 会 clamp 到 1..limit
  assert.deepEqual(buffer.list(3).map((message) => message.content), ['msg-248', 'msg-249', 'msg-250'])
  assert.equal(buffer.list(0).length, 1)
  assert.equal(buffer.list(9999).length, 200)

  buffer.clear()
  assert.equal(buffer.size, 0)
  assert.equal(buffer.total, 0)
  assert.equal(buffer.updatedAt, null)
  assert.deepEqual(buffer.list(10), [])
})

test('messageFromSession：群聊映射 scene/groupId/targetId/userName', () => {
  const message = messageFromSession(fakeSession())
  assert.deepEqual(message, {
    scene: 'group',
    targetId: '123456',
    groupId: '123456',
    userId: '20000',
    userName: 'Alice',
    content: '/echo hi',
    messageId: 'm1',
    direction: 'in',
  })

  // userName 回退到 session.username
  assert.equal(messageFromSession(fakeSession({ user: undefined, username: 'Bob' })).userName, 'Bob')
  // 拿不到昵称时不带 userName 字段
  const anonymous = messageFromSession(fakeSession({ user: undefined, username: undefined }))
  assert.equal('userName' in anonymous, false)
  // messageId 数字转字符串、缺失时省略
  assert.equal(messageFromSession(fakeSession({ messageId: 123 })).messageId, '123')
  assert.equal('messageId' in messageFromSession(fakeSession({ messageId: undefined })), false)
  // 群没有 guildId 时回落到 channelId
  const channelOnly = messageFromSession(fakeSession({ guildId: undefined, channelId: '999' }))
  assert.equal(channelOnly.scene, 'group')
  assert.equal(channelOnly.targetId, '999')
  assert.equal(channelOnly.groupId, '999')
})

test('messageFromSession：私聊映射 scene=private，content 为空时用 elements 摘要', () => {
  const privateMessage = messageFromSession(
    fakeSession({ isDirect: true, guildId: undefined, channelId: 'private:20000', content: 'hello' }),
  )
  assert.equal(privateMessage.scene, 'private')
  assert.equal(privateMessage.targetId, '20000')
  assert.equal(privateMessage.userId, '20000')
  assert.equal('groupId' in privateMessage, false)
  assert.equal(privateMessage.content, 'hello')

  // isDirect 缺失时，private: channel 前缀也可判定私聊
  const fallback = messageFromSession(
    fakeSession({ isDirect: undefined, guildId: undefined, channelId: 'private:20001', userId: '20001', content: 'x' }),
  )
  assert.equal(fallback.scene, 'private')
  assert.equal(fallback.targetId, '20001')

  // content 为空 -> elements 可读摘要
  const rich = messageFromSession(
    fakeSession({
      isDirect: true,
      guildId: undefined,
      channelId: 'private:20000',
      content: '',
      elements: [
        { type: 'image', attrs: { url: 'x' } },
        { type: 'at', attrs: { id: '10000' } },
        { type: 'text', attrs: { content: ' hi' } },
      ],
    }),
  )
  assert.equal(rich.content, '[图片]@10000 hi')

  // content 非空时原样使用，不重新生成摘要
  const raw = messageFromSession(
    fakeSession({ content: '<image url="x"/>', elements: [{ type: 'image', attrs: { url: 'x' } }] }),
  )
  assert.equal(raw.content, '<image url="x"/>')
})

test('clampMessageLimit：1..200，非法值回落 50', () => {
  assert.equal(clampMessageLimit(undefined), 50)
  assert.equal(clampMessageLimit(''), 50)
  assert.equal(clampMessageLimit('abc'), 50)
  assert.equal(clampMessageLimit('10'), 10)
  assert.equal(clampMessageLimit(0), 1)
  assert.equal(clampMessageLimit(-5), 1)
  assert.equal(clampMessageLimit(2.9), 2)
  assert.equal(clampMessageLimit(999), MAX_QUERY_MESSAGES)
  assert.equal(MAX_QUERY_MESSAGES, 200)
})

test('Config 默认值：新增 messagesPath/messageLimit，旧字段保持不变', () => {
  const resolved = (Config as any)({})
  assert.equal(resolved.path, '/api/qqbot/health')
  assert.equal(resolved.contactsPath, '/api/qqbot/contacts')
  assert.equal(resolved.messagesPath, DEFAULT_MESSAGES_PATH)
  assert.equal(resolved.messageLimit, DEFAULT_MESSAGE_LIMIT)
  assert.equal(DEFAULT_MESSAGES_PATH, '/api/qqbot/messages')
  assert.equal(DEFAULT_MESSAGE_LIMIT, 200)
})

test('apply 接线：记录入站消息，/api/qqbot/messages 返回 {ok,messages,total,updatedAt}', () => {
  const { ctx, routes, emitSession } = createFakeContext()
  apply(ctx as any, makeConfig({ messageLimit: 200 }))

  assert.ok(routes.has('/api/qqbot/health'))
  assert.ok(routes.has('/api/qqbot/contacts'))
  assert.ok(routes.has('/api/qqbot/messages'))

  emitSession(fakeSession({ content: '/echo one', messageId: 'm1' }))
  emitSession(fakeSession({ isDirect: true, guildId: undefined, channelId: 'private:20000', content: 'hi' }))
  // 非消息事件不记录
  emitSession(fakeSession({ type: 'notice' }))
  emitSession(fakeSession({ type: 'message-deleted' }))
  emitSession(fakeSession({ type: 'guild-member-added' }))

  const koa: any = { query: { limit: '50' }, body: null }
  routes.get('/api/qqbot/messages')!(koa)
  assert.equal(koa.body.ok, true)
  assert.equal(koa.body.total, 2)
  assert.equal(koa.body.messages.length, 2)
  assert.equal(typeof koa.body.updatedAt, 'string')
  // 正序：旧 -> 新
  assert.equal(koa.body.messages[0].content, '/echo one')
  assert.equal(koa.body.messages[0].scene, 'group')
  assert.equal(koa.body.messages[1].scene, 'private')
  assert.equal(koa.body.messages[1].targetId, '20000')
  assert.match(koa.body.messages[0].time, /^\d{4}-\d{2}-\d{2}T/)

  // 无消息时也是稳定结构
  const empty = createFakeContext()
  apply(empty.ctx as any, makeConfig())
  const emptyKoa: any = { query: {}, body: null }
  empty.routes.get('/api/qqbot/messages')!(emptyKoa)
  assert.deepEqual(emptyKoa.body.messages, [])
  assert.equal(emptyKoa.body.total, 0)
  assert.equal(typeof emptyKoa.body.updatedAt, 'string')
})

test('apply 接线：?limit 会 clamp 到 1..200，且 total 是累计收到数', () => {
  const { ctx, routes, emitSession } = createFakeContext()
  // 缓冲上限 300，用于区分「缓冲上限」与「接口单次最多 200 条」
  apply(ctx as any, makeConfig({ messageLimit: 300 }))
  for (let index = 1; index <= 250; index += 1) {
    emitSession(fakeSession({ content: `msg-${index}` }))
  }

  const koa: any = { query: { limit: '999' }, body: null }
  routes.get('/api/qqbot/messages')!(koa)
  assert.equal(koa.body.total, 250)
  assert.equal(koa.body.messages.length, 200) // 接口上限 200
  assert.equal(koa.body.messages[0].content, 'msg-51')
  assert.equal(koa.body.messages.at(-1)?.content, 'msg-250')

  const small: any = { query: { limit: '3' }, body: null }
  routes.get('/api/qqbot/messages')!(small)
  assert.equal(small.body.messages.length, 3)
  assert.deepEqual(small.body.messages.map((message: any) => message.content), ['msg-248', 'msg-249', 'msg-250'])
})

test('apply 接线：/api/qqbot/health 与 /api/qqbot/contacts 行为不变', async () => {
  const { ctx, routes } = createFakeContext()
  apply(ctx as any, makeConfig())

  const healthKoa: any = { body: null }
  routes.get('/api/qqbot/health')!(healthKoa)
  assert.equal(healthKoa.body.ok, false)
  assert.deepEqual(healthKoa.body.bots, [])
  assert.equal(healthKoa.body.stats.messagesReceived, 0)
  assert.equal(healthKoa.body.stats.welcomesSent, 0)

  const contactsKoa: any = { body: null, status: 200 }
  await routes.get('/api/qqbot/contacts')!(contactsKoa)
  assert.deepEqual(contactsKoa.body, {
    ok: false,
    error: '没有在线的机器人账号',
    groups: [],
    friends: [],
  })
})


test('messageFromSession：出站消息记为 out，sender 为机器人', () => {
  const payload = messageFromSession({
    isDirect: false,
    guildId: '1026855069',
    channelId: '1026855069',
    selfId: '676512192',
    content: '收到',
    bot: { user: { name: '机器人昵称' } },
  }, 'out')
  assert.equal(payload.direction, 'out')
  assert.equal(payload.userId, '676512192')
  assert.equal(payload.userName, '机器人昵称')
  assert.equal(payload.groupId, '1026855069')
  assert.equal(payload.content, '收到')
})

test('apply：只记录权限白名单目标群的入站 + 出站消息', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-health-access-'))
  const accessFile = join(dir, 'access.json')
  writeFileSync(accessFile, JSON.stringify({
    version: 1,
    inbound: { groups: { mode: 'whitelist', ids: ['1026855069'] }, private: { mode: 'all', ids: [] }, quiet: { enabled: false, prefixes: ['/'] } },
    outbound: { groups: { mode: 'whitelist', ids: ['1026855069'] }, private: { mode: 'all', ids: [] } },
  }))
  const { ctx, routes, emitSession, emitBeforeSend } = createFakeContext()
  apply(ctx as any, makeConfig({ accessFile }))
  emitSession(fakeSession({ guildId: '1026855069', channelId: '1026855069', content: '你好' }))
  emitSession(fakeSession({ guildId: '999999', channelId: '999999', content: '不该出现' }))
  emitBeforeSend(fakeSession({ guildId: '1026855069', channelId: '1026855069', content: '收到', userId: undefined, selfId: '10000' }))
  emitBeforeSend(fakeSession({ guildId: '999999', channelId: '999999', content: '不该出现', userId: undefined, selfId: '10000' }))
  const handler = routes.get(DEFAULT_MESSAGES_PATH)!
  const koa: any = { query: {} }
  handler(koa)
  const body = koa.body
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].direction, 'in')
  assert.equal(body.messages[0].content, '你好')
  assert.equal(body.messages[1].direction, 'out')
  assert.equal(body.messages[1].content, '收到')
  rmSync(dir, { recursive: true, force: true })
})

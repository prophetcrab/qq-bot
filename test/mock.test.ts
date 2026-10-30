import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as corePlugin from '../plugins/core/index.ts'
import * as echoPlugin from '../plugins/echo/index.ts'
import * as welcomePlugin from '../plugins/welcome/index.ts'

async function createApp() {
  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: '10000' })
  app.plugin(corePlugin)
  app.plugin(echoPlugin)
  app.plugin(welcomePlugin)
  await app.start()
  return app
}

test('指令：/echo 会复读文字', async () => {
  const app = await createApp()
  try {
    const client = app.mock.client('20000')
    await client.shouldReply('/echo 你好，世界', '你好，世界')
    await client.shouldReply('/复读 hello', 'hello')
  } finally {
    await app.stop()
  }
})

test('中间件：关键词 ping 直接回复 pong，其他消息放行', async () => {
  const app = await createApp()
  try {
    const client = app.mock.client('20000')
    // 只应回复一次 pong：中间件若直接 return session.send(...)，
    // 其返回值（消息 id 数组）会被 Koishi 当作新消息再次发送。
    const replies = await client.receive('ping')
    assert.deepEqual(replies, ['pong'])
    await client.shouldReply('PING', 'pong')
    await client.shouldNotReply('无关消息')
  } finally {
    await app.stop()
  }
})

test('服务与指令：/qqbot.status 返回运行统计', async () => {
  const app = await createApp()
  try {
    const client = app.mock.client('20000')
    await client.receive('ping')
    await client.shouldReply('/qqbot.status', /运行时长：\d{2}:\d{2}:\d{2}/)
    assert.equal(app.qqbot.stats.messagesReceived >= 1, true)
    assert.equal(typeof app.qqbot.statsSummary(), 'string')
  } finally {
    await app.stop()
  }
})

test('配置：核心插件可编程传参覆盖默认值', async () => {
  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: '10000' })
  app.plugin(corePlugin, { statusCommand: false, adminUsers: ['123'] } as any)
  app.plugin(echoPlugin)
  await app.start()
  try {
    assert.equal(app.qqbot.config.statusCommand, false)
    assert.equal(app.qqbot.isAdmin('123'), true)
    assert.equal(app.qqbot.isAdmin('456'), false)
  } finally {
    await app.stop()
  }
})

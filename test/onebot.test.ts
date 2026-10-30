import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, type WebSocket } from 'ws'
import { App } from 'koishi'
import { HTTP } from '@koishijs/plugin-http'
import onebot from 'koishi-plugin-adapter-onebot'
import * as corePlugin from '../plugins/core/index.ts'
import * as echoPlugin from '../plugins/echo/index.ts'
import * as welcomePlugin from '../plugins/welcome/index.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean, label: string, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await sleep(30)
  }
  throw new Error(`等待超时：${label}`)
}

/** 模拟一个 OneBot 11 WebSocket 服务端（相当于 NapCat / Lagrange 的 WS 服务端） */
function createOneBotServer() {
  const wss = new WebSocketServer({ port: 0 })
  const actions: any[] = []
  return new Promise<{ wss: WebSocketServer; port: number; actions: any[]; getSocket: () => WebSocket }>((resolve) => {
    wss.once('listening', () => {
      const port = (wss.address() as { port: number }).port
      resolve({
        wss,
        port,
        actions,
        getSocket: () => [...wss.clients][0] as WebSocket,
      })
    })
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const action = JSON.parse(raw.toString())
        actions.push(action)
        let data: any = {}
        if (action.action === 'get_login_info') data = { user_id: 10000, nickname: 'TestBot' }
        else if (action.action === 'send_group_msg' || action.action === 'send_private_msg') data = { message_id: 1000 + actions.length }
        else if (action.action === 'get_group_list') data = []
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: action.echo }))
      })
    })
  })
}

function groupMessage(content: string) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 10000,
    group_id: 123456,
    user_id: 20000,
    message_id: 1,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: content } }],
    raw_message: content,
    font: 0,
    sender: { user_id: 20000, nickname: 'Alice', card: '', role: 'member' },
  }
}

test('OneBot 11 WebSocket：连接 → 收消息 → 指令回复 → 发消息', async () => {
  const server = await createOneBotServer()
  const app = new App({ prefix: ['/'] })
  app.plugin(HTTP)
  app.plugin(onebot as any, {
    selfId: '10000',
    protocol: 'ws',
    endpoint: `ws://127.0.0.1:${server.port}`,
    retryInterval: 100,
  })
  app.plugin(corePlugin)
  app.plugin(echoPlugin)
  app.plugin(welcomePlugin)

  await app.start()
  try {
    // 1. 连接建立且机器人上线
    await waitUntil(
      () => app.bots.length > 0 && app.bots[0].status === 1 && server.wss.clients.size > 0,
      '机器人上线',
    )
    assert.equal(app.bots[0].selfId, '10000')
    assert.ok(server.actions.some((action) => action.action === 'get_login_info'))

    // 2. 服务端推送一条群消息：/echo hello
    server.getSocket().send(JSON.stringify(groupMessage('/echo hello')))

    // 3. 机器人应通过 OneBot API 发出群消息
    await waitUntil(
      () => server.actions.some((action) => action.action === 'send_group_msg'),
      '发送群消息',
    )
    const reply = server.actions.find((action) => action.action === 'send_group_msg')
    assert.equal(reply.params.group_id, 123456)
    assert.equal(reply.params.message[0].data.text, 'hello')

    // 4. 推送入群通知，验证事件归一化与欢迎插件
    server.actions.length = 0
    server.getSocket().send(
      JSON.stringify({
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        self_id: 10000,
        group_id: 123456,
        user_id: 30000,
        operator_id: 20000,
        time: Math.floor(Date.now() / 1000),
      }),
    )
    await waitUntil(
      () => server.actions.some((action) => action.action === 'send_group_msg'),
      '发送入群欢迎',
    )
    const welcome = server.actions.find((action) => action.action === 'send_group_msg')
    const segments = welcome.params.message
    assert.equal(segments[0].type, 'at')
    assert.equal(String(segments[0].data.qq), '30000')
    assert.ok(
      segments.some((segment: any) => segment.type === 'text' && String(segment.data.text).includes('欢迎')),
    )
  } finally {
    await app.stop()
    server.wss.close()
  }
})

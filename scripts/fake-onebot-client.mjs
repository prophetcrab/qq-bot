#!/usr/bin/env node
/**
 * 本地「假 QQ」调试工具：模拟 NapCat / Lagrange 的反向 WebSocket 客户端。
 *
 * 用途：不接真实 QQ，也能完整验证「连接 → 收消息 → 指令处理 → 发消息」链路。
 *
 *   1. npm start                       # 启动机器人（默认监听 ws://127.0.0.1:5140/onebot）
 *   2. npm run mock:qq                 # 另开终端，启动本工具
 *
 * 启动后会自动发送一条 /echo 消息和一条入群通知；之后可在终端输入文字继续对话。
 * 环境变量：ONEBOT_REVERSE_URL / ONEBOT_SELF_ID / DEMO_GROUP_ID
 */
import WebSocket from 'ws'
import readline from 'node:readline'

const URL = process.env.ONEBOT_REVERSE_URL || 'ws://127.0.0.1:5140/onebot'
const SELF_ID = String(process.env.ONEBOT_SELF_ID || '10000')
const GROUP_ID = Number(process.env.DEMO_GROUP_ID || 123456)
const USER_ID = 20000
let online = false

const ws = new WebSocket(URL, {
  headers: { 'x-client-role': 'Universal', 'x-self-id': SELF_ID },
})

function now() {
  return Math.floor(Date.now() / 1000)
}

function sendMessage(content) {
  ws.send(
    JSON.stringify({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: Number(SELF_ID),
      group_id: GROUP_ID,
      user_id: USER_ID,
      message_id: Date.now() % 100000,
      time: now(),
      message: [{ type: 'text', data: { text: content } }],
      raw_message: content,
      font: 0,
      sender: { user_id: USER_ID, nickname: '调试用户', card: '', role: 'member' },
    }),
  )
  console.log(`\x1b[36m你 →\x1b[0m ${content}`)
}

function sendMemberJoined(userId = 30000) {
  ws.send(
    JSON.stringify({
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      self_id: Number(SELF_ID),
      group_id: GROUP_ID,
      user_id: userId,
      operator_id: USER_ID,
      time: now(),
    }),
  )
  console.log(`\x1b[90m[模拟事件] ${userId} 加入了群 ${GROUP_ID}\x1b[0m`)
}

ws.on('open', () => {
  console.log(`\x1b[32m已连接到 ${URL}\x1b[0m（selfId=${SELF_ID}, group=${GROUP_ID}）`)
})

ws.on('message', (raw) => {
  let action
  try {
    action = JSON.parse(raw.toString())
  } catch {
    return
  }

  const reply = (data) =>
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: action.echo }))

  switch (action.action) {
    case 'get_login_info':
      reply({ user_id: Number(SELF_ID), nickname: 'MockQQ' })
      if (!online) {
        online = true
        console.log('\x1b[32m机器人已上线\x1b[0m')
        setTimeout(() => sendMessage('/echo 反向 WebSocket 链路正常'), 1500)
        setTimeout(() => sendMemberJoined(), 2200)
        setTimeout(() => console.log('\x1b[90m输入任意文字作为群消息发送；输入 /quit 退出。\x1b[0m\n'), 2600)
      }
      break
    case 'send_group_msg':
    case 'send_private_msg':
      reply({ message_id: Date.now() % 100000 })
      console.log(`\x1b[32m机器人 →\x1b[0m ${renderSegments(action.params.message)}`)
      break
    default:
      reply({})
      break
  }
})

function renderSegments(message) {
  if (typeof message === 'string') return message
  return (message || [])
    .map((segment) => {
      if (segment.type === 'text') return segment.data.text
      if (segment.type === 'at') return `@${segment.data.qq}`
      if (segment.type === 'image') return '[图片]'
      return `[${segment.type}]`
    })
    .join('')
}

ws.on('close', () => {
  console.log('\x1b[33m连接已断开\x1b[0m')
  process.exit(0)
})

ws.on('error', (error) => {
  console.error(`\x1b[31m连接失败：${error.message}\x1b[0m`)
  console.error('请确认机器人已启动（npm start），且 koishi.yml 中 adapter-onebot 使用 ws-reverse。')
  process.exit(1)
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  if (text === '/quit' || text === '/exit') {
    ws.close()
    return
  }
  sendMessage(text)
})
rl.on('SIGINT', () => ws.close())

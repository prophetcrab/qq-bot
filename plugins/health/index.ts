import { Context, Schema } from 'koishi'
import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'health'
export const inject = ['server', 'qqbot']

/** 默认保留的最近消息条数。 */
export const DEFAULT_MESSAGE_LIMIT = 200

/** 默认消息流接口路径。 */
export const DEFAULT_MESSAGES_PATH = '/api/qqbot/messages'

/** 单次查询最多返回的消息条数。 */
export const MAX_QUERY_MESSAGES = 200

/** 一条入站/出站消息记录（/api/qqbot/messages 的数组元素）。 */
export interface MessageRecord {
  /** 自增序号 */
  id: number
  /** ISO 时间字符串 */
  time: string
  direction: 'in' | 'out'
  scene: 'group' | 'private'
  /** 群聊为群号，私聊为 userId */
  targetId: string
  /** 仅群聊存在 */
  groupId?: string
  userId: string
  /** 昵称（拿不到时省略） */
  userName?: string
  /** 原文；原文为空时使用 elements 的可读摘要 */
  content: string
  messageId?: string
}

/** 不含缓冲区生成字段（id/time）的消息内容；direction 默认 in。 */
export type MessagePayload = Omit<MessageRecord, 'id' | 'time' | 'direction'> & { direction?: 'in' | 'out' }

/** 内存环形消息缓冲。 */
export interface MessageBuffer {
  /** 缓冲上限 */
  readonly limit: number
  /** 当前缓冲条数 */
  readonly size: number
  /** 自插件启动以来收到的消息总数（含已被裁剪的） */
  readonly total: number
  /** 最后一条消息的时间 */
  readonly updatedAt: string | null
  push(payload: MessagePayload): MessageRecord
  /** 取最近的 limit 条，按时间正序（旧 -> 新）返回 */
  list(limit?: number): MessageRecord[]
  clear(): void
}

/** 元素类型 -> 可读占位符。 */
const ELEMENT_PLACEHOLDERS: Record<string, string> = {
  image: '[图片]',
  face: '[表情]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  reply: '[回复]',
}

/**
 * 把消息 elements 转成可读文本摘要，用于 content 为空的消息。
 *
 * text 取原文，at 取 `@名称/QQ`，常见富媒体用占位符，其余用 `[type]`。
 */
export function describeElements(elements: unknown): string {
  if (!Array.isArray(elements)) return ''
  const parts: string[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') continue
    const type = typeof (element as { type?: unknown }).type === 'string' ? (element as { type: string }).type : ''
    const attrs = (element as { attrs?: Record<string, any> }).attrs ?? {}
    if (type === 'text') {
      const text = attrs['content']
      if (typeof text === 'string' && text !== '') parts.push(text)
      continue
    }
    if (type === 'at') {
      const label = attrs['name'] ?? attrs['nick'] ?? attrs['id'] ?? attrs['qq'] ?? ''
      parts.push(`@${String(label)}`)
      continue
    }
    const placeholder = ELEMENT_PLACEHOLDERS[type]
    parts.push(placeholder ?? `[${type || 'unknown'}]`)
  }
  return parts.join('')
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** 把查询参数 clamp 到 1..200，非法值回落到 50。 */
export function clampMessageLimit(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') return fallback
  return clampInteger(value, fallback, 1, MAX_QUERY_MESSAGES)
}

/**
 * 创建固定上限的环形消息缓冲。
 *
 * 超过上限时从最旧的消息开始丢弃；`total` 仍是累计收到数。
 */
export function createMessageBuffer(limit: number = DEFAULT_MESSAGE_LIMIT): MessageBuffer {
  const capacity = clampInteger(limit, DEFAULT_MESSAGE_LIMIT, 1, 5000)
  const records: MessageRecord[] = []
  let sequence = 0
  let total = 0
  let updatedAt: string | null = null

  return {
    limit: capacity,
    get size() {
      return records.length
    },
    get total() {
      return total
    },
    get updatedAt() {
      return updatedAt
    },
    push(payload) {
      sequence += 1
      total += 1
      const record: MessageRecord = {
        id: sequence,
        time: new Date().toISOString(),
        direction: 'in',
        ...payload,
      }
      records.push(record)
      if (records.length > capacity) records.splice(0, records.length - capacity)
      updatedAt = record.time
      return record
    },
    list(count = capacity) {
      const asked = clampInteger(count, capacity, 1, capacity)
      const start = Math.max(0, records.length - asked)
      return records.slice(start)
    },
    clear() {
      records.length = 0
      sequence = 0
      total = 0
      updatedAt = null
    },
  }
}

/**
 * 把 Koishi session 映射成一条消息记录内容。
 *
 * 群聊 scene=group（targetId/groupId 取 guildId || channelId），私聊 scene=private
 * （targetId=userId）；content 为空时回落到 describeElements。
 */
export function messageFromSession(session: any, direction: 'in' | 'out' = 'in'): MessagePayload {
  const channelId = session?.channelId !== undefined && session?.channelId !== null ? String(session.channelId) : ''
  const guildId = session?.guildId !== undefined && session?.guildId !== null && session.guildId !== '' ? String(session.guildId) : undefined
  const userId = direction === 'out'
    ? String(session?.selfId ?? session?.userId ?? '')
    : (session?.userId !== undefined && session?.userId !== null ? String(session.userId) : '')

  const isDirect = session?.isDirect === true || (guildId === undefined && channelId.startsWith('private:'))
  const scene: MessageRecord['scene'] = isDirect ? 'private' : 'group'
  const targetId = scene === 'group' ? guildId ?? channelId : userId

  const rawContent = typeof session?.content === 'string' ? session.content : ''
  const content = rawContent.trim() === '' ? describeElements(session?.elements) : rawContent

  const payload: MessagePayload = { scene, targetId, userId, content, direction }

  if (scene === 'group') payload.groupId = guildId ?? channelId
  const rawMessageId = session?.messageId
  if (rawMessageId !== undefined && rawMessageId !== null && String(rawMessageId) !== '') {
    payload.messageId = String(rawMessageId)
  }
  const userName = direction === 'out'
    ? (session?.bot?.user?.name || session?.username || '机器人')
    : (session?.user?.name || session?.username)
  if (userName !== undefined && userName !== null && String(userName) !== '') {
    payload.userName = String(userName)
  }
  return payload
}

export interface Config {
  /** 健康检查接口路径 */
  path: string
  /** 群/好友列表接口路径 */
  contactsPath: string
  /** 最近消息接口路径 */
  messagesPath: string
  /** 内存中保留的最近消息条数上限 */
  messageLimit: number
  /** 权限策略文件：用于只记录白名单目标群的消息 */
  accessFile: string
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('/api/qqbot/health').description('健康检查接口路径'),
  contactsPath: Schema.string().default('/api/qqbot/contacts').description('群聊/好友列表接口路径'),
  messagesPath: Schema.string()
    .default(DEFAULT_MESSAGES_PATH)
    .description('最近入站消息接口路径（DSH 面板消息流）'),
  messageLimit: Schema.natural()
    .default(DEFAULT_MESSAGE_LIMIT)
    .min(1)
    .description('内存中保留的最近消息条数上限'),
  accessFile: Schema.string()
    .default('data/access.json')
    .description('权限策略文件；配置白名单时只把目标群的消息记录到监控面板'),
})

/**
 * 健康检查 / 监控接口。
 *
 *   GET /api/qqbot/health
 *   {
 *     "ok": true,
 *     "bots": [{ "platform": "onebot", "selfId": "676512192", "status": 1, "online": true }],
 *     "stats": { ... }
 *   }
 *
 *   GET /api/qqbot/messages?limit=50
 *   {
 *     "ok": true,
 *     "messages": [{ "id": 1, "time": "...", "direction": "in", "scene": "group",
 *                    "targetId": "123456", "groupId": "123456", "userId": "20000",
 *                    "userName": "Alice", "content": "/echo hi", "messageId": "..." }],
 *     "total": 123,
 *     "updatedAt": "..."
 *   }
 *
 * `messages` 按时间正序（旧 -> 新）返回最近 `limit` 条（direction 为 in/out）；total
 * 为插件启动以来记录的消息总数（包含已被环形缓冲裁剪的）。可用于进程守护、状态页与 DSH 消息流面板。
 */
function sessionGroupId(session: any): string {
  const guildId = session?.guildId !== undefined && session?.guildId !== null && session.guildId !== '' ? String(session.guildId) : ''
  const channelId = session?.channelId !== undefined && session?.channelId !== null ? String(session.channelId) : ''
  return guildId !== '' ? guildId : channelId
}

function loadAccessPolicy(path: string): any {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function apply(ctx: Context, config: Config) {
  const messages = createMessageBuffer(config.messageLimit)
  const accessPath = resolve(process.cwd(), config.accessFile)
  let policy: any = loadAccessPolicy(accessPath)

  const reloadPolicy = () => {
    policy = loadAccessPolicy(accessPath)
  }
  if (typeof (ctx as any).effect === 'function') {
    ;(ctx as any).effect(() => {
      watchFile(accessPath, { interval: 1000 }, reloadPolicy)
      return () => {
        unwatchFile(accessPath, reloadPolicy)
      }
    })
  }

  const monitored = (section: any, id: string): boolean => {
    if (section === null || section === undefined) return true
    const ids = Array.isArray(section.ids) ? section.ids.map((item: any) => String(item)) : []
    if (section.mode === 'whitelist') return ids.includes(id)
    if (section.mode === 'blacklist') return !ids.includes(id)
    return true
  }
  const inboundAllowed = (session: any): boolean => {
    if (policy === null) return true
    const direct = session?.isDirect === true || (session?.guildId === undefined && String(session?.channelId ?? '').startsWith('private:'))
    if (direct) return monitored(policy.inbound?.private, String(session?.userId ?? ''))
    return monitored(policy.inbound?.groups, sessionGroupId(session))
  }
  const outboundAllowed = (session: any): boolean => {
    if (policy === null) return true
    const direct = session?.isDirect === true || (session?.guildId === undefined && String(session?.channelId ?? '').startsWith('private:'))
    if (direct) return monitored(policy.outbound?.private, String(session?.userId ?? session?.selfId ?? ''))
    return monitored(policy.outbound?.groups, sessionGroupId(session))
  }

  // internal/session 在中间件之前触发；这里按权限策略过滤，只记录目标群消息。
  ctx.on('internal/session', (session) => {
    const type = (session as { type?: string } | null)?.type
    if (type !== 'message' && type !== 'message-created') return
    if (!inboundAllowed(session)) return
    messages.push(messageFromSession(session, 'in'))
  })

  // before-send 在真正发送前触发；记录机器人发出的消息（回复、指令结果等）。
  ctx.on('before-send', (session) => {
    if (!outboundAllowed(session)) return
    messages.push(messageFromSession(session, 'out'))
  })

  // 群/好友列表：供控制中心做「点击式」权限管理
  ctx.server.get(config.contactsPath, async (koa) => {
    const bot = ctx.bots.find((bot) => bot.status === 1)
    if (!bot) {
      koa.status = 200
      koa.body = { ok: false, error: '没有在线的机器人账号', groups: [], friends: [] }
      return
    }
    try {
      const [groups, friends] = await Promise.all([loadGroups(bot), loadFriends(bot)])
      koa.body = {
        ok: true,
        selfId: bot.selfId,
        platform: bot.platform,
        groups,
        friends,
        fetchedAt: new Date().toISOString(),
      }
    } catch (error) {
      koa.body = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        groups: [],
        friends: [],
      }
    }
  })

  // 最近入站/出站消息：供 DSH 面板展示实时消息流
  ctx.server.get(config.messagesPath, (koa) => {
    const limit = clampMessageLimit(koa.query?.limit)
    koa.body = {
      ok: true,
      messages: messages.list(limit),
      total: messages.total,
      updatedAt: messages.updatedAt ?? new Date().toISOString(),
    }
  })

  ctx.server.get(config.path, (koa) => {
    const bots = ctx.bots.map((bot) => ({
      platform: bot.platform,
      selfId: bot.selfId,
      status: bot.status,
      online: bot.status === 1,
    }))
    koa.body = {
      ok: bots.some((bot) => bot.online),
      bots,
      stats: {
        startedAt: ctx.qqbot.stats.startedAt,
        messagesReceived: ctx.qqbot.stats.messagesReceived,
        messagesSent: ctx.qqbot.stats.messagesSent,
        noticesReceived: ctx.qqbot.stats.noticesReceived,
        welcomesSent: ctx.qqbot.stats.welcomesSent,
      },
    }
  })
}


/** Normalize a OneBot get_group_list entry. */
export function mapGroup(raw: any): { id: string; name: string; memberCount?: number } {
  const id = String(raw?.group_id ?? raw?.id ?? '')
  const name = String(raw?.group_name || raw?.name || id)
  const memberCount = Number(raw?.member_count)
  return {
    id,
    name,
    ...(Number.isFinite(memberCount) && memberCount > 0 ? { memberCount } : {}),
  }
}

/** Normalize a OneBot get_friend_list entry. */
export function mapFriend(raw: any): { id: string; name: string } {
  const id = String(raw?.user_id ?? raw?.id ?? '')
  const name = String(raw?.remark || raw?.nickname || raw?.name || id)
  return { id, name }
}

async function loadGroups(bot: any): Promise<Array<{ id: string; name: string; memberCount?: number }>> {
  if (typeof bot.internal?.getGroupList === 'function') {
    const raw = await bot.internal.getGroupList()
    return (Array.isArray(raw) ? raw : []).map((item: any) => mapGroup(item)).filter((group: { id: string }) => group.id !== '')
  }
  if (typeof bot.getGuildList === 'function') {
    const result = await bot.getGuildList()
    return (Array.isArray(result?.data) ? result.data : []).map((item: any) => mapGroup(item)).filter((group: { id: string }) => group.id !== '')
  }
  return []
}

async function loadFriends(bot: any): Promise<Array<{ id: string; name: string }>> {
  if (typeof bot.internal?.getFriendList === 'function') {
    const raw = await bot.internal.getFriendList()
    return (Array.isArray(raw) ? raw : []).map((item: any) => mapFriend(item)).filter((friend: { id: string }) => friend.id !== '')
  }
  if (typeof bot.getFriendList === 'function') {
    const result = await bot.getFriendList()
    return (Array.isArray(result?.data) ? result.data : []).map((item: any) => mapFriend(item)).filter((friend: { id: string }) => friend.id !== '')
  }
  return []
}

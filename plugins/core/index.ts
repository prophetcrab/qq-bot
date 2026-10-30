import { Context, Schema, Service } from 'koishi'

declare module 'koishi' {
  interface Context {
    qqbot: QqBotCore
  }
}

export const name = 'qq-bot-core'
export const inject = []

export interface Config {
  /** 是否在日志中输出收到的消息，便于调试 */
  logMessages: boolean
  /** 消息日志级别 */
  logLevel: 'debug' | 'info'
  /** 是否注册 qqbot.status 指令 */
  statusCommand: boolean
  /** 允许执行管理指令的 QQ 号；留空表示不限制 */
  adminUsers: string[]
}

export const Config: Schema<Config> = Schema.object({
  logMessages: Schema.boolean().default(true).description('是否在日志中输出收到的消息（方便调试，生产环境可关闭）'),
  logLevel: Schema.union(['debug', 'info'] as const).default('debug').description('消息日志使用的级别'),
  statusCommand: Schema.boolean().default(true).description('是否注册 qqbot.status 指令'),
  adminUsers: Schema.array(Schema.string())
    .default([])
    .description('允许执行管理指令的 QQ 号；留空表示不限制（仅建议在开发环境留空）'),
})

export interface QqBotStats {
  /** 进程启动时间 */
  startedAt: Date
  /** 收到的消息数 */
  messagesReceived: number
  /** 发出的消息数 */
  messagesSent: number
  /** 收到的通知事件数（入群、退群、撤回等） */
  noticesReceived: number
  /** 入群欢迎次数 */
  welcomesSent: number
}

/**
 * 机器人核心服务。
 *
 * 其他插件通过 `inject = ['qqbot']` 声明依赖，然后访问 `ctx.qqbot`。
 * 这里把跨插件共享的状态与能力收敛到服务中，后续的群管、统计、AI 对话等插件
 * 只需要依赖这个服务，而不必彼此耦合。
 */
export class QqBotCore extends Service<Config> {
  static inject = []

  readonly botLogger: ReturnType<Context['logger']>
  readonly stats: QqBotStats = {
    startedAt: new Date(),
    messagesReceived: 0,
    messagesSent: 0,
    noticesReceived: 0,
    welcomesSent: 0,
  }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'qqbot', true)
    // 直接作为插件加载（不经过 loader / 控制台）时 config 可能缺省，这里兜底合并默认值
    this.config = Object.assign(
      { logMessages: true, logLevel: 'debug' as const, statusCommand: true, adminUsers: [] as string[] },
      config,
    )
    this.botLogger = ctx.logger('qqbot')

    if (this.config.logMessages) {
      ctx.on('message', (session) => {
        this.stats.messagesReceived++
        this.botLogger[this.config.logLevel](
          `[${session.platform}] ${session.userId ?? '?'} @ ${session.channelId ?? 'private'}: ${session.content ?? ''}`,
        )
      })
    } else {
      ctx.on('message', () => {
        this.stats.messagesReceived++
      })
    }

    ctx.on('send', () => {
      this.stats.messagesSent++
    })

    const noticeEvents = [
      'guild-added',
      'guild-removed',
      'guild-member-added',
      'guild-member-removed',
      'message-deleted',
      'friend-request',
      'guild-request',
      'guild-member-request',
      'reaction-added',
      'reaction-removed',
    ] as const
    for (const event of noticeEvents) {
      ctx.on(event, () => {
        this.stats.noticesReceived++
      })
    }

    if (this.config.statusCommand) {
      ctx
        .command('qqbot.status', '查看机器人运行状态')
        .usage('仅管理员可用；在 core 插件配置的 adminUsers 中填入 QQ 号')
        .action(() => this.statsSummary())
    }

    this.botLogger.info('QQ bot core service ready')
  }

  /** 其他插件在发送欢迎消息后调用，用于统一统计 */
  recordWelcome() {
    this.stats.welcomesSent++
  }

  /** 判断某个用户是否属于管理员 */
  isAdmin(userId: string | undefined): boolean {
    if (!userId) return false
    if (!this.config.adminUsers.length) return true
    return this.config.adminUsers.includes(userId)
  }

  /** 供指令与状态接口共用的运行状态摘要 */
  statsSummary(): string {
    const seconds = Math.floor((Date.now() - this.stats.startedAt.getTime()) / 1000)
    const uptime = [
      Math.floor(seconds / 3600),
      Math.floor((seconds % 3600) / 60),
      seconds % 60,
    ]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')

    return [
      'QQ Bot 运行状态',
      `运行时长：${uptime}`,
      `收到消息：${this.stats.messagesReceived}`,
      `发出消息：${this.stats.messagesSent}`,
      `通知事件：${this.stats.noticesReceived}`,
      `入群欢迎：${this.stats.welcomesSent}`,
      `已连接账号：${this.ctx.bots.map((bot) => `${bot.platform}:${bot.selfId}(${bot.status})`).join(', ') || '无'}`,
    ].join('\n')
  }
}

/** 插件入口：注册核心服务 */
export function apply(ctx: Context, config: Config) {
  ctx.plugin(QqBotCore, config)
}

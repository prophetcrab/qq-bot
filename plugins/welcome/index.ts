import { Context, Schema, h } from 'koishi'

export const name = 'welcome'
export const inject = ['qqbot']

export interface Config {
  /** 欢迎语，会拼在 @新成员 之后 */
  message: string
  /** 仅在群组中生效 */
  onlyGroup: boolean
}

export const Config: Schema<Config> = Schema.object({
  message: Schema.string().default('欢迎加入本群，发送 /help 查看机器人指令～').description('欢迎语正文'),
  onlyGroup: Schema.boolean().default(true).description('是否只在群组中发送欢迎消息'),
})

/**
 * 示例插件：监听「成员加入」事件。
 *
 * OneBot 11 的 `group_increase` 会被适配器归一化为 `guild-member-added` 事件，
 * QQ 官方机器人则对应 `guild-member-added` / 群成员变动事件。
 * 这里同时演示了如何依赖核心服务 `ctx.qqbot` 做统一计数。
 */
export function apply(ctx: Context, config: Config) {
  config = Object.assign(
    { message: '欢迎加入本群，发送 /help 查看机器人指令～', onlyGroup: true },
    config,
  )

  ctx.on('guild-member-added', async (session) => {
    if (config.onlyGroup && !session.guildId) return
    ctx.qqbot.recordWelcome()
    await session.send(h.at(session.userId) + ' ' + config.message)
  })
}

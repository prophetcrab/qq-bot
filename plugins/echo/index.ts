import { Context, Schema } from 'koishi'

export const name = 'echo'

export interface Config {
  /** 中间件示例：命中该关键词时直接回复，默认 ping */
  keyword: string
  /** 命中关键词时的回复内容 */
  reply: string
  /** 复读指令允许的最大长度 */
  maxLength: number
}

export const Config: Schema<Config> = Schema.object({
  keyword: Schema.string().default('ping').description('中间件示例：命中该关键词时直接回复'),
  reply: Schema.string().default('pong').description('命中关键词时的回复内容'),
  maxLength: Schema.natural().min(1).default(2000).description('复读指令允许的最大字符数'),
})

/**
 * 示例插件：同时演示「指令」与「中间件」两种扩展点。
 *
 * - 指令：`/echo <文字>`、`/复读 <文字>` 由 Koishi 指令系统解析；
 * - 中间件：收到 `keyword` 时直接回复，并用 `next()` 放行其他消息。
 */
export function apply(ctx: Context, config: Config) {
  config = Object.assign({ keyword: 'ping', reply: 'pong', maxLength: 2000 }, config)

  ctx
    .command('echo <text:text>', '让机器人复读一段文字')
    .alias('复读')
    .usage('例：/echo 你好，世界')
    .action(({ session }, text) => {
      if (!text) return '请输入要复读的内容'
      if (!session) return '该指令只能在消息会话中使用'
      return text.slice(0, config.maxLength)
    })

  ctx.middleware(async (session, next) => {
    if (session.content?.trim().toLowerCase() === config.keyword.toLowerCase()) {
      // 注意：中间件的返回值会被 Koishi 当作新消息自动发出（session.send 的返回值是消息 id 数组），
      // 因此这里先 await 再显式返回，避免把消息 id 也发出去。
      await session.send(config.reply)
      return
    }
    return next()
  })
}

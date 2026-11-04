/** Standalone fishing game gateway: commands, DSH forwarding and replies. */
import { Context } from 'koishi'
import { Config } from './config.ts'
import { DshTransport } from '../shared/dsh-transport.ts'
import { sendGameResult } from '../shared/game-result.ts'

export const name = 'game-fishing'
export const inject: string[] = []
export { Config } from './config.ts'

const COMMANDS = ['/兑换钓鱼币', '/钓鱼'] as const

export function fishingCommandOf(content: string): string | null {
  const line = String(content ?? '').trimStart().split(/\r?\n/u, 1)[0].trimEnd()
  for (const command of COMMANDS) {
    if (line === command || line.startsWith(`${command} `) || line.startsWith(`${command}\t`)) return line.trim()
  }
  return null
}

export function apply(ctx: Context, config: Config): void {
  const transport = new DshTransport({ endpoint: config.endpoint, discoveryFile: config.discoveryFile, timeoutMs: config.requestTimeoutMs })

  ctx.middleware(async (session, next) => {
    if (!config.enabled) return next()
    if (session.userId === session.selfId || session.author?.isBot === true) return next()
    if (config.groupOnly && session.isDirect === true) return next()
    const groupId = String(session.guildId ?? session.channelId ?? '')
    if (groupId === '') return next()
    const access = (ctx as any).access
    if (access !== null && access !== undefined) {
      if (typeof access.isInboundAllowed === 'function' && !access.isInboundAllowed(session)) return next()
      if (typeof access.isQuietBlocked === 'function' && access.isQuietBlocked(session)) return next()
    }
    const command = fishingCommandOf(String(session.content ?? ''))
    if (command === null) return next()
    const nickname = String((session as any).author?.name ?? (session as any).username ?? session.userId ?? '')
    const result = await transport.post('/qqbot/games/fishing/command', {
      groupId,
      userId: String(session.userId ?? ''),
      nickname,
      command,
    })
    if (result?.ok === true) await sendGameResult(session, result)
    else await session.send('钓鱼服务暂时不可用，请稍后再试。')
  }, true)
}

/** Slash commands are handled before the LLM loop and never enter chat material. */
export const GAME_COMMANDS = ['/注册', '/签到', '/账号背包', '/兑换钓鱼币', '/钓鱼', '/help', '/帮助'] as const

/** Commands whose arguments are part of the command and must be forwarded. */
const ARGUMENT_COMMANDS = new Set<string>(['/兑换钓鱼币', '/钓鱼'])

export function gameCommandOf(content: string): string | null {
  const line = String(content ?? '').trimStart().split(/\r?\n/u, 1)[0].trimEnd()
  for (const command of GAME_COMMANDS) {
    if (line === command || line.startsWith(`${command} `) || line.startsWith(`${command}\t`)) {
      return ARGUMENT_COMMANDS.has(command) ? line.trim() : command
    }
  }
  return null
}

export async function sendCommandReplies(session: any, replies: unknown): Promise<void> {
  const list = (Array.isArray(replies) ? replies : [])
    .filter((reply): reply is string => typeof reply === 'string' && reply.trim() !== '')
    .slice(0, 3)
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 250))
    await session.send(list[index])
  }
}

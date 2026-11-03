/** Slash commands are handled before the LLM loop and never enter chat material. */
export const GAME_COMMANDS = ['/注册', '/签到', '/账号背包', '/help', '/帮助'] as const

export function gameCommandOf(content: string): string | null {
  const value = String(content ?? '').trimStart()
  for (const command of GAME_COMMANDS) {
    if (value === command || value.startsWith(`${command} `) || value.startsWith(`${command}\n`) || value.startsWith(`${command}\t`)) {
      return command
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

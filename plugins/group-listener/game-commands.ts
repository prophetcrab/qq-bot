import { h } from 'koishi'

/** Slash commands are handled before the LLM loop and never enter chat material. */
export const GAME_COMMANDS = ['/注册', '/签到', '/账号背包', '/help', '/帮助'] as const

/** Commands whose arguments are part of the command and must be forwarded. */
const ARGUMENT_COMMANDS = new Set<string>()

export function gameCommandOf(content: string): string | null {
  const line = String(content ?? '').trimStart().split(/\r?\n/u, 1)[0].trimEnd()
  for (const command of GAME_COMMANDS) {
    if (line === command || line.startsWith(`${command} `) || line.startsWith(`${command}\t`)) {
      return ARGUMENT_COMMANDS.has(command) ? line.trim() : command
    }
  }
  return null
}

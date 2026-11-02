/** Tool registry with permissions, timeout and bounded observations. */

import type { ToolContext, ToolResult, ToolSpec } from './types.js'

const DEFAULT_MAX_RESULT_CHARS = 64 * 1024

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()
  private readonly maxResultChars: number

  constructor(options: { maxResultChars?: number } = {}) {
    this.maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  }

  register(spec: ToolSpec): void {
    if (spec.name.trim() === '') throw new Error('tool name is required')
    this.tools.set(spec.name, spec)
  }

  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  get(name: string): ToolSpec | null {
    return this.tools.get(name) ?? null
  }

  list(permissions: string[] = []): ToolSpec[] {
    return [...this.tools.values()].filter((tool) => hasPermissions(tool.permissions, permissions))
  }

  async invoke(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (tool === undefined) return { ok: false, error: `unknown-tool:${name}` }
    if (!hasPermissions(tool.permissions, context.permissions)) return { ok: false, error: `permission-denied:${name}` }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<ToolResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, error: `timeout:${name}` }), tool.timeoutMs)
        timer.unref?.()
      })
      const result = await Promise.race([
        Promise.resolve(tool.execute(args, context)).then<ToolResult>((value) => ({
          ok: true,
          result: bound(value, this.maxResultChars),
        })),
        timeout,
      ])
      return result
    } catch (error) {
      return { ok: false, error: `tool-failed:${String((error as Error)?.message ?? error)}` }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function hasPermissions(required: string[], granted: string[]): boolean {
  return required.every((permission) => granted.includes(permission))
}

function bound(value: unknown, maxChars: number): unknown {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    return String(value).slice(0, maxChars)
  }
  if (text.length <= maxChars) return value
  return { truncated: true, text: text.slice(0, maxChars) }
}

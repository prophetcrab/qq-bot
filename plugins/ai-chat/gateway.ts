/** HTTP gateway to the DSH AI bridge (`POST /qqbot/ai/chat`). */
import type { Config } from './config.js'
import type { HistoryMessage } from './types.js'

export interface AiPayload {
  apiVersion: number
  messages: HistoryMessage[]
  background: string
  images: unknown[]
  backgroundImages: unknown[]
  quotedImages: unknown[]
  quote: unknown
  groupId: string
  userId: string
  userName: string
  mentionSelf: boolean
  mentionOthers: string[]
  mentionAll: boolean
  replyToBot: boolean
  system?: string
}

export interface AiBridgeResult {
  ok: boolean
  status: number
  data: any
  error?: string
}

export async function postAi(
  endpoint: string,
  payload: AiPayload,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<AiBridgeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(5000, config.timeoutMs))
  timer.unref?.()
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    return { ok: true, status: response.status, data }
  } catch (error: any) {
    return { ok: false, status: 0, data: null, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

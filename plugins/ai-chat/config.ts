/** AI chat configuration, runtime overrides and DSH bridge discovery. */
import { readFileSync } from 'node:fs'
import { Schema } from 'koishi'
import type { Discovery, RuntimeSettings } from './types.js'

export interface Config {
  enabled: boolean
  replyProbability: number
  followUpMinutes: number
  batchWindowMs: number
  batchMaxWaitMs: number
  groupOnly: boolean
  historyLimit: number
  maxReplyChars: number
  timeoutMs: number
  endpoint: string
  discoveryFile: string
  stateFile: string
  settingsFile: string
  systemPrompt: string
  imageLimit: number
  imageMaxBytes: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用 AI 聊天'),
  replyProbability: Schema.number().default(0.15).min(0).max(1)
    .description('未被 @ / 回复 时的随机回复概率（0~1）'),
  followUpMinutes: Schema.number().default(3).min(0).max(60)
    .description('回复某人后，多少分钟内继续回复此人的消息'),
  batchWindowMs: Schema.number().default(2500).min(0).max(10000)
    .description('同一个人连续消息的合并等待时间（毫秒），0 表示不合并'),
  batchMaxWaitMs: Schema.number().default(10000).min(0).max(30000)
    .description('连续消息最多等待多久就必须回复一次（毫秒）'),
  groupOnly: Schema.boolean().default(true).description('是否只处理群聊'),
  historyLimit: Schema.number().default(100).min(0).max(200)
    .description('向上保留并发送的群聊背景消息条数（最多 100 条）'),
  maxReplyChars: Schema.number().default(1200).min(100).max(4000)
    .description('单条回复最大字符数（超长自动分条）'),
  timeoutMs: Schema.number().default(120000).min(5000).max(600000)
    .description('调用 DSH AI 桥的超时时间'),
  endpoint: Schema.string().default('').description('DSH AI 桥地址；留空则读取 discoveryFile'),
  discoveryFile: Schema.string().default('data/ai.json').description('DSH 写入的 AI 桥发现文件（相对项目根目录）'),
  stateFile: Schema.string().default('data/ai-chat-state.json').description('AI 监听/回复诊断状态文件（相对项目根目录）'),
  settingsFile: Schema.string().default('data/ai-settings.json').description('DSH 面板写入的运行时回复设置（概率/跟进/上下文）'),
  systemPrompt: Schema.string().default('').description('额外系统提示词；留空使用 DSH 侧默认'),
  imageLimit: Schema.number().default(4).min(0).max(6).description('每条消息最多读取的图片数'),
  imageMaxBytes: Schema.number().default(6 * 1024 * 1024).min(1024 * 1024).max(10 * 1024 * 1024)
    .description('单张图片最大字节数'),
})

export function clampNumber(value: any, fallback: number, min: number, max: number, truncate = false): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const bounded = Math.min(max, Math.max(min, number))
  return truncate ? Math.trunc(bounded) : Math.round(bounded * 1000) / 1000
}

export function loadRuntimeSettings(file: string, config: Config): RuntimeSettings {
  const fallback: RuntimeSettings = {
    enabled: config.enabled,
    replyProbability: clampNumber(config.replyProbability, 0.15, 0, 1),
    followUpMinutes: clampNumber(config.followUpMinutes, 3, 0, 60, true),
    historyLimit: clampNumber(config.historyLimit, 100, 0, 200, true),
    batchWindowMs: clampNumber(config.batchWindowMs, 2500, 0, 10000, true),
    batchMaxWaitMs: clampNumber(config.batchMaxWaitMs, 10000, 0, 30000, true),
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return fallback
    return {
      enabled: parsed.enabled === undefined ? fallback.enabled : parsed.enabled === true,
      replyProbability: clampNumber(parsed.replyProbability, fallback.replyProbability, 0, 1),
      followUpMinutes: clampNumber(parsed.followUpMinutes, fallback.followUpMinutes, 0, 60, true),
      historyLimit: clampNumber(parsed.historyLimit, fallback.historyLimit, 0, 200, true),
      batchWindowMs: clampNumber(parsed.batchWindowMs, fallback.batchWindowMs, 0, 10000, true),
      batchMaxWaitMs: Math.max(
        clampNumber(parsed.batchWindowMs, fallback.batchWindowMs, 0, 10000, true),
        clampNumber(parsed.batchMaxWaitMs, fallback.batchMaxWaitMs, 0, 30000, true),
      ),
    }
  } catch {
    return fallback
  }
}

export function readDiscovery(file: string): Discovery | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.endpoint === 'string' && parsed.endpoint !== '') {
      return {
        endpoint: parsed.endpoint,
        provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
        model: typeof parsed.model === 'string' ? parsed.model : undefined,
      }
    }
  } catch {
    // file missing / not yet written
  }
  return null
}

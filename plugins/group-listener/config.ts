import { Schema } from 'koishi'

export interface Config {
  enabled: boolean
  groupOnly: boolean
  bufferSize: number
  analysisWindow: number
  minCountTrigger: number
  maxCountTrigger: number
  timeTriggerMinutes: number
  cooldownReplyMs: number
  cooldownNoReplyMs: number
  firstBubbleDelayMinMs: number
  firstBubbleDelayMaxMs: number
  bubbleDelayMinMs: number
  bubbleDelayMaxMs: number
  imageLimit: number
  imageMaxBytes: number
  maxConcurrentGroups: number
  discoveryFile: string
  stateFile: string
  personaFile: string
  endpoint: string
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用群聊监听'),
  groupOnly: Schema.boolean().default(true).description('只监听群聊'),
  bufferSize: Schema.number().default(100).min(20).max(200).description('每群素材缓冲上限'),
  analysisWindow: Schema.number().default(30).min(10).max(80).description('分析阶段最近消息窗口'),
  minCountTrigger: Schema.number().default(3).min(1).max(100).description('随机消息数触发下限'),
  maxCountTrigger: Schema.number().default(10).min(1).max(100).description('随机消息数触发上限'),
  timeTriggerMinutes: Schema.number().default(30).min(1).max(240).description('时间触发窗口（分钟）'),
  cooldownReplyMs: Schema.number().default(25000).min(0).max(300000).description('发言后的群冷却'),
  cooldownNoReplyMs: Schema.number().default(7000).min(0).max(300000).description('不发言后的群冷却'),
  firstBubbleDelayMinMs: Schema.number().default(1200).min(0).max(10000).description('首条气泡最短延迟'),
  firstBubbleDelayMaxMs: Schema.number().default(3000).min(0).max(15000).description('首条气泡最长延迟'),
  bubbleDelayMinMs: Schema.number().default(800).min(0).max(10000).description('后续气泡最短间隔'),
  bubbleDelayMaxMs: Schema.number().default(2200).min(0).max(15000).description('后续气泡最长间隔'),
  imageLimit: Schema.number().default(4).min(0).max(4).description('每轮最多附带图片数'),
  imageMaxBytes: Schema.number().default(4 * 1024 * 1024).min(1024 * 1024).max(10 * 1024 * 1024).description('单张图片最大字节数'),
  maxConcurrentGroups: Schema.number().default(3).min(1).max(20).description('群间并发的最大群数'),
  discoveryFile: Schema.string().default('data/state/ai.json').description('DSH AI 发现文件'),
  stateFile: Schema.string().default('data/state/group-listener-status.json').description('监听诊断状态文件'),
  personaFile: Schema.string().default('data/config/persona.json').description('人设文件，读取兴趣关键词'),
  endpoint: Schema.string().default('').description('DSH 地址；留空读取 discoveryFile'),
  requestTimeoutMs: Schema.number().default(45000).min(5000).max(120000).description('单次 DSH 请求超时'),
})

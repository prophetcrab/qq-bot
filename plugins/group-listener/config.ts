import { Schema } from 'koishi'

export interface Config {
  enabled: boolean
  groupOnly: boolean
  bufferSize: number
  countTrigger: number
  timeTriggerMinutes: number
  cooldownReplyMs: number
  cooldownNoReplyMs: number
  maxConcurrentGroups: number
  discoveryFile: string
  stateFile: string
  endpoint: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用群聊监听'),
  groupOnly: Schema.boolean().default(true).description('只监听群聊'),
  bufferSize: Schema.number().default(100).min(20).max(200).description('每群素材缓冲上限'),
  countTrigger: Schema.number().default(5).min(1).max(100).description('新增消息数触发阈值'),
  timeTriggerMinutes: Schema.number().default(30).min(1).max(240).description('时间触发窗口（分钟）'),
  cooldownReplyMs: Schema.number().default(25000).min(0).max(300000).description('发言后的群冷却'),
  cooldownNoReplyMs: Schema.number().default(7000).min(0).max(300000).description('不发言后的群冷却'),
  maxConcurrentGroups: Schema.number().default(3).min(1).max(20).description('群间并发的最大群数'),
  discoveryFile: Schema.string().default('data/state/ai.json').description('DSH AI 发现文件'),
  stateFile: Schema.string().default('data/state/group-listener-status.json').description('监听诊断状态文件'),
  endpoint: Schema.string().default('').description('DSH 地址；留空读取 discoveryFile'),
})

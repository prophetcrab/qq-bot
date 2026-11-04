import { Schema } from 'koishi'

export interface Config {
  enabled: boolean
  groupOnly: boolean
  endpoint: string
  discoveryFile: string
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用钓鱼命令入口'),
  groupOnly: Schema.boolean().default(true).description('是否只处理群聊'),
  endpoint: Schema.string().default('').description('DSH 地址；留空读取 discoveryFile'),
  discoveryFile: Schema.string().default('data/state/ai.json').description('DSH 发现文件'),
  requestTimeoutMs: Schema.number().default(120000).min(5000).max(600000).description('DSH 请求超时'),
})

#!/usr/bin/env node
/**
 * 把 koishi.yml 中 OneBot 适配器的 selfId 改成你的机器人 QQ 号。
 *
 *   npm run set:self-id 123456789
 *
 * 只修改 adapter-onebot 配置块里的 selfId，其余配置保持不变。
 * 修改后重启 `npm start` 生效。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const qq = process.argv[2]?.trim()

if (!qq) {
  console.error('用法：npm run set:self-id <你的QQ号>')
  process.exit(1)
}
if (!/^[1-9]\d{4,11}$/.test(qq)) {
  console.error(`QQ 号格式看起来不对：${qq}（应为 5-12 位数字）`)
  process.exit(1)
}

const file = resolve(process.cwd(), 'koishi.yml')
const lines = readFileSync(file, 'utf8').split('\n')

const adapterIndex = lines.findIndex((line) => /^\s+adapter-onebot:[^\s]*:/.test(line))
if (adapterIndex < 0) {
  console.error('koishi.yml 中找不到 adapter-onebot 配置块，请确认文件是否完整。')
  process.exit(1)
}
const adapterIndent = lines[adapterIndex].match(/^\s*/)[0].length

let selfIdIndex = -1
for (let i = adapterIndex + 1; i < lines.length; i++) {
  const line = lines[i]
  const indent = line.match(/^\s*/)[0].length
  // 离开 adapter-onebot 配置块
  if (line.trim() && indent <= adapterIndent) break
  if (/^\s+selfId:/.test(line)) {
    selfIdIndex = i
    break
  }
}
if (selfIdIndex < 0) {
  console.error('adapter-onebot 配置块中找不到 selfId 字段。')
  process.exit(1)
}

const old = lines[selfIdIndex].trim()
lines[selfIdIndex] = lines[selfIdIndex].replace(/selfId:.*$/, `selfId: '${qq}'`)
writeFileSync(file, lines.join('\n'))

console.log(`已更新 selfId：${old} → selfId: '${qq}'`)
console.log('')
console.log('接下来：')
console.log('  1. 启动机器人：npm start')
console.log('  2. NapCat WebUI → 网络配置 → 新建 → WebSocket 客户端')
console.log('     URL：ws://127.0.0.1:5140/onebot')
console.log('     消息格式：array；Token 留空（或与 koishi.yml 中 token 保持一致）')
console.log('  3. 保存后 NapCat 会自动连接，Koishi 日志出现 bot online 即成功')

# qq-bot

基于 [Koishi 4](https://koishi.chat/) 的高扩展性 QQ 机器人项目。第一阶段完成的是**整体框架 + QQ 连接 + 消息读取/发送能力**：多协议适配器、插件系统、统一消息管道、Web 控制台，以及一套不依赖真实 QQ 就能跑通的本地调试与自动化测试。

## 特性

- **QQ 接入**
  - OneBot 11：对接 NapCat / Lagrange / LLOneBot，支持正向 WS、反向 WS（默认）、HTTP
  - QQ 官方机器人：`@koishijs/plugin-adapter-qq`，支持 WebSocket / Webhook、沙箱环境、事件 Intents
- **统一消息模型**：插件只面向 Koishi 的 `Session` / `Bot` / 事件编程，切换 QQ 接入方式（OneBot ↔ 官方）不需要改业务代码
- **插件化框架**：`koishi.yml` 配置驱动；本地 TypeScript 插件按相对路径直接加载，无需构建；支持热插拔、服务依赖注入
- **核心服务 `ctx.qqbot`**：消息/事件统计、管理员判断、欢迎计数，供后续插件复用
- **完整扩展点**：指令、中间件、事件、服务、定时器、数据库、控制台扩展
- **权限管理**：自动读取群/好友列表（群名/群号/人数），点击勾选即可配置接收与发送白名单/黑名单；安静模式只处理指令或 @机器人 的消息，避免刷屏
- **健康检查**：`GET /api/qqbot/health` 返回适配器在线状态与运行统计，便于监控/守护
- **开箱即用的调试链路**
  - Web 控制台 + 沙盒（http://localhost:5140）
  - `npm run mock:qq`：假 QQ 客户端，模拟 NapCat 反向 WS，可在终端直接聊天
  - `npm test`：mock 适配器测试 + 真实 OneBot WS 协议端到端测试
  - 监控消息流：只记录权限白名单目标群的入站消息，同时记录机器人发送的消息（direction=in/out）
- **TypeScript**：严格模式类型检查，`npm run typecheck`

## 目录结构

```text
qq-bot/
├── koishi.yml                     # 应用配置：插件、适配器、本地插件（由 Koishi Loader 自动维护）
├── koishi.example.yml             # 带注释的配置参考
├── plugins/                       # 本地 Koishi 插件（TS 源码，直接加载）
│   ├── core/                      # 核心服务：ctx.qqbot + 统计 + qqbot.status
│   ├── health/                    # 健康检查接口 /api/qqbot/health
│   ├── access-control/            # 群/私聊收发权限过滤（data/access.json）
│   ├── echo/                      # 示例：指令 /echo、复读别名、关键词中间件
│   └── welcome/                   # 示例：入群事件监听 + @ 新成员欢迎
├── scripts/
│   └── fake-onebot-client.mjs     # 假 QQ：模拟 NapCat 反向 WS 客户端
├── test/
│   ├── mock.test.ts               # 指令 / 中间件 / 服务测试（mock 适配器）
│   └── onebot.test.ts             # OneBot 11 WebSocket 端到端测试（连接-收-发）
├── docs/
│   ├── architecture.md            # 架构、消息流转与扩展点
│   ├── connect-qq.md              # OneBot / QQ 官方接入指南
│   └── write-plugin.md            # 插件开发指南
├── data/                          # 运行时数据（SQLite，已 gitignore）
└── package.json
```

## AI 聊天

`plugins/ai-chat`：群聊最多 100 条背景上下文，触发后调用 DSH 的 `/qqbot/ai/chat` 桥（复用 DSH 模型和凭据，不保存 API Key）。

- **@机器人** 或 **回复机器人**：必定回复
- 其他消息：按 `replyProbability` 概率回复
- 对某人回复后 3 分钟内继续回复此人（`followUpMinutes`）
- 当前消息图片会送多模态模型
- 不同人的消息并发处理；同一个人的连续消息静默排队，不发送「上一条还在处理」提示
- 每个人按 QQ 号维护长期画像，由 DSH 作为系统提示词第二段注入

```yaml
./plugins/ai-chat:ai7k2m:
  replyProbability: 0.15
  followUpMinutes: 3
  historyLimit: 100
```

DSH 端会把 `data/ai.json`（端点、provider、model）写好，插件自动读取；DSH 端口变化后自动更新。人设卡在 DSH 面板编辑，保存为 `data/persona.json`；人物画像保存在 `data/profiles.json`。面板「AI」页的回复设置写入 `data/ai-settings.json`，插件热加载，无需重启。

## 运行时目录

本项目就是机器人运行时的唯一目录：Koishi 源码、`node_modules`、`data`、`logs`、`runtime/napcat-installer`（NapCat 安装器缓存）都在这里。DSH 插件「QQ 机器人」会负责创建/安装依赖/启动，无需手动搭环境。

## 快速开始

环境要求：Node.js >= 20（推荐 22 LTS 及以上），npm。

> 本地插件以 TypeScript 源码直接运行（通过 `tsx` 的 require hook），因此 `tsx` 已放入 `dependencies`。生产部署时保留该依赖，或先构建插件为 JS 后再去掉。

```bash
cd ~/project/qq-bot
npm install
npm start
```

启动后：

- Web 控制台：<http://localhost:5140>
- 默认以 OneBot 11 **反向 WebSocket** 模式监听 `ws://127.0.0.1:5140/onebot`，等待 NapCat / Lagrange 连接
- 本地业务插件 `core` / `echo` / `welcome` 自动加载

### 方式一：接入真实 QQ（NapCat，推荐）

1. 安装并登录 [NapCat](https://napneko.github.io/)（或 Lagrange / LLOneBot）
2. 在 NapCat 的「网络配置」中新建 **WebSocket 客户端**（即反向 WS）：
   - URL：`ws://127.0.0.1:5140/onebot`
   - 消息格式：`array`
   - Token：留空（若填写，需与 `koishi.yml` 中 `adapter-onebot.token` 一致）
3. 写入机器人 QQ 号（必须与 NapCat 登录的账号一致，否则连接会被拒绝）：
   ```bash
   npm run set:self-id 你的QQ号
   ```
   也可以手动编辑 `koishi.yml` 中 `adapter-onebot` 的 `selfId`。
4. 先启动 `npm start`，再回到 NapCat 保存连接配置；看到 Koishi 日志出现 `bot online` 后，在群里发送 `/echo 你好` 验证
5. 更详细的接入方式（正向 WS、HTTP、QQ 官方机器人）见 [docs/connect-qq.md](docs/connect-qq.md)

### 方式二：不接 QQ，本地假 QQ 联调

保持 `npm start` 运行，另开一个终端：

```bash
npm run mock:qq
```

它会模拟 NapCat 连接机器人，自动发送一条 `/echo` 群消息和一条入群通知，打印机器人的回复；之后可以直接在终端输入文字继续对话，输入 `/quit` 退出。

也可以在控制台 →「沙盒」里直接与机器人对话（无需任何真实平台账号）。

## 权限管理（接收 / 发送）

`plugins/access-control` 会读取 `data/access.json`，对**接收消息**和**发送消息**分别做群聊/私聊级过滤；文件变更约 1 秒内自动热加载，无需重启 Koishi。

```json
{
  "version": 1,
  "inbound": {
    "groups": { "mode": "whitelist", "ids": ["123456789"] },
    "private": { "mode": "blacklist", "ids": [] },
    "quiet": { "enabled": true, "prefixes": ["/"] }
  },
  "outbound": {
    "groups": { "mode": "whitelist", "ids": ["123456789"] },
    "private": { "mode": "all", "ids": [] }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `inbound.groups.mode` | 接收群消息：`all` / `whitelist` / `blacklist`，配合 `ids` |
| `inbound.private` | 私聊接收策略（同样支持三种 mode） |
| `inbound.quiet` | 开启后群里只处理 `/` 前缀指令或 @机器人 的消息 |
| `outbound.groups` | 允许机器人向哪些群发消息；可阻止误发/刷屏 |
| `outbound.private` | 私聊发送策略 |

- DSH 的「QQ 机器人 → 权限」页会自动读取群/好友列表，点击勾选管理；也可以直接编辑本文件（约 1 秒热加载）
- 群/好友列表接口：`GET /api/qqbot/contacts`（由 `plugins/health` 提供，转发 OneBot `get_group_list` / `get_friend_list`）
- 消息流接口：`GET /api/qqbot/messages?limit=50`（最近收到的群/私聊消息，内存环形缓冲，重启清空）
- 策略文件缺失时会自动创建默认全放行；损坏时回退默认且不覆盖原文件
- 通过 `ctx.access` 服务，其他插件也可查询/复用策略

## 消息读取与发送

### 读取

插件中通过 `session` 获取消息与环境信息：

```ts
ctx.on('message', (session) => {
  session.content        // 纯文本内容（自动去掉 @机器人）
  session.elements       // 消息元素（文本、图片、@ 等）
  session.userId         // 发送者
  session.channelId      // 群号 / 私聊频道
  session.guildId        // 群号（群聊时）
  session.platform       // 'onebot' / 'qq' 等
})
```

### 发送

回复当前会话（最常用）：

```ts
await session.send('纯文本回复')
await session.send(h.at(session.userId) + ' 欢迎加入本群！')   // 组合 @ 与文本
await session.send(h.image('https://example.com/a.png'))      // 图片
```

主动向指定会话发送：

```ts
// 群聊：channelId 直接填群号
await ctx.bots[0].sendMessage('123456', '大家好')

// 私聊：channelId 使用 private: 前缀
await ctx.bots[0].sendMessage('private:20000', '你好')

// 底层 OneBot API（需要平台特有能力时）
await ctx.bots[0].internal.sendGroupMsg(123456, '通过 OneBot API 发送')
```

跨适配器/多账号时，先按平台筛选：

```ts
const bot = ctx.bots.find((bot) => bot.platform === 'onebot')
await bot.sendMessage('123456', 'hello')
```

事件类型（OneBot 与 QQ 官方会被统一归一化）：

| 事件 | 说明 |
| --- | --- |
| `message` | 收到消息 |
| `message-deleted` | 消息撤回 |
| `guild-member-added` / `guild-member-removed` | 群成员加入/退出 |
| `friend-request` / `guild-request` | 好友申请 / 加群申请 |
| `send` | 任意消息发出后 |
| `bot-status-updated` | 机器人上下线 |

## 插件开发

`plugins/` 下的每个子目录就是一个 Koishi 插件，入口为 `index.ts`，通过 `koishi.yml` 的相对路径加载：

```yaml
group:local:
  ./plugins/my-plugin:<自动生成的 id>: {}
```

最小插件：

```ts
import { Context, Schema } from 'koishi'

export const name = 'my-plugin'
export const inject = ['qqbot']

export interface Config {
  greeting: string
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('你好'),
})

export function apply(ctx: Context, config: Config) {
  ctx.command('hi', '打个招呼').action(({ session }) => session?.send(config.greeting))
}
```

更多内容（配置构型、指令参数、中间件、事件、服务依赖、定时任务、测试）见 [docs/write-plugin.md](docs/write-plugin.md)，架构与扩展点见 [docs/architecture.md](docs/architecture.md)。

## 测试与校验

```bash
npm test          # mock 适配器测试 + OneBot WS 端到端测试
npm run typecheck # TypeScript 严格类型检查
```

端到端测试会启动一个假的 OneBot 11 WebSocket 服务端，验证：

1. 适配器成功连接并上线（`get_login_info`）
2. 服务端推送群消息 `/echo hello`
3. 机器人通过 OneBot API 发出 `send_group_msg`，内容正确
4. 推送 `group_increase` 通知，`welcome` 插件发送 @新成员 的欢迎消息

## 配置说明

`koishi.yml` 由 Koishi Loader 自动维护（会补全插件实例 id、规范化 YAML 格式，并**不保留注释**）。带注释的完整参考见 [koishi.example.yml](koishi.example.yml)。常见可调项：

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| `prefix` | 顶层 | 指令前缀，默认 `['/']` |
| `server.port` | `group:server` | 控制台/HTTP/反向 WS 端口，默认 5140 |
| `adapter-onebot.selfId` | `group:adapter` | 机器人 QQ 号 |
| `adapter-onebot.protocol` | `group:adapter` | `ws-reverse`（默认）/ `ws` / `http` |
| `./plugins/core` | `group:local` | 核心服务配置：`logMessages`、`adminUsers`、`statusCommand` |

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| NapCat 连接后机器人仍离线 | `selfId` 与登录 QQ 不一致；反向 WS 需要 `X-Client-Role: Universal`（NapCat 默认满足） |
| 指令无响应 | 检查 `prefix` 是否为 `['/']`，或消息是否被其他中间件拦截 |
| 控制台打不开 | 端口被占用时 Koishi 会自动顺延到 5141…，查看启动日志中的实际地址 |
| 连接被拒绝 `token` | NapCat 配了 token 时，`adapter-onebot.token` 需一致 |
| 改完插件不生效 | 本地插件为源码热加载之外的普通加载，重启 `npm start` 即可（HMR 在路线图中） |

## 下一步（Step 2 路线图）

- [ ] 群管理插件：禁言、踢人、撤回、入群审批、黑名单
- [ ] 持久化权限/配置：基于 `database-sqlite` 的管理员与分群配置
- [ ] 定时任务与主动推送（公告、定时提醒）
- [ ] HMR 热重载与插件脚手架命令
- [ ] AI 对话接入（适配器无关，直接复用 `ctx.qqbot` 与消息管道）
- [ ] 生产部署：Docker、日志落盘、进程守护

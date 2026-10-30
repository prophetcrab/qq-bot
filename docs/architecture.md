# 架构与扩展点

本项目没有另造一套机器人框架，而是以 **Koishi 4** 为内核，把「协议接入」和「业务插件」彻底解耦。你只需要写一次业务插件，就能同时跑在 OneBot（个人 QQ）与 QQ 官方机器人上。

## 分层

```text
        QQ 账号 / QQ 开放平台
   ┌────────────┴────────────┐
   │ NapCat / Lagrange / 官方 │
   └────────────┬────────────┘
                │ OneBot 11（WS/HTTP）  或  QQ 开放平台（WebSocket/Webhook）
┌───────────────▼───────────────────────────────┐
│ 适配器层 Adapter                                │
│  koishi-plugin-adapter-onebot                  │
│  @koishijs/plugin-adapter-qq                   │
│  职责：协议握手、鉴权、事件解析、API 调用          │
└───────────────┬───────────────────────────────┘
                │ 统一 Bot / Session / 事件（与平台无关）
┌───────────────▼───────────────────────────────┐
│ Koishi 内核 Core                                │
│  指令系统 Command · 中间件 Middleware · 事件 Events │
│  服务 Service · 数据库 Database · 定时器 Timer     │
└───────────────┬───────────────────────────────┘
                │ ctx.qqbot 服务 / 事件 / 指令注册
┌───────────────▼───────────────────────────────┐
│ 业务插件层 plugins/                              │
│  core（服务）· echo（指令/中间件）· welcome（事件） │
└───────────────────────────────────────────────┘
```

## 一条消息的完整流转

```text
QQ 群消息
  │
  ▼
NapCat  ──OneBot 事件 JSON──▶  adapter-onebot
                                   │ 归一化为 Session + MessageEvent
                                   ▼
                             Koishi 内核
                 ┌─────────────────┼──────────────────┐
                 ▼                 ▼                  ▼
             中间件链          指令解析           事件监听
          (echo 的关键词)    (/echo hello)     (ctx.on('message'))
                 │                 │                  │
                 └─────────────────┴──────────────────┘
                                   ▼
                          session.send(...)
                                   │
                                   ▼
                         adapter-onebot 调用 OneBot API
                                   │
                                   ▼
                          NapCat ──▶ QQ 群消息
```

对应的自动化测试见 `test/onebot.test.ts`：用假 WS 服务端完整复现了这条链路。

## 插件如何被加载

- `koishi.yml` 中 `group:local` 使用相对路径（如 `./plugins/core`）声明本地插件；
- Koishi Loader 通过 `require` 解析该路径，`npm start` 时用 `tsx/cjs` require hook 直接执行 TypeScript 源码，**不需要预编译**；
- 每个插件入口导出 `name`、可选 `Config`（Schema 配置构型）与 `apply(ctx, config)`；
- 插件实例 id 由 Loader 自动补全（如 `./plugins/core:orq22s`），这是 Koishi 管理多实例的方式。

## 扩展点一览

| 想做什么 | 用什么 | 示例位置 |
| --- | --- | --- |
| 新增一个 QQ 平台/协议 | 新增适配器插件，或安装社区适配器 | `group:adapter` |
| 新增一组业务功能 | 在 `plugins/` 下新建插件目录 | `plugins/echo` |
| 新增指令 | `ctx.command()` | `plugins/echo` |
| 拦截/改写消息 | `ctx.middleware()` + `next()` | `plugins/echo` |
| 监听平台事件 | `ctx.on('message' / 'guild-member-added' / ...)` | `plugins/welcome` |
| 提供跨插件能力/共享状态 | `Service` + `ctx.qqbot` | `plugins/core` |
| 持久化数据 | `database-sqlite` 提供的 `ctx.database` / `ctx.model` | 预留 |
| 定时任务 | `ctx.setInterval()` / `ctx.setTimeout()` | 预留 |
| 管理界面 | 控制台 + 插件 Config Schema | `console` / `config` |
| 运行状态监控 | 健康检查接口 `GET /api/qqbot/health` | `plugins/health` |
| 自定义 Web 页面/API | `ctx.server` / `ctx.console` | 预留 |

## 核心服务 `ctx.qqbot`

`plugins/core` 注册了服务 `qqbot`，其他插件通过依赖注入使用：

```ts
export const inject = ['qqbot']

export function apply(ctx: Context) {
  ctx.qqbot.stats.messagesReceived      // 消息统计
  ctx.qqbot.isAdmin(session.userId)     // 管理员判断
  ctx.qqbot.recordWelcome()             // 欢迎计数
  ctx.qqbot.statsSummary()              // 运行状态文本
}
```

这样，后续的群管、统计、AI 对话等插件都依赖这一个服务，而不是彼此直接引用。

## 多适配器 / 多账号

`group:adapter` 下可以同时配置多个适配器实例（每项会自动获得独立 id）：

```yaml
group:adapter:
  adapter-onebot:rwzua8:
    selfId: '111111'
    protocol: ws-reverse
    path: /onebot
  adapter-onebot:x8k2ab:      # 第二个 QQ 账号
    selfId: '222222'
    protocol: ws-reverse
    path: /onebot2
  adapter-qq:opsrjg:
    id: ...
    secret: ...
    type: private
```

业务插件通过 `ctx.bots` 选择平台/账号：

```ts
const bots = ctx.bots.filter((bot) => bot.platform === 'onebot')
```

## 配置文件的特殊说明

`koishi.yml` 是 Koishi Loader 的**运行时配置文件**，启动时会被自动规范化（补全插件实例 id、数组格式），因此**注释不会保留**。带注释的参考配置放在 `koishi.example.yml`，修改时请以它为准编辑 `koishi.yml`。

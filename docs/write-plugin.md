# 插件开发指南

本项目使用 Koishi 的插件体系。一个插件就是一个导出 `apply` 函数的 TypeScript 模块；`koishi.yml` 负责加载与传参。

## 1. 新建插件目录

在 `plugins/` 下新建目录，例如 `plugins/weather/index.ts`：

```ts
import { Context, Schema } from 'koishi'

export const name = 'weather'

export interface Config {
  apiKey: string
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().description('天气服务 API Key').required(),
})

export function apply(ctx: Context, config: Config) {
  ctx.command('weather <city:string>', '查询天气').action(async ({ session }, city) => {
    if (!city) return '请输入城市名，例如：/weather 北京'
    // ... 调用天气服务
    return `${city}：晴，25°C`
  })
}
```

## 2. 在 koishi.yml 中加载

在 `group:local` 下追加一项（**key 为相对路径**）：

```yaml
group:local:
  ./plugins/weather:
    apiKey: your-api-key
```

重启 `npm start` 即生效。Koishi Loader 会自动补全实例 id（如 `./plugins/weather:ab12cd`），这是正常现象。

也可以在控制台 →「插件配置」中看到该插件并按 Schema 编辑配置。

## 3. 指令

```ts
ctx.command('echo <text:text>', '复读一段文字')
  .alias('复读')                 // 别名 /复读
  .usage('例：/echo 你好')
  .option('count', '-c <n:number>', '重复次数', { fallback: 1 })
  .action(({ session, options }, text) => {
    if (!text) return '请输入内容'
    return (text + '\n').repeat(options.count).trim()
  })
```

- `<arg>` 必选参数，`[arg]` 可选参数；类型支持 `string` / `text` / `number` / `user` / `channel`
- 嵌套指令：`ctx.command('admin.ban <user:user>')` → `/admin.ban @某人`
- 指令权限可结合核心服务判断：

```ts
ctx.command('admin.broadcast <text:text>').action(({ session }, text) => {
  if (!session || !ctx.qqbot.isAdmin(session.userId)) return '权限不足'
  // ...
})
```

## 4. 中间件

中间件可以拦截消息、改写处理结果，或调用 `next()` 放行：

```ts
ctx.middleware(async (session, next) => {
  if (session.content === 'ping') {
    // 注意：中间件的返回值会被 Koishi 当作新消息发送，
    // 而 session.send() 返回的是消息 id 数组，所以要先 await 再 return。
    await session.send('pong')
    return
  }
  // 放行给后续中间件（包括指令解析）
  return next()
})
```

建议只处理明确匹配的内容，避免吞掉指令。

## 5. 事件

```ts
// 消息
ctx.on('message', (session) => { /* ... */ })

// 入群 / 退群
ctx.on('guild-member-added', async (session) => {
  await session.send(h.at(session.userId) + ' 欢迎！')
})

// 好友申请 / 加群申请
ctx.on('friend-request', (session) => { /* ... */ })
ctx.on('guild-request', (session) => { /* ... */ })
```

事件与平台无关：OneBot 的 `group_increase`、QQ 官方的群成员事件都会被归一化成 `guild-member-added`，因此插件在两种接入方式下都能工作。

常用 `session` 字段：`content`、`elements`、`userId`、`channelId`、`guildId`、`platform`、`messageId`、`quote`、`event`。

## 6. 发送消息

```ts
await session.send('文本')
await session.send(h.at(userId) + ' 文本')
await session.send(h.image('https://example.com/a.png'))
await session.send(h.image('file:///path/to/local.png'))   // 本地图片（OneBot）

// 引用回复（h.quote 需要消息 id）
await session.send(h.quote(session.messageId) + '引用回复的内容')
```

主动发送（不在事件回调里）：

```ts
const bot = ctx.bots[0]
await bot.sendMessage('群号', '大家好')                    // 群聊
await bot.sendMessage('private:QQ号', '你好')             // 私聊

// 平台原生 API（OneBot）
await bot.internal.sendGroupMsg(123456, '消息')
```

## 7. 服务与依赖注入

如果多个插件需要共享能力，注册一个服务，而不是互相 import：

```ts
// plugins/core 已经提供了 ctx.qqbot，这里演示依赖它
export const inject = ['qqbot']

export function apply(ctx: Context) {
  ctx.on('message', () => {
    ctx.qqbot.stats.messagesReceived  // 共享状态
  })
}
```

自定义服务（参考 `plugins/core/index.ts`）：

```ts
import { Context, Service } from 'koishi'

declare module 'koishi' {
  interface Context {
    myService: MyService
  }
}

export class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService', true)
  }
}

export function apply(ctx: Context) {
  ctx.plugin(MyService)
}
```

## 8. 配置构型（Schema）

`Config` 使用 Koishi 的 Schema（schemastery）定义，支持默认值、必填、描述、分组、联动等；控制台会据此渲染配置表单。

```ts
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用'),
  admins: Schema.array(Schema.string()).default([]).description('管理员 QQ'),
  mode: Schema.union(['strict', 'loose'] as const).default('loose'),
})
```

> 通过 `app.plugin()` 直接加载（例如测试）时不会自动套用 Schema 默认值，插件里应做兜底（可参考 `plugins/echo` 的 `Object.assign({...defaults}, config)`）。

## 9. 定时任务

```ts
export function apply(ctx: Context) {
  ctx.setInterval(() => {
    ctx.logger('cron').info('每分钟执行一次')
  }, 60 * 1000)
}
```

插件卸载时定时器会被 Koishi 自动清理。

## 10. 测试

项目使用 Node 内置测试框架 + `@koishijs/plugin-mock`，无需真实 QQ：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as myPlugin from '../plugins/weather/index.ts'

test('weather 指令', async () => {
  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: '10000' })
  app.plugin(myPlugin, { apiKey: 'test' } as any)
  await app.start()
  try {
    const client = app.mock.client('20000')
    await client.shouldReply('/weather 北京', /晴/)
  } finally {
    await app.stop()
  }
})
```

运行：

```bash
npm test
```

若需要验证真实协议链路，可参考 `test/onebot.test.ts`：用 `ws` 启动一个假 OneBot 服务端，断言 `send_group_msg` 等 API 调用。

## 11. 发布为独立 npm 插件（可选）

本地插件无需构建即可运行。若要发布或跨项目复用：

1. 将插件目录整理成独立包（`package.json` 中声明 `koishi` 关键字与 peerDependencies）
2. 用 `tsc` / `yakumo` 构建到 `lib/`
3. 发布后在 `koishi.yml` 中直接写插件包名，不再使用相对路径

当前阶段的本地开发不需要这一步。

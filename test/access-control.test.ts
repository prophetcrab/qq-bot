import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { App } from 'koishi'
import mock from '@koishijs/plugin-mock'
import * as accessControl from '../plugins/access-control/index.ts'
import * as echoPlugin from '../plugins/echo/index.ts'

const SELF_ID = '10000'
const GROUP_A = '123456'
const GROUP_B = '654321'
const USER_A = '20000'
const USER_B = '20001'

/** 完整默认策略（与 DSH 侧共享的 JSON 结构一致）。 */
function basePolicy(): any {
  return {
    version: 1,
    inbound: {
      groups: { mode: 'all', ids: [] },
      private: { mode: 'all', ids: [] },
      quiet: { enabled: false, prefixes: ['/'] },
    },
    outbound: {
      groups: { mode: 'all', ids: [] },
      private: { mode: 'all', ids: [] },
    },
  }
}

/** 把策略写到指定文件（字符串则原样写入，用于构造损坏文件）。 */
function writePolicy(storagePath: string, policy: unknown): void {
  mkdirSync(dirname(storagePath), { recursive: true })
  const content = typeof policy === 'string' ? policy : `${JSON.stringify(policy, null, 2)}\n`
  writeFileSync(storagePath, content, 'utf8')
}

interface SetupOptions {
  /** 对象=写入该策略；字符串=原样写入（损坏文件）；null=不创建文件 */
  policy?: object | string | null
  config?: Record<string, any>
}

/**
 * 创建测试 App：mock 适配器 + access-control + echo 插件 + 一个带副作用的 /mark 指令。
 * 策略文件放在临时目录，测试结束后停止 App 并删除目录。
 */
async function setup(t: TestContext, options: SetupOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-access-'))
  const storagePath = join(dir, 'data', 'access.json')
  if (options.policy !== null) writePolicy(storagePath, options.policy ?? basePolicy())

  const app = new App({ prefix: ['/'] })
  app.plugin(mock, { selfId: SELF_ID })
  app.plugin(accessControl, { storagePath, ...(options.config ?? {}) } as any)
  app.plugin(echoPlugin)

  const executed = { mark: 0 }
  app.command('mark', '测试用指令：执行后记录一次副作用').action(() => {
    executed.mark += 1
    return 'marked'
  })

  await app.start()
  t.after(async () => {
    await app.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const client = (userId: string, channelId?: string) => app.mock.client(userId, channelId)
  return { app, dir, storagePath, executed, client }
}

test('默认 all-allow：群聊/私聊均放行，且自动创建 data/access.json', async (t) => {
  const { app, storagePath } = await setup(t, { policy: null })

  // 首次启动：目录与默认文件都应被创建
  assert.equal(existsSync(storagePath), true)
  const saved = JSON.parse(readFileSync(storagePath, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(typeof saved.updatedAt, 'string')
  assert.deepEqual(saved.inbound.groups, { mode: 'all', ids: [] })
  assert.deepEqual(saved.inbound.private, { mode: 'all', ids: [] })
  assert.deepEqual(saved.inbound.quiet, { enabled: false, prefixes: ['/'] })
  assert.deepEqual(saved.outbound.groups, { mode: 'all', ids: [] })
  assert.deepEqual(saved.outbound.private, { mode: 'all', ids: [] })
  assert.deepEqual(app.access.policy.inbound.groups, { mode: 'all', ids: [] })

  // 群聊、另一个群、私聊都能触发 echo 指令
  await app.mock.client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
  await app.mock.client(USER_A, GROUP_B).shouldReply('/echo hi', 'hi')
  await app.mock.client(USER_A).shouldReply('/echo hi', 'hi')
})

test('inbound whitelist：仅白名单群放行', async (t) => {
  const policy = basePolicy()
  policy.inbound.groups = { mode: 'whitelist', ids: [GROUP_A] }
  const { app, client } = await setup(t, { policy, config: { logBlocked: true } })

  await client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
  await client(USER_A, GROUP_B).shouldNotReply('/echo hi')
  // 未受群策略影响的私聊仍放行
  await client(USER_A).shouldReply('/echo hi', 'hi')
})

test('inbound blacklist：黑名单群被拦截，其他群放行', async (t) => {
  const policy = basePolicy()
  policy.inbound.groups = { mode: 'blacklist', ids: [GROUP_A, GROUP_B] }
  const { app, client, storagePath } = await setup(t, { policy })

  await client(USER_A, GROUP_A).shouldNotReply('/echo hi')
  await client(USER_A, GROUP_B).shouldNotReply('/echo hi')
  await client(USER_A, '777777').shouldReply('/echo hi', 'hi')
  // id 归一化：数字 -> 字符串字符串
  assert.deepEqual(app.access.policy.inbound.groups.ids, [GROUP_A, GROUP_B])
  assert.equal(JSON.parse(readFileSync(storagePath, 'utf8')).inbound.groups.mode, 'blacklist')
})

test('quiet：只放行指令前缀与 @机器人 的群消息', async (t) => {
  const policy = basePolicy()
  policy.inbound.quiet = { enabled: true, prefixes: ['/'] }
  const { app, client } = await setup(t, { policy })

  // 普通文本与关键词（echo 的 ping 中间件）都被静默丢弃
  await client(USER_A, GROUP_A).shouldNotReply('随便聊聊')
  await client(USER_A, GROUP_A).shouldNotReply('ping')
  // 指令前缀放行
  await client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
  // @机器人 的指令放行（元素中的 at id == selfId）
  await client(USER_A, GROUP_A).shouldReply('<at id="10000"/> /echo hi', 'hi')

  // 用自定义中间件验证「非指令文本」在 quiet 下的放行/拦截
  app.middleware((session, next) => {
    if (session.content?.includes('reply-me')) return 'seen'
    return next()
  })
  await client(USER_A, GROUP_A).shouldNotReply('reply-me')
  await client(USER_A, GROUP_A).shouldReply('<at id="10000"/> reply-me', 'seen')
  await client(USER_A, GROUP_A).shouldNotReply('<at id="99999"/> reply-me')
  // quiet 不影响私聊
  await client(USER_A).shouldReply('reply-me', 'seen')
})

test('quiet：JSON 内 prefixes 优先于 Config.quietPrefixes', async (t) => {
  const policy = basePolicy()
  policy.inbound.quiet = { enabled: true, prefixes: ['!'] }
  const { app, client } = await setup(t, { policy, config: { quietPrefixes: ['/'] } })

  app.middleware((session, next) => {
    if (session.content?.includes('reply-me')) return 'seen'
    return next()
  })

  await client(USER_A, GROUP_A).shouldReply('!reply-me', 'seen')
  // JSON 前缀为 ['!']，配置里的 '/' 不应生效
  await client(USER_A, GROUP_A).shouldNotReply('/echo hi')
})

test('quiet：JSON prefixes 为空时回落到 Config.quietPrefixes', async (t) => {
  const policy = basePolicy()
  policy.inbound.quiet = { enabled: true, prefixes: [] }
  const { app, client } = await setup(t, { policy, config: { quietPrefixes: ['!'] } })

  app.middleware((session, next) => {
    if (session.content?.includes('reply-me')) return 'seen'
    return next()
  })

  assert.deepEqual(app.access.policy.inbound.quiet.prefixes, ['!'])
  await client(USER_A, GROUP_A).shouldReply('!reply-me', 'seen')
  await client(USER_A, GROUP_A).shouldNotReply('/echo hi')
})

test('outbound groups 限制：指令会执行，但发送被取消', async (t) => {
  const policy = basePolicy()
  policy.outbound.groups = { mode: 'blacklist', ids: [GROUP_A] }
  const { client, executed } = await setup(t, { policy, config: { logBlocked: true } })

  const blocked = await client(USER_A, GROUP_A).receive('/mark')
  assert.deepEqual(blocked, [])
  assert.equal(executed.mark, 1) // 指令确实执行了

  // 其他群不受影响
  await client(USER_A, GROUP_B).shouldReply('/mark', 'marked')
  assert.equal(executed.mark, 2)
})

test('outbound private 限制：私聊发送同样会被取消', async (t) => {
  const policy = basePolicy()
  policy.outbound.private = { mode: 'blacklist', ids: [USER_A] }
  const { client, executed } = await setup(t, { policy })

  const blocked = await client(USER_A).receive('/mark')
  assert.deepEqual(blocked, [])
  assert.equal(executed.mark, 1)

  await client(USER_B).shouldReply('/mark', 'marked')
  assert.equal(executed.mark, 2)
  await client(USER_A, GROUP_A).shouldReply('/mark', 'marked')
  assert.equal(executed.mark, 3)
})

test('inbound private blacklist：私聊被拦截，群聊不受影响', async (t) => {
  const policy = basePolicy()
  policy.inbound.private = { mode: 'blacklist', ids: [USER_A] }
  const { client } = await setup(t, { policy })

  await client(USER_A).shouldNotReply('/echo hi')
  await client(USER_B).shouldReply('/echo hi', 'hi')
  await client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
})

test('文件热更新：reload 后新策略立即生效', async (t) => {
  const { app, storagePath, client } = await setup(t)
  await client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')

  const whitelist = basePolicy()
  whitelist.inbound.groups = { mode: 'whitelist', ids: [GROUP_B] }
  writePolicy(storagePath, whitelist)
  app.access.reload()
  assert.equal(app.access.policy.inbound.groups.mode, 'whitelist')

  await client(USER_A, GROUP_A).shouldNotReply('/echo hi')
  await client(USER_A, GROUP_B).shouldReply('/echo hi', 'hi')

  writePolicy(storagePath, basePolicy())
  app.access.reload()
  await client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
})

test('损坏的策略文件：使用默认策略、不崩溃、不覆盖原文件', async (t) => {
  const raw = '{ this is not valid json'
  const { app, storagePath } = await setup(t, { policy: raw })

  assert.equal(readFileSync(storagePath, 'utf8'), raw)
  assert.equal(app.access.policy.inbound.groups.mode, 'all')
  assert.equal(app.access.policy.outbound.groups.mode, 'all')
  await app.mock.client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')

  // 损坏文件 reload 失败时保留上一份策略
  writeFileSync(storagePath, '[]', 'utf8')
  const before = app.access.policy
  app.access.reload()
  assert.equal(app.access.policy, before)
  await app.mock.client(USER_A, GROUP_A).shouldReply('/echo hi', 'hi')
})

test('normalizePolicy：缺失字段补默认值，ids 去重排序，非法输入返回 null', () => {
  const policy = accessControl.normalizePolicy({
    version: 7,
    updatedAt: '2026-01-01T00:00:00.000Z',
    inbound: {
      groups: { mode: 'whitelist', ids: [123, ' 456 ', '123', '', null] },
      quiet: { enabled: true, prefixes: [] },
    },
  })
  assert.ok(policy)
  assert.equal(policy?.version, 7)
  assert.equal(policy?.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(policy?.inbound.groups, { mode: 'whitelist', ids: ['123', '456'] })
  assert.deepEqual(policy?.inbound.private, { mode: 'all', ids: [] })
  assert.deepEqual(policy?.inbound.quiet, { enabled: true, prefixes: ['/'] })
  assert.deepEqual(policy?.outbound.groups, { mode: 'all', ids: [] })

  // fallback 前缀：JSON 为空时使用调用方提供的兜底值
  const fallback = accessControl.normalizePolicy({ inbound: { quiet: { enabled: true, prefixes: [] } } }, ['!'])
  assert.deepEqual(fallback?.inbound.quiet.prefixes, ['!'])

  // 数字 id 按数值排序
  const sorted = accessControl.normalizePolicy({ inbound: { groups: { mode: 'blacklist', ids: [10, 2, '1'] } } })
  assert.deepEqual(sorted?.inbound.groups.ids, ['1', '2', '10'])

  assert.equal(accessControl.normalizePolicy(null), null)
  assert.equal(accessControl.normalizePolicy('invalid'), null)
  assert.equal(accessControl.normalizePolicy([]), null)

  const defaults = accessControl.createDefaultPolicy()
  assert.deepEqual(defaults.inbound.quiet, { enabled: false, prefixes: ['/'] })
  assert.deepEqual(defaults.outbound.private, { mode: 'all', ids: [] })
})

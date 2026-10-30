import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Context, Schema, Service } from 'koishi'

export const name = 'access-control'
export const inject = []

/** 访问策略的三种模式。 */
export type PolicyMode = 'all' | 'whitelist' | 'blacklist'

/** 一个方向（群聊或私聊）的 id 策略。 */
export interface AccessSection {
  mode: PolicyMode
  ids: string[]
}

/** quiet 模式：开启后群聊只放行指令前缀或 @机器人 的消息。 */
export interface QuietPolicy {
  enabled: boolean
  prefixes: string[]
}

/**
 * 与 DSH 侧共享的 `data/access.json` 结构。
 *
 * 该结构由 DSH qqbot 插件写入、由本插件读取，字段与默认值必须保持一致：
 * `version` / `updatedAt` / `inbound.{groups,private,quiet}` / `outbound.{groups,private}`。
 */
export interface AccessPolicy {
  version: number
  updatedAt?: string
  inbound: {
    groups: AccessSection
    private: AccessSection
    quiet: QuietPolicy
  }
  outbound: {
    groups: AccessSection
    private: AccessSection
  }
}

export interface Config {
  /** 策略文件路径；相对路径基于 Koishi 进程 cwd（即项目根目录）解析 */
  storagePath: string
  /** 是否把被拦截的消息以 debug 级别写日志（带节流） */
  logBlocked: boolean
  /** quiet 模式下 JSON 未提供 prefixes 时使用的兜底指令前缀 */
  quietPrefixes: string[]
}

export const DEFAULT_STORAGE_PATH = 'data/access.json'
export const DEFAULT_QUIET_PREFIXES = ['/']

export const Config: Schema<Config> = Schema.object({
  storagePath: Schema.string()
    .default(DEFAULT_STORAGE_PATH)
    .description('策略文件路径，默认 data/access.json（相对 koishi 进程 cwd）'),
  logBlocked: Schema.boolean()
    .default(false)
    .description('是否记录被拦截消息的 debug 日志（会按关键词节流）'),
  quietPrefixes: Schema.array(Schema.string())
    .default([...DEFAULT_QUIET_PREFIXES])
    .description('quiet 模式下 JSON 未提供 prefixes 时使用的兜底指令前缀'),
})

/**
 * 从 session 里读取本插件需要的字段。
 *
 * 用结构化接口而不是 Koishi 的 `Session`，这样收消息中间件与 `before-send`
 * 的发送 session 都能直接传入。
 */
export interface AccessSession {
  guildId?: string | null
  channelId?: string | null
  userId?: string | null
  selfId?: string | null
  isDirect?: boolean
  content?: string | null
  elements?: ReadonlyArray<{ type?: string; attrs?: Record<string, any>; children?: unknown }> | null
}

declare module 'koishi' {
  interface Context {
    access: AccessControl
  }
}

/** 默认策略：全部放行、quiet 关闭。 */
export function createDefaultPolicy(prefixes: string[] = DEFAULT_QUIET_PREFIXES): AccessPolicy {
  const normalizedPrefixes = normalizePrefixes(prefixes)
  return {
    version: 1,
    inbound: {
      groups: { mode: 'all', ids: [] },
      private: { mode: 'all', ids: [] },
      quiet: {
        enabled: false,
        prefixes: normalizedPrefixes.length > 0 ? normalizedPrefixes : [...DEFAULT_QUIET_PREFIXES],
      },
    },
    outbound: {
      groups: { mode: 'all', ids: [] },
      private: { mode: 'all', ids: [] },
    },
  }
}

/** 数字字符串优先按数值排序，其他按字典序。 */
function compareIds(a: string, b: string): number {
  const left = Number(a)
  const right = Number(b)
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right
  return a.localeCompare(b)
}

/** 归一化 id 数组：数字转字符串、去空、去重、排序。 */
export function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      ids.add(String(item))
      continue
    }
    if (typeof item === 'string') {
      const trimmed = item.trim()
      if (trimmed !== '') ids.add(trimmed)
    }
  }
  return [...ids].sort(compareIds)
}

/** 归一化前缀数组：只保留非空字符串，去重且保留顺序。 */
export function normalizePrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const prefixes = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item !== '') prefixes.add(item)
  }
  return [...prefixes]
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeMode(value: unknown): PolicyMode {
  return value === 'whitelist' || value === 'blacklist' ? value : 'all'
}

/** 解析单个方向；缺失/非法字段回落到 all-allow。 */
export function normalizeSection(value: unknown): AccessSection {
  if (!isRecord(value)) return { mode: 'all', ids: [] }
  return { mode: normalizeMode(value.mode), ids: normalizeIds(value.ids) }
}

/**
 * 把任意 JSON 归一化成完整策略；不是对象时返回 null（调用方保留上一份策略）。
 *
 * 缺失字段使用默认值；quiet.prefixes 为空时依次回落到 `fallbackPrefixes` 与 `['/']`。
 */
export function normalizePolicy(raw: unknown, fallbackPrefixes: string[] = DEFAULT_QUIET_PREFIXES): AccessPolicy | null {
  if (!isRecord(raw)) return null
  const inbound = isRecord(raw.inbound) ? raw.inbound : {}
  const outbound = isRecord(raw.outbound) ? raw.outbound : {}
  const quiet = isRecord(inbound.quiet) ? inbound.quiet : {}

  let prefixes = normalizePrefixes(quiet.prefixes)
  if (prefixes.length === 0) prefixes = normalizePrefixes(fallbackPrefixes)
  if (prefixes.length === 0) prefixes = [...DEFAULT_QUIET_PREFIXES]

  const policy: AccessPolicy = {
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    inbound: {
      groups: normalizeSection(inbound.groups),
      private: normalizeSection(inbound.private),
      quiet: { enabled: quiet.enabled === true, prefixes },
    },
    outbound: {
      groups: normalizeSection(outbound.groups),
      private: normalizeSection(outbound.private),
    },
  }
  if (typeof raw.updatedAt === 'string' && raw.updatedAt !== '') policy.updatedAt = raw.updatedAt
  return policy
}

function errorText(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error)
}

function describeSection(section: AccessSection): string {
  return `${section.mode}${section.ids.length > 0 ? `:${section.ids.join(',')}` : ''}`
}

/** 判断一个 id 是否通过某个方向的策略。 */
function isSectionAllowed(section: AccessSection, id: string | undefined): boolean {
  if (section.mode === 'all') return true
  if (section.mode === 'whitelist') return id !== undefined && section.ids.includes(id)
  // blacklist：缺少 id 时无法命中黑名单，放行
  return id === undefined ? true : !section.ids.includes(id)
}

/** 私聊判定：优先 isDirect，其次没有 guildId 且 channelId 为 private: 前缀。 */
function isDirectSession(session: AccessSession): boolean {
  if (session.isDirect === true) return true
  if (session.guildId) return false
  return typeof session.channelId === 'string' && session.channelId.startsWith('private:')
}

/** 群标识：guildId || channelId。 */
function sessionGroupId(session: AccessSession): string | undefined {
  const id = session.guildId || session.channelId
  return id ? String(id) : undefined
}

/** 私聊用户标识：优先 userId，发送 session 可回落到 `private:<userId>`。 */
function sessionUserId(session: AccessSession): string | undefined {
  if (session.userId) return String(session.userId)
  if (isDirectSession(session) && typeof session.channelId === 'string' && session.channelId.startsWith('private:')) {
    return session.channelId.slice('private:'.length)
  }
  return undefined
}

/** 消息 elements 中是否存在 @机器人。 */
function hasAtSelf(session: AccessSession): boolean {
  const selfId = session.selfId ? String(session.selfId) : ''
  if (selfId === '' || !Array.isArray(session.elements)) return false
  for (const element of session.elements) {
    if (element?.type !== 'at') continue
    const attrs = element.attrs ?? {}
    if (String(attrs['id'] ?? '') === selfId || String(attrs['qq'] ?? '') === selfId) return true
  }
  return false
}

/**
 * Koishi 权限控制服务。
 *
 * 收消息：prepend 中间件在指令/业务中间件之前拦截；
 * 发消息：`before-send` 返回 true 取消发送；
 * 策略文件变更后通过 `fs.watchFile` 自动重载（解析失败保留上一份策略）。
 */
export class AccessControl extends Service<Config> {
  static inject = []

  private currentPolicy: AccessPolicy
  private readonly storageFilePath: string
  private readonly logTimes = new Map<string, number>()
  private readonly logIntervalMs = 2000
  private readonly accessLogger: ReturnType<Context['logger']>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'access', true)
    this.config = Object.assign(
      {
        storagePath: DEFAULT_STORAGE_PATH,
        logBlocked: false,
        quietPrefixes: [...DEFAULT_QUIET_PREFIXES],
      },
      config,
    )
    if (!Array.isArray(this.config.quietPrefixes)) {
      this.config.quietPrefixes = [...DEFAULT_QUIET_PREFIXES]
    }
    if (typeof this.config.storagePath !== 'string' || this.config.storagePath.trim() === '') {
      this.config.storagePath = DEFAULT_STORAGE_PATH
    }
    this.storageFilePath = isAbsolute(this.config.storagePath)
      ? this.config.storagePath
      : resolve(process.cwd(), this.config.storagePath)
    this.accessLogger = ctx.logger('access-control')
    this.currentPolicy = createDefaultPolicy(this.config.quietPrefixes)

    this.loadInitialPolicy()

    // 策略文件变更时重载；用 effect 保证插件 unload 时停止 watch。
    ctx.effect(() => {
      const listener = () => {
        this.reload()
      }
      watchFile(this.storageFilePath, { interval: 1000 }, listener)
      this.accessLogger.debug(`正在监听策略文件：${this.storageFilePath}`)
      return () => {
        unwatchFile(this.storageFilePath, listener)
        this.accessLogger.debug(`已停止监听策略文件：${this.storageFilePath}`)
      }
    })

    ctx.middleware((session, next) => {
      if (!this.isInboundAllowed(session)) {
        this.logBlocked('inbound', session, this.reasonOf(session))
        return
      }
      if (this.isQuietBlocked(session)) {
        this.logBlocked('quiet', session, 'quiet-mode')
        return
      }
      return next()
    }, true)

    ctx.on('before-send', (session) => {
      if (this.isOutboundAllowed(session)) return
      this.logBlocked('outbound', session, this.reasonOf(session))
      // 返回 true 让 Koishi 取消本次发送
      return true
    })

    this.accessLogger.debug(`权限控制已加载：${describeSection(this.currentPolicy.inbound.groups)} / ${describeSection(this.currentPolicy.outbound.groups)}`)
  }

  /** 当前生效的策略（只读用途；修改请写文件后 reload）。 */
  get policy(): AccessPolicy {
    return this.currentPolicy
  }

  /** 策略文件的绝对路径。 */
  get storagePath(): string {
    return this.storageFilePath
  }

  /** 重新读取策略文件；失败时保留上一份策略并 warn，不抛错。 */
  reload(): AccessPolicy {
    try {
      const policy = this.readPolicyFile()
      this.currentPolicy = policy
      this.accessLogger.debug(`策略已重载：${this.storageFilePath}`)
      return this.currentPolicy
    } catch (error) {
      this.accessLogger.warn(`重载策略失败，保留上一份策略：${errorText(error)}`)
      return this.currentPolicy
    }
  }

  /** 收消息是否允许（不考虑 quiet）。 */
  isInboundAllowed(session: AccessSession): boolean {
    const inbound = this.currentPolicy.inbound
    if (isDirectSession(session)) return isSectionAllowed(inbound.private, sessionUserId(session))
    return isSectionAllowed(inbound.groups, sessionGroupId(session))
  }

  /** quiet 模式下该群消息是否应被静默丢弃（私聊不受 quiet 影响）。 */
  isQuietBlocked(session: AccessSession): boolean {
    const quiet = this.currentPolicy.inbound.quiet
    if (!quiet.enabled || isDirectSession(session)) return false
    if (hasAtSelf(session)) return false
    const content = session.content ?? ''
    if (quiet.prefixes.some((prefix) => prefix !== '' && content.startsWith(prefix))) return false
    return true
  }

  /** 发消息是否允许。发送 session 没有群/私聊上下文时放行，避免误伤系统播报。 */
  isOutboundAllowed(session: AccessSession): boolean {
    const outbound = this.currentPolicy.outbound
    if (isDirectSession(session)) return isSectionAllowed(outbound.private, sessionUserId(session))
    const groupId = sessionGroupId(session)
    if (groupId === undefined) return true
    return isSectionAllowed(outbound.groups, groupId)
  }

  private reasonOf(session: AccessSession): string {
    return isDirectSession(session) ? 'private-policy' : 'group-policy'
  }

  /** 首次启动：文件不存在时创建默认 all-allow 文件；存在但损坏时保留默认策略。 */
  private loadInitialPolicy(): void {
    try {
      if (!existsSync(this.storageFilePath)) {
        const policy: AccessPolicy = {
          ...createDefaultPolicy(this.config.quietPrefixes),
          updatedAt: new Date().toISOString(),
        }
        this.writePolicyFile(policy)
        this.currentPolicy = policy
        this.accessLogger.info(`已创建默认权限策略：${this.storageFilePath}`)
        return
      }
      const policy = this.readPolicyFile()
      this.currentPolicy = policy
      this.accessLogger.debug(`已加载权限策略：${this.storageFilePath}`)
    } catch (error) {
      this.accessLogger.warn(`读取策略文件失败，使用默认策略（不覆盖原文件）：${errorText(error)}`)
    }
  }

  private readPolicyFile(): AccessPolicy {
    const text = readFileSync(this.storageFilePath, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new Error(`JSON 解析失败：${errorText(error)}`)
    }
    const policy = normalizePolicy(parsed, this.config.quietPrefixes)
    if (policy === null) throw new Error('策略文件必须是 JSON 对象')
    return policy
  }

  private writePolicyFile(policy: AccessPolicy): void {
    mkdirSync(dirname(this.storageFilePath), { recursive: true })
    writeFileSync(this.storageFilePath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  }

  /** debug 日志节流：同一来源 + 原因每 2 秒最多一条，避免刷屏。 */
  private logBlocked(kind: string, session: AccessSession, reason: string): void {
    if (!this.config.logBlocked) return
    const id = isDirectSession(session)
      ? sessionUserId(session) ?? '?'
      : sessionGroupId(session) ?? '?'
    const key = `${kind}:${id}:${reason}`
    const now = Date.now()
    const last = this.logTimes.get(key) ?? 0
    if (now - last < this.logIntervalMs) return
    this.logTimes.set(key, now)
    this.accessLogger.debug(`[${kind}] 已拦截 id=${id} reason=${reason}`)
  }
}

/** 插件入口。 */
export function apply(ctx: Context, config: Config) {
  ctx.plugin(AccessControl, config)
}

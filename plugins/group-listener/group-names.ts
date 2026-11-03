import type { GroupState } from './types.js'

const CACHE_TTL_MS = 5 * 60 * 1000

/** Resolve group_id -> group_name from OneBot get_group_list, with a small cache. */
export class GroupNameResolver {
  private cache = new Map<string, string>()
  private fetchedAt = 0
  private pending: Promise<void> | null = null

  async prime(bot: any): Promise<void> {
    if (this.pending !== null || Date.now() - this.fetchedAt < CACHE_TTL_MS) return
    this.pending = this.fetch(bot).finally(() => { this.pending = null })
    return this.pending
  }

  getCached(groupId: string): string | undefined {
    return this.cache.get(groupId)
  }

  set(groupId: string, name: string): void {
    if (groupId !== '' && name !== '') this.cache.set(groupId, name)
  }

  async resolve(bot: any, groupId: string): Promise<string> {
    const cached = this.cache.get(groupId)
    if (cached !== undefined) return cached
    await this.prime(bot)
    return this.cache.get(groupId) ?? ''
  }

  async fill(groups: Map<string, GroupState>, bot: any): Promise<boolean> {
    await this.prime(bot)
    let changed = false
    for (const [id, group] of groups) {
      const name = this.cache.get(id)
      if (name !== undefined && group.name === '') {
        group.name = name
        changed = true
      }
    }
    return changed
  }

  private async fetch(bot: any): Promise<void> {
    try {
      let rows: any[] = []
      if (typeof bot?.internal?.getGroupList === 'function') {
        const raw = await bot.internal.getGroupList()
        rows = Array.isArray(raw) ? raw : []
      } else if (typeof bot?.getGuildList === 'function') {
        const raw = await bot.getGuildList()
        rows = Array.isArray(raw?.data) ? raw.data : []
      }
      for (const row of rows) {
        const id = String(row?.group_id ?? row?.id ?? '')
        const name = String(row?.group_name ?? row?.name ?? '').trim()
        if (id !== '' && name !== '') this.cache.set(id, name)
      }
      this.fetchedAt = Date.now()
    } catch {
      // Group names are best-effort; message delivery must not depend on them.
    }
  }
}

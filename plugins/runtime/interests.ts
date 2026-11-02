/** Semantic interests written by the AI host and matched by the runtime. */

export interface SemanticInterest {
  groupId: string
  label: string
  aliases: string[]
  summary: string
  weight: number
  confidence: number
  expiresAt: number
  lastSeenAt: number
  source: string
}

export interface InterestHit {
  groupId: string
  label: string
  matched: string
  weight: number
  confidence: number
  summary: string
  expiresAt: number
}

const normalize = (value: unknown): string => String(value ?? '').normalize('NFKC').toLowerCase().trim()
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

export class SemanticInterestStore {
  private readonly byGroup = new Map<string, SemanticInterest[]>()

  restore(payload: unknown): void {
    this.byGroup.clear()
    const list = payload !== null && typeof payload === 'object' && Array.isArray((payload as { interests?: unknown }).interests)
      ? (payload as { interests: unknown[] }).interests
      : []
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const source = item as Record<string, unknown>
      const groupId = normalize(source.groupId)
      const label = String(source.label ?? '').trim()
      if (groupId === '' || label === '') continue
      const aliases = Array.isArray(source.aliases)
        ? source.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '').map((alias) => alias.trim()).slice(0, 6)
        : []
      const interest: SemanticInterest = {
        groupId,
        label,
        aliases,
        summary: String(source.summary ?? '').slice(0, 200),
        weight: clamp01(Number(source.weight) || 0.5),
        confidence: clamp01(Number(source.confidence) || 0.6),
        expiresAt: Number(source.expiresAt) || 0,
        lastSeenAt: Number(source.lastSeenAt) || 0,
        source: String(source.source ?? 'llm'),
      }
      const list = this.byGroup.get(groupId) ?? []
      list.push(interest)
      this.byGroup.set(groupId, list)
    }
  }

  prune(now = Date.now()): void {
    for (const [groupId, list] of this.byGroup) {
      const active = list.filter((interest) => interest.expiresAt === 0 || now < interest.expiresAt)
      if (active.length === 0) this.byGroup.delete(groupId)
      else this.byGroup.set(groupId, active)
    }
  }

  match(text: string, groupId: string): InterestHit[] {
    const haystack = normalize(text)
    if (haystack === '') return []
    const group = this.byGroup.get(normalize(groupId)) ?? []
    const now = Date.now()
    const hits: InterestHit[] = []
    for (const interest of group) {
      if (interest.expiresAt > 0 && now >= interest.expiresAt) continue
      const candidates = [interest.label, ...interest.aliases]
      const matched = candidates.find((candidate) => normalize(candidate) !== '' && haystack.includes(normalize(candidate)))
      if (matched === undefined) continue
      hits.push({
        groupId: interest.groupId,
        label: interest.label,
        matched,
        weight: interest.weight,
        confidence: interest.confidence,
        summary: interest.summary,
        expiresAt: interest.expiresAt,
      })
    }
    return hits
  }

  score(text: string, groupId: string): number {
    return this.match(text, groupId).reduce((sum, hit) => sum + hit.weight * hit.confidence, 0)
  }

  list(groupId?: string): SemanticInterest[] {
    return [...this.byGroup.values()].flat().filter((interest) => groupId === undefined || interest.groupId === normalize(groupId))
  }
}

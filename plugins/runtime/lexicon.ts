/** Dynamic, scoped attention lexicon. Keywords add salience; they never force a reply. */

import type { KeywordHit, KeywordStatus, KeywordTerm, LexiconKey, LexiconScope } from './types.js'

const STOPWORDS = new Set([
  '这个', '那个', '什么', '怎么', '可以', '没有', '就是', '还是', '然后', '因为', '所以',
  '我们', '你们', '他们', '自己', '现在', '时候', '一个', '一下', '真的', '感觉', '知道',
  '哈哈', '哈哈哈', '笑死', '不是', '已经', '还有', '但是', '如果', '这样', '那样',
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'have', 'from', 'just',
])

export interface LexiconOptions {
  maxTermsPerScope?: number
  defaultTtlMs?: number
  halfLifeMs?: number
  minWeight?: number
}

export interface TermOptions {
  weight?: number
  confidence?: number
  source?: string
  aliases?: string[]
  expiresAt?: number | null
  status?: KeywordStatus
}

export function scopeKey(key: LexiconKey): string {
  return `${key.scope}:${key.owner}`
}

/** Normalize text for keyword matching (case, width, whitespace). */
export function normalize(text: string): string {
  return String(text ?? '').normalize('NFKC').toLowerCase().trim()
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Extract compact candidate terms; intentionally conservative to avoid noise. */
export function extractCandidates(text: string): string[] {
  const normalized = normalize(text)
  const chunks: string[] = []
  try {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike !== true) continue
      const term = segment.segment.trim()
      if (term !== '') chunks.push(term)
    }
  } catch {
    chunks.push(...(normalized.match(/[\p{Script=Han}]{2,8}|[a-z][a-z0-9_-]{2,}/gu) ?? []))
  }
  // Chinese proper nouns often segment into single characters (e.g. 龙/图).
  // Add conservative 2-4 character Han n-grams so names and phrases survive.
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    const chars = [...run]
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) {
        const gram = chars.slice(index, index + size).join('')
        if (STOPWORDS.has(gram)) continue
        chunks.push(gram)
      }
    }
  }
  const output: string[] = []
  for (const chunk of chunks) {
    const term = chunk.trim()
    if (term.length < 2 || STOPWORDS.has(term)) continue
    if (/^\d+$/u.test(term)) continue
    if (!output.includes(term)) output.push(term)
  }
  return output.slice(0, 12)
}

interface StoredTerm {
  key: LexiconKey
  term: KeywordTerm
}

export class DynamicLexicon {
  private readonly maxTermsPerScope: number
  private readonly defaultTtlMs: number
  private readonly halfLifeMs: number
  private readonly minWeight: number
  private readonly terms = new Map<string, StoredTerm>()

  constructor(options: LexiconOptions = {}) {
    this.maxTermsPerScope = options.maxTermsPerScope ?? 200
    this.defaultTtlMs = options.defaultTtlMs ?? 7 * 24 * 60 * 60 * 1000
    this.halfLifeMs = options.halfLifeMs ?? 24 * 60 * 60 * 1000
    this.minWeight = options.minWeight ?? 0.05
  }

  add(key: LexiconKey, text: string, options: TermOptions = {}, now = Date.now()): KeywordTerm {
    const normalized = normalize(text)
    const id = `${scopeKey(key)}|${normalized}`
    const existing = this.terms.get(id)
    if (existing !== undefined) {
      existing.term.lastSeenAt = now
      existing.term.weight = clamp01(existing.term.weight + (options.weight ?? 0.1))
      existing.term.confidence = clamp01(Math.max(existing.term.confidence, options.confidence ?? existing.term.confidence))
      if (options.expiresAt !== undefined) existing.term.expiresAt = options.expiresAt
      if (options.status !== undefined) existing.term.status = options.status
      this.enforceLimit(key, now)
      return existing.term
    }
    const term: KeywordTerm = {
      text: normalized,
      aliases: uniqueAliases(options.aliases ?? []),
      weight: clamp01(options.weight ?? 0.2),
      confidence: clamp01(options.confidence ?? 0.5),
      source: options.source ?? 'manual',
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt: options.expiresAt === undefined ? now + this.defaultTtlMs : options.expiresAt,
      status: options.status ?? 'active',
    }
    this.terms.set(id, { key, term })
    this.enforceLimit(key, now)
    return term
  }

  remove(key: LexiconKey, text: string): boolean {
    return this.terms.delete(`${scopeKey(key)}|${normalize(text)}`)
  }

  pin(key: LexiconKey, text: string): boolean {
    const stored = this.terms.get(`${scopeKey(key)}|${normalize(text)}`)
    if (stored === undefined) return false
    stored.term.status = 'pinned'
    stored.term.expiresAt = null
    return true
  }

  suppress(key: LexiconKey, text: string): boolean {
    const stored = this.terms.get(`${scopeKey(key)}|${normalize(text)}`)
    if (stored === undefined) return false
    stored.term.status = 'suppressed'
    return true
  }

  /** Match every active term across the supplied scopes. */
  match(text: string, keys: LexiconKey[]): KeywordHit[] {
    const haystack = normalize(text)
    if (haystack === '') return []
    const wanted = new Set(keys.map(scopeKey))
    const hits: KeywordHit[] = []
    for (const stored of this.terms.values()) {
      if (stored.term.status === 'suppressed') continue
      if (!wanted.has(scopeKey(stored.key))) continue
      const candidates = [stored.term.text, ...stored.term.aliases]
      const matched = candidates.find((candidate) => candidate !== '' && haystack.includes(candidate))
      if (matched === undefined) continue
      hits.push({
        key: stored.key,
        text: stored.term.text,
        matched,
        weight: stored.term.weight,
        confidence: stored.term.confidence,
      })
    }
    return hits
  }

  score(text: string, keys: LexiconKey[]): number {
    return this.match(text, keys).reduce((sum, hit) => sum + hit.weight * hit.confidence, 0)
  }

  /** Learn candidate terms from a message; repeated occurrences gain weight. */
  learn(text: string, key: LexiconKey, now = Date.now()): KeywordTerm[] {
    const learned: KeywordTerm[] = []
    for (const candidate of extractCandidates(text)) {
      learned.push(this.add(key, candidate, { weight: 0.2, confidence: 0.4, source: 'learned' }, now))
    }
    return learned
  }

  decay(now = Date.now()): void {
    for (const [id, stored] of this.terms) {
      const term = stored.term
      if (term.status === 'pinned') continue
      if (term.expiresAt !== null && now >= term.expiresAt) {
        this.terms.delete(id)
        continue
      }
      const elapsed = now - term.lastSeenAt
      if (elapsed > 0) term.weight *= Math.pow(0.5, elapsed / this.halfLifeMs)
      if (term.weight < this.minWeight) this.terms.delete(id)
    }
  }

  snapshot(): Array<{ key: LexiconKey; terms: KeywordTerm[] }> {
    const grouped = new Map<string, { key: LexiconKey; terms: KeywordTerm[] }>()
    for (const stored of this.terms.values()) {
      const id = scopeKey(stored.key)
      const group = grouped.get(id) ?? { key: stored.key, terms: [] }
      group.terms.push({ ...stored.term, aliases: [...stored.term.aliases] })
      grouped.set(id, group)
    }
    return [...grouped.values()]
  }

  /** Serialize the lexicon for persistence. */
  exportState(): Array<{ key: LexiconKey; terms: KeywordTerm[] }> {
    return this.snapshot()
  }

  /** Restore persisted terms, preserving weights and expiration. */
  restoreState(state: Array<{ key: LexiconKey; terms: KeywordTerm[] }>): void {
    this.terms.clear()
    for (const set of state) {
      if (set === null || typeof set !== 'object' || set.key === undefined) continue
      const key = set.key
      if (typeof key.scope !== 'string' || typeof key.owner !== 'string') continue
      for (const term of set.terms ?? []) {
        if (term === null || typeof term !== 'object' || typeof term.text !== 'string') continue
        const normalized = normalize(term.text)
        if (normalized === '') continue
        const stored: KeywordTerm = {
          text: normalized,
          aliases: uniqueAliases(term.aliases ?? []),
          weight: clamp01(Number(term.weight) || 0.2),
          confidence: clamp01(Number(term.confidence) || 0.5),
          source: typeof term.source === 'string' ? term.source : 'persisted',
          firstSeenAt: Number(term.firstSeenAt) || Date.now(),
          lastSeenAt: Number(term.lastSeenAt) || Date.now(),
          expiresAt: term.expiresAt === null ? null : Number(term.expiresAt) || null,
          status: term.status === 'pinned' || term.status === 'suppressed' ? term.status : 'active',
        }
        this.terms.set(`${scopeKey(key)}|${normalized}`, { key, term: stored })
      }
    }
  }

  private enforceLimit(key: LexiconKey, now: number): void {
    const id = scopeKey(key)
    const list = [...this.terms.entries()].filter(([, stored]) => scopeKey(stored.key) === id)
    if (list.length <= this.maxTermsPerScope) return
    list
      .filter(([, stored]) => stored.term.status !== 'pinned')
      .sort((left, right) => left[1].term.weight * left[1].term.confidence - right[1].term.weight * right[1].term.confidence)
      .slice(0, list.length - this.maxTermsPerScope)
      .forEach(([termId]) => this.terms.delete(termId))
    void now
  }
}

function uniqueAliases(input: string[]): string[] {
  const output: string[] = []
  for (const item of input) {
    const normalized = normalize(item)
    if (normalized !== '' && !output.includes(normalized)) output.push(normalized)
  }
  return output
}

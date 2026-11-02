/** Registration surface for future games, activities and life sources. */

export interface GameSpec {
  id: string
  name: string
  commands: string[]
  permissions: string[]
  createSession: (groupId: string, initiator: string) => unknown
  reduce: (session: unknown, event: unknown) => unknown
  render: (session: unknown) => string
  onTimeout: (session: unknown) => unknown
}

export interface ActivitySpec {
  id: string
  title: string
  phases: string[]
  durationMs: number
  progressRules: unknown[]
}

export interface LifeSourceSpec {
  id: string
  tick: (context: { now: number; personaId: string }) => unknown
}

export class ExtensionRegistry {
  private readonly games = new Map<string, GameSpec>()
  private readonly activities = new Map<string, ActivitySpec>()
  private readonly lifeSources = new Map<string, LifeSourceSpec>()

  registerGame(spec: GameSpec): void {
    this.games.set(spec.id, spec)
  }

  registerActivity(spec: ActivitySpec): void {
    this.activities.set(spec.id, spec)
  }

  registerLifeSource(spec: LifeSourceSpec): void {
    this.lifeSources.set(spec.id, spec)
  }

  unregisterGame(id: string): boolean {
    return this.games.delete(id)
  }

  unregisterActivity(id: string): boolean {
    return this.activities.delete(id)
  }

  unregisterLifeSource(id: string): boolean {
    return this.lifeSources.delete(id)
  }

  listGames(): GameSpec[] {
    return [...this.games.values()]
  }

  listActivities(): ActivitySpec[] {
    return [...this.activities.values()]
  }

  listLifeSources(): LifeSourceSpec[] {
    return [...this.lifeSources.values()]
  }

  clear(): void {
    this.games.clear()
    this.activities.clear()
    this.lifeSources.clear()
  }
}

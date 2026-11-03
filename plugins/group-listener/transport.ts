import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 120_000

/** HTTP client for the DSH group-loop endpoints, with discovery-file lookup. */
export class DshTransport {
  private endpoint: string

  private readonly options: { endpoint: string; discoveryFile: string; timeoutMs: number }

  constructor(options: { endpoint: string; discoveryFile: string; timeoutMs?: number }) {
    this.options = { ...options, timeoutMs: Number.isFinite(options.timeoutMs) ? Math.max(5000, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS }
    this.endpoint = options.endpoint
  }

  private origin(): string {
    if (this.endpoint === '') {
      try {
        const parsed = JSON.parse(readFileSync(resolve(process.cwd(), this.options.discoveryFile), 'utf8'))
        if (typeof parsed.endpoint === 'string') this.endpoint = parsed.endpoint
      } catch {
        // The panel writes discovery asynchronously; callers get a clear not-ready result.
      }
    }
    if (this.endpoint === '') return ''
    try { return new URL(this.endpoint).origin } catch { return '' }
  }

  async post(path: string, body: unknown): Promise<any> {
    const origin = this.origin()
    if (origin === '') return { ok: false, error: 'DSH endpoint not ready' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    timer.unref?.()
    try {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      return data !== null && typeof data === 'object' ? data : { ok: false, error: `HTTP ${response.status}` }
    } catch (error: any) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Current-message image collection and safe downloading. */
import type { Config } from './config.js'
import type { InboundImage } from './types.js'
import { resolvePublicHttpUrl, sniffImageType } from './url-safety.js'

/** Image URLs present on the current message. */
export function collectImageUrls(session: any, limit: number): string[] {
  const elements = Array.isArray(session?.elements) ? session.elements : []
  const urls: string[] = []
  for (const element of elements) {
    if (element?.type !== 'image' && element?.type !== 'img') continue
    const raw = element?.attrs?.src ?? element?.attrs?.url ?? element?.attrs?.file
    const url = typeof raw === 'string' ? raw.trim() : ''
    if (!/^https?:\/\//iu.test(url)) continue
    if (!urls.includes(url)) urls.push(url)
    if (urls.length >= limit) break
  }
  return urls
}

const MAX_REDIRECTS = 3

/** Fetch one untrusted image URL, validating every redirect hop. */
async function fetchImage(url: string, config: Config, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Response> {
  let current = await resolvePublicHttpUrl(url)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetchImpl(current.href, {
      signal,
      redirect: 'manual',
      headers: { accept: 'image/*' },
    })
    if (response.status < 300 || response.status >= 400 || redirect === MAX_REDIRECTS) return response
    const location = response.headers.get('location')
    if (location === null || location === '') return response
    await response.body?.cancel?.()
    current = await resolvePublicHttpUrl(new URL(location, current).href)
  }
  throw new Error('image-redirect-limit')
}

/** Read a response while enforcing the byte cap before buffering everything. */
async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.()
    throw new Error('image-too-large')
  }
  if (response.body !== null && typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.byteLength
        if (total > limit) {
          await reader.cancel()
          throw new Error('image-too-large')
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock?.()
    }
    return Buffer.concat(chunks)
  }
  const fallback = Buffer.from(await response.arrayBuffer())
  if (fallback.byteLength > limit) throw new Error('image-too-large')
  return fallback
}

/** Download images for multimodal inference; any unsafe/broken image is skipped. */
export async function downloadImageUrls(urls: string[], config: Config, fetchImpl: typeof fetch = fetch): Promise<InboundImage[]> {
  const images: InboundImage[] = []
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    timer.unref?.()
    try {
      const response = await fetchImage(url, config, fetchImpl, controller.signal)
      if (response.ok !== true) continue
      const buffer = await readBounded(response, config.imageMaxBytes)
      if (buffer.byteLength === 0) continue
      const mediaType = sniffImageType(buffer)
      if (mediaType === null) continue
      images.push({ mediaType, data: buffer.toString('base64') })
    } catch {
      // ignore a broken/unsafe image; text still goes through
    } finally {
      clearTimeout(timer)
    }
  }
  return images
}

export async function downloadImages(session: any, config: Config, fetchImpl: typeof fetch = fetch): Promise<InboundImage[]> {
  return downloadImageUrls(collectImageUrls(session, Math.max(0, config.imageLimit)), config, fetchImpl)
}

/** Current-message image collection and download. */
import type { Config } from './config.js'
import type { InboundImage } from './types.js'

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

function mediaTypeOf(contentType: string | null, url: string): string {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp' || type === 'image/gif') return type
  const match = /\.(jpe?g|png|webp|gif)(?:\?|$)/iu.exec(url)
  if (match !== null) {
    const ext = match[1].toLowerCase()
    if (ext === 'jpg') return 'image/jpeg'
    return `image/${ext}`
  }
  return 'image/jpeg'
}

/** Download images for multimodal inference. */
export async function downloadImageUrls(urls: string[], config: Config, fetchImpl: typeof fetch = fetch): Promise<InboundImage[]> {
  const images: InboundImage[] = []
  for (const url of urls) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      timer.unref?.()
      let response: Response
      try {
        response = await fetchImpl(url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (response.ok !== true) continue
      const type = mediaTypeOf(response.headers.get('content-type'), url)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0 || buffer.byteLength > config.imageMaxBytes) continue
      images.push({ mediaType: type, data: buffer.toString('base64') })
    } catch {
      // ignore a broken image; text still goes through
    }
  }
  return images
}

export async function downloadImages(session: any, config: Config, fetchImpl: typeof fetch = fetch): Promise<InboundImage[]> {
  return downloadImageUrls(collectImageUrls(session, Math.max(0, config.imageLimit)), config, fetchImpl)
}

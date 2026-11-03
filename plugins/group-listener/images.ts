/** Image collection and safe downloading for the group listener. */
import { resolvePublicHttpUrl, sniffImageType } from '../ai-chat/url-safety.ts'
import type { Envelope } from './types.ts'

export interface InboundImage { mediaType: string; data: string }
export interface ImagePlan { current: string[]; quoted: string[]; background: string[] }
export interface ImageBucket { current: InboundImage[]; quoted: InboundImage[]; background: InboundImage[] }

const MAX_REDIRECTS = 3

function attrsUrl(element: any): string {
  const source = element?.attrs ?? {}
  const value = source.src ?? source.url ?? source.file
  return typeof value === 'string' && /^https?:\/\//iu.test(value.trim()) ? value.trim() : ''
}

function urlsFromElements(elements: any[], limit: number): string[] {
  const urls: string[] = []
  for (const element of Array.isArray(elements) ? elements : []) {
    if (element?.type !== 'image' && element?.type !== 'img') continue
    const url = attrsUrl(element)
    if (url === '' || urls.includes(url)) continue
    urls.push(url)
    if (urls.length >= limit) break
  }
  return urls
}

function quoteElements(session: any): any[] {
  const quote = session?.quote
  if (quote === null || quote === undefined) return []
  if (Array.isArray(quote?.elements)) return quote.elements
  if (Array.isArray(quote?.message)) return quote.message
  if (typeof quote?.content === 'string') {
    const urls = [...quote.content.matchAll(/(?:src|url|file)=["']([^"']+)["']/giu)].map((match) => match[1])
    return urls.map((url) => ({ type: 'image', attrs: { src: url } }))
  }
  return []
}

function unique(urls: string[], limit: number): string[] {
  return [...new Set(urls)].slice(0, limit)
}

export function collectImagePlan(session: any, buffer: Envelope[], totalLimit = 4): ImagePlan {
  const limit = Math.max(0, Math.min(4, totalLimit))
  const current = unique(urlsFromElements(session?.elements, limit), limit)
  const quoted = unique(urlsFromElements(quoteElements(session), Math.min(2, limit - current.length)), Math.max(0, limit - current.length))
  const used = new Set([...current, ...quoted])
  const background: string[] = []
  for (const entry of buffer.slice(-30).reverse()) {
    if (entry.fromSelf === true) continue
    for (const attachment of entry.content.attachments) {
      if (attachment.url === undefined || used.has(attachment.url)) continue
      used.add(attachment.url)
      background.push(attachment.url)
      if (current.length + quoted.length + background.length >= limit) break
    }
    if (current.length + quoted.length + background.length >= limit) break
  }
  return { current, quoted, background }
}

async function fetchImage(url: string, maxBytes: number, signal: AbortSignal): Promise<Response> {
  let current = await resolvePublicHttpUrl(url)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(current.href, { signal, redirect: 'manual', headers: { accept: 'image/*' } })
    if (response.status < 300 || response.status >= 400 || redirect === MAX_REDIRECTS) return response
    const location = response.headers.get('location')
    if (location === null || location === '') return response
    await response.body?.cancel?.()
    current = await resolvePublicHttpUrl(new URL(location, current).href)
  }
  throw new Error('image-redirect-limit')
}

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

async function download(urls: string[], maxBytes: number): Promise<InboundImage[]> {
  const images: InboundImage[] = []
  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    timer.unref?.()
    try {
      const response = await fetchImage(url, maxBytes, controller.signal)
      if (response.ok !== true) continue
      const buffer = await readBounded(response, maxBytes)
      const mediaType = sniffImageType(buffer)
      if (buffer.byteLength === 0 || mediaType === null) continue
      images.push({ mediaType, data: buffer.toString('base64') })
    } catch {
      // A broken/unsafe image is omitted; the text still goes through.
    } finally {
      clearTimeout(timer)
    }
  }
  return images
}

export async function downloadImagePlan(plan: ImagePlan, maxBytes: number): Promise<ImageBucket> {
  return {
    current: await download(plan.current, maxBytes),
    quoted: await download(plan.quoted, maxBytes),
    background: await download(plan.background, maxBytes),
  }
}

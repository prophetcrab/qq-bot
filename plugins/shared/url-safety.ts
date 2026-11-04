/** URL/address safety for image downloads coming from group messages. */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home', '.lan']

/** IPv4 ranges that must never be fetched from an untrusted chat URL. */
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

/** Loopback, link-local, private, documentation and multicast addresses. */
export function isPrivateAddress(address: string): boolean {
  const value = String(address ?? '').trim().replace(/^\[|\]$/gu, '').toLowerCase()
  if (value === '') return true
  if (isIP(value) === 4) return isPrivateIPv4(value)
  if (isIP(value) !== 6) return true
  if (value === '::' || value === '::1') return true
  // Block IPv4-mapped IPv6 entirely. This closes the hex form (::ffff:7f00:1)
  // that cannot be fed directly to the IPv4 parser.
  if (value.includes('::ffff:')) return true
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (value.startsWith('2001:db8:')) return true
  return false
}

/** Reject hostnames that are local/reserved even if DNS is unavailable. */
export function isBlockedHostname(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/u, '')
  if (host === '' || host === 'localhost') return true
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

type LookupHost = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string }>>

/**
 * Resolve an untrusted URL and require every DNS answer to be public.
 * Returns the normalized URL. Call this again for every redirect hop.
 */
export async function resolvePublicHttpUrl(
  raw: string,
  lookupHost: LookupHost = lookup as LookupHost,
): Promise<URL> {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error('invalid-image-url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported-image-protocol')
  if (url.username !== '' || url.password !== '') throw new Error('image-url-credentials')
  if (url.port !== '' && url.port !== '80' && url.port !== '443') throw new Error('image-url-port')
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  if (isBlockedHostname(hostname)) throw new Error('image-url-local-host')
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new Error('image-url-private-address')
    return url
  }
  const answers = await lookupHost(hostname, { all: true, verbatim: true })
  const list = Array.isArray(answers) ? answers : []
  if (list.length === 0) throw new Error('image-url-no-dns')
  if (list.some((answer) => isPrivateAddress(String(answer.address ?? '')))) {
    throw new Error('image-url-private-address')
  }
  return url
}

/** Detect the actual image type from magic bytes; do not trust headers alone. */
export function sniffImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { downloadImageUrls } from '../plugins/ai-chat/media.ts'
import { isPrivateAddress, isPrivateIPv4, resolvePublicHttpUrl, sniffImageType } from '../plugins/ai-chat/url-safety.ts'

const CONFIG = { imageLimit: 4, imageMaxBytes: 1024 * 1024 } as any
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('url safety: private IPv4/IPv6 ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '172.16.1.1', '192.168.1.1', '169.254.1.1', '::1', '::ffff:7f00:1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(address), true, address)
  }
  assert.equal(isPrivateIPv4('93.184.216.34'), false)
  assert.equal(isPrivateAddress('93.184.216.34'), false)
})

test('url safety: local hosts, credentials and non-image ports are rejected', async () => {
  await assert.rejects(() => resolvePublicHttpUrl('http://127.0.0.1/a.png'))
  await assert.rejects(() => resolvePublicHttpUrl('http://localhost/a.png'))
  await assert.rejects(() => resolvePublicHttpUrl('http://user:pass@example.com/a.png'))
  await assert.rejects(() => resolvePublicHttpUrl('http://93.184.216.34:8080/a.png'))
  await assert.rejects(() => resolvePublicHttpUrl('https://private.example/a.png', async () => [{ address: '10.0.0.3', family: 4 }]))
  const url = await resolvePublicHttpUrl('https://93.184.216.34/a.png')
  assert.equal(url.hostname, '93.184.216.34')
})

test('url safety: image type is decided by magic bytes', () => {
  assert.equal(sniffImageType(PNG), 'image/png')
  assert.equal(sniffImageType(Buffer.from('not an image')), null)
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg')
})

test('downloadImageUrls: never fetches private URLs or accepts non-images', async () => {
  const hits: string[] = []
  const fakeFetch = (async (url: string) => {
    hits.push(String(url))
    return { ok: true, status: 200, headers: { get: () => null }, body: null, arrayBuffer: async () => Buffer.from('not an image') }
  }) as any
  const images = await downloadImageUrls(['http://127.0.0.1/a.png', 'https://93.184.216.34/a.png'], CONFIG, fakeFetch)
  assert.deepEqual(hits, ['https://93.184.216.34/a.png'])
  assert.deepEqual(images, [])
})

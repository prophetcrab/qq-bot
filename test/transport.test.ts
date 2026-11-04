import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DshTransport } from '../plugins/group-listener/transport.ts'

test('DshTransport aborts a stalled request within its configured timeout', async () => {
  const original = globalThis.fetch
  let aborted = false
  globalThis.fetch = ((_: any, init: any) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
  })) as typeof fetch
  try {
    const transport = new DshTransport({ endpoint: 'http://127.0.0.1:49605', discoveryFile: '', timeoutMs: 5000 })
    const started = Date.now()
    const result = await transport.post('/slow', {})
    assert.equal(result.ok, false)
    assert.equal(aborted, true)
    assert.ok(Date.now() - started < 10000)
  } finally {
    globalThis.fetch = original
  }
})

test('DshTransport follows a rewritten discovery endpoint', async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-transport-'))
  const discovery = join(dir, 'ai.json')
  const makeServer = async (name: string) => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, name })) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    return { server, endpoint: `http://127.0.0.1:${address.port}/qqbot/ai/chat` }
  }
  const first = await makeServer('first')
  const second = await makeServer('second')
  try {
    await writeFile(discovery, JSON.stringify({ endpoint: first.endpoint }), 'utf8')
    const transport = new DshTransport({ endpoint: '', discoveryFile: discovery, timeoutMs: 5000 })
    assert.equal((await transport.post('/qqbot/group/compose', {})).name, 'first')
    await writeFile(discovery, JSON.stringify({ endpoint: second.endpoint }), 'utf8')
    assert.equal((await transport.post('/qqbot/group/compose', {})).name, 'second')
  } finally {
    await new Promise<void>((resolve) => first.server.close(() => resolve()))
    await new Promise<void>((resolve) => second.server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

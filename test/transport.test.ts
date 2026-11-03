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

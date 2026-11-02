import assert from 'node:assert/strict'
import { test } from 'node:test'
import { directFallbackText, ensureDirectSpeak } from '../plugins/group-listener/index.ts'

test('direct triggers force a spoken result even when analysis says no', () => {
  const forced = ensureDirectSpeak('mention', { enabled: false })
  assert.equal(forced.enabled, true)
  assert.equal(forced.kind, 'statement')
  const reply = ensureDirectSpeak('reply', { enabled: true, kind: 'reply', replyType: 'action', target: { messageIds: [], userIds: ['1'] } })
  assert.equal(reply.replyType, 'normal')
  assert.equal(ensureDirectSpeak('count', { enabled: false }).enabled, false)
  assert.equal(directFallbackText('mention'), '我在，怎么了？')
  assert.equal(directFallbackText('count'), '')
})

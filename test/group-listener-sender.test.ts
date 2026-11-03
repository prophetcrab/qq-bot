import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendReply } from '../plugins/group-listener/sender.ts'

const timing = { firstMinDelayMs: 0, firstMaxDelayMs: 0, minDelayMs: 0, maxDelayMs: 0 }

test('action sends OneBot send_poke and no text bubbles', async () => {
  const calls: any[] = []
  const session: any = {
    guildId: '725042903',
    bot: { internal: { _request: async (action: string, params: any) => { calls.push({ action, params }); return { retcode: 0, data: null } } } },
  }
  const result = await sendReply({ loopId: 'l1', session } as any, {
    replyType: 'action', target: { messageIds: [], userIds: ['3090495044'] },
  }, [], timing)
  assert.equal(result.sent, true)
  assert.equal(result.parts, 0)
  assert.deepEqual(calls[0], { action: 'send_poke', params: { group_id: 725042903, user_id: 3090495044 } })
})

test('action reports a failed poke without falling back to text', async () => {
  const session: any = { guildId: '725042903', bot: { internal: { _request: async () => ({ retcode: 1404, wording: 'not found' }) } } }
  const result = await sendReply({ loopId: 'l1', session } as any, {
    replyType: 'action', target: { messageIds: [], userIds: ['3090495044'] },
  }, [], timing)
  assert.equal(result.sent, false)
  assert.match(result.error ?? '', /not found/u)
})

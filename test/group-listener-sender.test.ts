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


test('at delivery can quote an earlier focus message', async () => {
  const sent: any[] = []
  const session: any = { guildId: 'g1', send: async (content: any) => { sent.push(content) }, bot: { internal: { _request: async () => ({ retcode: 0 }) } } }
  const result = await sendReply({ loopId: 'l1', session } as any, {
    replyType: 'at', target: { messageIds: ['m1'], userIds: ['20000'] }, quote: { messageIds: ['m0'], userIds: [] },
  }, ['你好'], timing)
  assert.equal(result.sent, true)
  assert.match(sent[0], /<at id="20000"\/><quote id="m0"\/>你好/u)
})

test('at delivery strips a model-written leading @mention instead of doubling it', async () => {
  const sent: any[] = []
  const session: any = { guildId: 'g1', send: async (content: any) => { sent.push(content) }, bot: { internal: { _request: async () => ({ retcode: 0 }) } } }
  await sendReply({ loopId: 'l2', session } as any, {
    replyType: 'at', target: { messageIds: ['m1'], userIds: ['20000'] },
  }, ['@螃蟹MKII 你艾特的不是我啊'], timing)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /^<at id="20000"\/>你艾特的不是我啊$/u)
  assert.doesNotMatch(sent[0], /@螃蟹MKII/u)
})

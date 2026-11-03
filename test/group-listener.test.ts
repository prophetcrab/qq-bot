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

test('envelope normalization and participant extraction keep one unique sender', async () => {
  const { normalizeEnvelope, participantsOf } = await import('../plugins/group-listener/envelope.ts')
  const session = (id: string, qq: string, text: string): any => ({
    messageId: id,
    userId: qq,
    username: `user${qq}`,
    guildId: 'g1',
    content: text,
    elements: [{ type: 'text', attrs: { content: text } }],
    event: { sender: { user_id: qq, nickname: `昵称${qq}` }, time: 1790000000 },
  })
  const one = normalizeEnvelope(session('m1', '20000', 'hello'), 'g1')
  const two = normalizeEnvelope(session('m2', '20000', 'again'), 'g1')
  assert.equal(one.sender.qq, '20000')
  assert.equal(one.sender.nickname, '昵称20000')
  assert.deepEqual(participantsOf([one, two]), [{ qq: '20000', nickname: '昵称20000' }])
})

test('group queue merges direct requests and keeps one normal request', async () => {
  const { createGroupState, enqueueDirect, enqueueNormal, materialSnapshot, takeItem } = await import('../plugins/group-listener/queue.ts')
  const group = createGroupState(5)
  enqueueNormal(group, 'm1', { guildId: 'g1' }, 'count')
  enqueueDirect(group, 'm2', { guildId: 'g1' }, 'mention')
  enqueueDirect(group, 'm3', { guildId: 'g1' }, 'reply')
  const item = group.queue.urgent
  if (item === null) throw new Error('urgent queue missing')
  assert.equal(item.triggerMessageIds.length, 2)
  assert.equal(group.queue.normal, null)
  takeItem(group, item)
  assert.equal(group.queue.urgent, null)
  const snapshot = materialSnapshot(group, item, 100)
  assert.equal(snapshot.count, 0)
})

test('group name resolver caches OneBot group names', async () => {
  const { GroupNameResolver } = await import('../plugins/group-listener/group-names.ts')
  const { createGroupState } = await import('../plugins/group-listener/queue.ts')
  const resolver = new GroupNameResolver()
  const groups = new Map([['g1', createGroupState(5)]])
  const bot = { internal: { getGroupList: async () => [{ group_id: 'g1', group_name: '测试群' }] } }
  assert.equal(await resolver.fill(groups, bot), true)
  const state = groups.get('g1')
  if (state === undefined) throw new Error('group missing')
  assert.equal(state.name, '测试群')
  assert.equal(await resolver.resolve(bot, 'g1'), '测试群')
})


test('count threshold is randomized inside the configured range', async () => {
  const { randomCountThreshold } = await import('../plugins/group-listener/queue.ts')
  assert.equal(randomCountThreshold(3, 10, () => 0), 3)
  assert.equal(randomCountThreshold(3, 10, () => 0.999999), 10)
  for (let i = 0; i < 100; i += 1) {
    const value = randomCountThreshold(3, 10)
    assert.ok(value >= 3 && value <= 10, `out of range: ${value}`)
  }
})

test('image plan covers current, quote and recent background images', async () => {
  const { collectImagePlan } = await import('../plugins/group-listener/images.ts')
  const session = {
    elements: [{ type: 'image', attrs: { src: 'https://93.184.216.34/current.png' } }],
    quote: { elements: [{ type: 'image', attrs: { src: 'https://93.184.216.34/quote.png' } }] },
  }
  const buffer: any[] = [{
    id: 'm1', groupId: 'g1', sender: { qq: '20000', nickname: '小明' }, sentAt: { iso: '', unix: 0 }, receivedAt: '',
    content: { text: '', quote: null, forward: null, attachments: [{ type: 'image', summary: '图片', url: 'https://93.184.216.34/background.png' }] },
  }]
  const plan = collectImagePlan(session, buffer, 4)
  assert.deepEqual(plan.current, ['https://93.184.216.34/current.png'])
  assert.deepEqual(plan.quoted, ['https://93.184.216.34/quote.png'])
  assert.deepEqual(plan.background, ['https://93.184.216.34/background.png'])
})

test('image plan downloads a magic-byte checked image', async () => {
  const { downloadImagePlan } = await import('../plugins/group-listener/images.ts')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } })) as typeof fetch
  try {
    const result = await downloadImagePlan({ current: ['https://93.184.216.34/pic.png'], quoted: [], background: [] }, 1024 * 1024)
    assert.equal(result.current.length, 1)
    assert.equal(result.current[0].mediaType, 'image/png')
    assert.ok(result.current[0].data.length > 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

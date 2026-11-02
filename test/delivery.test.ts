import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseReplyMode, replyDelayMs, segmentDelayMs, segmentReply } from '../plugins/ai-chat/delivery.ts'

test('chooseReplyMode: questions prefer normal, casual chat often short/casual', () => {
  assert.equal(chooseReplyMode({ question: true }, () => 0.1), 'normal')
  assert.equal(chooseReplyMode({ images: true }, () => 0.6), 'casual')
  assert.equal(chooseReplyMode({}, () => 0.1), 'short')
  assert.equal(chooseReplyMode({}, () => 0.5), 'casual')
  assert.equal(chooseReplyMode({}, () => 0.8), 'reaction')
  assert.equal(chooseReplyMode({}, () => 0.95), 'normal')
})

test('segmentReply: long text always splits, short reactions stay one bubble', () => {
  const long = segmentReply('a'.repeat(2500), 'normal', 1000)
  assert.ok(long.length > 1)
  assert.deepEqual(segmentReply('热死了', 'reaction', 1000, () => 0), ['热死了'])
  const casual = segmentReply('今天真的好热呀。鱼鱼已经快化了。要不要一起喝冰水？', 'casual', 1200, () => 0)
  assert.equal(casual.length, 2)
  assert.ok(casual[0].includes('好热'))
  assert.ok(casual[1].includes('冰水'))
})

test('reply delay: bounded and longer for fuller replies', () => {
  const short = replyDelayMs('short', '嗯', () => 0)
  const normal = replyDelayMs('normal', '这是一段更长的回复内容'.repeat(5), () => 0)
  assert.ok(short >= 300)
  assert.ok(normal > short)
  assert.ok(normal <= 2400)
  assert.ok(segmentDelayMs(() => 0) >= 260)
})

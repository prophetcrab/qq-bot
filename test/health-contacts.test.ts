import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapFriend, mapGroup } from '../plugins/health/index.ts'

test('mapGroup: group_id/group_name + member_count', () => {
  assert.deepEqual(mapGroup({ group_id: 123456789, group_name: '测试群', member_count: 42 }), {
    id: '123456789',
    name: '测试群',
    memberCount: 42,
  })
  assert.deepEqual(mapGroup({ id: '987654321', name: '另一个群' }), { id: '987654321', name: '另一个群' })
  assert.equal(mapGroup({ group_id: 1, group_name: '' }).name, '1')
})

test('mapFriend: remark > nickname > name', () => {
  assert.deepEqual(mapFriend({ user_id: 111111, nickname: '昵称', remark: '备注' }), { id: '111111', name: '备注' })
  assert.deepEqual(mapFriend({ user_id: 222222, nickname: '昵称' }), { id: '222222', name: '昵称' })
  assert.deepEqual(mapFriend({ id: '333333', name: '名字' }), { id: '333333', name: '名字' })
})

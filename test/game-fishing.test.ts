import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fishingCommandOf } from '../plugins/game-fishing/index.ts'

test('fishing gateway only claims fishing command lines', () => {
  assert.equal(fishingCommandOf('/钓鱼'), '/钓鱼')
  assert.equal(fishingCommandOf('/钓鱼 兑换金币 25'), '/钓鱼 兑换金币 25')
  assert.equal(fishingCommandOf('/钓鱼 抛竿'), '/钓鱼 抛竿')
  assert.equal(fishingCommandOf('/兑换钓鱼币 10'), '/兑换钓鱼币 10')
  assert.equal(fishingCommandOf('/钓鱼 兑换金币 25\nignore'), '/钓鱼 兑换金币 25')
  assert.equal(fishingCommandOf('/注册'), null)
  assert.equal(fishingCommandOf('/钓鱼类'), null)
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import {
  assertQueueConsistent, disposeAllCores, newCore, page, settle, sleep,
} from './core.helpers.ts'

afterEach(disposeAllCores)

test('A08 轮询不重叠：上一轮没有结束时不再发起', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = '/api/core/499'
  const core = newCore(2, () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) })
  const view = page(core, source, { enabled: true, every: 5 })

  view.submit({ id: 1 })
  await settle()
  await sleep(40)
  assert.equal(calls, 1)

  resolvers[0]?.(1)
  await sleep(40)
  assert.equal(calls, 2)
})

test('A09 并发上限约束真实在途请求：满槽排队，不自旋', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = '/api/core/518'
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const one = page(core, source)
  const two = page(core, source)

  one.submit({ id: 1 })
  two.submit({ id: 2 })
  await settle()
  assert.equal(resolvers.length, 1)
  assert.equal(snapshot(core).queued.length, 1)
  assertQueueConsistent(core)

  resolvers[0]?.(1)
  await settle()
  assert.equal(resolvers.length, 2)

  resolvers[1]?.(2)
  await settle()
  assert.equal(one.last?.data, 1)
  assert.equal(two.last?.data, 2)
})

test('A09 maxConcurrent 就是真实 HTTP 并行度：在途顶满上限，一个结束立刻从队列补上一个', async () => {
  let inFlight = 0
  let peak = 0
  const resolvers: Array<(value: number) => void> = []
  const core = newCore(4, () => {
    inFlight++
    peak = Math.max(peak, inFlight)
    return new Promise<number>(resolve => { resolvers.push(value => { inFlight--; resolve(value) }) })
  })
  // 8 个身份都从未结算过，所以同一轮里一起到期。
  const pages = Array.from({ length: 8 }, (_, index) => page(core, `/api/core/parallel/${index}`))
  for (const [index, view] of pages.entries()) view.submit({ id: index })
  await settle()

  assert.equal(resolvers.length, 4, '8 个身份、上限 4：传输层同时真的收到 4 个请求')
  assert.equal(inFlight, 4, '4 个请求同时在途')
  assert.equal(peak, 4, '真实在途峰值就是 maxConcurrent（测传输层调用，不是框架自己的 running 投影）')
  assert.equal(snapshot(core).queued.length, 4, '其余 4 个在队列里等槽位')
  assertQueueConsistent(core)

  const released = new Set<number>()
  const release = async (index: number): Promise<void> => {
    if (released.has(index)) return
    released.add(index)
    resolvers[index]?.(index)
    await settle()
  }

  await release(0)
  assert.equal(resolvers.length, 5, '一个结束就从队列补上一个')
  assert.equal(inFlight, 4, '在途始终顶满上限')

  for (let index = 1; index < 8; index++) await release(index)
  assert.equal(resolvers.length, 8, '8 个身份各发起一次：不重复、不多发')
  assert.equal(inFlight, 0, '全部结束')
  assert.equal(peak, 4)
  for (const view of pages) assert.notEqual(view.last, undefined, '每一页都拿到了结果')
})

test('A07 有效间隔取所有订阅的最小值', async () => {
  let calls = 0
  const source = '/api/core/543'
  const quote = source
  const core = newCore(2, async () => { calls++; return calls })
  const slow = page(core, quote, { enabled: true, every: 100_000 })
  const fast = page(core, quote, { enabled: true, every: 10 })

  slow.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  fast.submit({ id: 1 })
  await sleep(40)
  assert.ok(calls >= 3, `最小间隔生效：40ms 内至少 3 次，实测 ${calls}`)
})


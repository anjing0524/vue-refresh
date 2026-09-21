import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import { declared, disposeAllCores, eligible, newCore, page, settle, sleep, tableOf, type FakePost, type Page } from './core.helpers.ts'

afterEach(disposeAllCores)

test('A04/A06 失去环境（浏览器隐藏与组件失活由适配层合成同一个 present）只失去资格：要求被撤销、声明与在途都留着', async () => {
  let calls = 0
  const source = '/api/core/297'
  const core = newCore(2, () => { calls++; return new Promise<number>(() => {}) })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()
  assert.equal(snapshot(core).resources.length, 1, '声明让实例留在册')

  view.set({ present: false })
  await settle()
  assert.equal(eligible(core, view), false, '环境不允许即失去读者身份')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(snapshot(core).resources.length, 1, '失去环境只失去资格：实例与在途都留着（ADR-61）')

  view.refresh()
  await settle()
  assert.equal(snapshot(core).resources.length, 1, '失去环境期间刷新不新建实例')
  assert.equal(calls, 1, '失去环境期间刷新不发请求（入口闸：配置有效且环境允许）')
})

test('A06 组件失活只失去资格：点过的那次刷新继续等当前请求，声明与实例都留着', async () => {
  const source = '/api/core/318'
  const core = newCore(2, () => new Promise<number>(() => {}))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  view.set({ present: false })
  await settle()
  assert.equal(eligible(core, view), false, '失活即失去读者身份')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(snapshot(core).resources.length, 1, '失活只失去资格：当前请求仍在跑，实例不释放')
})

test('A06 最后一个声明者退出（卸载）：在途请求被 abort，实例与结果一并消失', async () => {
  let signal: AbortSignal | undefined
  let finish: ((value: number) => void) | undefined
  const source = '/api/core/334'
  const core = newCore(2, (_url, _body, context) => {
    signal = context.signal
    return new Promise<number>(resolve => { finish = resolve })
  })
  const quote = source
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  assert.equal(signal?.aborted, false)

  core.undeclare(view.config)
  assert.equal(signal?.aborted, true)
  assert.equal(snapshot(core).resources.length, 0)
  // 实例没了，但那次请求还在跑：它仍占着并发账本（`abandoned`），直到真实结束自己交还（ADR-65）。
  assert.equal(snapshot(core).running.length, 1, '被弃的在途请求继续占着槽位')
  assert.equal(snapshot(core).queued.length, 0)

  finish?.(9)
  await settle()
  assert.equal(snapshot(core).running.length, 0, '真实结束后交还槽位')
})

test('A06 刷新不留账：刷新之后立刻卸载，实例当场回收，不等这一轮的结果', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = '/api/core/901'
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  resolvers[0]?.(1) // 第一轮结束，实例空闲
  await settle()
  view.refresh() // 刷新发起第二轮：旧口径里它是一张欠条，会让实例活到结算为止
  await settle()
  assert.equal(snapshot(core).running.length, 1, '刷新已经发起第二轮取数')

  core.undeclare(view.config)
  assert.equal(snapshot(core).resources.length, 0, '刷新不留账：卸载当场回收实例')
  assert.equal(snapshot(core).running.length, 1, '在途请求仍占着槽位，直到真实结束')
  resolvers[1]?.(2)
  await settle()
  assert.equal(snapshot(core).running.length, 0, '真实结束后交还槽位')
  assert.equal(snapshot(core).results.length, 0, '实例已经回收：迟到的结果写不进表')
})

test('A06/A13 释放之后那次请求才失败：迟到的失败不写进已释放身份的那一格', async () => {
  let fail: ((error: Error) => void) | undefined
  const source = '/api/core/412'
  const core = newCore(2, () => new Promise<number>((_resolve, reject) => { fail = reject }))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  assert.equal(snapshot(core).running.length, 1, '请求已经发出')

  // 释放：实例与结果一并回收；那次请求还在跑，稍后才失败。
  core.undeclare(view.config)
  assert.equal(snapshot(core).results.length, 0)

  fail?.(new Error('晚到的失败'))
  await settle()
  assert.equal(snapshot(core).running.length, 0, '真实结束后交还槽位')
  assert.equal(snapshot(core).results.length, 0, '迟到的失败同样不写表：那一格已经随实例释放')
})

test('A12/A06 复制结果期间换了执行：旧执行的结果不写进结果表（复制会读属性，取值器可能同步重入）', async () => {
  let release: (() => void) | undefined
  const source = '/api/core/413'
  let view!: Page
  const core = newCore(2, () => new Promise<unknown>(resolve => {
    // 响应对象的取值器在复制结果那一步被读到，那一刻同步释放这个身份。
    release = () => { resolve({ get id() { core.undeclare(view.config); return 1 } }) }
  }))
  view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  assert.equal(snapshot(core).running.length, 1, '请求已经发出')

  release?.()
  await settle()
  assert.equal(snapshot(core).running.length, 0, '真实结束后交还槽位')
  assert.equal(snapshot(core).results.length, 0, '复制期间丢掉的执行：结果不写进结果表')
})


test('A06/A11 恢复：实例还在就立即读到历史结果，不重复取数；最后一个声明者退出则连实例一起销毁', async () => {
  let calls = 0
  const source = '/api/core/352'
  const core = newCore(2, async () => { calls++; return calls })
  const quote = source
  const view = page(core, quote)
  const other = page(core, quote)

  view.submit({ id: 1 })
  other.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ present: false })
  await settle()
  const written = view.writes()
  view.set({ present: true })
  await settle()
  assert.equal(view.writes(), written, '恢复不产生新的写入：读的是结果表里已有的那份')
  assert.equal(view.last?.data, 1)
  assert.equal(calls, 1, '恢复读到历史结果，不重复取数')

  core.undeclare(view.config)
  core.undeclare(other.config)
  assert.equal(snapshot(core).resources.length, 0, '最后一个需求退出后实例与结果一起消失')
})

test('A07 长时间挂起后恢复只取一次，不补跑漏掉的周期', async () => {
  let calls = 0
  const source = '/api/core/379'
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source, { enabled: true, every: 30 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ present: false })
  await sleep(200)
  view.set({ present: true })
  await settle()
  assert.equal(calls, 2, '恢复只取一次，不按漏掉的周期补跑')

  view.set({ present: false })
})

test('A06/A17 写表时的同步重入里刷新并卸载：释放之后不再补一轮，身份不会被复活重取', async () => {
  let calls = 0
  const resolvers: Array<(value: number) => void> = []
  const source = '/api/core/692'
  const core = newCore(1, () => {
    calls++
    return new Promise<number>(resolve => resolvers.push(resolve))
  })
  const view = page(core, source)
  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  // 写表会同步触发页面代码：这一瞬页面点了一次刷新，然后当场卸载。
  tableOf(core).onWrite = () => {
    view.refresh()
    core.undeclare(view.config)
  }
  resolvers[0]?.(1)
  await settle()

  assert.equal(calls, 1, '释放之后不再补一轮：已释放的身份不该被重新取数')
  assert.equal(snapshot(core).resources.length, 0, '实例已回收')
  assert.equal(snapshot(core).queued.length, 0, '队列里不留下已释放的实例')
  assert.equal(snapshot(core).running.length, 0, '在途归零')
  assert.equal(core.readResult(source, '1'), undefined, '结果表条目也没有被写回来')
})

test('A04/A17 两个协调者互不共享：同 Source 同参数各自取数', async () => {
  let calls = 0
  const source = '/api/core/607'
  const quote = source
  const post: FakePost = async () => { calls++; return calls }
  const first = newCore(1, post)
  const second = newCore(1, post)
  const left = page(first, quote)
  const right = page(second, quote)

  left.submit({ id: 1 })
  right.submit({ id: 1 })
  await settle()

  assert.equal(calls, 2)
  assert.equal(left.last?.data, 1)
  assert.equal(right.last?.data, 2)
})

test('A17 销毁：幂等，之后所有入口都不产生事实，未结束的执行不再写事实', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = '/api/core/653'
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  core.dispose()
  assert.equal(core.isDisposed(), true)
  assert.equal(snapshot(core).resources.flatMap(resource => [...resource.declarers]).length, 0,
    '销毁只动自己的名册：没有任何页面回调参与')
  assert.deepEqual(view.submit({ id: 2 }), { status: 'cancelled' })
  view.refresh()
  const empty = snapshot(core)
  // 备注：`declarers`／`scheduled`／`flushing` 三个投影已随 ADR-74 从观测面删除（`snapshot()` 只剩四个
  // 字段）。「销毁后没有残留唤醒 Timer」这条观测随之消失——它由 `dispose` 自己的清理保证（见 DESIGN §4.2）。
  assert.deepEqual([
    empty.resources.flatMap(resource => [...resource.declarers]).length,
    empty.resources.length,
    empty.queued.length,
  ], [0, 0, 0])

  const delivered = view.writes()
  resolvers[0]?.(9)
  await settle()
  assert.equal(view.writes(), delivered, '迟到的结束不再写任何事实')
  assert.equal(snapshot(core).running.length, 0, '未结束的执行到真实结束才释放槽位')
  core.dispose()
})

test('A04/A05 配置非法时不取数、不刷新、不通知；声明仍在，修正后按到期恢复', async () => {
  const source = '/api/core/684'
  const core = newCore(2, async () => 1)
  const view = page(core, source, null)

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()
  assert.equal(eligible(core, view), false, '配置非法：没有资格，不算读者')
  assert.equal(snapshot(core).resources.length, 1, '身份已声明（实例在册），但不取数')
  assert.equal(view.writes(), 0)

  view.refresh()
  assert.equal(view.failedAt(), null, '配置非法不取数自然也不会写失败：页面读自己的 refs 就知道')
})

test('A04/A05 配置由合法转非法时整组失效：资格立即为假，槽内不残留合法旧值', async () => {
  const source = '/api/core/685'
  const core = newCore(1, async () => 1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  assert.equal(view.writes(), 1)
  assert.equal(eligible(core, view), true)

  // 先合法、后非法：非法分支必须整组置无效——只清 `every` 也能让资格为假，
  // 但留着 `enabled`／`present` 的合法旧值会让下一拍读槽的人误判「这三项曾同时成立」。
  view.set(null)
  assert.equal(view.config.enabled, false)
  assert.equal(view.config.every, null)
  assert.equal(view.config.present, false)
  assert.equal(eligible(core, view), false, '非法那一拍资格必须为假')
})

test('A06/A09 失去资格只挡新入队：已经排上的那次取数照常走完', async () => {
  const started: number[] = []
  const resolvers: Array<() => void> = []
  const core = newCore(1, async (_url, body) => {
    started.push((body as { id: number }).id)
    await new Promise<void>(resolve => { resolvers.push(resolve) })
    return (body as { id: number }).id
  })
  const source = '/api/core/602'
  const first = page(core, source)
  const second = page(core, source)
  first.submit({ id: 1 })
  second.submit({ id: 2 })
  await settle()
  assert.deepEqual(started, [1], '一号在途、二号在队（并发上限 1）')

  // 两页同时失去环境（＝ 浏览器隐藏）：资格只在入队时判定，已经排上的那次照常走完。
  first.set({ present: false })
  second.set({ present: false })
  await settle()
  assert.deepEqual(started, [1], '失去资格期间不新入队、也不提前启动')
  resolvers[0]?.()
  await settle()
  assert.deepEqual(started, [1, 2], '槽位空出后，队列里那一次照常发出')
  resolvers[1]?.()
  await settle()
  core.dispose()
})

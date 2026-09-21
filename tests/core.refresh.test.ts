import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import {
  declared, disposeAllCores, eligible, newCore, page, settle, sleep, tableOf,
} from './core.helpers.ts'

afterEach(disposeAllCores)

test('A14 在途任务直接满足本次刷新：不追发第二次', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = '/api/core/186'
  const core = newCore(2, () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()
  assert.equal(calls, 1, '有请求就直接用它，不再发第二次')

  resolvers[0]?.(100)
  await settle()
  assert.equal(resolvers.length, 1, '在途任务直接满足本次刷新，不追发后继请求')
  assert.equal(view.last?.data, 100, '刷新拿到的就是这次请求的结果')
})

test('A14 排队未启动的任务同样直接满足本次刷新', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = '/api/core/207'
  const core = newCore(1, () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) })
  const blocker = page(core, source)
  const view = page(core, source)

  blocker.submit({ id: 1 })
  await settle()
  view.submit({ id: 2 })
  await settle()
  assert.equal(calls, 1, '槽位被第一个身份占满，第二个排队')

  view.refresh()
  resolvers[0]?.(1)
  await settle()

  assert.equal(calls, 2)
  resolvers[1]?.(2)
  await settle()
  assert.equal(view.last?.data, 2)
})

test('A12 结果写入期间换了身份的页面不再由这一次结果满足：写入点与订阅者同口径复核', async () => {
  let calls = 0
  const source = '/api/core/233'
  const core = newCore(2, async (_url, body) => { calls++; return (body as { id: number }).id })
  const paused = page(core, source, { enabled: false, every: 100_000 })
  const watcher = page(core, source)
  // 结果写入的那一刻页面代码同步重入：把暂停页换成另一个身份，这一页当场与新身份绑定。
  tableOf(core).onWrite = () => { paused.submit({ id: 2 }) }

  watcher.submit({ id: 1 })
  paused.submit({ id: 1 })
  paused.refresh()
  await settle()

  assert.equal(calls, 1, '暂停页点过的那次刷新由这一个在途请求满足，不追发第二次')
  assert.equal(watcher.writes(), 1)
  assert.equal(paused.writes(), 0, '要求已在结果写入期间被撤销，这一次结果不再轮到它')
})

test('A12/A14 结果写入期间点的刷新由后继请求满足，同一轮内合并成一次', async () => {
  let calls = 0
  let asked = false
  const source = '/api/core/254'
  const core = newCore(2, async () => { calls++; return calls })
  const paused = page(core, source, { enabled: false, every: 100_000 })
  const watcher = page(core, source)
  // 结果写入的那一刻点刷新（点两次）：这一轮已经产出，所以要的是下一轮——同一轮里点几次只补一次。
  tableOf(core).onWrite = () => { if (asked) return; asked = true; paused.refresh(); paused.refresh() }

  watcher.submit({ id: 1 })
  paused.submit({ id: 1 })
  await settle()

  assert.equal(calls, 2, '产出之后点的刷新由后继请求满足，同一轮内合并成一次')
  assert.equal(paused.last?.data, 2, '暂停页拿到的是后继请求的结果')
  assert.equal(watcher.writes(), 2, '订阅页两次写入都读到')
})

test('A12 产出之后的刷新是下一轮的命令：页面每收一次结果就点一次，框架就一直取下去', async () => {
  let calls = 0
  let asks = 0
  const source = '/api/core/903'
  const core = newCore(2, async () => { calls++; return calls })
  const paused = page(core, source, { enabled: false, every: 100_000 })
  const watcher = page(core, source)
  // 页面在每次结果到达时都点刷新（一个自触发的循环）：前三次各补一轮，第四次停手。
  // 旧口径按页记欠条、重复点击被吃掉；新口径刷新是**给身份的命令**，核心不记是谁点的（ADR-70）。
  tableOf(core).onWrite = () => { if (asks >= 3) return; asks++; paused.refresh() }

  watcher.submit({ id: 1 })
  paused.submit({ id: 1 })
  await settle()
  assert.equal(calls, 4, '产出之后的每一次刷新都补一轮')

  await sleep(30)
  assert.equal(calls, 4, '页面停手就不再取：补的是命令，不是重试')
  assert.equal(paused.last?.data, 4)
})

test('A04/A05 关闭开启意愿后停止周期取数，但页面仍可显式刷新一次', async () => {
  let calls = 0
  const source = '/api/core/274'
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source, { enabled: true, every: 15 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ enabled: false, every: 100_000 })
  await settle()
  await sleep(40)
  assert.equal(calls, 1, '暂停后不再有周期请求')
  assert.equal(eligible(core, view), false, '暂停即失去读者身份（画面冻结）')
  assert.notEqual(declared(core, view), undefined, '声明还在：实例与结果都不回收')

  view.refresh()
  await settle()
  assert.equal(calls, 2, '暂停页仍可刷新一次')
  await sleep(40)
  assert.equal(calls, 2, '刷新不会把暂停页变回订阅')
})

test('A05 暂停只失去资格：已点过的那次刷新继续等当前请求的结果，声明、实例与结果都保留', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = '/api/core/398'
  const core = newCore(2, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  view.set({ enabled: false, every: 100_000 })
  await settle()
  // 暂停只失去「自动取数」的资格（读者身份与画面冻结是适配层的事，由 tests/vue.test.ts 的 A05 用例证明；
  // ADR-66 之后核心不再记「谁在等」，要求是身份级的一个位）。
  assert.equal(eligible(core, view), false, '暂停即失去取数资格')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(snapshot(core).resources.length, 1, '实例不释放、在途不取消')

  // 暂停不撤销已点过的那次刷新：它由当前这个请求的结果满足，既不另发一次也不必等下个周期。
  resolvers[0]?.(7)
  await settle()
  assert.equal(resolvers.length, 1, '暂停期间不追发请求，本次刷新用现有这一次')
  // 要求被这一次结果满足；但**声明还在**，所以实例与结果都不回收（ADR-61）：暂停/失活不再删结果。
  // 「画面冻结」与「恢复后读回」是适配层的事，由 tests/vue.test.ts 验证；核心这一层断言的是声明与结果表的事实。
  assert.equal(snapshot(core).results.length, 1, '声明还在：结果表条目保留（ADR-61）')
  assert.equal(view.last?.data, 7, '核心这一层：按身份仍能读到那一份结果')
  assert.equal(snapshot(core).resources.length, 1, '暂停不释放实例：声明还在')
})

test('A13/A14 在途时点的刷新由这一轮的结果回答：失败不自动重试，也不补第二次', async () => {
  const resolvers: Array<(value: number) => void> = []
  const rejecters: Array<(reason: unknown) => void> = []
  const source = '/api/core/445'
  const core = newCore(2, () => new Promise<number>((resolve, reject) => { resolvers.push(resolve); rejecters.push(reject) }))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  rejecters[0]?.(new Error('down'))
  await settle()
  assert.ok(view.failedAt(), '失败写进该身份那一格：刷新没有回执')
  assert.ok(eligible(core, view), '资格与开启意愿都保留')
  assert.equal(resolvers.length, 1, '失败不自动重试')
})

test('A13/A14 暂停页显式刷新失败：没有回执，失败写进该身份那一格等读取面取', async () => {
  const source = '/api/core/466'
  const core = newCore(2, async () => { throw new Error('down') })
  const paused = page(core, source, { enabled: false, every: 100_000 })

  paused.submit({ id: 1 })
  paused.refresh()
  await settle()

  assert.ok(paused.failedAt(), '未订阅页面按身份从结果表读到失败')
  assert.equal(paused.writes(), 0, '失败不写结果')
  assert.equal(snapshot(core).resources.length, 1, '失败不留账：声明还在，实例不释放')
})

test('A05/A14 未声明身份时刷新不产生请求也不通知', async () => {
  let calls = 0
  const source = '/api/core/698'
  const core = newCore(2, async () => { calls++; return 1 })
  const view = page(core, source)

  view.refresh()
  await settle()
  assert.equal(calls, 0)
  assert.equal(view.failedAt(), null, '页面自己知道还没有身份，不产生失败')
})


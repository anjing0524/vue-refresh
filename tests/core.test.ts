import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { RefreshCore } from '../src/core.ts'
import type { Config, Handle } from '../src/core.ts'
import { defineRefresh, prepareParameters } from '../src/source.ts'
import type { Parameters } from '../src/source.ts'
import { CancelReason, ErrorOrigin } from '../src/public-types.ts'
import type { RefreshDisplay, RefreshError, RefreshResult, RefreshSource, SubmitResult } from '../src/public-types.ts'

/** 每个用例结束时销毁核心：周期调度会留下唯一的唤醒 Timer，不销毁的话进程不会退出。 */
const cores: RefreshCore[] = []
function newCore(maxConcurrent: number): RefreshCore {
  const core = new RefreshCore(maxConcurrent)
  cores.push(core)
  return core
}
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose()
  mock.timers.reset()
})

/** 一页：句柄 ＋ 交付记录 ＋ 错误记录。与集成测试同一口径，直接驱动核心。 */
interface Page {
  readonly handle: Handle
  readonly published: RefreshDisplay<object, unknown>[]
  readonly errors: RefreshError[]
  readonly last: RefreshDisplay<object, unknown> | undefined
  submit(args: object): SubmitResult
  refresh(): Promise<RefreshResult>
  set(config: Config | null): void
}

function page(
  core: RefreshCore,
  source: RefreshSource<object, unknown>,
  config: Config | null = { enabled: true, every: 100_000 },
  hooks: { publish?: (value: RefreshDisplay<object, unknown>) => void; onError?: (error: RefreshError) => unknown } = {},
): Page {
  let current = config
  const published: RefreshDisplay<object, unknown>[] = []
  const errors: RefreshError[] = []
  const handle: Handle = {
    source,
    config: () => current,
    publish: value => { if (hooks.publish) hooks.publish(value); else published.push(value) },
    onError: error => { if (hooks.onError) return hooks.onError(error); errors.push(error) },
    cleanup: null,
    operationId: 0,
    parameters: null,
    subscription: null,
    active: false,
    disposed: false,
  }
  core.addHandle(handle)
  core.activate(handle)
  return {
    handle,
    published,
    errors,
    submit: args => core.submit(handle, (): Parameters => prepareParameters(args, source)),
    refresh: () => core.refresh(handle),
    set(next) { current = next; core.reconcile(handle) },
    get last() { return published.at(-1) },
  }
}

/** 让微任务与 0ms 定时器跑完（每个 `await` 一跳）。 */
const settle = async (rounds = 3): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => { setTimeout(resolve, 0) })
}

/** 只跑微任务，不依赖被伪造的定时器。 */
const micro = async (rounds = 8): Promise<void> => {
  for (let index = 0; index < rounds; index++) await Promise.resolve()
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

test('A01/A11 首次订阅立即取一次，并按整体发布交付参数、数据、来源与时间', async () => {
  const core = newCore(2)
  const source = defineRefresh<{ symbol: string }, number>({ load: async () => 7 })
  const quote = source
  const view = page(core, quote)

  assert.equal(view.submit({ symbol: 'A' }).status, 'accepted')
  await settle()

  assert.equal(view.published.length, 1)
  assert.deepEqual(view.last?.args, { symbol: 'A' })
  assert.equal(view.last?.data, 7)
  assert.equal(typeof view.last?.updatedAt, 'number')
  assert.equal(core.readSnapshot(quote, { symbol: 'A' }), 7)
})

test('A11/A02 同参数的两个组件共享同一次请求，各自拿到独立副本', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, { list: number[] }>({
    load: async () => { calls++; return { list: [1, 2] } },
  })
  const quote = source
  const core = newCore(2)
  const first = page(core, quote)
  const second = page(core, quote)

  first.submit({ id: 1 })
  second.submit({ id: 1 })
  await settle()

  assert.equal(calls, 1)
  assert.equal(first.published.length, 1)
  assert.equal(second.published.length, 1)

  // 改自己拿到的副本不影响共享实例，也不影响别人。
  const copy = first.last?.data as { list: number[] }
  copy.list.push(99)
  assert.deepEqual(core.readSnapshot(quote, { id: 1 }), { list: [1, 2] })
  assert.deepEqual(second.last?.data, { list: [1, 2] })
})

test('A02 身份是「Source 身份 ＋ 完整参数值」：字段顺序无关，数组顺序有关，不同参数各取一次', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number; tags: string[] }, number>({ load: async () => { calls++; return calls } })
  const quote = source
  const core = newCore(4)
  const first = page(core, quote)
  const second = page(core, quote)
  const third = page(core, quote)

  first.submit({ id: 1, tags: ['a', 'b'] })
  second.submit({ tags: ['a', 'b'], id: 1 })
  await settle()
  assert.equal(calls, 1, '字段顺序不同仍是同一个身份')

  third.submit({ id: 1, tags: ['b', 'a'] })
  await settle()
  assert.equal(calls, 2, '数组顺序影响身份')
})

test('A03 相同参数重复声明幂等：不新增请求、不重建订阅', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const subscription = view.handle.subscription

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()

  assert.equal(calls, 1)
  assert.equal(view.handle.subscription, subscription)
})

test('A03 参数被拒时返回 rejected，保留已有身份，并按 validation 通知（带声明代次）', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: async () => 1, validate: args => args.id > 0 })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const declared = view.handle.parameters
  const subscription = view.handle.subscription

  assert.equal(view.submit({ id: -1 }).status, 'rejected')
  assert.equal(view.handle.parameters, declared)
  assert.equal(view.handle.subscription, subscription)
  assert.equal(view.errors.at(-1)?.origin, 'validation')
  assert.equal(view.errors.at(-1)?.operationId, 2)
  // 校验失败不改动任何状态：旧身份仍然在后台继续取数。
  assert.equal(view.errors.length, 1)

  // 业务 validate 自己抛错时同样按 validation 拒绝：异常由提交边界收住，不冒泡到调用方。
  const throwing = defineRefresh<{ id: number }, number>({
    load: async () => 1,
    validate: () => { throw new Error('bad rule') },
  })
  const victim = page(core, throwing)
  assert.equal(victim.submit({ id: 1 }).status, 'rejected')
  assert.equal(victim.handle.parameters, null, '被拒的声明不改动状态')
  assert.equal(victim.errors.at(-1)?.origin, 'validation')
})

test('A14 在途任务直接满足本次刷新：不追发第二次，结算在交付之后', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({
    load: () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) },
  })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()
  assert.equal(calls, 1, '有请求就直接用它，不再发第二次')

  resolvers[0]?.(100)
  await settle()
  assert.equal(resolvers.length, 1, '在途任务直接结算本次刷新，不追发后继请求')
  assert.deepEqual(await refreshing, { status: 'success' })
  assert.equal(view.last?.data, 100, '结算在交付之后：返回 success 时本页 display 已是这次结果')
})

test('A14 排队未启动的任务同样直接满足本次刷新', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({
    load: () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) },
  })
  const core = newCore(1)
  const blocker = page(core, source)
  const view = page(core, source)

  blocker.submit({ id: 1 })
  await settle()
  view.submit({ id: 2 })
  await settle()
  assert.equal(calls, 1, '槽位被第一个身份占满，第二个排队')

  const refreshing = view.refresh()
  resolvers[0]?.(1)
  await settle()

  assert.equal(calls, 2)
  resolvers[1]?.(2)
  await settle()
  assert.deepEqual(await refreshing, { status: 'success' })
  assert.equal(view.last?.data, 2)
})

test('A04/A05 关闭开启意愿后停止周期取数，但页面仍可显式刷新一次', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const core = newCore(2)
  const view = page(core, source, { enabled: true, every: 15 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ enabled: false, every: 100_000 })
  await settle()
  await sleep(40)
  assert.equal(calls, 1, '暂停后不再有周期请求')
  assert.equal(view.handle.subscription, null)

  assert.deepEqual(await view.refresh(), { status: 'success' })
  assert.equal(calls, 2, '暂停页仍可刷新一次')
  await sleep(40)
  assert.equal(calls, 2, '刷新不会把暂停页变回订阅')
})

test('A04/A06 浏览器隐藏与组件失活都会当场结算未完成的刷新要求', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: () => new Promise<number>(() => {}) })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()

  core.setVisible(false)
  assert.deepEqual(await refreshing, { status: 'cancelled', reason: 'unavailable' })
  assert.equal(view.handle.subscription, null, '隐藏即退订')
  assert.equal(await view.refresh().then(result => result.status), 'cancelled')
})

test('A06 组件失活取消本页未完成的刷新要求，但不改变被暂停页的显式刷新能力', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: () => new Promise<number>(() => {}) })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()

  core.deactivate(view.handle)
  assert.deepEqual(await refreshing, { status: 'cancelled', reason: 'unavailable' })
})

test('A06 最后一个需求退出：在途请求被 abort，实例与结果一并消失', async () => {
  let signal: AbortSignal | undefined
  const source = defineRefresh<{ id: number }, number>({
    load: (_args, context) => { signal = context.signal; return new Promise<number>(() => {}) },
  })
  const quote = source
  const core = newCore(2)
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  assert.equal(signal?.aborted, false)

  core.removeHandle(view.handle)
  assert.equal(signal?.aborted, true)
  assert.equal(core.readSnapshot(quote, { id: 1 }), undefined)
  assert.equal(core.snapshot().resources.length, 0)
})

test('A06/A11 恢复：实例还在就立即交付历史结果，不重复取数；最后一个需求退出则连实例一起销毁', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const quote = source
  const core = newCore(2)
  const view = page(core, quote)
  const other = page(core, quote)

  view.submit({ id: 1 })
  other.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  core.deactivate(view.handle)
  await settle()
  const published = view.published.length
  core.activate(view.handle)
  await settle()
  assert.equal(view.published.length, published + 1)
  assert.equal(view.last?.data, 1)
  assert.equal(calls, 1, '恢复交付历史结果，不重复取数')

  core.removeHandle(view.handle)
  core.removeHandle(other.handle)
  assert.equal(core.readSnapshot(quote, { id: 1 }), undefined)
})

test('A07 长时间挂起后恢复只取一次，不补跑漏掉的周期', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const core = newCore(2)
  const view = page(core, source, { enabled: true, every: 30 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  core.setVisible(false)
  await sleep(200)
  core.setVisible(true)
  await settle()
  assert.equal(calls, 2, '恢复只取一次，不按漏掉的周期补跑')

  core.setVisible(false)
})

test('A05 暂停只退订：已发起的刷新要求继续等当前请求的结果，实例不因暂停而释放', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>({
    load: () => new Promise<number>(resolve => resolvers.push(resolve)),
  })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()

  view.set({ enabled: false, every: 100_000 })
  await settle()
  assert.equal(view.handle.subscription, null, '暂停即退订')
  assert.equal(core.snapshot().resources.length, 1, '刷新要求还没结算，实例不释放、在途不取消')

  // 暂停不结算已发起的刷新要求：它由当前这个请求的结果结算，既不另发一次也不必等下个周期。
  resolvers[0]?.(7)
  await settle()
  assert.equal(resolvers.length, 1, '暂停期间不追发请求，本次刷新用现有这一次')
  assert.deepEqual(await refreshing, { status: 'success' })
  assert.equal(view.last?.data, 7, '暂停页仍然拿到这次结果')
  assert.equal(core.snapshot().resources.length, 0, '要求结算后没有需求，才释放实例')
  assert.equal(view.last?.data, 7, '释放共享实例不动页面自己的副本')
})

test('A13 共享请求失败：保留旧画面、通知页面、下个周期继续', async () => {
  let fail = false
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({
    load: async () => { calls++; if (fail) throw new Error('boom'); return 5 },
  })
  const core = newCore(2)
  const view = page(core, source, { enabled: true, every: 20 })

  view.submit({ id: 1 })
  await settle()
  fail = true
  await sleep(50)

  assert.ok(calls >= 2)
  assert.equal(view.last?.data, 5, '失败保留旧画面')
  assert.equal(view.errors.at(-1)?.origin, 'request')
  assert.equal(view.errors.at(-1)?.operationId, 1)
  assert.equal(view.handle.subscription?.resource.subscribers.size, 1, '需求与开启意愿都保留')
})

test('A13/A14 失败结算该实例全部未完成的刷新要求，不自动重试', async () => {
  const resolvers: Array<(value: number) => void> = []
  const rejecters: Array<(reason: unknown) => void> = []
  const source = defineRefresh<{ id: number }, number>({
    load: () => new Promise<number>((resolve, reject) => { resolvers.push(resolve); rejecters.push(reject) }),
  })
  const core = newCore(2)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()

  rejecters[0]?.(new Error('down'))
  await settle()
  const settled = await refreshing
  assert.equal(settled.status, 'error')
  assert.equal(settled.status === 'error' ? settled.origin : null, 'request')
  assert.notEqual(view.handle.subscription, null, '订阅与开启意愿都保留')
  assert.equal(resolvers.length, 1, '失败不自动重试')
})

test('A11/A13 空结果（undefined）按请求失败处理，null 是有效结果', async () => {
  let mode: 'empty' | 'null' = 'empty'
  const source = defineRefresh<{ id: number }, number | null>({
    load: async () => (mode === 'empty' ? (undefined as unknown as number) : null),
  })
  const core = newCore(2)
  const empty = page(core, source)
  empty.submit({ id: 1 })
  await settle()
  assert.equal(empty.errors.at(-1)?.origin, 'request')
  assert.equal(empty.last, undefined, '空结果不交付')

  mode = 'null'
  const view = page(core, source)
  view.submit({ id: 2 })
  await settle()
  assert.equal(view.last?.data, null)
})

test('A08 轮询不重叠：上一轮没有结束时不再发起', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({
    load: () => { calls++; return new Promise<number>(resolve => resolvers.push(resolve)) },
  })
  const core = newCore(2)
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
  const source = defineRefresh<{ id: number }, number>({
    load: () => new Promise<number>(resolve => resolvers.push(resolve)),
  })
  const core = newCore(1)
  const one = page(core, source)
  const two = page(core, source)

  one.submit({ id: 1 })
  two.submit({ id: 2 })
  await settle()
  assert.equal(resolvers.length, 1)
  assert.equal(core.snapshot().queued.length, 1)

  resolvers[0]?.(1)
  await settle()
  assert.equal(resolvers.length, 2)

  resolvers[1]?.(2)
  await settle()
  assert.equal(one.last?.data, 1)
  assert.equal(two.last?.data, 2)
})

test('A07 有效间隔取所有订阅的最小值', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const quote = source
  const core = newCore(2)
  const slow = page(core, quote, { enabled: true, every: 100_000 })
  const fast = page(core, quote, { enabled: true, every: 10 })

  slow.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  fast.submit({ id: 1 })
  await sleep(40)
  assert.ok(calls >= 3, `最小间隔生效：40ms 内至少 3 次，实测 ${calls}`)
})

test('A10 上限到期：挂死的 load 出册并交还槽位，迟到的结束不再写任何事实', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>({
    load: () => new Promise<number>(resolve => resolvers.push(resolve)),
  })
  const core = newCore(1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await micro()
  assert.equal(resolvers.length, 1)
  assert.equal(core.snapshot().running.length, 1)

  mock.timers.tick(10_000)
  await micro()

  assert.equal(core.snapshot().running.length, 0, '上限到期当场出册，槽位交还调度')
  assert.equal(core.snapshot().resources[0]?.task, null)
  assert.equal(view.errors.at(-1)?.origin, 'request')

  const delivered = view.published.length
  resolvers[0]?.(99)
  await micro()
  assert.equal(view.published.length, delivered, '迟到的结束不交付')
})

test('A11 交付面：null 之外的任何结果都整体替换，且页面副本与共享副本互不影响', async () => {
  const source = defineRefresh<{ id: number }, { rows: number[] }>({ load: async () => ({ rows: [1] }) })
  const quote = source
  const core = newCore(2)
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  const first = view.last
  const copy = first?.data as { rows: number[] }
  copy.rows.push(2)

  assert.deepEqual(core.readSnapshot(quote, { id: 1 }), { rows: [1] })
  assert.equal(view.handle.parameters?.key, '{"id":1}')
})

test('A15 只读定位：无实例与编码不出的参数都返回 undefined，读到的是副本', async () => {
  const source = defineRefresh<{ id: number }, { rows: number[] }>({ load: async () => ({ rows: [1] }) })
  const quote = source
  const core = newCore(1)

  assert.equal(core.readSnapshot(quote, { id: 1 }), undefined)
  // 编码不做合法性判断：这些根容器只是各自不同的键，没有实例就返回 undefined。
  for (const other of [[1, 2], null, 7, 'x', new Date(0), { id: Number.NaN }]) {
    assert.equal(core.readSnapshot(quote, other as object), undefined, `根容器 ${String(other)} 不该抛`)
  }
  // 编码不出身份的参数按「没有这个身份」处理：读取点不需要 try/catch。
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(core.readSnapshot(quote, cyclic), undefined)

  const view = page(core, quote)
  view.submit({ id: 1 })
  await settle()
  const found = core.readSnapshot(quote, { id: 1 }) as { rows: number[] }
  found.rows.push(2)
  assert.deepEqual(core.readSnapshot(quote, { id: 1 }), { rows: [1] })
})

test('A04/A17 两个协调者互不共享：同 Source 同参数各自取数', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return calls } })
  const quote = source
  const first = newCore(1)
  const second = newCore(1)
  const left = page(first, quote)
  const right = page(second, quote)

  left.submit({ id: 1 })
  right.submit({ id: 1 })
  await settle()

  assert.equal(calls, 2)
  assert.equal(left.last?.data, 1)
  assert.equal(right.last?.data, 2)
})

test('A16 页面回调抛错或返回拒绝的 Promise 都不影响框架状态与其他接收者', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: async () => 3 })
  const quote = source
  const core = newCore(2)
  const hostile = page(core, quote, { enabled: true, every: 100_000 }, {
    publish: () => { throw new Error('render failed') },
  })
  const normal = page(core, quote)

  normal.submit({ id: 1 })
  hostile.submit({ id: 1 })
  await settle()

  assert.equal(normal.last?.data, 3, '一个接收者失败不影响另一个')
  assert.equal(core.readSnapshot(quote, { id: 1 }), 3)

  // 失败通知里的 onError 抛错同样被隔离，订阅与开启意愿都不受影响。
  let notified = 0
  const failing = defineRefresh<{ id: number }, number>({ load: async () => { throw new Error('down') } })
  const victim = page(core, failing, { enabled: true, every: 100_000 }, {
    onError: () => { notified++; throw new Error('handler failed') },
  })
  victim.submit({ id: 1 })
  await settle()
  assert.equal(notified, 1)
  assert.equal(victim.handle.subscription?.resource.subscribers.size, 1)
})

test('A15/A17 销毁：幂等，之后所有入口都返回 cancelled/disposed，未结束的执行不再写事实', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>({
    load: () => new Promise<number>(resolve => resolvers.push(resolve)),
  })
  const core = newCore(1)
  const view = page(core, source)
  let cleaned = 0
  view.handle.cleanup = () => { cleaned++ }

  view.submit({ id: 1 })
  await settle()
  const refreshing = view.refresh()
  await settle()

  core.dispose()
  assert.equal(core.isDisposed(), true)
  assert.equal(cleaned, 1)
  assert.deepEqual(await refreshing, { status: 'cancelled', reason: 'disposed' })
  assert.deepEqual(view.submit({ id: 2 }), { status: 'cancelled', reason: CancelReason.Disposed })
  assert.equal(await view.refresh().then(result => result.status), 'cancelled')
  const empty = core.snapshot()
  assert.deepEqual([empty.handles.length, empty.resources.length, empty.queued.length, empty.scheduled], [0, 0, 0, false])

  const delivered = view.published.length
  resolvers[0]?.(9)
  await settle()
  assert.equal(view.published.length, delivered, '迟到的结束不再写任何事实')
  assert.equal(core.snapshot().running.length, 0, '未结束的执行到真实结束才释放槽位')
  core.dispose()
})

test('A04/A05 配置非法时不订阅也不刷新，刷新入口按 configuration 结算', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: async () => 1 })
  const core = newCore(2)
  const view = page(core, source, null)

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()
  assert.equal(view.handle.subscription, null)
  assert.equal(view.published.length, 0)

  const result = await view.refresh()
  assert.equal(result.status, 'error')
  assert.equal(result.status === 'error' ? result.origin : null, ErrorOrigin.Configuration)
})

test('A05/A14 未声明身份时刷新结算 unavailable，不产生请求', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>({ load: async () => { calls++; return 1 } })
  const core = newCore(2)
  const view = page(core, source)

  assert.deepEqual(await view.refresh(), { status: 'cancelled', reason: 'unavailable' })
  assert.equal(calls, 0)
})

test('A18 参数编码与序号上界：键按 JSON 语义稳定排序，序号到达上界后停在原地', async () => {
  const source = defineRefresh<{ id: number }, number>({ load: async () => 1 })
  const core = newCore(1)
  const view = page(core, source)

  // 编码沿用 JSON 语义、不做合法性判断（那是调用方的责任）：键就是按键排序后的 JSON 文本。
  assert.equal(prepareParameters({ b: 1, a: 2 }).key, '{"a":2,"b":1}', '对象键排序')
  assert.equal(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['a', 'b'] }).key)
  assert.notEqual(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['b', 'a'] }).key, '数组顺序影响身份')
  assert.equal(prepareParameters({ id: -0 }).key, prepareParameters({ id: 0 }).key, '-0 与 0 是同一个数')
  assert.equal(prepareParameters({ id: Number.NaN }).key, prepareParameters({ id: null }).key, 'NaN 按 JSON 语义读作 null')
  assert.equal(prepareParameters({ id: undefined }).key, prepareParameters({}).key, 'undefined 字段按 JSON 语义省略')
  assert.equal(prepareParameters({ at: new Date(0) }).key,
    prepareParameters({ at: '1970-01-01T00:00:00.000Z' }).key, 'Date 按其 ISO 字符串')

  // 循环引用编码不出身份：按非法参数拒绝，且不改动任何状态。
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(view.submit(cyclic).status, 'rejected')
  assert.equal(view.handle.parameters, null)

  // 序号到达安全整数上界后停在原地：不销毁、不抛错，入口照常工作。
  view.handle.operationId = Number.MAX_SAFE_INTEGER
  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  assert.equal(view.handle.operationId, Number.MAX_SAFE_INTEGER)
  await settle()
  assert.equal(view.last?.data, 1)
})

/**
 * 这一条是「调用方不用写 try/catch」的总账：三条公开入口都只能给出返回值或 `onError`。
 * 唯一会同步抛错的是装配误用（`useRefresh` 不在 setup、没有协调者、`maxConcurrent` 非法、安装冲突），
 * 那些在 `vue.test.ts` 里各有一条，且都发生在第一次运行就能看见的固定位置。
 */
test('边界总账：运行期失败只走返回值或 onError，三类公开入口都不抛错', async () => {
  // 取数侧：结果非法（`undefined`）与结果不可复制都只是后台失败，槽位当场交还。
  for (const source of [
    defineRefresh<{ id: number }, number>({ load: async () => undefined as unknown as number }),
    defineRefresh<{ id: number }, object>({ load: async () => ({ f: () => 1 }) }),
  ]) {
    const core = newCore(1)
    const view = page(core, source)
    assert.doesNotThrow(() => { view.submit({ id: 1 }) })
    await settle()
    assert.equal(view.errors.at(-1)?.origin, 'request')
    assert.equal(core.snapshot().running.length, 0)
  }

  // 参数侧：复制失败、编码不出、`validate` 拒绝，一律是 `rejected` ＋ `validation` 通知，不产生实例。
  const source = defineRefresh<object, number>({
    load: async () => 1,
    validate: args => (args as { valid?: boolean }).valid !== false,
  })
  const core = newCore(1)
  const view = page(core, source)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const bad of [cyclic, { f: () => 1 }, { valid: false }]) {
    let status = ''
    assert.doesNotThrow(() => { status = view.submit(bad).status })
    assert.equal(status, 'rejected')
  }
  for (const validate of [
    (): never => { throw new Error('校验炸') },
    (): never => Promise.resolve(true) as never,
  ]) {
    assert.equal(page(newCore(1), defineRefresh<object, number>({ load: async () => 1, validate })).submit({}).status, 'rejected')
  }
  assert.ok(view.errors.every(error => error.origin === 'validation'))
  assert.equal(core.snapshot().resources.length, 0)

  // 读取侧：编码不出的参数返回 `undefined`；显式刷新永不 reject。
  assert.doesNotThrow(() => { core.readSnapshot(source, cyclic) })
  assert.equal(core.readSnapshot(source, cyclic), undefined)
  await assert.doesNotReject(async () => { await view.refresh() })
})

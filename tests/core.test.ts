import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { RefreshCore } from '../src/core.ts'
import type { Config, Entry, Handle, Resource, ResultCell, ResultRow, ResultSink } from '../src/core.ts'
import { defineRefresh, prepareParameters } from '../src/source.ts'
import type { Parameters } from '../src/source.ts'
import type { RefreshDisplay, RefreshFailure, RefreshSource, SubmitResult } from '../src/public-types.ts'

/** 每个用例结束时销毁核心：周期调度会留下唯一的唤醒 Timer，不销毁的话进程不会退出。 */
const cores: RefreshCore[] = []

/**
 * 结果表替身：与 Pinia store 同形（格＝成功 ＋ 失败，整格换新对象、随实例释放即删），
 * 并记录成功写入次序供断言。`onWrite` 让用例模拟「写结果的那一刻页面代码同步重入」。
 */
function newTable() {
  const cells = new Map<string, ResultCell>()
  const writes: Array<{ url: string; key: string; entry: Entry }> = []
  const id = (url: string, key: string): string => `${url}\u0000${key}`
  const table = {
    sink: {
      write(url: string, key: string, entry: Entry): void {
        cells.set(id(url, key), { entry, failure: null })
        writes.push({ url, key, entry })
        table.onWrite?.()
      },
      fail(url: string, key: string, failure: RefreshFailure): void {
        cells.set(id(url, key), { entry: cells.get(id(url, key))?.entry ?? null, failure })
        table.onWrite?.()
      },
      remove(url: string, key: string): void { cells.delete(id(url, key)) },
      list(): readonly ResultRow[] {
        const rows: ResultRow[] = []
        for (const [raw, cell] of cells) {
          if (cell.entry === null && cell.failure === null) continue
          const [url = '', key = ''] = raw.split('\u0000')
          rows.push({ url, key, cell })
        }
        return rows
      },
    } satisfies ResultSink,
    writes,
    onWrite: null as (() => void) | null,
    read(url: string, key: string): ResultCell | undefined { return cells.get(id(url, key)) },
    /** 这一格上当前的失败；空格子或成功过之后都是 `null`。 */
    failure(url: string, key: string): RefreshFailure | null { return cells.get(id(url, key))?.failure ?? null },
  }
  return table
}

/** 每个核心一张结果表：`newCore` 建表并登记，`page()` 从这里取，因此调用点不用改。 */
const tables = new WeakMap<RefreshCore, ReturnType<typeof newTable>>()

/**
 * 每个用例一个假传输：返回值就是这次取数的结果（框架只取它的 `data`）。
 * 旧契约里写在定义上的 `load` 原样搬到这里——框架自己发 `post(url, 参数值的克隆, { signal })`。
 */
type FakePost = (url: string, body: object, context: { readonly signal: AbortSignal }) => Promise<unknown>
function newCore(maxConcurrent: number, post: FakePost = async () => undefined): RefreshCore {
  const table = newTable()
  const core = new RefreshCore(maxConcurrent, {
    // 显式标注参数：`RefreshHttp.post` 的第二个参数是 `unknown`，这里要收窄回假传输的 `object`。
    post: async (url: string, body: object, context: { readonly signal: AbortSignal }) => ({
      data: await post(url, body, context),
    }),
  }, table.sink)
  tables.set(core, table)
  cores.push(core)
  return core
}

/** 取本核心的结果表；只有经 `newCore` 建立的核心才有。 */
function tableOf(core: RefreshCore): ReturnType<typeof newTable> {
  const table = tables.get(core)
  assert.ok(table, '核心必须先经 newCore 建立结果表')
  return table
}

afterEach(() => {
  for (const core of cores.splice(0)) core.dispose()
  mock.timers.reset()
})

/**
 * 配置快照的两项默认值：挂载且激活、开启意愿、超长周期。
 *
 * ADR-61 把「这一页是否激活」并进了快照，所以旧契约里 `addHandle` 之后紧跟的那次 `activate`
 * 现在等价于默认快照里的 `active: true`。
 */
const DEFAULT_CONFIG: Config = { enabled: true, every: 100_000, active: true }
/** 只给要改的那几项；`null` 表示整份快照非法。 */
type PartialConfig = { enabled?: boolean; every?: number; active?: boolean }

/** 一页：句柄 ＋ 按身份读结果表。与集成测试同一口径，直接驱动核心；画面按身份从结果表现读。 */
interface Page {
  readonly handle: Handle
  readonly last: RefreshDisplay<object, unknown> | undefined
  /** 本页**当前身份**那一格上的失败；没有身份、或成功过之后为 `null`（ADR-63）。 */
  failure(): RefreshFailure | null
  /** 本页**当前身份**被写进结果表几次（成功；旧契约里的「交付次数」）；没有身份时为 0。 */
  writes(): number
  submit(args: object): SubmitResult
  refresh(): void
  /** 合并式写快照：只给要改的那项，其余沿用当前值（ADR-61 的单一写入口）。 */
  set(next: PartialConfig | null): void
}

function page(
  core: RefreshCore,
  source: RefreshSource<object, unknown>,
  initial: PartialConfig | null = {},
): Page {
  const table = tableOf(core)
  const handle: Handle = {
    source,
    config: initial === null ? null : { ...DEFAULT_CONFIG, ...initial },
    cleanup: null,
    parameters: null,
  }
  core.addHandle(handle)
  return {
    handle,
    writes(): number {
      const parameters = handle.parameters
      if (parameters === null) return 0
      return table.writes.filter(write => write.url === handle.source.name && write.key === parameters.key).length
    },
    failure(): RefreshFailure | null {
      const parameters = handle.parameters
      if (parameters === null) return null
      return table.failure(handle.source.name, parameters.key)
    },
    submit: args => core.submit(handle, (): Parameters => prepareParameters(args, source)),
    refresh: () => core.refresh(handle),
    set(next) {
      if (next === null) {
        handle.config = null
        core.reconcile(handle)
        return
      }
      const current = handle.config ?? DEFAULT_CONFIG
      handle.config = {
        enabled: next.enabled ?? current.enabled,
        every: next.every ?? current.every,
        active: next.active ?? current.active,
      }
      core.reconcile(handle)
    },
    get last() {
      const parameters = handle.parameters
      if (parameters === null) return undefined
      const cell = table.read(handle.source.name, parameters.key)
      if (!cell || (cell.entry === null && cell.failure === null)) return undefined
      // `display` 的形状：`args` 每次读取复制一份（身份键所描述的那份值），`data` 是结果表里同一个对象。
      return {
        args: structuredClone(parameters.args),
        data: cell.entry === null ? null : cell.entry.data,
        updatedAt: cell.entry === null ? null : cell.entry.updatedAt,
        failure: cell.failure,
      }
    },
  }
}

/**
 * 两个探针的分工（ADR-61 把「声明」与「资格」拆开之后）：
 *
 * - `declared`：这个句柄**声明**到了哪个实例。声明只要页面挂载着就一直算（暂停、失活、隐藏都不撤销），
 *   它决定实例与结果的生死——只有卸载、换身份、销毁才撤销。
 * - `reader`：这个句柄此刻算不算该身份的**读者**（有资格，或有未撤销的刷新要求）。
 *   它只决定画面跟不跟随新结果（冻结见 ADR-60），不决定实例在不在。
 */
function declared(core: RefreshCore, view: Page): Resource | undefined {
  return core.snapshot().resources.find(resource => resource.declarers.has(view.handle))
}

function reader(core: RefreshCore, view: Page): boolean {
  return core.isReader(view.handle)
}

/**
 * 队列不变量：`queue` 里的任务必定就是它实例的当前执行。
 *
 * `queue` 的唯一写入者是 `placeTask`，它只在「这个任务就是当前执行」时把它放进队列，因此
 * `startQueued` 不再复核归属（ADR-62 删掉了那个已不可达的分支）。这条断言把那个前提钉住：
 * 一旦有人新增第二个入队路径，它会红。
 */
function assertQueueConsistent(core: RefreshCore): void {
  for (const task of core.snapshot().queued) {
    assert.equal(task.resource.task, task, '队列里的任务必须是它实例的当前执行')
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

test('A01/A11 首次订阅立即取一次，结果按 args／data／时间整体读出', async () => {
  const source = defineRefresh<{ symbol: string }, number>('/api/core/84')
  const core = newCore(2, async () => 7)
  const quote = source
  const view = page(core, quote)

  assert.equal(view.submit({ symbol: 'A' }).status, 'accepted')
  await settle()

  assert.equal(view.writes(), 1)
  assert.deepEqual(view.last?.args, { symbol: 'A' })
  assert.equal(view.last?.data, 7)
  assert.equal(typeof view.last?.updatedAt, 'number')
})

test('A11/A02 同参数的两个组件共享同一次请求与同一份结果（要改自己复制）', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, { list: number[] }>('/api/core/99')
  const quote = source
  const core = newCore(2, async () => { calls++; return { list: [1, 2] } })
  const first = page(core, quote)
  const second = page(core, quote)

  first.submit({ id: 1 })
  second.submit({ id: 1 })
  await settle()

  assert.equal(calls, 1)
  assert.equal(first.writes(), 1)
  assert.equal(second.writes(), 1)

  // 数据是共享对象：要改自己复制（ADR-59）。改到的就是结果表里那一份，所以另一个读者也看得到。
  const copy = first.last?.data as { list: number[] }
  copy.list.push(99)
  assert.deepEqual(second.last?.data, { list: [1, 2, 99] })
})

test('A02 身份是「URL ＋ 完整参数值」：字段顺序无关，数组顺序有关，不同参数各取一次', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number; tags: string[] }, number>('/api/core/123')
  const quote = source
  const core = newCore(4, async () => { calls++; return calls })
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

test('A20 同一个 URL 在两处各声明一份定义仍然合并：只发一次取数，两个读者读到同一份结果', async () => {
  let calls = 0
  // 两份定义：URL 相同，validate 是各自写的箭头函数（它跟参数走，不参与身份）。
  const firstSource = defineRefresh<{ id: number }, number>('/api/core/identity', { validate: p => p.id > 0 })
  const secondSource = defineRefresh<{ id: number }, number>('/api/core/identity', { validate: p => p.id >= 0 })
  const core = newCore(2, async () => { calls++; return 42 })
  const first = page(core, firstSource)
  const second = page(core, secondSource)

  first.submit({ id: 1 })
  second.submit({ id: 1 })
  await settle()

  assert.equal(calls, 1, 'URL 与参数值相同就是同一个共享实例')
  assert.equal(first.writes(), 1)
  assert.equal(second.writes(), 1)
  assert.equal(core.snapshot().resources.length, 1)

  // 反向：URL 不同就是不同身份，即便参数值一模一样。
  const otherSource = defineRefresh<{ id: number }, number>('/api/core/identity-2')
  const third = page(core, otherSource)
  third.submit({ id: 1 })
  await settle()
  assert.equal(calls, 2, 'URL 不同则各有一次取数')
  assert.equal(core.snapshot().resources.length, 2)
})

test('A03 相同参数重复声明幂等：不新增请求、不重建订阅', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/142')
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const instance = declared(core, view)

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()

  assert.equal(calls, 1)
  assert.equal(declared(core, view), instance)
})

test('A03 参数被拒时返回 rejected，保留已有身份，且不通知（输入问题只走同步返回值）', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/159', { validate: args => args.id > 0 })
  const core = newCore(2, async () => 1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const before = view.handle.parameters
  const instance = declared(core, view)

  assert.equal(view.submit({ id: -1 }).status, 'rejected')
  assert.equal(view.handle.parameters, before)
  assert.equal(declared(core, view), instance)
  // 校验失败不改动任何状态：旧身份仍然在后台继续取数；输入问题也不进结果表（ADR-51）。
  assert.equal(view.failure(), null, '参数被拒只走同步返回值')

  // 业务 validate 自己抛错时同样按 rejected 返回：异常由提交边界收住，不冒泡到调用方。
  const throwing = defineRefresh<{ id: number }, number>('/api/core/159-throwing', {
    validate: () => { throw new Error('bad rule') },
  })
  const victim = page(core, throwing)
  assert.equal(victim.submit({ id: 1 }).status, 'rejected')
  assert.equal(victim.handle.parameters, null, '被拒的声明不改动状态')
  assert.equal(victim.failure(), null, '被拒的声明不产生失败')
})

test('A14 在途任务直接满足本次刷新：不追发第二次', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/186')
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
  const source = defineRefresh<{ id: number }, number>('/api/core/207')
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

test('A12 结果写入期间被撤销的刷新要求不再由这一次结果满足：写入点与订阅者同口径复核', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/233')
  const core = newCore(2, async (_url, body) => { calls++; return (body as { id: number }).id })
  const paused = page(core, source, { enabled: false, every: 100_000 })
  const watcher = page(core, source)
  // 结果写入的那一刻页面代码同步重入：把暂停页换成另一个身份，这会当场结算掉它的刷新要求。
  tableOf(core).onWrite = () => { paused.submit({ id: 2 }) }

  watcher.submit({ id: 1 })
  paused.submit({ id: 1 })
  paused.refresh()
  await settle()

  assert.equal(calls, 1, '暂停页的刷新要求由这一个在途请求满足，不追发第二次')
  assert.equal(watcher.writes(), 1)
  assert.equal(paused.writes(), 0, '要求已在结果写入期间被撤销，这一次结果不再轮到它')
})

test('A12/A14 结果写入期间新登记的刷新要求由后继请求满足（refill）', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/254')
  const core = newCore(2, async () => { calls++; return calls })
  const paused = page(core, source, { enabled: false, every: 100_000 })
  const watcher = page(core, source)
  // 结果写入的那一刻登记一次刷新：它不在这一批里，只能由后继请求满足。
  tableOf(core).onWrite = () => { paused.refresh() }

  watcher.submit({ id: 1 })
  paused.submit({ id: 1 })
  await settle()

  assert.equal(calls, 2, '结果写入期间登记的要求由后继请求满足')
  assert.equal(paused.last?.data, 2, '暂停页拿到的是后继请求的结果')
  assert.equal(watcher.writes(), 2, '订阅页两次写入都读到')
})

test('A04/A05 关闭开启意愿后停止周期取数，但页面仍可显式刷新一次', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/274')
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source, { enabled: true, every: 15 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ enabled: false, every: 100_000 })
  await settle()
  await sleep(40)
  assert.equal(calls, 1, '暂停后不再有周期请求')
  assert.equal(reader(core, view), false, '暂停即失去读者身份（画面冻结）')
  assert.notEqual(declared(core, view), undefined, '声明还在：实例与结果都不回收')

  view.refresh()
  await settle()
  assert.equal(calls, 2, '暂停页仍可刷新一次')
  await sleep(40)
  assert.equal(calls, 2, '刷新不会把暂停页变回订阅')
})

test('A04/A06 浏览器隐藏与组件失活只失去资格：要求被撤销、声明与在途都留着', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/297')
  const core = newCore(2, () => { calls++; return new Promise<number>(() => {}) })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()
  assert.equal(core.snapshot().resources.length, 1, '刷新要求让实例留在册')

  core.setVisible(false)
  await settle()
  assert.equal(reader(core, view), false, '隐藏即失去读者身份')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(core.snapshot().resources.length, 1, '隐藏只失去资格：实例与在途都留着（ADR-61）')

  view.refresh()
  await settle()
  assert.equal(core.snapshot().resources.length, 1, '隐藏期间刷新不新建实例')
  assert.equal(calls, 1, '隐藏期间刷新不发请求（入口闸：激活且浏览器可见）')
})

test('A06 组件失活撤销本页未完成的刷新要求，声明与实例都留着', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/318')
  const core = newCore(2, () => new Promise<number>(() => {}))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  view.set({ active: false })
  await settle()
  assert.equal(reader(core, view), false, '失活即失去读者身份')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(core.snapshot().resources.length, 1, '失活只失去资格：要求被撤销，实例不释放')
})

test('A06 最后一个声明者退出（卸载）：在途请求被 abort，实例与结果一并消失', async () => {
  let signal: AbortSignal | undefined
  const source = defineRefresh<{ id: number }, number>('/api/core/334')
  const core = newCore(2, (_url, _body, context) => { signal = context.signal; return new Promise<number>(() => {}) })
  const quote = source
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  assert.equal(signal?.aborted, false)

  core.removeHandle(view.handle)
  assert.equal(signal?.aborted, true)
  assert.equal(core.snapshot().resources.length, 0)
})

test('A06/A11 恢复：实例还在就立即读到历史结果，不重复取数；最后一个声明者退出则连实例一起销毁', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/352')
  const core = newCore(2, async () => { calls++; return calls })
  const quote = source
  const view = page(core, quote)
  const other = page(core, quote)

  view.submit({ id: 1 })
  other.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  view.set({ active: false })
  await settle()
  const written = view.writes()
  view.set({ active: true })
  await settle()
  assert.equal(view.writes(), written, '恢复不产生新的写入：读的是结果表里已有的那份')
  assert.equal(view.last?.data, 1)
  assert.equal(calls, 1, '恢复读到历史结果，不重复取数')

  core.removeHandle(view.handle)
  core.removeHandle(other.handle)
  assert.equal(core.snapshot().resources.length, 0, '最后一个需求退出后实例与结果一起消失')
})

test('A07 长时间挂起后恢复只取一次，不补跑漏掉的周期', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/379')
  const core = newCore(2, async () => { calls++; return calls })
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

test('A05 暂停只失去资格：已发起的刷新要求继续等当前请求的结果，声明、实例与结果都保留', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>('/api/core/398')
  const core = newCore(2, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  view.set({ enabled: false, every: 100_000 })
  await settle()
  // 暂停只失去「自动取数」的资格；这一页此刻还持有未撤销的刷新要求，所以在要求结算之前**仍是读者**
  // （ADR-60 的读者 = 有资格的声明 ∪ 未撤销要求；要求结算之后它才冻结）。
  assert.equal(reader(core, view), true, '暂停但仍持有未撤销的刷新要求：读者身份保留到这次结算')
  assert.notEqual(declared(core, view), undefined, '声明还在')
  assert.equal(core.snapshot().resources.length, 1, '刷新要求还没满足，实例不释放、在途不取消')

  // 暂停不撤销已发起的刷新要求：它由当前这个请求的结果满足，既不另发一次也不必等下个周期。
  resolvers[0]?.(7)
  await settle()
  assert.equal(resolvers.length, 1, '暂停期间不追发请求，本次刷新用现有这一次')
  // 要求被这一次结果满足；但**声明还在**，所以实例与结果都不回收（ADR-61）：暂停/失活不再删结果。
  // 「画面冻结」与「恢复后读回」是适配层的事，由 tests/vue.test.ts 验证；核心这一层断言的是声明与结果表的事实。
  assert.equal(core.snapshot().results.length, 1, '声明还在：结果表条目保留（ADR-61）')
  assert.equal(view.last?.data, 7, '核心这一层：按身份仍能读到那一份结果')
  assert.equal(core.snapshot().resources.length, 1, '暂停不释放实例：声明还在')
  assert.equal(reader(core, view), false, '要求已结算：暂停页不再是读者，画面冻结在最后一帧')
})

test('A13 共享请求失败：保留旧址、把失败写进该身份那一格、下个周期继续', async () => {
  let fail = false
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/425')
  const core = newCore(2, async () => { calls++; if (fail) throw new Error('boom'); return 5 })
  const view = page(core, source, { enabled: true, every: 20 })

  view.submit({ id: 1 })
  await settle()
  fail = true
  await sleep(50)

  assert.ok(calls >= 2)
  assert.equal(view.last?.data, 5, '失败保留旧画面')
  assert.ok(view.failure(), '失败写进该身份那一格：按身份读得到（读取面这一侧由 tests/vue.test.ts 验证）')
  assert.equal(declared(core, view)?.declarers.size, 1, '资格与开启意愿都保留')
})

test('A13/A14 失败结算该实例全部未完成的刷新要求，不自动重试', async () => {
  const resolvers: Array<(value: number) => void> = []
  const rejecters: Array<(reason: unknown) => void> = []
  const source = defineRefresh<{ id: number }, number>('/api/core/445')
  const core = newCore(2, () => new Promise<number>((resolve, reject) => { resolvers.push(resolve); rejecters.push(reject) }))
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  rejecters[0]?.(new Error('down'))
  await settle()
  assert.ok(view.failure(), '失败写进该身份那一格：刷新没有回执')
  assert.ok(reader(core, view), '资格与开启意愿都保留')
  assert.equal(resolvers.length, 1, '失败不自动重试')
})

test('A13/A14 暂停页显式刷新失败：没有回执，失败写进该身份那一格等读取面取', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/466')
  const core = newCore(2, async () => { throw new Error('down') })
  const paused = page(core, source, { enabled: false, every: 100_000 })

  paused.submit({ id: 1 })
  paused.refresh()
  await settle()

  assert.ok(paused.failure(), '未订阅页面按身份从结果表读到失败')
  assert.equal(paused.writes(), 0, '失败不写结果')
  assert.equal(core.snapshot().resources.length, 1, '失败撤销要求；声明还在，实例不释放')
})

test('A11/A13 空结果（undefined）按请求失败处理，null 是有效结果', async () => {
  let mode: 'empty' | 'null' = 'empty'
  const source = defineRefresh<{ id: number }, number | null>('/api/core/480')
  const core = newCore(2, async () => (mode === 'empty' ? (undefined as unknown as number) : null))
  const empty = page(core, source)
  empty.submit({ id: 1 })
  await settle()
  assert.ok(empty.failure(), '空结果按请求失败：这一格处于失败态')
  assert.equal(empty.last?.data, null, '空结果不写数据：这一格只有失败')

  mode = 'null'
  const view = page(core, source)
  view.submit({ id: 2 })
  await settle()
  assert.equal(view.last?.data, null)
})

test('A08 轮询不重叠：上一轮没有结束时不再发起', async () => {
  const resolvers: Array<(value: number) => void> = []
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/499')
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
  const source = defineRefresh<{ id: number }, number>('/api/core/518')
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const one = page(core, source)
  const two = page(core, source)

  one.submit({ id: 1 })
  two.submit({ id: 2 })
  await settle()
  assert.equal(resolvers.length, 1)
  assert.equal(core.snapshot().queued.length, 1)
  assertQueueConsistent(core)

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
  const source = defineRefresh<{ id: number }, number>('/api/core/543')
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

test('A10 上限到期：挂死的 load 出册并交还槽位，迟到的结束不再写任何事实', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>('/api/core/560')
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)

  view.submit({ id: 1 })
  await micro()
  assert.equal(resolvers.length, 1)
  assert.equal(core.snapshot().running.length, 1)

  mock.timers.tick(10_000)
  await micro()

  assert.equal(core.snapshot().running.length, 0, '上限到期当场出册，槽位交还调度')
  assert.equal(core.snapshot().resources[0]?.task, null)
  assert.ok(view.failure(), '上限到期按请求失败写一次该格')

  const delivered = view.writes()
  resolvers[0]?.(99)
  await micro()
  assert.equal(view.writes(), delivered, '迟到的结束不写结果')
})

test('A11 交付面：null 之外的任何结果都整体替换，读者拿到的是结果表里同一个对象（要改自己复制）', async () => {
  const source = defineRefresh<{ id: number }, { rows: number[] }>('/api/core/587')
  const quote = source
  const core = newCore(2, async () => ({ rows: [1] }))
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  const first = view.last
  const copy = first?.data as { rows: number[] }
  copy.rows.push(2)

  // 数据是共享对象：要改自己复制（ADR-59）。这里改的就是结果表里那一份，后加入者读到的是同一个对象，
  // 而且它是按同一身份现读的——没有为它再取数。
  const late = page(core, quote)
  late.submit({ id: 1 })
  await settle()
  assert.deepEqual(late.last?.data, { rows: [1, 2] })
  assert.equal(late.last?.data, view.last?.data, '两个读者拿到的是结果表里同一个对象')
  assert.equal(view.handle.parameters?.key, '{"id":1}')
})

test('A04/A17 两个协调者互不共享：同 Source 同参数各自取数', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/607')
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

test('A16 页面回调抛错不影响框架状态与其他页面：传输失败只写结果表，清理抛错被隔离', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/625')
  // 同一个核心只有一个传输，因此按 URL 分派：失败的资源用另一个 URL。
  const core = newCore(2, async url => { if (url === '/api/core/643') throw new Error('down'); return 3 })
  const quote = source
  const hostile = page(core, quote, { enabled: true, every: 100_000 })
  const normal = page(core, quote)

  normal.submit({ id: 1 })
  hostile.submit({ id: 1 })
  await settle()

  assert.equal(normal.last?.data, 3, '一个读者拿到的结果不受另一个影响')
  assert.equal(hostile.last?.data, 3, '两个读者读的是结果表里同一份结果')
  assert.equal(core.snapshot().resources.length, 1, '页面回调失败不影响实例与结果')

  // 传输失败只是这个身份那一格的事实：两个声明者都能读到它，框架状态照旧。
  const failing = defineRefresh<{ id: number }, number>('/api/core/643')
  const victim = page(core, failing, { enabled: true, every: 100_000 })
  const witness = page(core, failing, { enabled: true, every: 100_000 })
  victim.submit({ id: 1 })
  witness.submit({ id: 1 })
  await settle()
  assert.ok(victim.failure(), '失败方自己读得到')
  assert.ok(witness.failure(), '同一个身份另一个读者读的是同一格，也读得到')
  assert.equal(victim.failure()?.cause instanceof Error, true, '原始异常原样带出')
  assert.equal(declared(core, victim)?.declarers.size, 2)

  // 框架唯一还会调用的页面回调是 `cleanup`：它抛错同样被隔离，名册与别的句柄都不受影响。
  victim.handle.cleanup = () => { throw new Error('cleanup failed') }
  assert.doesNotThrow(() => { core.removeHandle(victim.handle) })
  assert.equal(core.snapshot().handles.includes(victim.handle), false, '抛错的清理不打断释放本身')
  assert.equal(declared(core, witness)?.declarers.size, 1, '另一个句柄的声明不受影响')
})

test('A17 销毁：幂等，之后所有入口都不产生事实，未结束的执行不再写事实', async () => {
  const resolvers: Array<(value: number) => void> = []
  const source = defineRefresh<{ id: number }, number>('/api/core/653')
  const core = newCore(1, () => new Promise<number>(resolve => resolvers.push(resolve)))
  const view = page(core, source)
  let cleaned = 0
  view.handle.cleanup = () => { cleaned++ }

  view.submit({ id: 1 })
  await settle()
  view.refresh()
  await settle()

  core.dispose()
  assert.equal(core.isDisposed(), true)
  assert.equal(cleaned, 1)
  assert.deepEqual(view.submit({ id: 2 }), { status: 'cancelled' })
  view.refresh()
  const empty = core.snapshot()
  assert.deepEqual([empty.handles.length, empty.resources.length, empty.queued.length, empty.scheduled], [0, 0, 0, false])

  const delivered = view.writes()
  resolvers[0]?.(9)
  await settle()
  assert.equal(view.writes(), delivered, '迟到的结束不再写任何事实')
  assert.equal(core.snapshot().running.length, 0, '未结束的执行到真实结束才释放槽位')
  core.dispose()
})

test('A04/A05 配置非法时不取数、不刷新、不通知；声明仍在，修正后按到期恢复', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/684')
  const core = newCore(2, async () => 1)
  const view = page(core, source, null)

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()
  assert.equal(reader(core, view), false, '配置非法：没有资格，不算读者')
  assert.equal(core.snapshot().resources.length, 1, '身份已声明（实例在册），但不取数')
  assert.equal(view.writes(), 0)

  view.refresh()
  assert.equal(view.failure(), null, '配置非法不取数自然也不会写失败：页面读自己的 refs 就知道')
})

test('A05/A14 未声明身份时刷新不产生请求也不通知', async () => {
  let calls = 0
  const source = defineRefresh<{ id: number }, number>('/api/core/698')
  const core = newCore(2, async () => { calls++; return 1 })
  const view = page(core, source)

  view.refresh()
  await settle()
  assert.equal(calls, 0)
  assert.equal(view.failure(), null, '页面自己知道还没有身份，不产生失败')
})

test('A18 参数编码与值域：键按 JSON 语义稳定排序，坏参数一律拒绝且不改动状态', async () => {
  const source = defineRefresh<{ id: number }, number>('/api/core/710')
  const core = newCore(1, async () => 1)
  const view = page(core, source)

  // 标量沿用 JSON 语义，不做业务合法性判断（那是调用方的责任）：键就是按键排序后的 JSON 文本。
  assert.equal(prepareParameters({ b: 1, a: 2 }).key, '{"a":2,"b":1}', '对象键排序')
  assert.equal(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['a', 'b'] }).key)
  assert.notEqual(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['b', 'a'] }).key, '数组顺序影响身份')
  assert.equal(prepareParameters({ id: -0 }).key, prepareParameters({ id: 0 }).key, '-0 与 0 是同一个数')
  assert.equal(prepareParameters({ id: Number.NaN }).key, prepareParameters({ id: null }).key, 'NaN 按 JSON 语义读作 null')
  assert.equal(prepareParameters({ id: undefined }).key, prepareParameters({}).key, 'undefined 字段按 JSON 语义省略')

  // 严格线（ADR-52）：对象型参数只能是普通对象或数组。这些容器的内容对编码不可见（全部编码成 `{}`），
  // 不同内容会塌成同一个身份、共享另一条查询的数据，故一律拒绝。
  for (const box of [new Date(0), new Map([['k', 1]]), new Set([1]), /x/g, new ArrayBuffer(2)]) {
    assert.throws(() => prepareParameters({ box }), /参数只能是普通对象、数组与 JSON 标量/, `${box.constructor.name} 被拒绝`)
    assert.equal(view.submit({ box }).status, 'rejected', `${box.constructor.name} 的提交被拒绝`)
  }
  assert.equal(view.handle.parameters, null, '值域不合格的参数不改动任何状态')

  // 循环引用编码不出身份：同样按非法参数拒绝，且不改动任何状态。
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(view.submit(cyclic).status, 'rejected')
  assert.equal(view.handle.parameters, null)

  // 编码得出身份的参数照常接纳并取数。
  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()
  assert.equal(view.last?.data, 1)
})

/**
 * 参数的隔离靠**每个消费者各一份副本**，不靠冻结（ADR-52）：`Object.freeze` 冻的是属性描述符，
 * 而 `Map.set` / `Set.add` / `Date.setTime` 写的是内部槽，规范上冻不住；框架私有那份既然不外发，
 * 就不需要任何「冻得住」的假设。
 */
test('A19 参数副本：validate、每轮 load 与每个接收者各拿一份副本，改自己的不影响别人', async () => {
  const seen: { id: number; tags: string[] }[] = []
  const source = defineRefresh<{ id: number; tags: string[] }, number>('/api/core/748', {
    validate: args => { (args as unknown as { tags: string[] }).tags.push('validate 改的'); return true },
  })
  const core = newCore(2, async (_url, body) => {
    const box = body as unknown as { id: number; tags: string[] }
    seen.push(box)
    box.tags.push('load 改的')
    return box.id
  })
  const a = page(core, source)
  const b = page(core, source)

  assert.equal(a.submit({ id: 1, tags: [] }).status, 'accepted')
  await settle()
  assert.deepEqual(seen[0]?.tags, ['load 改的'], 'load 改的是交给自己那份')
  assert.deepEqual(a.last?.args, { id: 1, tags: [] }, 'validate 与 load 的改写都没有进到身份里')

  a.refresh()
  await settle()
  assert.deepEqual(seen[1]?.tags, ['load 改的'], '上一轮 load 的改写没有留到下一轮')

  assert.equal(b.submit({ id: 1, tags: [] }).status, 'accepted')
  await settle()
  const argsOfA = a.last?.args as unknown as { tags: string[] }
  argsOfA.tags.push('A 页改的')
  assert.deepEqual(argsOfA.tags, ['A 页改的'], 'A 页改的是自己读到的那一份')
  assert.deepEqual(a.last?.args, { id: 1, tags: [] }, '下一次读到的仍是身份键所描述的那份值')
  assert.deepEqual(b.last?.args, { id: 1, tags: [] }, 'A 页改自己的参数影响不到 B 页')
})

/**
 * 这一条是「调用方不用写 try/catch」的总账：公开入口只给返回值、结果表这一格，或者什么都不给。
 * 唯一会同步抛错的是装配误用（`useRefresh` 不在 setup、没有协调者、`maxConcurrent` 非法、安装冲突），
 * 那些在 `vue.test.ts` 里各有一条，且都发生在第一次运行就能看见的固定位置。
 */
test('边界总账：运行期失败只走返回值或结果表这一格，公开入口都不抛错', async () => {
  // 取数侧：结果非法（`undefined`）与结果不可复制都只是后台失败，槽位当场交还。
  const broken: Array<{ name: string; post: FakePost }> = [
    { name: '/api/core/788', post: async () => undefined as unknown as number },
    { name: '/api/core/789', post: async () => ({ f: () => 1 }) },
  ]
  for (const { name, post } of broken) {
    const source = defineRefresh<object, unknown>(name)
    const core = newCore(1, post)
    const view = page(core, source)
    assert.doesNotThrow(() => { view.submit({ id: 1 }) })
    await settle()
    assert.ok(view.failure(), '运行期失败写进该格，入口不抛错')
    assert.equal(core.snapshot().running.length, 0)
  }

  // 参数侧：复制失败、编码不出、`validate` 拒绝，一律只给同步 `rejected`（不通知），也不产生实例。
  const source = defineRefresh<object, number>('/api/core/800', {
    validate: args => (args as { valid?: boolean }).valid !== false,
  })
  const core = newCore(1, async () => 1)
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
    assert.equal(page(newCore(1, async () => 1), defineRefresh<object, number>('/api/core/813', { validate })).submit({}).status, 'rejected')
  }
  assert.equal(view.failure(), null, '输入非法一律不进结果表')
  assert.equal(core.snapshot().resources.length, 0)

  // 刷新侧：入口状态不成立（这里是没有身份）时直接返回，不抛错、不需要 try/catch。
  assert.doesNotThrow(() => { view.refresh() })
  assert.equal(core.snapshot().resources.length, 0, '未声明身份的刷新不产生实例或请求')
})

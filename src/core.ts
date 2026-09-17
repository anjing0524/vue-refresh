import { CancelReason, ErrorOrigin } from './public-types.ts'
import type { RefreshDisplay, RefreshError, RefreshResult, SubmitResult } from './public-types.ts'
import { parameterKey } from './source.ts'
import type { Parameters, SourceRuntime } from './source.ts'

/**
 * 共享取数与调度核心。**全部运行时状态都在本文件**，只有三件事：
 *
 * - `buckets`：`Source → 参数键 → Resource`，一个「相同 Source ＋ 相同参数值」的共享实例；
 * - `Resource` 上的 `subscribers` 与 `waiters`：谁在按周期订阅它、谁在等一次显式刷新；
 * - `Resource.task` ＋ `queue`/`running`：它当前的一次后台执行、排队位置与真实并发槽。
 *
 * 一次取数与交付的完整链路（没有第二条路径）：
 *
 * ```text
 * submit ─ 准备参数 → 建立身份 → reconcile：资格成立就订阅，否则退订
 * refresh ─ 登记 waiter（版本下限）→ 没有当前任务就入队
 * flush  ─ 协调句柄 → 到期入队 → 按 FIFO 占槽启动 → 安排唯一唤醒 Timer
 * runTask ─ source.load → 复核任务身份 → 记结果 → publish（逐页独立副本 → 结算 waiter）
 * ```
 *
 * 交付、失败与取消都只改这三件事，不另立镜像：句柄的「当前订阅」是它自己身上的一个字段，
 * 实例侧的集合里是同一些句柄本身；没有第二个对象去描述同一份关系。
 */

/** 配置快照；读不出（getter 抛错或值非法）时为 `null`，此时既不订阅也不自动刷新。 */
export interface Config {
  readonly enabled: boolean
  readonly every: number | null
  readonly visible: boolean
}

/** 组件需求句柄：本页声明的身份、当前订阅与交付出口。字段都由本文件写，适配层只读。 */
export interface Handle<P extends object = object, T = unknown> {
  readonly source: SourceRuntime
  /** 最近一次配置快照。 */
  readonly config: () => Config | null
  /**
   * 本页交付出口。写成**方法**：方法参数双变，具体 `RefreshDisplay<P, T>` 因此可以直接进入
   * 擦除后的注册表槽位，适配层不必在创建点断言。
   */
  publish(display: RefreshDisplay<P, T>): void
  readonly onError: (error: RefreshError) => unknown
  cleanup: (() => void) | null
  /** 最近一次声明尝试的代次；只用于错误的归属（`0` 表示还没有任何页面操作）。 */
  operationId: number
  /** 已声明的身份；未声明时为 `null`。 */
  parameters: Parameters | null
  /** 当前订阅（实例 ＋ 本页间隔）；资格成立时存在，暂停页刷新时为空。 */
  subscription: { readonly resource: Resource; every: number } | null
  /** 组件是否挂载/激活。 */
  active: boolean
  disposed: boolean
}

/** 一次后台执行；执行位置由 `queue` / `running` 的归属决定。 */
export interface Task {
  readonly resource: Resource
  readonly version: number
  readonly controller: AbortController
}

/** 一次显式刷新尚未满足的要求：结果版本必须不低于 `min`。 */
export interface Waiter {
  readonly handle: Handle
  readonly min: number
  readonly settle: (result: RefreshResult) => void
}

/** 实例最近一次有效结果。 */
export interface Entry {
  readonly version: number
  readonly data: unknown
  readonly updatedAt: number
}

/** 一个「Source ＋ 参数值」的共享实例。 */
export interface Resource {
  readonly source: SourceRuntime
  readonly parameters: Parameters
  /** 按周期订阅本实例的句柄；各自的间隔在它们自己的 `subscription` 上。 */
  readonly subscribers: Set<Handle>
  /** 尚未结算的刷新要求。 */
  readonly waiters: Set<Waiter>
  entry: Entry | null
  /** 最近一次正常结束（成功或失败）的时刻；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null
  /** 最后一个已分配的任务版本。 */
  issued: number
  task: Task | null
}

/** 框架侧单次 `load` 的上限（毫秒）：从真正开始执行起算，排队等待不计入（数值与依据见 ADR-20）。 */
const LOAD_TIMEOUT_MS = 10_000

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 序号分配：安全整数区间内递增，到达上界后停在原地；不销毁、不抛错，也不给调用方第三种结果（ADR-23）。 */
function nextSequence(previous: number): number {
  return previous < Number.MAX_SAFE_INTEGER ? previous + 1 : previous
}

/** 调用页面提供的回调并隔离它的失败：同步抛错与异步拒绝都不改变框架状态。 */
function isolate(effect: () => unknown): void {
  try {
    const result: unknown = effect()
    if (result instanceof Promise) void result.catch(() => {})
  } catch {
    // 回调失败只吞掉这一条；已定结果、订阅与调度都不受影响。
  }
}

/** 经 `onError` 通知页面。框架自身的失败不进这条通道（它没有页面可报）。 */
export function report(handle: Handle, error: RefreshError): void {
  isolate(() => handle.onError(error))
}

/** 声明代次身份：`0` 不是有效代次，那一条通知就不带该字段（缺席表示不属于某次页面操作）。 */
function identity(handle: Handle): { operationId?: number } {
  return handle.operationId === 0 ? {} : { operationId: handle.operationId }
}

/** 结果边界：拒绝 `undefined`，其余原生复制；业务合法性由请求适配器负责。 */
function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('A request must return a result')
  return structuredClone(input)
}

export class RefreshCore {
  private readonly maxConcurrent: number
  /** Source → 参数键 → 实例。 */
  private readonly buckets = new Map<SourceRuntime, Map<string, Resource>>()
  /** 全部页面句柄；可见性变化时按它们重新协调。 */
  private readonly handles = new Set<Handle>()
  /** FIFO 待执行任务。 */
  private readonly queue = new Set<Task>()
  /** 真实尚未结束的任务；并发槽的唯一事实。 */
  private readonly running = new Set<Task>()
  /** 唯一 Timer 的取消句柄；调用即取消。 */
  private wakeup: (() => void) | null = null
  /** 已安排、尚未执行的一轮合并调度。 */
  private flushing = false
  /** 浏览器可见性这一项事实。 */
  private visible = true
  private cleanup: (() => void) | null = null
  private disposed = false

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent
  }

  // ══════════════════════════ 状态观测与生命周期 ══════════════════════════

  isDisposed(): boolean {
    return this.disposed
  }

  /** 浏览器可见性：隐藏时当场退订（取消立即结算），不等下一轮调度。 */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    for (const handle of [...this.handles]) this.coordinate(handle)
    this.flushSoon()
  }

  /** 登记框架自身的释放回调（应用卸载时移除可见性监听）；至多一个。 */
  setCleanup(cleanup: () => void): void {
    this.cleanup = cleanup
  }

  addHandle(handle: Handle): void {
    if (this.disposed) return
    this.handles.add(handle)
    this.reconcile(handle)
  }

  /** 释放一个句柄：先结算它的刷新要求，再退订并停止接纳。 */
  removeHandle(handle: Handle): void {
    if (handle.disposed) return
    handle.disposed = true
    this.handles.delete(handle)
    const cleanup = handle.cleanup
    handle.cleanup = null
    if (cleanup) isolate(cleanup)
    this.settleRefreshes(handle, CancelReason.Disposed)
    handle.parameters = null
    this.unsubscribe(handle)
    this.flushSoon()
  }

  /** 挂载/激活：恢复资格。与 `deactivate` 存在交叠（KeepAlive），因此两个方向都必须幂等。 */
  activate(handle: Handle): void {
    if (handle.disposed) return
    handle.active = true
    this.reconcile(handle)
  }

  /** 失活：撤销资格，并结算本页未完成的刷新要求。 */
  deactivate(handle: Handle): void {
    if (handle.disposed) return
    handle.active = false
    this.reconcile(handle)
  }

  /**
   * 配置或生命周期变化后的唯一入口：先协调关系，再安排一次合并调度。
   *
   * 两步必须分开：`coordinate` 在 `flush` 遍历句柄时也要跑，而那里不能再排一轮 flush。
   */
  reconcile(handle: Handle): void {
    this.coordinate(handle)
    this.flushSoon()
  }

  // ══════════════════════════ 页面操作 ══════════════════════════

  /** 声明或更新身份。相同参数值幂等；参数准备在身份被接纳之后才执行。 */
  submit(handle: Handle, prepare: () => Parameters): SubmitResult {
    if (this.disposed || handle.disposed) return { status: 'cancelled', reason: CancelReason.Disposed }
    handle.operationId = nextSequence(handle.operationId)

    let parameters: Parameters
    try {
      parameters = prepare()
    } catch (error) {
      // 无效声明不改动任何状态：旧身份、订阅与未结算的刷新要求原样保留。
      report(handle, { origin: ErrorOrigin.Validation, error, ...identity(handle) })
      return { status: 'rejected', error }
    }
    const declared = handle.parameters
    if (declared && declared.key === parameters.key) return { status: 'accepted' }

    // 顺序固定：先用旧身份结算刷新要求（它可能落在旧实例上），再退订，最后换身份并重新协调。
    this.settleRefreshes(handle, CancelReason.Superseded)
    this.unsubscribe(handle)
    handle.parameters = parameters
    this.reconcile(handle)
    return { status: 'accepted' }
  }

  /** 显式刷新：为当前身份登记一个「不低于某版本」的要求；不恢复自动刷新，也不改写调用方的开关。 */
  refresh(handle: Handle): Promise<RefreshResult> {
    const immediate = (result: RefreshResult): Promise<RefreshResult> => Promise.resolve(result)
    if (this.disposed || handle.disposed) return immediate({ status: 'cancelled', reason: CancelReason.Disposed })

    const config = handle.config()
    if (config === null) {
      return immediate({ status: 'error', origin: ErrorOrigin.Configuration, error: new TypeError('Invalid refresh configuration') })
    }
    if (!(handle.active && this.visible && config.visible)) {
      return immediate({ status: 'cancelled', reason: CancelReason.Unavailable })
    }
    const parameters = handle.parameters
    if (parameters === null) return immediate({ status: 'cancelled', reason: CancelReason.Unavailable })

    const resource = this.resourceFor(handle.source, parameters)
    let settle!: (result: RefreshResult) => void
    const result = new Promise<RefreshResult>(resolve => { settle = resolve })
    resource.waiters.add({ handle, min: this.floor(resource), settle })
    if (!resource.task) this.enqueue(resource)
    this.flushSoon()
    return result
  }

  // ══════════════════════════ 只读定位与观测面 ══════════════════════════

  /** 只读定位：按参数键查实例并返回独立副本。不创建实例、不保活、不执行 `validate`。 */
  readSnapshot(source: SourceRuntime, args: object): unknown {
    if (this.disposed) return undefined
    // 先算键再查实例：参数非法时抛给读取者，且与「此刻有没有活跃实例」无关。
    const key = parameterKey(args)
    const resource = this.buckets.get(source)?.get(key)
    return resource?.entry ? structuredClone(resource.entry.data) : undefined
  }

  /**
   * 只读计数投影：给演示面板与集成测试看状态。**不属于包契约**，也不提供改状态的入口；
   * 集合是副本，元素仍是核心对象（比较身份是这些断言的要点），因此它是观察面而不是安全边界。
   */
  snapshot(): {
    disposed: boolean
    visible: boolean
    handles: readonly Handle[]
    resources: readonly Resource[]
    queued: readonly Task[]
    running: readonly Task[]
    entries: Readonly<Partial<Record<string, Entry>>>
    scheduled: boolean
    flushing: boolean
  } {
    const resources: Resource[] = []
    const entries: Partial<Record<string, Entry>> = {}
    for (const bucket of this.buckets.values()) {
      for (const [key, resource] of bucket) {
        resources.push(resource)
        if (resource.entry) entries[key] = resource.entry
      }
    }
    return {
      disposed: this.disposed,
      visible: this.visible,
      handles: [...this.handles],
      resources,
      queued: [...this.queue],
      running: [...this.running],
      entries,
      scheduled: this.wakeup !== null,
      flushing: this.flushing,
    }
  }

  /** 销毁：幂等、不可复用。未结束的执行仍会真实结束，并在自己的 `finally` 里释放槽位。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWakeup()
    this.queue.clear()
    const cleanup = this.cleanup
    this.cleanup = null
    if (cleanup) isolate(cleanup)
    for (const handle of [...this.handles]) this.removeHandle(handle)
    this.buckets.clear()
  }

  // ══════════════════════════ 需求关系 ══════════════════════════

  /**
   * 按最新配置与生命周期协调一个句柄；资格成立则接入或更新订阅，否则退订。
   *
   * 四组事实缺一不可：存活、已声明身份、环境允许（激活且浏览器可见）、配置明确开启且有周期。
   * 刷新要求不参与资格：它由 `refresh` 的入口闸与 `waiters` 的归属表达，因此暂停页仍可刷新。
   */
  private coordinate(handle: Handle): void {
    if (this.disposed || handle.disposed) return
    const present = handle.active && this.visible
    if (!present) this.settleRefreshes(handle, CancelReason.Unavailable)

    const config = handle.config()
    const parameters = handle.parameters
    const every = config?.every ?? null
    const subscribed = handle.subscription
    if (!present || !config?.enabled || !config.visible || every === null || parameters === null) {
      if (subscribed) this.unsubscribe(handle)
      return
    }
    if (subscribed) {
      // 改频率只更新间隔：保留在途请求，由下一次调度按新间隔重算到期。
      subscribed.every = every
      return
    }
    const resource = this.resourceFor(handle.source, parameters)
    // 一个身份只保留一份参数对象：后加入者采用实例已持有的那一份（同键等值，且已冻结）。
    handle.parameters = resource.parameters
    handle.subscription = { resource, every }
    resource.subscribers.add(handle)
    // 已有结果立即交付（恢复时拿历史结果，不重复取数）；没有结果时交给这一轮 flush 的到期遍历首查。
    if (resource.entry) this.deliverTo(handle, resource, resource.entry)
  }

  /** 按「Source 身份 ＋ 完整参数值稳定键」查找，没有就建立实例。 */
  private resourceFor(source: SourceRuntime, parameters: Parameters): Resource {
    let bucket = this.buckets.get(source)
    if (!bucket) {
      bucket = new Map()
      this.buckets.set(source, bucket)
    }
    const existing = bucket.get(parameters.key)
    if (existing) return existing

    const resource: Resource = {
      source, parameters, subscribers: new Set(), waiters: new Set(),
      entry: null, settledAt: null, issued: 0, task: null,
    }
    bucket.set(parameters.key, resource)
    return resource
  }

  /** 本页已声明身份所在的实例；只查不建（结算刷新要求时用）。 */
  private resourceOf(handle: Handle): Resource | undefined {
    const subscription = handle.subscription
    if (subscription) return subscription.resource
    const parameters = handle.parameters
    return parameters ? this.buckets.get(handle.source)?.get(parameters.key) : undefined
  }

  /** 实例仍注册在自己的参数键上。 */
  private registered(resource: Resource): boolean {
    return this.buckets.get(resource.source)?.get(resource.parameters.key) === resource
  }

  private unsubscribe(handle: Handle): void {
    const subscription = handle.subscription
    if (!subscription) return
    handle.subscription = null
    subscription.resource.subscribers.delete(handle)
    this.releaseIfUnused(subscription.resource)
  }

  /** 没有订阅者也没有刷新要求：删实例与排队任务，abort 在途；迟到的结束在任务身份复核处失效。 */
  private releaseIfUnused(resource: Resource): void {
    if (resource.subscribers.size > 0 || resource.waiters.size > 0) return
    if (!this.registered(resource)) return
    const bucket = this.buckets.get(resource.source)
    bucket?.delete(resource.parameters.key)
    if (bucket?.size === 0) this.buckets.delete(resource.source)

    const task = resource.task
    resource.task = null
    resource.entry = null
    if (task) {
      this.queue.delete(task)
      task.controller.abort()
    }
  }

  // ══════════════════════════ 后台执行 ══════════════════════════

  /** 分配版本并登记一次后台执行；全部调用点都先确认没有当前任务，因此不替换、不 abort 在途。 */
  private enqueue(resource: Resource): void {
    const version = nextSequence(resource.issued)
    resource.issued = version
    const task: Task = { resource, version, controller: new AbortController() }
    resource.task = task
    this.queue.add(task)
  }

  private async runTask(task: Task): Promise<void> {
    const resource = task.resource
    // 上限从真正开始执行起算（排队不计入）：一个永不结束的 load 不能永久占住并发槽。
    const timer = setTimeout(() => { this.expire(task) }, LOAD_TIMEOUT_MS)
    try {
      const raw = await resource.source.load(resource.parameters.args, { signal: task.controller.signal })
      if (resource.task !== task) return
      const entry: Entry = { version: task.version, data: copyResult(raw), updatedAt: Date.now() }
      if (resource.task !== task) return
      resource.settledAt = Date.now()
      this.publish(resource, entry)
    } catch (error) {
      if (resource.task === task) this.fail(resource, error)
    } finally {
      clearTimeout(timer)
      this.running.delete(task)
      if (resource.task === task) resource.task = null
      this.refill(resource)
      this.flushSoon()
    }
  }

  /**
   * 上限到期：先撤销在册身份再触发会同步重入的外部效果，因此这次执行迟到的结束被判为无效
   * （不写 Store、不交付、不二次通知），而槽位当场交还调度。
   */
  private expire(task: Task): void {
    const resource = task.resource
    if (resource.task !== task) return
    resource.task = null
    this.running.delete(task)
    task.controller.abort()
    this.fail(resource, new Error(`load did not settle within ${LOAD_TIMEOUT_MS} ms`))
    this.refill(resource)
    this.flushSoon()
  }

  /**
   * 该实例此刻的下次到期时刻：由「最近一次结算时刻 ＋ 当前最短间隔」现算，因此改频率立刻生效；
   * 从未结算过的实例立即到期。取消不计时、不补跑漏掉的周期。
   */
  private dueAt(resource: Resource, now: number): number {
    return resource.settledAt === null ? now : resource.settledAt + this.shortestEvery(resource)
  }

  /** 有效间隔现算：所有订阅的最小值，不缓存。 */
  private shortestEvery(resource: Resource): number {
    let every = Infinity
    for (const handle of resource.subscribers) {
      const subscription = handle.subscription
      if (subscription && subscription.resource === resource) every = Math.min(every, subscription.every)
    }
    return every
  }

  /**
   * 共享请求失败（含上限到期）：通知仍有效的订阅者，并按同一失败结算该实例全部未完成的要求。
   * 失败保留画面、需求与开启意愿，下个周期继续。
   */
  private fail(resource: Resource, error: unknown): void {
    resource.settledAt = Date.now()
    for (const handle of [...resource.subscribers]) {
      if (!resource.subscribers.has(handle)) continue
      report(handle, { origin: ErrorOrigin.Request, error, ...identity(handle) })
    }
    for (const waiter of [...resource.waiters]) {
      this.settleWaiter(resource, waiter, { status: 'error', origin: ErrorOrigin.Request, error })
    }
  }

  /** 后台成功：收货方一次收齐（有效订阅 ∪ 满足版本门槛的刷新要求），同一句柄只交付一次。 */
  private publish(resource: Resource, entry: Entry): void {
    resource.entry = entry
    const satisfied: Waiter[] = []
    const refreshing = new Set<Handle>()
    for (const waiter of [...resource.waiters]) {
      if (waiter.min > entry.version) continue
      satisfied.push(waiter)
      refreshing.add(waiter.handle)
    }
    const delivered = new Set<Handle>()
    for (const handle of [...resource.subscribers]) {
      // 前一个接收者的回调可能已经改身份或退订，因此每个交付点重新复核归属。
      if (!resource.subscribers.has(handle)) continue
      delivered.add(handle)
      this.deliverTo(handle, resource, entry)
    }
    for (const handle of refreshing) {
      if (!delivered.has(handle)) this.deliverTo(handle, resource, entry)
    }
    // 结算在交付之后：`await refresh()` 返回 success 时本页 display 已经是这次的结果。
    for (const waiter of satisfied) this.settleWaiter(resource, waiter, { status: 'success' })
  }

  /** 交付一份独立副本。 */
  private deliverTo(handle: Handle, resource: Resource, entry: Entry): void {
    isolate(() => handle.publish({
      args: resource.parameters.args,
      data: structuredClone(entry.data),
      updatedAt: entry.updatedAt,
    }))
  }

  // ══════════════════════════ 刷新要求 ══════════════════════════

  /**
   * 本次要求的下限：排队未启动的任务算「动作之后启动」，可以直接满足它；
   * 已在执行的任务不算，本次刷新等它结束后补一次后继请求。
   */
  private floor(resource: Resource): number {
    const task = resource.task
    if (!task) return resource.issued
    return this.running.has(task) ? task.version + 1 : task.version
  }

  /** 结算一个句柄未完成的要求（失去存在、身份被替代、卸载、销毁都由它收尾）。 */
  private settleRefreshes(handle: Handle, reason: CancelReason): void {
    const resource = this.resourceOf(handle)
    if (!resource) return
    for (const waiter of [...resource.waiters]) {
      if (waiter.handle === handle) this.settleWaiter(resource, waiter, { status: 'cancelled', reason })
    }
  }

  private settleWaiter(resource: Resource, waiter: Waiter, result: RefreshResult): void {
    if (!resource.waiters.delete(waiter)) return
    waiter.settle(result)
    this.releaseIfUnused(resource)
  }

  /** 任务结束后仍有未完成的要求、又没有当前任务时，补一次后继请求。 */
  private refill(resource: Resource): void {
    if (resource.waiters.size === 0 || resource.task !== null) return
    if (!this.registered(resource)) return
    this.enqueue(resource)
  }

  // ══════════════════════════ 调度 ══════════════════════════

  /** 安排一次合并调度；同一轮内的多次请求合并成一个微任务。 */
  private flushSoon(): void {
    if (this.flushing || this.disposed) return
    this.flushing = true
    queueMicrotask(() => { this.flush() })
  }

  /**
   * 一次 flush：协调句柄 → 到期入队 → 按 FIFO 用可用槽位启动 → 设置唯一唤醒 Timer。
   *
   * 满槽的队列由任务结束唤醒（不自旋）；本轮内新增的请求留给下一轮。
   */
  private flush(): void {
    this.flushing = false
    if (this.disposed) return
    this.clearWakeup()
    for (const handle of [...this.handles]) this.coordinate(handle)

    const now = Date.now()
    let next = Infinity
    for (const bucket of this.buckets.values()) {
      for (const resource of bucket.values()) {
        if (resource.task || resource.subscribers.size === 0) continue
        const due = this.dueAt(resource, now)
        if (due <= now) this.enqueue(resource)
        else next = Math.min(next, due)
      }
    }
    for (const task of [...this.queue]) {
      if (task.resource.task !== task) {
        this.queue.delete(task)
        continue
      }
      if (this.running.size >= this.maxConcurrent) break
      this.queue.delete(task)
      this.running.add(task)
      void this.runTask(task)
    }
    if (this.queue.size === 0 && next < Infinity) this.setWakeup(next)
  }

  private clearWakeup(): void {
    const cancel = this.wakeup
    this.wakeup = null
    if (cancel) cancel()
  }

  private setWakeup(due: number): void {
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, due - Date.now()))
    const timer = setTimeout(() => {
      this.wakeup = null
      this.flushSoon()
    }, delay)
    this.wakeup = () => { clearTimeout(timer) }
  }
}

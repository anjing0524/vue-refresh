import type { RefreshSource, SubmitResult } from './public-types.ts'
import type { Parameters } from './source.ts'

/**
 * 共享取数与调度核心：**只管跨实例的事**——注册表、句柄名册、可见性与销毁、FIFO 队列、并发槽、
 * 唯一唤醒 Timer、只读投影。一个身份自己的全部状态与操作在 `Resource` 里。
 *
 * 一次取数与交付的链路（唯一路径）见 DESIGN §2.1；「同一份关系不另立镜像」的理由见 DESIGN §3.1。
 */

/** 配置快照：开启意愿与刷新间隔两项，由适配层现读；读不出时为 `null`（后果见 DESIGN §6.1）。 */
export interface Config {
  readonly enabled: boolean
  readonly every: number
}

/**
 * 组件需求句柄：三种角色挂在一个对象上，读之前先分清是哪一组——**组 A｜端口与配置**（`source` / `config` /
 * `onError`）由适配层给、核心只读、**组 B｜状态**（`parameters` / `active`）由核心独占写入、
 * **组 C｜接驳**（`cleanup`）双向。完整所有权表见 DESIGN §3.3。
 *
 * 两件事不存字段：**是否已释放**是 `RefreshCore.handles` 的名册成员资格（DESIGN §3.7），
 * **订阅到哪个实例**是那个实例 `subscribers` 的成员资格（DESIGN §3.5 第 1 条）。
 */
export interface Handle<P extends object = object, T = unknown> {
  /** 擦除后的固定定义（URL ＋ 参数准入）：具体 Source 靠 `validate` 的方法双变进入这里。 */
  readonly source: RefreshSource<object, unknown>
  /** 最近一次配置快照；适配层每读到新值就改写，核心只读。 */
  config: Config | null
  readonly onError: (error: unknown) => unknown
  /** 适配层的释放回调；`removeHandle` 读一次、清空，然后调用它。 */
  cleanup: (() => void) | null
  /** 已声明的身份；未声明时为 `null`。 */
  parameters: Parameters | null
  /** 组件是否挂载/激活。 */
  active: boolean
}

/** 一次后台执行；执行位置由 `queue` / `running` 的归属决定。 */
export interface Task {
  readonly resource: Resource
  readonly controller: AbortController
}

/** 一次有效取数的结果；写进结果表后就当**不可变**用（整条替换，不就地改）。 */
export interface Entry {
  readonly data: unknown
  readonly updatedAt: number
}

/** 结果表的一行。 */
export interface ResultRow {
  readonly url: string
  readonly key: string
  readonly entry: Entry
}

/**
 * 结果表：**结果的唯一真值**，按「URL → 参数键」两级分组。
 *
 * 内核只经这三个动作碰它：成功时 `write`、实例释放时 `remove`、只读投影时 `list`。
 * 适配层把它接到 Pinia（`src/store.ts`），因此 `core.ts` 仍然零运行时依赖。
 */
export interface ResultSink {
  write(url: string, key: string, entry: Entry): void
  remove(url: string, key: string): void
  list(): readonly ResultRow[]
}

/**
 * 一个「URL ＋ 参数值」的共享实例：同一个身份的**全部状态与全部操作都在这个类里**。
 *
 * 越过实例边界的事（FIFO 队列、并发槽、注册表注销）只调核心的两个入口（`enqueue` / `releaseIfUnused`），
 * 所以「一个身份的一生」可以只读这一个类：接入 → 到期 → 执行 → 交付或失败 → 结算要求 → 回收。
 */
export class Resource {
  /** 实例只经核心的两个入口请求跨实例动作（ADR-42、ADR-44）。 */
  private readonly core: RefreshCore
  readonly source: RefreshSource<object, unknown>
  readonly parameters: Parameters
  /** 按周期订阅本实例的句柄；各自的间隔从它们自己的配置快照现算。 */
  readonly subscribers = new Set<Handle>()
  /** 仍想要一次取数的句柄（显式刷新登记的要求）。它是**标志**而不是队列：重复刷新同一个句柄只留一份。 */
  readonly waiters = new Set<Handle>()
  /** 最近一次正常结束（成功或失败）的时刻；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null = null
  task: Task | null = null

  constructor(core: RefreshCore, source: RefreshSource<object, unknown>, parameters: Parameters) {
    this.core = core
    this.source = source
    this.parameters = parameters
  }

  /** 有效间隔现算：所有订阅的最小值，不缓存。 */
  shortestEvery(): number {
    let every = Infinity
    for (const handle of this.subscribers) {
      // 订阅成立 ⟹ 配置快照有效（§3.5 第 12 条），因此间隔现算，不在句柄或实例上另存一份。
      const config = handle.config
      if (config) every = Math.min(every, config.every)
    }
    return every
  }

  /** 该实例此刻的下次到期时刻：`settledAt ＋ 当前最短间隔`；从未结算过的实例立即到期。取消不计时不补跑。 */
  dueAt(now: number): number {
    return this.settledAt === null ? now : this.settledAt + this.shortestEvery()
  }

  /**
   * 成功结算：记结算时刻、把结果写进结果表（唯一真值），再满足这一批刷新要求。
   *
   * 这里**没有交付循环**：谁在读、读几次、读到的是哪一版，都由读的人在结果表上自己取（ADR-59）。
   * 顺序固定：先落定结果，再结算要求——要求结算可能让实例当场释放，而释放会把结果删掉（A06）。
   */
  settle(entry: Entry): void {
    this.settledAt = Date.now()
    // 这一批要满足的要求**先定下来再写结果**：写结果表会同步触发页面代码（例如 `flush: 'sync'` 的 watcher），
    // 它可能当场 `refresh()`；那条新要求不在这一批里，只能由 `refill` 的后继请求满足（§3.9 第一条）。
    const satisfied = [...this.waiters]
    this.core.writeResult(this, entry)
    for (const handle of satisfied) this.clearRequest(handle)
  }

  /**
   * 失败结算：通知仍有效的订阅者与本次有未完成要求的页面（后者没有回执，这是它唯一的失败通道），
   * 然后撤销本实例全部未完成的刷新要求。
   */
  fail(error: unknown): void {
    this.settledAt = Date.now()
    const notified = new Set<Handle>(this.subscribers)
    for (const handle of this.waiters) notified.add(handle)
    for (const handle of notified) {
      // 前一个页面的 `onError` 可能已经改身份或退订，因此每个通知点重新复核归属。
      if (!this.subscribers.has(handle) && !this.waiters.has(handle)) continue
      report(handle, error)
    }
    for (const handle of [...this.waiters]) this.clearRequest(handle)
  }

  /** 撤销一个句柄的刷新要求；它可能是本实例的最后一个需求，因此顺手让核心判断要不要回收这个实例。 */
  clearRequest(handle: Handle): void {
    if (!this.waiters.delete(handle)) return
    this.core.releaseIfUnused(this)
  }

  /** 任务结束后仍有未完成的要求时补一次请求；唯一来源是交付回调里的重入（DESIGN §3.9 第一条）。 */
  refill(): void {
    if (this.waiters.size === 0 || this.task !== null) return
    this.core.enqueue(this)
  }

}

/** 框架侧单次取数的上限（毫秒）：从真正开始执行起算，排队等待不计入（数值与依据见 ADR-20）。 */
const LOAD_TIMEOUT_MS = 10_000

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 调用页面提供的回调并隔离它的失败：同步抛错与异步拒绝都不改变框架状态。 */
function isolate(effect: () => unknown): void {
  try {
    const result: unknown = effect()
    if (result instanceof Promise) void result.catch(() => {})
  } catch {
    // 回调失败只吞掉这一条；已定结果、订阅与调度都不受影响。
  }
}

/** 经 `onError` 通知页面：**只报共享请求失败**，参数是原始异常（ADR-51）。框架自身的失败不进这条通道。 */
export function report(handle: Handle, error: unknown): void {
  isolate(() => handle.onError(error))
}

/** 结果边界：拒绝 `undefined`，其余原生复制；业务合法性由请求适配器负责。 */
function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('取数结果不能是 undefined')
  return structuredClone(input)
}

/** 取数传输：框架只需要一个 POST。真实的 axios 实例在结构上满足它（见 `createRefreshManager`）。 */
export interface RefreshHttp {
  post(url: string, data: unknown, config: { readonly signal: AbortSignal }): Promise<{ readonly data: unknown }>
}

/** 跨实例的协调者：实例注册表、句柄名册、FIFO 队列与并发槽、唯一唤醒 Timer、可见性与销毁。 */
export class RefreshCore {
  private readonly maxConcurrent: number
  /** 取数用的 axios 实例；内核只调它的 `post`，因此 core.ts 仍然零运行时依赖。 */
  private readonly http: RefreshHttp
  /** 结果表：结果的唯一真值，适配层接在 Pinia 上（`src/store.ts`）。 */
  private readonly sink: ResultSink
  /** URL → 参数键 → 实例。 */
  private readonly buckets = new Map<string, Map<string, Resource>>()
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

  constructor(maxConcurrent: number, http: RefreshHttp, sink: ResultSink) {
    this.maxConcurrent = maxConcurrent
    this.http = http
    this.sink = sink
  }

  // ══════════════════════════ 状态观测与生命周期 ══════════════════════════

  /** 协调者是否已销毁；存活状态的唯一公开出口。 */
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

  /** 登记一个句柄并协调它。调用方保证协调者尚未销毁：`useRefresh` 在造出句柄之前就查过 `isDisposed`。 */
  addHandle(handle: Handle): void {
    this.handles.add(handle)
    this.reconcile(handle)
  }

  /** 释放一个句柄：先结算它的刷新要求，再退订并停止接纳。名册成员资格就是「是否已释放」。 */
  removeHandle(handle: Handle): void {
    if (!this.handles.has(handle)) return
    this.handles.delete(handle)
    const cleanup = handle.cleanup
    handle.cleanup = null
    if (cleanup) isolate(cleanup)
    // 退订要按身份找实例，因此必须在清空 `parameters` 之前（它与 `clearRefreshes` 都读身份）。
    this.clearRefreshes(handle)
    this.unsubscribe(handle)
    handle.parameters = null
    this.flushSoon()
  }

  /** 挂载/激活：恢复资格。与 `deactivate` 存在交叠（KeepAlive），因此两个方向都必须幂等。 */
  activate(handle: Handle): void {
    if (!this.handles.has(handle)) return
    handle.active = true
    this.reconcile(handle)
  }

  /** 失活：撤销资格，并结算本页未完成的刷新要求。 */
  deactivate(handle: Handle): void {
    if (!this.handles.has(handle)) return
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
    if (this.disposed || !this.handles.has(handle)) return { status: 'cancelled' }

    let parameters: Parameters
    try {
      parameters = prepare()
    } catch (error) {
      // 无效声明不改动任何状态：旧身份、订阅与未结算的刷新要求原样保留。
      // 输入问题不走 `onError`：它由本次调用的同步返回值说清楚（ADR-51）。
      return { status: 'rejected', error }
    }
    const declared = handle.parameters
    if (declared && declared.key === parameters.key) return { status: 'accepted' }

    // 顺序固定：先用旧身份撤销刷新要求（它可能落在旧实例上），再退订，最后换身份并重新协调。
    this.clearRefreshes(handle)
    this.unsubscribe(handle)
    handle.parameters = parameters
    this.reconcile(handle)
    return { status: 'accepted' }
  }

  /**
   * 显式刷新：有当前请求就直接用它的结果，没有就当场登记一次；不恢复自动刷新，也不改写调用方的开关。
   *
   * **不回执**：成功只经 `display`，失败只经 `onError`。入口条件不成立时直接返回、不产生副作用也不通知。
   */
  refresh(handle: Handle): void {
    if (this.disposed || !this.handles.has(handle)) return
    if (handle.config === null) return
    if (!(handle.active && this.visible)) return
    const parameters = handle.parameters
    if (parameters === null) return

    const resource = this.resourceFor(handle.source, parameters)
    // 有请求就直接用：`enqueue` 的三个调用点都先确认没有当前任务，因此有 `task` 时它就是本实例唯一的请求；
    // 没有请求时由本次登记的任务满足。同一个句柄重复刷新只留一份要求。
    resource.waiters.add(handle)
    if (!resource.task) this.enqueue(resource)
    this.flushSoon()
  }

  // ══════════════════════════ 观测面 ══════════════════════════

  /** 只读计数投影：给演示面板、基准脚本与集成测试看状态。**不属于包契约**，也不提供改状态的入口。 */
  snapshot(): {
    handles: readonly Handle[]
    resources: readonly Resource[]
    results: readonly ResultRow[]
    queued: readonly Task[]
    running: readonly Task[]
    scheduled: boolean
    flushing: boolean
  } {
    const resources: Resource[] = []
    for (const bucket of this.buckets.values()) {
      for (const resource of bucket.values()) resources.push(resource)
    }
    return {
      handles: [...this.handles],
      resources,
      results: this.sink.list(),
      queued: [...this.queue],
      running: [...this.running],
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
    if (this.disposed || !this.handles.has(handle)) return
    const present = handle.active && this.visible
    if (!present) this.clearRefreshes(handle)

    const config = handle.config
    const parameters = handle.parameters
    const resource = this.resourceOf(handle)
    const subscribed = resource?.subscribers.has(handle) ?? false
    if (!present || !config?.enabled || parameters === null) {
      if (subscribed) this.unsubscribe(handle)
      return
    }
    // 已订阅：改频率不需要重建连接（间隔现算），在途请求也保留，下一次调度按新间隔重算到期。
    if (subscribed) return
    // `resourceOf` 没找到就当场建立；找到了就是它，不必再查一次桶。
    const target = resource ?? this.resourceFor(handle.source, parameters)
    // 一个身份只保留一份参数对象：后加入者采用实例已持有的那一份（同键等值）。这份是框架私有权威副本，
    // 外发给每个消费者（`validate`／每轮请求体／每个接收者的 `display`）时各复制一份（ADR-52）。
    handle.parameters = target.parameters
    target.subscribers.add(handle)
  }

  /** 按「URL ＋ 完整参数值稳定键」查找，没有就建立实例。 */
  private resourceFor(source: RefreshSource<object, unknown>, parameters: Parameters): Resource {
    let bucket = this.buckets.get(source.name)
    if (!bucket) {
      bucket = new Map()
      this.buckets.set(source.name, bucket)
    }
    const existing = bucket.get(parameters.key)
    if (existing) return existing

    const resource = new Resource(this, source, parameters)
    bucket.set(parameters.key, resource)
    return resource
  }

  /** 本页已声明身份所在的实例；只查不建（协调资格、结算刷新要求、退订都用它）。 */
  private resourceOf(handle: Handle): Resource | undefined {
    const parameters = handle.parameters
    return parameters ? this.buckets.get(handle.source.name)?.get(parameters.key) : undefined
  }

  /** 退订一个句柄；退订后若订阅与要求都空了，实例随之被回收。 */
  private unsubscribe(handle: Handle): void {
    const resource = this.resourceOf(handle)
    if (!resource?.subscribers.delete(handle)) return
    this.releaseIfUnused(resource)
  }

  /**
   * 没有订阅者也没有刷新要求：删实例与排队任务，abort 在途；迟到的结束在任务身份复核处失效。**实例入口**。
   * 只判「都空」就够：注销是唯一的删除路径，此刻这个键指向的必定是它自己（§3.5 第 11 条）。
   */
  releaseIfUnused(resource: Resource): void {
    if (resource.subscribers.size > 0 || resource.waiters.size > 0) return
    const bucket = this.buckets.get(resource.source.name)
    bucket?.delete(resource.parameters.key)
    if (bucket?.size === 0) this.buckets.delete(resource.source.name)

    const task = resource.task
    // 结果随实例释放即删：结果表里没有「没人要的」条目，读的人也就不会读到过期数据。
    this.sink.remove(resource.source.name, resource.parameters.key)
    if (task) {
      // 在跑的那次不能当场交还槽位：它仍占着并发账本，必须等迟到的结束自己交还（`detached`）。
      this.placeTask(task, this.running.has(task) ? 'detached' : 'settled')
      task.controller.abort()
    }
  }

  /** 把一次成功写进结果表。**实例入口**：结果住结果表，实例只在成功这一刻与它打交道。 */
  writeResult(resource: Resource, entry: Entry): void {
    this.sink.write(resource.source.name, resource.parameters.key, entry)
  }

  // ══════════════════════════ 后台执行 ══════════════════════════

  /**
   * 任务位置（`queue` / `running` / `Resource.task`）的唯一写入点。
   *
   * `queued`／`running` 是「占着并发账本的某一格，且是本实例的当前执行」；`detached` 是实例已被回收、
   * 当前执行已撤销，但在跑的那次仍占着槽位，直到迟到的结束自己交还（`releaseIfUnused`——槽位若当场
   * 交还，在途的请求就与后来者并发了）；`settled` 是三处都不在。
   */
  private placeTask(task: Task, position: 'queued' | 'running' | 'detached' | 'settled'): void {
    this.queue.delete(task)
    this.running.delete(task)
    if (position === 'queued') this.queue.add(task)
    if (position === 'running' || position === 'detached') this.running.add(task)
    // 撤销当前执行要认人：`expire` 交还槽位后可能已经登记了后继任务，那一刻它才是当前执行。
    if (position === 'queued' || position === 'running') task.resource.task = task
    else if (task.resource.task === task) task.resource.task = null
  }

  /** 登记一次后台执行；全部调用点都先确认没有当前任务，因此不替换、不 abort 在途。**实例入口**。 */
  enqueue(resource: Resource): void {
    const task: Task = { resource, controller: new AbortController() }
    this.placeTask(task, 'queued')
  }

  /** 执行一次后台请求；成功、失败或被上限结算，都在 `finally` 释放槽位并补后继请求。 */
  private async runTask(task: Task): Promise<void> {
    const resource = task.resource
    // 上限从真正开始执行起算（排队不计入）：一个永不结束的请求不能永久占住并发槽。
    const timer = setTimeout(() => { this.expire(task) }, LOAD_TIMEOUT_MS)
    try {
      // 每一轮都交出一份副本：请求体改不动身份键描述的那份值（ADR-52）。URL 与参数值一起决定身份，
      // 因此「同一个 URL ＋ 同一份参数值」在这里只会有一条执行（合并发生在 `resourceFor`）。
      const response = await this.http.post(
        resource.source.name,
        structuredClone(resource.parameters.args),
        { signal: task.controller.signal },
      )
      if (resource.task !== task) return
      const entry: Entry = { data: copyResult(response.data), updatedAt: Date.now() }
      if (resource.task !== task) return
      resource.settle(entry)
    } catch (error) {
      if (resource.task === task) resource.fail(error)
    } finally {
      clearTimeout(timer)
      this.placeTask(task, 'settled')
      resource.refill()
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
    this.placeTask(task, 'settled')
    task.controller.abort()
    resource.fail(new Error(`取数未在框架上限 ${LOAD_TIMEOUT_MS} 毫秒内结束`))
    resource.refill()
    this.flushSoon()
  }

  // ══════════════════════════ 刷新要求 ══════════════════════════

  /** 撤销一个句柄未完成的刷新要求（失去存在、身份被替代、卸载、销毁都由它收尾）。 */
  private clearRefreshes(handle: Handle): void {
    const resource = this.resourceOf(handle)
    if (resource) resource.clearRequest(handle)
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
        const due = resource.dueAt(now)
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
      this.placeTask(task, 'running')
      void this.runTask(task)
    }
    if (this.queue.size === 0 && next < Infinity) this.setWakeup(next)
  }

  /** 取消唯一唤醒 Timer；没有安排时什么也不做。 */
  private clearWakeup(): void {
    const cancel = this.wakeup
    this.wakeup = null
    if (cancel) cancel()
  }

  /** 安排唯一唤醒 Timer；到期时刻超出平台上限时分段等待。 */
  private setWakeup(due: number): void {
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, due - Date.now()))
    const timer = setTimeout(() => {
      this.wakeup = null
      this.flushSoon()
    }, delay)
    this.wakeup = () => { clearTimeout(timer) }
  }
}

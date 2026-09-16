import { EFFECT_FAILED, cloneSnapshot, copyResult, declarationIdentity, notify, observe } from './delivery.ts'
import { reportObserverError } from './diagnostics.ts'
import { Scheduler } from './scheduler.ts'
import type { Parameters, SourceRuntime } from './source.ts'
import type {
  Clock, Handle, Input, ManagerInspection, RefreshWaiter, Resource, ResultStore, ScheduleHost,
  StoreEntry, Subscription, Task, ValidInput,
} from './model.ts'
import { CancelReason, ErrorOrigin, RequestOrigin } from './public-types.ts'
import type { RefreshResult, SubmitResult } from './public-types.ts'

/** 一次成功结果的全部收货方；订阅与刷新要求在同一处收齐，同一句柄只交付一次。 */
interface Publisher {
  readonly handle: Handle
  readonly subscription: Subscription | null
  readonly waiter: RefreshWaiter | null
  readonly data: unknown
}

/**
 * 应用协调者：拥有页面需求与资源注册表，并把后台调度委托给 {@link Scheduler}。
 *
 * 声明（{@link submit}）与刷新（{@link refresh}）共用同一条获取与交付路径：
 * - 声明建立或更新身份；资格成立时接入共享实例，到期由调度器登记任务；
 * - 刷新为同一身份登记一次「不低于某版本」的临时要求，需要时就地登记任务，不等周期。
 * 交付的接收者是「有效订阅 ∪ 满足本次版本门槛的刷新要求」，两者都只经
 * {@link publishResult} / {@link publishError} 到达。
 *
 * 两类事实是「唯一」的：
 * - `handles` 是页面需求的唯一集合，句柄的每个字段只有本文件会写；
 * - `resources` 是共享实例的唯一注册表，最后一个订阅与刷新要求都退出即销毁。
 *
 * 这些可变状态全部是 `private`：外部只能调用下面这些被命名过的操作，或通过
 * {@link inspect} 读一份只读投影。`DESIGN.md` 「谁写哪个字段」的表因此在编译期成立，
 * 而不是靠约定。
 *
 * 全文反复出现的一条顺序约束：**先建立新身份（新 operationId / 新 Task / 新订阅），
 * 再触发会同步重入的外部效果（abort、Store 通知、publish、onError）。**
 * 每一步之后都要重新复核当前身份，旧执行只允许清理自己。
 */
export class Manager {
  /** 组件需求句柄。 */
  private readonly handles = new Set<Handle>()
  /** Source → 参数键 → 运行实例。 */
  private readonly resources = new Map<SourceRuntime, Map<string, Resource>>()
  private readonly store: ResultStore
  /** 资源 id 前缀，区分不同 Manager 实例。 */
  private readonly namespace: string
  /** 唯一 Timer、FIFO 队列与并发槽位；本类只通过命名操作使用它。 */
  private readonly scheduler: Scheduler
  /** Manager 自身的释放回调；至多一个。 */
  private cleanup: (() => void) | null = null
  private issuedResourceId = 0
  private browserVisible = true
  private disposed = false
  /** 可控时间端口。 */
  readonly clock: Clock

  constructor(store: ResultStore, clock: Clock, maxConcurrent: number, namespace: string) {
    this.store = store
    this.clock = clock
    this.namespace = namespace
    // 宿主回调用对象字面量满足端口：既不需要转发类，也不会扩大 Manager 的公共面。
    const host: ScheduleHost = {
      isDisposed: () => this.disposed,
      reconcileHandles: () => {
        for (const handle of [...this.handles]) {
          // 两步分开：synchronize 只决定「还要不要有订阅」，attach 只决定「接入哪个实例」。
          // 中间可能有 abort / 通知回调同步重入，所以 attach 重新读取声明与资格。
          this.synchronize(handle)
          this.attach(handle)
        }
      },
      enqueueTask: resource => this.enqueueTask(resource),
      isCurrentTask: task => this.currentTask(task),
      startTask: task => { void this.startTask(task) },
    }
    this.scheduler = new Scheduler(clock, maxConcurrent, this.resources, host)
  }

  // ══════════════════════════════ 状态观测 ══════════════════════════════

  /** Manager 是否已销毁；销毁后所有入口立即拒绝。 */
  isDisposed(): boolean {
    return this.disposed
  }

  /** 只读观测面：内部事实的投影，集合是副本，调用方改不动核心状态。 */
  inspect(): ManagerInspection {
    const resources: Resource[] = []
    for (const bucket of this.resources.values()) resources.push(...bucket.values())
    return {
      disposed: this.disposed,
      visible: this.browserVisible,
      handles: [...this.handles],
      resources,
      // 与其余集合一致地复制一份：观测面不能成为改核心状态的入口。
      entries: { ...this.store.entries },
      ...this.scheduler.inspect(),
    }
  }

  // ══════════════════════════════ 页面操作 ══════════════════════════════

  /**
   * 声明或更新本页的订阅身份。相同身份重复声明是幂等的：不产生新请求、不重建订阅。
   * 同步返回接纳结果，不代表请求已完成。
   *
   * `prepare` 在身份就位之后才调用：参数准备会执行业务 `validate`，它可能同步重入。
   */
  submit(handle: Handle, prepare: () => Parameters): SubmitResult {
    if (this.disposed || handle.disposed) {
      return { status: 'cancelled', reason: CancelReason.Disposed }
    }
    const previousId = handle.operationId
    const id = this.nextIdentity(previousId)
    if (id === null) return { status: 'cancelled', reason: CancelReason.Disposed }
    // 只推进代次：它用于识别「本次声明是否仍被接纳」，不改变任何已声明事实。
    handle.operationId = id

    let parameters: Parameters
    try {
      parameters = prepare()
    } catch (error) {
      // 无效声明不改动任何状态：旧声明、订阅与未结算的刷新要求原样保留。
      if (!this.currentOperation(handle, id)) return this.supersededResult(handle)
      handle.operationId = previousId
      notify(handle, { origin: ErrorOrigin.Validation, error }, { operationId: id })
      return { status: 'rejected', error }
    }
    // prepare 或 validate 可能同步提交了新声明；被替代时由新声明拥有结果。
    if (!this.currentOperation(handle, id)) return this.supersededResult(handle)
    return this.commitDeclaration(handle, id, parameters)
  }

  /**
   * 声明成立：同一身份是幂等的（不写状态、不请求）；新身份整体替换。
   *
   * 替换会 abort 旧执行，而 abort 回调可以同步提交新声明，因此替换之后必须复核代次。
   */
  private commitDeclaration(handle: Handle, id: number, parameters: Parameters): SubmitResult {
    const declared = handle.submission
    if (declared && declared.parameters.key === parameters.key) return { status: 'accepted' }
    // 新身份：先建立新声明，再作废未结算的刷新要求并退出旧订阅。
    handle.submission = { parameters }
    this.settleRefreshes(handle, CancelReason.Superseded)
    const replaced = handle.subscription
    if (replaced) this.releaseSubscription(replaced)
    if (!this.currentOperation(handle, id)) return this.supersededResult(handle)
    this.requestFlush()
    return { status: 'accepted' }
  }

  /** 已被同步新声明替代或实例已销毁：不写回任何状态。 */
  private supersededResult(handle: Handle): SubmitResult {
    return {
      status: 'cancelled',
      reason: this.disposed || handle.disposed ? CancelReason.Disposed : CancelReason.Superseded,
    }
  }

  /**
   * 显式刷新当前已声明的身份：与自动刷新共用同一条获取与交付路径。
   *
   * 入口闸与旧查询一致——配置非法直接结算 `configuration`，失去存在结算 `unavailable`，
   * 没有已声明身份同样结算 `unavailable`；**开启意愿不参与**，暂停页仍可刷新。
   * 结算条件见 {@link refreshFloor}：等待一个在本次动作之后启动的请求。
   */
  refresh(handle: Handle): Promise<RefreshResult> {
    const settled = (result: RefreshResult): Promise<RefreshResult> => Promise.resolve(result)
    if (this.disposed || handle.disposed) {
      return settled({ status: 'cancelled', reason: CancelReason.Disposed })
    }
    const input = handle.readInput()
    if (!input.valid) return settled({ status: 'error', origin: ErrorOrigin.Configuration, error: input.error })
    if (!this.allowed(handle, input)) return settled({ status: 'cancelled', reason: CancelReason.Unavailable })
    const submission = handle.submission
    if (!submission) return settled({ status: 'cancelled', reason: CancelReason.Unavailable })

    const resource = this.resourceFor(handle.source, submission.parameters)
    if (!resource) return settled({ status: 'cancelled', reason: CancelReason.Disposed })

    // Promise 执行器同步运行，resolver 只接受第一个结果；取消可以先于底层结束结算。
    let settle!: RefreshWaiter['settle']
    const result = new Promise<RefreshResult>(resolve => { settle = resolve })
    const waiter: RefreshWaiter = { owner: handle, resource, minVersion: this.refreshFloor(resource), settle }
    resource.waiters.add(waiter)
    handle.refreshes.add(waiter)

    // 没有当前任务就由本次刷新登记请求；已有任务（排队或执行中）则等它，或等它之后补一次。
    if (!resource.task) this.enqueueTask(resource)
    this.requestFlush()
    return result
  }

  /** 只读快照：按参数键查已有分区并返回独立副本。不创建资源、不保活后台任务。 */
  readSnapshot(source: SourceRuntime, key: string): unknown {
    if (this.disposed) return undefined
    const resource = this.resources.get(source)?.get(key)
    const entry = resource && this.store.entries[resource.id]
    return entry === undefined ? undefined : cloneSnapshot(entry)
  }

  // ══════════════════════════════ 需求关系 ══════════════════════════════

  /**
   * 按最新配置快照协调一个句柄；配置变化与生命周期变化的唯一入口。
   *
   * 失去存在（失活或隐藏）先作废本页未结算的刷新要求，再按资格退出或保留订阅。
   * 有效订阅改频率只更新间隔：保留在途请求，由下一次调度按新间隔重算到期。
   */
  private synchronize(handle: Handle): void {
    if (this.disposed || handle.disposed) return
    const input = handle.readInput()
    // 失去存在（失活、隐藏）才结算本页未完成的刷新要求；`enabled` 边沿不参与。
    if (!this.present(handle)) this.settleRefreshes(handle, CancelReason.Unavailable)

    const subscription = handle.subscription
    if (!this.eligible(handle, input)) {
      if (subscription) this.releaseSubscription(subscription)
      return
    }
    if (subscription && subscription.every !== input.every) subscription.every = input.every
  }

  /**
   * 一个句柄的配置或生命周期变化：先同步协调，再安排一次合并调度。
   *
   * 两步必须分开：`synchronize` 自己不能请求 flush，否则 {@link flush} 遍历句柄时会再置一次
   * `flushPending`，末尾的 Timer 安排就被跳过。
   */
  reconcile(handle: Handle): void {
    this.synchronize(handle)
    this.requestFlush()
  }

  /** 组件挂载/激活：由适配层在 mounted / activated 时调用。 */
  activate(handle: Handle): void {
    if (handle.disposed) return
    handle.lifecycleActive = true
    this.reconcile(handle)
  }

  /** 组件失活：由适配层在 deactivated 时调用。 */
  deactivate(handle: Handle): void {
    if (handle.disposed) return
    handle.lifecycleActive = false
    this.reconcile(handle)
  }

  /**
   * 浏览器可见性变化：更新唯一事实并重新协调全部句柄。
   *
   * 这里的 `synchronize` 与 {@link reconcile} 同构且必须同步执行：隐藏页面时要当场结算在途刷新
   * （取消立即结算），只排一次 flush 会把它推迟一个微任务。随后的 `requestFlush` 会让 `flush`
   * 再协调一次，两次调用是幂等的。
   */
  setBrowserVisible(visible: boolean): void {
    this.browserVisible = visible
    for (const handle of [...this.handles]) this.synchronize(handle)
    this.requestFlush()
  }

  /** 登记 Manager 自身的释放回调；至多一个，`dispose` 时执行。 */
  setCleanup(cleanup: () => void): void {
    this.cleanup = cleanup
  }

  /** 登记句柄的作用域释放回调；至多一个，句柄释放时执行。 */
  setHandleCleanup(handle: Handle, cleanup: () => void): void {
    handle.cleanup = cleanup
  }

  /** 结算并移除本页全部未结算的刷新要求；只由命名操作与释放路径调用。 */
  private settleRefreshes(handle: Handle, reason: CancelReason): void {
    for (const waiter of [...handle.refreshes]) {
      this.settleWaiter(waiter, { status: 'cancelled', reason })
    }
  }

  /** 解除订阅关系；实例再无订阅者与刷新要求时才销毁。 */
  private releaseSubscription(subscription: Subscription): void {
    const handle = subscription.owner
    if (handle.subscription === subscription) handle.subscription = null
    subscription.resource.subscribers.delete(subscription)
    this.releaseResourceIfUnused(subscription.resource)
  }

  /**
   * 没有订阅者也没有刷新要求时销毁实例：删注册与分区、作废排队任务，最后才 abort。
   * 已启动的执行仍会真实结束，并在自己的 finally 里释放槽位。
   */
  private releaseResourceIfUnused(resource: Resource): void {
    if (resource.subscribers.size > 0 || resource.waiters.size > 0) return
    const bucket = this.resources.get(resource.source)
    if (!bucket || bucket.get(resource.parameters.key) !== resource) return

    bucket.delete(resource.parameters.key)
    if (!bucket.size) this.resources.delete(resource.source)
    const previousTask = resource.task
    resource.task = null
    if (previousTask) this.scheduler.cancel(previousTask)
    observe(() => this.store.remove(resource.id), EFFECT_FAILED.store, { resourceId: resource.id })
    previousTask?.controller.abort()
  }

  /**
   * 尝试把一个有资格、已声明身份的句柄接入共享 Resource。
   * 只有这里会创建实际 Resource：首次有效订阅建立实例，其余情况复用。
   */
  private attach(handle: Handle): void {
    const submission = handle.submission
    // 订阅互斥：已接入的句柄不再重复接入；配置变化走 synchronize 更新间隔。
    if (!submission || handle.subscription) return
    const input = handle.readInput()
    if (!this.eligible(handle, input)) return

    const resource = this.resourceFor(handle.source, submission.parameters)
    if (!resource) return
    const subscription: Subscription = { owner: handle, resource, every: input.every }
    handle.subscription = subscription
    resource.subscribers.add(subscription)

    // 已有合格结果就交付；没有结果时由调度器的到期遍历登记首次请求。
    const entry = this.store.entries[resource.id]
    if (entry) this.deliver(resource, handle, entry, cloneSnapshot(entry), RequestOrigin.Background)
  }

  /** 按「Source 身份 + 完整参数值稳定键」查找运行实例；序号耗尽时统一销毁。 */
  private resourceFor(source: SourceRuntime, parameters: Parameters): Resource | undefined {
    let bucket = this.resources.get(source)
    if (!bucket) {
      bucket = new Map()
      this.resources.set(source, bucket)
    }
    const existing = bucket.get(parameters.key)
    if (existing) return existing

    const id = this.nextIdentity(this.issuedResourceId)
    if (id === null) return undefined
    this.issuedResourceId = id
    const resource: Resource = {
      id: `${this.namespace}:${id}`,
      source,
      parameters,
      subscribers: new Set(),
      waiters: new Set(),
      issuedVersion: 0,
      task: null,
      lastSettledAt: null,
    }
    bucket.set(parameters.key, resource)
    return resource
  }

  // ══════════════════════════════ 后台执行 ══════════════════════════════

  /**
   * 为一个已登记的资源分配版本并登记一次后台执行。
   *
   * 同一资源同时至多一个当前任务：全部调用点（到期遍历、显式刷新、结算后补一次）都在
   * 确认没有当前任务之后才调用，因此这里不替换、也不 abort 在途执行。
   */
  private enqueueTask(resource: Resource): void {
    if (!this.registered(resource)) return
    const version = this.nextIdentity(resource.issuedVersion)
    if (version === null) return
    resource.issuedVersion = version

    const task: Task = { resource, version, controller: new AbortController() }
    resource.task = task
    this.scheduler.add(task)
  }

  /**
   * 真实执行一次后台任务。
   *
   * 只有 `load` 的正常结束才推进调度时间与并发槽位；取消只是逻辑失效，
   * 物理槽位只在 finally 释放，旧任务的 finally 也只能释放自己。
   */
  private async startTask(task: Task): Promise<void> {
    const resource = task.resource
    try {
      const raw = await resource.source.load(resource.parameters.args, { signal: task.controller.signal })
      if (!this.currentTask(task)) return
      const entry: StoreEntry = { version: task.version, data: copyResult(raw), updatedAt: this.clock.timestamp() }
      if (!this.currentTask(task)) return
      this.publishResult(task, entry)
    } catch (error) {
      this.publishError(task, error)
    } finally {
      if (this.currentTask(task)) resource.task = null
      this.scheduler.release(task)
      this.refillWaiters(resource)
      this.requestFlush()
    }
  }

  /**
   * 后台成功：先准备全部页面副本，再记结束时间、写 Store、逐页交付，最后结算刷新要求。
   *
   * 收货方一次收齐：有效订阅与满足本次版本门槛的刷新要求；同一句柄只交付一次，
   * 但它的刷新要求仍要结算。版本门槛更高的要求留给后继任务（见 {@link refillWaiters}）。
   */
  private publishResult(task: Task, entry: StoreEntry): void {
    const resource = task.resource
    const { publishers, satisfied } = this.collectReceivers(resource, entry)

    resource.lastSettledAt = this.clock.now()
    observe(() => this.store.put(resource.id, entry), EFFECT_FAILED.store, { resourceId: resource.id, taskVersion: task.version })

    for (const publisher of publishers) {
      if (!this.currentTask(task)) return
      this.publishTo(publisher, resource, entry)
    }
    for (const waiter of satisfied) {
      if (!this.currentTask(task)) return
      this.settleWaiter(waiter, { status: 'success' })
    }
  }

  /** 一次收齐本次成功结果的收货方：有效订阅与满足版本门槛的刷新要求，同一句柄只交付一次。 */
  private collectReceivers(
    resource: Resource,
    entry: StoreEntry,
  ): { publishers: Publisher[]; satisfied: RefreshWaiter[] } {
    const publishers: Publisher[] = []
    const satisfied: RefreshWaiter[] = []
    const receivers = new Set<Handle>()
    for (const subscription of resource.subscribers) {
      if (!this.currentSubscription(subscription) || receivers.has(subscription.owner)) continue
      receivers.add(subscription.owner)
      publishers.push({
        handle: subscription.owner, subscription, waiter: null, data: cloneSnapshot(entry),
      })
    }
    for (const waiter of resource.waiters) {
      if (waiter.minVersion > entry.version) continue
      satisfied.push(waiter)
      if (receivers.has(waiter.owner)) continue
      receivers.add(waiter.owner)
      publishers.push({ handle: waiter.owner, subscription: null, waiter, data: cloneSnapshot(entry) })
    }
    return { publishers, satisfied }
  }

  /** 交付一条结果；交付前复核订阅与刷新要求的身份，任何一条失效就跳过本次发布。 */
  private publishTo(publisher: Publisher, resource: Resource, entry: StoreEntry): void {
    if (publisher.subscription && !this.currentSubscription(publisher.subscription)) return
    if (publisher.waiter && !this.currentWaiter(publisher.waiter)) return
    const origin = publisher.waiter ? RequestOrigin.Refresh : RequestOrigin.Background
    this.deliver(resource, publisher.handle, entry, publisher.data, origin)
  }

  /**
   * 后台失败：保留订阅与开启意愿，按下个周期继续；本次未结算的刷新要求按同一失败结算。
   */
  private publishError(task: Task, error: unknown): void {
    if (!this.currentTask(task)) return
    const resource = task.resource
    resource.lastSettledAt = this.clock.now()
    for (const subscription of [...resource.subscribers]) {
      if (!this.currentTask(task)) return
      if (this.currentSubscription(subscription)) {
        notify(subscription.owner, { origin: ErrorOrigin.Background, error },
          { resourceId: resource.id, taskVersion: task.version })
      }
    }
    for (const waiter of [...resource.waiters]) {
      this.settleWaiter(waiter, { status: 'error', origin: ErrorOrigin.Background, error })
    }
  }

  /** 把一个共享结果交付给一个句柄的 Display 端口。 */
  private deliver(
    resource: Resource,
    handle: Handle,
    entry: StoreEntry,
    data: unknown,
    origin: RequestOrigin,
  ): void {
    const submission = handle.submission
    if (!submission) return
    observe(
      () => handle.publish({
        args: submission.parameters.args, data, origin, updatedAt: entry.updatedAt,
      }),
      EFFECT_FAILED.publish,
      { resourceId: resource.id, taskVersion: entry.version },
    )
  }

  // ══════════════════════════════ 刷新要求 ══════════════════════════════

  /**
   * 本次刷新要求的版本下限：一次「在本次动作之后启动」的任务所拥有的版本。
   *
   * 排队未启动的任务已经算「之后启动」，可以直接满足它；已在执行的任务不算，
   * 本次刷新等它结束后由 {@link refillWaiters} 补一次后继请求。没有当前任务时取下一个
   * 未分配的版本，本次刷新自己登记这次请求。
   */
  private refreshFloor(resource: Resource): number {
    const task = resource.task
    if (!task) return resource.issuedVersion
    return this.scheduler.isRunning(task) ? task.version + 1 : task.version
  }

  /** 一次任务结算后：仍有未结算的刷新要求、又没有当前任务时，补一次后继请求。 */
  private refillWaiters(resource: Resource): void {
    if (resource.waiters.size === 0 || resource.task !== null) return
    if (!this.registered(resource)) return
    this.enqueueTask(resource)
  }

  /**
   * 结算并移除一个刷新要求：只处理仍然挂在实例上的那一个，因此旧路径不会覆盖新要求。
   * 结算后实例可能已经没有订阅者与要求，由 {@link releaseResourceIfUnused} 收尾。
   */
  private settleWaiter(waiter: RefreshWaiter, result: RefreshResult): void {
    if (!waiter.resource.waiters.delete(waiter)) return
    waiter.owner.refreshes.delete(waiter)
    waiter.settle(result)
    this.releaseResourceIfUnused(waiter.resource)
  }

  // ══════════════════════════════ 调度入口 ══════════════════════════════

  /** 安排一次合并调度；调度的事实与算法都在 {@link Scheduler} 内，这里只是入口。 */
  requestFlush(): void {
    this.scheduler.requestFlush()
  }

  // ══════════════════════════════ 有效性与身份 ══════════════════════════════

  /** 该句柄的声明代次仍是本次声明；用于参数准备阶段的复核。 */
  private currentOperation(handle: Handle, id: number): boolean {
    return !this.disposed && !handle.disposed && handle.operationId === id
  }

  /**
   * 句柄当前是否在表达后台需求。四组事实缺一不可：
   * 存活（Manager 与句柄）／已声明身份／环境允许（{@link allowed}）／配置明确开启。
   *
   * 刷新要求不在这里判断：它由 {@link refresh} 的入口闸与 `waiters` 集合自身的归属表达，
   * 因此暂停页的刷新不会被资格否定。
   */
  private eligible(handle: Handle, input: Input): input is ValidInput {
    return !this.disposed && !handle.disposed && handle.submission !== null
      && input.valid && input.enabled && this.allowed(handle, input)
  }

  /** 组件激活且浏览器可见；与配置快照无关，因此快照读不到时它仍然为真。 */
  private present(handle: Handle): boolean {
    return handle.lifecycleActive && this.browserVisible
  }

  /** 环境允许：组件可见成立，且配置快照明确允许可见。 */
  private allowed(handle: Handle, input: Input): boolean {
    return this.present(handle) && input.visible === true
  }

  /** Resource 仍注册在自己的 Source 桶中，且身份就是当前生存期实例。 */
  private registered(resource: Resource): boolean {
    return !this.disposed && this.resources.get(resource.source)?.get(resource.parameters.key) === resource
  }

  /** Task 仍是所属 Resource 的当前任务；被替换的旧任务不算有效。 */
  private currentTask(task: Task): boolean {
    return this.registered(task.resource) && task.resource.task === task
  }

  /** 订阅仍挂在同一句柄上，且该句柄当前仍有资格继续接收数据。 */
  private currentSubscription(subscription: Subscription): boolean {
    const handle = subscription.owner
    return this.registered(subscription.resource)
      && handle.subscription === subscription
      && this.eligible(handle, handle.readInput())
  }

  /** 刷新要求仍挂在这个实例上；已被结算或取消的要求不算有效。 */
  private currentWaiter(waiter: RefreshWaiter): boolean {
    return waiter.resource.waiters.has(waiter)
  }

  /**
   * 分配下一个序号。安全整数区间内逐个递增，耗尽时统一销毁当前 Manager，
   * 不新增 faulted 之类的局部降级状态；调用方必须把 null 当作「已销毁」。
   */
  private nextIdentity(previous: number): number | null {
    if (previous >= Number.MAX_SAFE_INTEGER) {
      this.dispose()
      reportObserverError('identity sequence exhausted')
      return null
    }
    return previous + 1
  }

  // ══════════════════════════════ 释放 ══════════════════════════════

  /** 登记一个组件句柄：句柄集合由 Manager 独家增删。 */
  addHandle(handle: Handle): void {
    this.handles.add(handle)
  }

  /** 释放一个组件句柄：先停止接纳并清空状态，再退订与结算刷新要求。 */
  removeHandle(handle: Handle): void {
    if (handle.disposed) return
    handle.disposed = true
    this.handles.delete(handle)

    const previous = handle.subscription
    handle.submission = null
    // 先取走再执行：回调可能重入并读到这个句柄。
    const cleanup = handle.cleanup
    handle.cleanup = null
    if (cleanup) observe(cleanup, EFFECT_FAILED.cleanup, declarationIdentity(handle))
    this.settleRefreshes(handle, CancelReason.Disposed)
    if (previous) this.releaseSubscription(previous)
    this.requestFlush()
  }

  /**
   * 销毁 Manager：幂等，不可复用。
   *
   * `disposed` 先置位，后续所有入口直接拒绝；未结束的执行只在这里隔离，
   * 等真实结束才从 running 移除。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    this.scheduler.dispose()
    const cleanup = this.cleanup
    this.cleanup = null
    if (cleanup) observe(cleanup, EFFECT_FAILED.cleanup)

    for (const handle of [...this.handles]) this.removeHandle(handle)
    observe(() => this.store.dispose(), EFFECT_FAILED.store)
  }
}

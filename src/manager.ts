import { cloneSnapshot, copyResult, notify, observe } from './delivery.ts'
import { reportObserverError } from './diagnostics.ts'
import { currentOperation, currentQuery, executeQuery, failQuery } from './query.ts'
import type { QueryRunner } from './query.ts'
import { Scheduler } from './scheduler.ts'
import type { Parameters, SourceRuntime } from './source.ts'
import { ActivityKind } from './model.ts'
import type {
  Activity, Clock, Delivery, DeliveryRequest, Handle, Input, ManagerInspection, QueryRun, Resource,
  ResultStore, ScheduleHost, StoreEntry, Submission, Subscription, Task, ValidInput,
} from './model.ts'
import { CancelReason, ErrorOrigin, RequestOrigin } from './public-types.ts'
import type { QueryResult, SubmitResult } from './public-types.ts'

/** 本次显式操作尚欠一次新后台请求：登记任务前 `barrier` 为 null。 */
function requestDelivery(): DeliveryRequest {
  return { barrier: null }
}

/**
 * 接管机制的唯一判据：该交付要求是否仍在等一次尚未登记资源的新请求。
 * 三个产生点（`submit` 的非首次操作、`query`、`enqueueTask` 的登记）都收敛到这个谓词与
 * `setRequirement`，避免「欠一次请求」在代码里被表达成三种写法。
 */
function owesRequest(delivery: Delivery): boolean {
  return delivery !== null && delivery.barrier === null
}

/**
 * 应用协调者：拥有页面需求与资源注册表，并把后台调度委托给 {@link Scheduler}。
 *
 * 两类事实是「唯一」的：
 * - `handles` 是页面需求的唯一集合，句柄的每个字段只有本文件会写；
 * - `resources` 是共享实例的唯一注册表，最后一个订阅退出即销毁。
 *
 * 这些可变状态全部是 `private`：外部只能调用下面这些被命名过的操作，或通过
 * {@link inspect} 读一份只读投影。`DESIGN.md` 「谁写哪个字段」的表因此在编译期成立，
 * 而不是靠约定。
 *
 * 全文反复出现的一条顺序约束：**先建立新身份（新 operationId / 新 Task / 新 activity），
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
  private nextResourceId = 0
  private browserVisible = true
  private disposed = false
  /** 可控时间端口；查询执行路径通过 {@link QueryHost} 只读使用。 */
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
          // 中间可能有 abort / 通知回调同步重入，所以 attach 重新读取活动与资格。
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
   * 记录一次刷新需求。同步返回接纳结果，不代表请求已完成。
   * `prepare` 在身份就位之后才调用：参数准备会执行业务 `validate`，它可能同步重入。
   */
  submit(handle: Handle, prepare: () => Parameters): SubmitResult {
    if (this.disposed || handle.disposed) {
      return { status: 'cancelled', reason: CancelReason.Disposed }
    }
    const firstOperation = handle.operationId === 0
    const id = this.nextIdentity(handle.operationId)
    if (id === null) return { status: 'cancelled', reason: CancelReason.Disposed }

    this.beginOperation(handle, id, null)
    const cancelled = (): SubmitResult => ({
      status: 'cancelled',
      reason: this.disposed || handle.disposed ? CancelReason.Disposed : CancelReason.Superseded,
    })
    if (!currentOperation(this, handle, id)) return cancelled()

    let parameters: Parameters
    try {
      parameters = prepare()
    } catch (error) {
      // 校验失败：清空本次可恢复参数、保留画面，但不关闭开启意愿。
      if (!currentOperation(this, handle, id)) return cancelled()
      notify(handle, { origin: ErrorOrigin.Validation, error }, { operationId: id })
      return { status: 'rejected', error }
    }
    // prepare 或 validate 可能同步提交了新操作；被替代时由新操作拥有结果。
    if (!currentOperation(this, handle, id)) return cancelled()
    // 首次显式操作是普通加入；之后的显式提交即使同参也欠一次新的后台请求。
    this.setSubmission(handle, parameters, firstOperation ? null : requestDelivery())
    this.requestFlush()
    return { status: 'accepted' }
  }

  /**
   * 查询入口裁决：返回「应当立即结算的拒绝结果」，`null` 表示可以接纳。
   *
   * 配置非法在接纳之前拒绝：既不替换此前的有效提交，也不关闭开启意愿。
   */
  private admitQuery(handle: Handle, input: Input): QueryResult | null {
    if (!input.valid) return { status: 'error', origin: ErrorOrigin.Configuration, error: input.error }
    if (!this.allowed(handle, input)) return { status: 'cancelled', reason: CancelReason.Unavailable }
    return null
  }

  /** 页面主动查询：立即独立执行一次，不占后台并发槽，只发布本页。 */
  query(handle: Handle, prepare: () => Parameters, runner: QueryRunner): Promise<QueryResult> {
    if (this.disposed || handle.disposed) {
      return Promise.resolve({ status: 'cancelled', reason: CancelReason.Disposed })
    }
    const refused = this.admitQuery(handle, handle.readInput())
    if (refused) return Promise.resolve(refused)

    const id = this.nextIdentity(handle.operationId)
    if (id === null) return Promise.resolve({ status: 'cancelled', reason: CancelReason.Disposed })

    // Promise 执行器同步运行，resolver 只接受第一个结果；取消可以先于底层结束结算。
    let settle!: QueryRun['settle']
    const resultPromise = new Promise<QueryResult>(resolve => { settle = resolve })
    const run: QueryRun = { kind: ActivityKind.Query, controller: new AbortController(), settle }

    this.beginOperation(handle, id, run)
    if (!currentQuery(this, handle, run)) return resultPromise

    let parameters: Parameters
    try {
      parameters = prepare()
    } catch (error) {
      failQuery(this, handle, run, ErrorOrigin.Validation, error)
      return resultPromise
    }
    if (!currentQuery(this, handle, run)) return resultPromise

    // 查询成功接入共享资源时要求一次新的后台请求，而不是交付旧的分区结果。
    this.setSubmission(handle, parameters, requestDelivery())
    // async 函数在第一个 await 之前同步执行 runner；无需等待即可返回公开 Promise。
    void executeQuery(this, handle, run, parameters, runner)
    return resultPromise
  }

  /** 只读快照：按参数键查已有分区并返回独立副本。不创建资源、不保活后台任务。 */
  readSnapshot(source: SourceRuntime, key: string): unknown {
    if (this.disposed) return undefined
    const resource = this.resources.get(source)?.get(key)
    const entry = resource && this.store.entries[resource.id]
    return entry === undefined ? undefined : cloneSnapshot(entry)
  }

  // ══════════════════════════════ 需求关系 ══════════════════════════════

  /** 按最新配置快照协调一个句柄；配置变化与生命周期变化的唯一入口。 */
  private synchronize(handle: Handle): void {
    if (this.disposed || handle.disposed) return
    const input = handle.readInput()
    const captured = handle.activity

    if (captured?.kind === ActivityKind.Query) {
      // 独立查询不因 every 非法而取消；只有明确的取消事件（关闭/失活/隐藏）才生效。
      // 读不到（null）不足以否定需求，因此这里用「明确否决」而不是「不满足允许」。
      if (!this.present(handle) || this.refused(input)) {
        this.releaseActivity(handle, captured, CancelReason.Unavailable)
      }
      return
    }
    if (!this.eligible(handle, input)) {
      this.releaseActivity(handle, captured)
    } else if (captured && captured.every !== input.every) {
      // 有效订阅改频率：替换该 Resource 的当前任务，而不是只改一个数字。
      captured.every = input.every
      this.enqueueTask(captured.resource, captured)
    }
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
   * 这里的 `synchronize` 与 {@link reconcile} 同构且必须同步执行：隐藏页面时要当场结算在途查询
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

  /**
   * 配置关闭边沿的命名操作：只取消进行中的独立查询，其余活动与既有需求不受影响。
   *
   * 适配层因此不必自己取活动引用、判断 kind、再传取消原因；`releaseActivity` 也不必对外可见。
   */
  closeQuery(handle: Handle): void {
    const activity = handle.activity
    if (activity?.kind === ActivityKind.Query) {
      this.releaseActivity(handle, activity, CancelReason.Unavailable)
    }
  }

  /**
   * 释放句柄当前捕获的活动。
   *
   * 只处理传入的那一个活动对象，因此旧清理不会覆盖已经登记的新活动。
   */
  private releaseActivity(
    handle: Handle,
    captured: Activity | null = handle.activity,
    reason: CancelReason = CancelReason.Superseded,
  ): void {
    if (!captured) return
    this.forgetActivity(handle, captured)
    if (captured.kind === ActivityKind.Query) this.releaseQuery(captured, reason)
    else this.releaseSubscription(captured)
    this.requestFlush()
  }

  /**
   * 只解除活动登记：忘掉这个活动对象，不结算、不取消、不销毁，也不安排调度。
   *
   * 与 {@link releaseActivity} 的分工：查询自己正常结束时走这里（它已经结算完了）；
   * 被替代、失活、关闭或销毁时走 releaseActivity（由那里负责结算与 abort）。
   * 只清理仍然是传入对象的那一个，因此旧执行的清理不会覆盖已经登记的新活动。
   */
  forgetActivity(handle: Handle, activity: Activity): void {
    if (handle.activity === activity) handle.activity = null
  }

  /** 取消独立查询：立即结算，不等底层请求真正结束。 */
  private releaseQuery(run: QueryRun, reason: CancelReason): void {
    run.settle({ status: 'cancelled', reason })
    run.controller.abort()
  }

  /** 解除订阅关系；若是最后一个订阅，则销毁实例、分区和排队任务，最后才 abort。 */
  private releaseSubscription(subscription: Subscription): void {
    const resource = subscription.resource
    resource.subscribers.delete(subscription)
    const bucket = this.resources.get(resource.source)
    if (resource.subscribers.size > 0 || !bucket || bucket.get(resource.parameters.key) !== resource) return

    bucket.delete(resource.parameters.key)
    if (!bucket.size) this.resources.delete(resource.source)
    const previousTask = resource.task
    resource.task = null
    if (previousTask) this.scheduler.cancel(previousTask)
    observe(() => this.store.remove(resource.id), { resourceId: resource.id })
    previousTask?.controller.abort()
  }

  /**
   * 尝试把一个有资格、已提交的句柄接入共享 Resource。
   * 只有这里会创建实际 Resource：首次有效订阅建立实例，其余情况复用。
   */
  private attach(handle: Handle): void {
    const submission = handle.submission
    // 活动互斥：独立查询或订阅仍在时不再接入；配置变化走 synchronize 替换。
    if (!submission || handle.activity) return
    const input = handle.readInput()
    if (!this.eligible(handle, input)) return

    const resource = this.resourceFor(handle.source, submission.parameters)
    if (!resource) return
    const subscription: Subscription = {
      kind: ActivityKind.Subscription, owner: handle, resource, every: input.every,
    }
    handle.activity = subscription
    resource.subscribers.add(subscription)

    if (owesRequest(submission.delivery)) {
      // 显式新操作尚欠请求：登记任务时把「尚未登记资源」换成具体门槛。
      this.enqueueTask(resource, subscription)
      return
    }
    // 其他生存期的旧门槛不约束新实例；同实例仍需等待合格的新结果。
    const barrier = submission.delivery?.barrier
    if (barrier && barrier.resourceId !== resource.id) this.setRequirement(submission, null)
    const entry = this.store.entries[resource.id]
    // 交付自身的异常隔离在 deliver 内，这里不再包一层，否则内部不变式违规会被伪装成通知失败。
    if (entry) this.deliver(subscription, entry, cloneSnapshot(entry))
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

    const id = this.nextIdentity(this.nextResourceId)
    if (id === null) return undefined
    this.nextResourceId = id
    const resource: Resource = {
      id: `${this.namespace}:${id}`,
      source,
      parameters,
      subscribers: new Set(),
      nextVersion: 0,
      task: null,
      lastSettledAt: null,
    }
    bucket.set(parameters.key, resource)
    return resource
  }

  // ══════════════════════════════ 后台执行 ══════════════════════════════

  /**
   * 登记一次后台执行，并（可选）把它记为发起订阅的强制要求。
   *
   * 先建立新任务、新版本和交付门槛，再 abort 旧任务：旧 abort 监听可能同步重入，
   * 重入方必须已经能看到完整的新身份。
   */
  private enqueueTask(resource: Resource, requester?: Subscription): void {
    if (!this.registered(resource)) return
    const version = this.nextIdentity(resource.nextVersion)
    if (version === null) return
    resource.nextVersion = version

    const previous = resource.task
    if (previous) this.scheduler.cancel(previous)
    const task: Task = { resource, version, controller: new AbortController() }
    resource.task = task
    this.scheduler.add(task)
    const submission = requester?.owner.submission
    if (submission) this.setRequirement(submission, { barrier: { resourceId: resource.id, minVersion: version } })
    previous?.controller.abort()
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
      this.requestFlush()
    }
  }

  /** 后台成功：先准备全部页面副本，再记结束时间、写 Store、逐页交付。 */
  private publishResult(task: Task, entry: StoreEntry): void {
    const resource = task.resource
    // 受控复制不会回调业务，因此可先一次性完成，避免部分交付。
    const deliveries: { subscription: Subscription; data: unknown }[] = []
    for (const subscription of resource.subscribers) {
      if (this.deliverable(subscription, entry)) deliveries.push({ subscription, data: cloneSnapshot(entry) })
    }

    resource.lastSettledAt = this.clock.now()
    observe(() => this.store.put(resource.id, entry), { resourceId: resource.id, taskVersion: task.version })

    for (const { subscription, data } of deliveries) {
      // 上一次 Store 或页面通知可能已经替换了当前任务。
      if (!this.currentTask(task)) return
      this.deliver(subscription, entry, data)
    }
  }

  /** 后台失败：保留订阅与开启意愿，按下个周期继续；任务被替换即停止旧通知。 */
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
  }

  /** 把后台结果交付给一个订阅；合格交付会消费本次提交的交付门槛。 */
  private deliver(subscription: Subscription, entry: StoreEntry, data: unknown): void {
    const submission = this.deliverable(subscription, entry)
    if (!submission) return
    const handle = subscription.owner
    this.setRequirement(submission, null)
    observe(
      () => handle.publish({
        args: submission.parameters.args, data, origin: RequestOrigin.Background, updatedAt: entry.updatedAt,
      }),
      { resourceId: subscription.resource.id, taskVersion: entry.version },
    )
  }

  // ══════════════════════════════ 调度入口 ══════════════════════════════

  /** 安排一次合并调度；调度的事实与算法都在 {@link Scheduler} 内，这里只是入口。 */
  requestFlush(): void {
    this.scheduler.requestFlush()
  }

  // ══════════════════════════════ 有效性与身份 ══════════════════════════════

  /**
   * 句柄当前是否在表达后台需求。四组事实缺一不可：
   * 存活（Manager 与句柄）／已提交参数／环境允许（{@link allowed}）／配置明确开启。
   *
   * 环境事实只有两个谓词：{@link present}（与快照无关）与 {@link refused}（明确否决）。
   * 三处原本各自内联的「是否允许」写法已收敛到这两个谓词上，写法差异只留在这里。
   *
   * 独立查询不在这里判断：三处调用点都已先行分流——`synchronize` 的查询分支直接返回，
   * `attach` 要求当前没有活动，`currentSubscription` 要求当前活动就是该订阅。
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

  /** 配置快照是否明确否决可见性；`null` 表示读不到，不构成否决。 */
  private refused(input: Input): boolean {
    return input.visible === false
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
      && handle.activity === subscription
      && this.eligible(handle, handle.readInput())
  }

  /**
   * 本次交付要消费的提交；不满足交付门槛时返回 null。
   *
   * `delivery === null` 是没有要求，已有合格结果即可交付；否则要么尚未登记资源
   * （`barrier === null`，必须等新请求），要么要求同一实例且版本达标。
   * 返回提交对象而不是布尔值，调用方不需要再用非空断言把它取回来。
   */
  private deliverable(subscription: Subscription, entry: StoreEntry): Submission | null {
    if (!this.currentSubscription(subscription)) return null
    const submission = subscription.owner.submission
    if (!submission) return null
    const delivery = submission.delivery
    if (delivery && (delivery.barrier === null
      || delivery.barrier.resourceId !== subscription.resource.id
      || entry.version < delivery.barrier.minVersion)) return null
    return submission
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

  /** 释放一个组件句柄：先停止接纳并清空状态，再退订。 */
  removeHandle(handle: Handle): void {
    if (handle.disposed) return
    handle.disposed = true
    this.handles.delete(handle)

    const previous = handle.activity
    handle.submission = null
    // 先取走再执行：回调可能重入并读到这个句柄。
    const cleanup = handle.cleanup
    handle.cleanup = null
    if (cleanup) observe(cleanup)
    this.releaseActivity(handle, previous, CancelReason.Disposed)
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
    if (cleanup) observe(cleanup)

    for (const handle of [...this.handles]) this.removeHandle(handle)
    observe(() => this.store.dispose())
  }

  /**
   * 安装一次新操作并释放被它取代的旧活动。
   * 新 operationId、空 Submission 和新 activity 必须在释放旧活动之前就位。
   */
  private beginOperation(handle: Handle, id: number, run: QueryRun | null): void {
    const previous = handle.activity
    handle.operationId = id
    handle.submission = null
    handle.activity = run
    this.releaseActivity(handle, previous, CancelReason.Superseded)
  }

  // ══════════════════════════════ 提交与交付要求 ══════════════════════════════

  /** 建立本次显式操作的参数与交付要求：新操作一经接纳就整体替换旧 Submission。 */
  private setSubmission(handle: Handle, parameters: Parameters, delivery: Delivery): void {
    handle.submission = { parameters, delivery }
  }

  /**
   * 交付要求的唯一写入点。只接受已经取到的 Submission，因此不需要空值守卫，
   * 调用方也不必用非空断言；`grep` 这个函数名即可定位全部交付要求变更。
   */
  private setRequirement(submission: Submission, delivery: Delivery): void {
    submission.delivery = delivery
  }
}

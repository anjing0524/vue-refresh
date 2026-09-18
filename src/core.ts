import type { SubmitResult } from './public-types.ts'
import type { Parameters } from './source.ts'

/**
 * 共享取数与调度核心：**只管一个身份自己的账**——谁声明着它、还要不要再取一次、什么时候到期、
 * 哪一次执行还算数。跨实例的事只有三件：身份注册表、FIFO 队列与并发槽、唯一唤醒 Timer。
 *
 * `Resource` 是**合并请求、排队与终止的单位**：同一个「URL ＋ 参数值」就是同一个实例，
 * 一次取数由它发起、由它的结果满足；核心不认识页面——一个页面交给它的全部内容就是自己那份
 * 配置快照（`Config`），按身份挂在实例的 `declarers` 里（ADR-66）。
 *
 * 核心也不执行任何调用方代码（ADR-64）：拨出去的外部调用只剩传输 `http.post` 与结果表
 * `sink.write／fail／remove／list` 两个注入端口。一次取数与交付的链路见 DESIGN §2.1。
 */

/**
 * 一页报给核心的配置快照。**它同时就是这一页在核心里的登记**：每页一个对象、适配层原地改写，
 * 因此「谁声明了这个身份」不需要第二份名册（ADR-66）。
 *
 * `every === null` 表示这一拍配置非法（读不出、或不是正安全整数）：不取数、不刷新、不算有资格。
 * 它与「暂停」（`enabled` 为假、`every` 仍有效）是两件事——暂停页还保有资格判定里的环境，
 * 因此仍可手动刷一次（A04、A05）。
 */
export interface Config {
  enabled: boolean
  every: number | null
  active: boolean
}

/**
 * 结果表的一格：**最后一次成功 ＋ 最近一次失败**，成败都只落在这里，四个字段全平。
 *
 * `updatedAt === null` ⟺ 从未成功过（`data` 此时无意义）；`failedAt === null` ⟺ 自最后一次成功以来没失败过。
 * `error` 是原始异常原样带出（页面 `throw undefined` 这种病态情况也如实带出，所以「有没有失败」看 `failedAt`）。
 * **只有整格是新对象这一件事代表「变过」**——读取面比较引用就知道要不要抄（ADR-63、ADR-65）。
 */
export interface ResultCell {
  readonly data: unknown
  readonly updatedAt: number | null
  readonly error: unknown
  readonly failedAt: number | null
}

/**
 * 结果表：**结果的唯一真值**，按「URL → 参数键」两级分组。
 *
 * 内核只经这四个动作碰它：成功时 `write`、失败时 `fail`、实例释放时 `remove`、只读投影时 `list`。
 * 适配层把它接到 Pinia（`src/store.ts`），因此 `core.ts` 仍然零运行时依赖。
 */
export interface ResultSink {
  /** 写成功：整格替换（失败随之清空）。 */
  write(url: string, key: string, data: unknown, updatedAt: number): void
  /** 写失败：**保留这一格已有的数据**，只换掉失败那一对字段。 */
  fail(url: string, key: string, error: unknown, failedAt: number): void
  remove(url: string, key: string): void
  /** 只读列举：给 `snapshot()` 这个观测面用，不是包契约。 */
  list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[]
}

/**
 * 一个「URL ＋ 参数值」的共享实例：这个身份的**全部状态与判定**都在这个类里。
 *
 * 它不持有核心、也不持有页面：谁声明着它（`declarers` 的成员资格）、谁还没拿到结果
 * （`waiters`）、什么时候到期（`settledAt`）、哪一次执行还算数（`controller`）——
 * 写表、回收、排队都是核心越过去做的动作，因此两方之间没有环（ADR-65、ADR-66）。
 */
export class Resource {
  /** 取数 URL：身份的一半，也是结果表分区的第一级。 */
  readonly url: string
  readonly parameters: Parameters
  /**
   * 声明了本身份的配置（页面挂载期间一直算，暂停、失活、隐藏都不撤销）。
   *
   * 「声明」决定实例与结果的生死（G4：最后一个声明者离开才回收），「资格」只决定要不要取数——
   * 两条正交规则，资格由 `config` 与核心的全局可见性现算，不在这里维护第二份集合。
   */
  readonly declarers = new Set<Config>()
  /**
   * 仍想要一次取数的配置（显式刷新登记的要求）。它是**标志而不是队列**：同一个页面重复刷新只留一份，
   * 而且只结算一次（§0.2「刷新要求」）——「这个页面已经在等」这件事必须按页记，否则写表期间的重入
   * 会被反复当成新要求，补发没有上界（A12/A14 的用例把这条钉住了）。
   */
  readonly waiters = new Set<Config>()
  /** 最近一次正常结束（成功或失败）的时刻；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null = null
  /**
   * 这次执行的身份与取消把手；`null` ＝ 本实例此刻没有执行。
   *
   * 一个字段回答两件事：**取消**（释放实例时 abort）与**认人**（迟到的结束不再是当前执行就丢弃）。
   */
  controller: AbortController | null = null

  constructor(url: string, parameters: Parameters) {
    this.url = url
    this.parameters = parameters
  }

  /**
   * 环境允许：这一页激活、配置有效、浏览器可见。它与「开启意愿」是两件事——暂停只关掉意愿，
   * 环境仍然允许，所以暂停页仍可显式刷新一次（A05）。
   */
  isPresent(config: Config, visible: boolean): boolean {
    return visible && config.every !== null && config.active
  }

  /** 一个声明者此刻是否有资格取数：环境允许 ＋ 开启意愿为真。 */
  isEligible(config: Config, visible: boolean): boolean {
    return this.isPresent(config, visible) && config.enabled
  }

  /** 有效间隔现算：**有资格**的声明者里最小的 `every`；没有有资格的人就是 `Infinity`（不取数）。 */
  eligibleEvery(visible: boolean): number {
    let every = Infinity
    for (const config of this.declarers) {
      if (!this.isEligible(config, visible)) continue
      const value = config.every
      if (value !== null) every = Math.min(every, value)
    }
    return every
  }

  /**
   * 该实例此刻的下次到期时刻：`settledAt ＋ 当前最小间隔`；从未结算过的实例立即到期。取消不计时不补跑。
   * 没有有资格的声明者时返回 `Infinity`：这一轮不取数，也不安排唤醒。
   */
  dueAt(now: number, visible: boolean): number {
    const every = this.eligibleEvery(visible)
    if (every === Infinity) return Infinity
    return this.settledAt === null ? now : this.settledAt + every
  }

  /**
   * 成功结算：记下结算时刻，并把**这一批**未完成的要求交回核心（写表与回收都由核心做，ADR-65）。
   *
   * 必须在写表**之前**调用、并且先取快照：写表会同步触发页面代码（例如 `flush: 'sync'` 的 watcher），
   * 它可能当场 `refresh()`——那条要求不属于这一批，只能由核心补的后继请求满足（DESIGN §3.9）。
   */
  settle(at: number): readonly Config[] {
    this.settledAt = at
    return [...this.waiters]
  }

  /** 失败结算：与 `settle` 同形（失败也算结算，因此不自动重试——A13）；失败记录由核心写。 */
  fail(at: number): readonly Config[] {
    this.settledAt = at
    return [...this.waiters]
  }
}

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 结果边界：拒绝 `undefined`，其余原生复制；业务合法性由请求适配器负责。 */
function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('取数结果不能是 undefined')
  return structuredClone(input)
}

/** 取数传输：框架只需要一个 POST。真实的 axios 实例在结构上满足它（见 `createRefreshManager`）。 */
export interface RefreshHttp {
  post(url: string, data: unknown, config: { readonly signal: AbortSignal }): Promise<{ readonly data: unknown }>
}

/**
 * 跨身份的协调者：身份注册表、FIFO 队列与并发槽、唯一唤醒 Timer、可见性与销毁。
 *
 * 它**不持有页面**：页面侧的全部内容就是挂在各自实例 `declarers` 里的 `Config`；
 * 本对象自己的状态只有上面那几项跨实例的事（ADR-66）。
 */
export class RefreshCore {
  private readonly maxConcurrent: number
  /** 取数用的 axios 实例；内核只调它的 `post`，因此 core.ts 仍然零运行时依赖。 */
  private readonly http: RefreshHttp
  /** 结果表：结果的唯一真值，适配层接在 Pinia 上（`src/store.ts`）。 */
  private readonly sink: ResultSink
  /** URL → 参数键 → 实例。 */
  private readonly buckets = new Map<string, Map<string, Resource>>()
  /** FIFO 待执行的实例（一个实例至多一个执行）。 */
  private readonly queue = new Set<Resource>()
  /** 真实尚未结束的请求；并发槽的唯一事实（含实例已回收、但请求仍在途的那一次）。 */
  private readonly running = new Set<Resource>()
  /** 唯一 Timer 的取消句柄；调用即取消。框架自己的闭包，不是页面回调。 */
  private wakeup: (() => void) | null = null
  /** 已安排、尚未执行的一轮合并调度。 */
  private flushing = false
  /** 浏览器可见性这一项事实（适配层的读闸门要用它，所以有一个只读出口）。 */
  private visible = true
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

  /** 浏览器此刻是否可见。读闸门在适配层，但这一项事实只有核心知道（ADR-66）。 */
  isVisible(): boolean {
    return this.visible
  }

  /** 浏览器可见性：隐藏让所有页面失去资格，下一轮调度不再取数；**已经发出的请求不受影响**。 */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    this.flushSoon()
  }

  /**
   * 配置或生命周期变化后：重新算一次到期与唤醒。
   *
   * 不需要传「是谁变了」——资格与最小间隔都是现算的，读数就在各实例的 `declarers` 里（ADR-66），
   * 所以这里只是一次合并调度。
   */
  reconcile(): void {
    this.flushSoon()
  }

  // ══════════════════════════ 页面操作 ══════════════════════════

  /**
   * 声明或更新身份；相同身份幂等。
   *
   * **参数先由适配层准备好再交进来**——复制、值域检查、身份键编码与 `validate` 都在提交边界完成（ADR-64）。
   * 换身份＝把这份配置从旧实例的 `declarers` 里摘掉、挂到新实例上；旧实例若因此没人要了就地回收。
   */
  submit(config: Config, url: string, parameters: Parameters): SubmitResult {
    if (this.disposed) return { status: 'cancelled' }

    const current = this.resourceOf(config)
    if (current && current.url === url && current.parameters.key === parameters.key) {
      return { status: 'accepted' }
    }
    if (current) {
      // 顺序固定：先撤销旧身份上未完成的要求，再摘掉声明（要求还在就回收不了，§3.6）。
      current.waiters.delete(config)
      current.declarers.delete(config)
      this.releaseIfUnused(current)
    }
    this.resourceFor(url, parameters).declarers.add(config)
    this.flushSoon()
    return { status: 'accepted' }
  }

  /**
   * 显式刷新：没有执行就当场登记一次，有执行就把「还要再取一次」置起（本轮结果满足不了它）。
   *
   * 返回值只说**这句命令收下了没有**（入口条件不成立时 `false`），不是取数回执：成功与失败都只经结果表。
   * 适配层用它决定自己那一页要不要跟着这一拍（读闸门在适配层，ADR-66）。
   */
  refresh(config: Config, url: string, key: string): boolean {
    if (this.disposed) return false
    if (!config.active || config.every === null || !this.visible) return false
    const resource = this.buckets.get(url)?.get(key)
    if (resource === undefined) return false

    // 有执行就直接用它的结果；没有就当场登记一次。同一个页面重复刷新只留一份要求（标志不是队列）。
    resource.waiters.add(config)
    if (resource.controller === null) this.enqueue(resource)
    this.flushSoon()
    return true
  }

  /** 这一份配置此刻有没有取数资格：有资格 ＝ 环境允许 ＋ 开启意愿（G3/G4 的判定）。 */
  isEligible(config: Config, url: string, key: string): boolean {
    return this.buckets.get(url)?.get(key)?.isEligible(config, this.visible) ?? false
  }

  /** 释放一页：撤销它未完成的要求与声明（组件卸载、销毁都由它收尾）。撤销后若实例没人要了就地回收。 */
  undeclare(config: Config): void {
    const resource = this.resourceOf(config)
    if (resource === undefined) return
    resource.waiters.delete(config)
    resource.declarers.delete(config)
    this.releaseIfUnused(resource)
    this.flushSoon()
  }

  // ══════════════════════════ 观测面 ══════════════════════════

  /** 只读计数投影：给演示面板、基准脚本与集成测试看状态。**不属于包契约**，也不提供改状态的入口。 */
  snapshot(): {
    declarers: readonly Config[]
    resources: readonly Resource[]
    results: readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[]
    queued: readonly Resource[]
    running: readonly Resource[]
    scheduled: boolean
    flushing: boolean
  } {
    const resources: Resource[] = []
    const declarers: Config[] = []
    for (const bucket of this.buckets.values()) {
      for (const resource of bucket.values()) {
        resources.push(resource)
        for (const config of resource.declarers) declarers.push(config)
      }
    }
    return {
      declarers,
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
    // 逐个实例撤销声明与未完成的要求并回收：abort 在途、删结果表条目。
    // 只清声明不够——要求还在就回收不了，迟到的结果还会写进表（A17 把这条钉住了）。
    for (const resource of this.all()) {
      resource.declarers.clear()
      resource.waiters.clear()
      this.releaseIfUnused(resource)
    }
    this.buckets.clear()
  }

  // ══════════════════════════ 身份注册表 ══════════════════════════

  /** 全部实例的一份快照（遍历时可能回收，所以先取出来）。 */
  private all(): Resource[] {
    const resources: Resource[] = []
    for (const bucket of this.buckets.values()) for (const resource of bucket.values()) resources.push(resource)
    return resources
  }

  /** 按「URL ＋ 完整参数值稳定键」查找，没有就建立实例。 */
  private resourceFor(url: string, parameters: Parameters): Resource {
    let bucket = this.buckets.get(url)
    if (!bucket) {
      bucket = new Map()
      this.buckets.set(url, bucket)
    }
    const existing = bucket.get(parameters.key)
    if (existing) return existing

    const resource = new Resource(url, parameters)
    bucket.set(parameters.key, resource)
    return resource
  }

  /**
   * 这份配置登记在哪个实例上；只查不建。
   *
   * 扫描是「不存反向字段」的代价（ADR-57）：`declarers` 的成员资格是唯一事实，
   * 一次换身份／一次卸载各扫一遍注册表（用户动作级，规模是几十个身份）。
   */
  private resourceOf(config: Config): Resource | undefined {
    for (const bucket of this.buckets.values()) {
      for (const resource of bucket.values()) {
        if (resource.declarers.has(config)) return resource
      }
    }
    return undefined
  }

  /**
   * 没有声明者也没有未完成的要求：删实例、abort 在途、删结果表条目。迟到的结束在身份复核处失效。**核心私有**。
   */
  private releaseIfUnused(resource: Resource): void {
    if (resource.declarers.size > 0 || resource.waiters.size > 0) return
    const bucket = this.buckets.get(resource.url)
    bucket?.delete(resource.parameters.key)
    if (bucket?.size === 0) this.buckets.delete(resource.url)

    // 结果随实例释放即删：结果表里没有「没人要的」条目，读的人也就不会读到过期数据。
    this.sink.remove(resource.url, resource.parameters.key)
    const controller = resource.controller
    if (controller) {
      // 在跑的那次不能当场交还槽位：它仍占着并发账本，必须等迟到的结束自己交还（占位的是请求，不是实例）。
      this.place(resource, this.running.has(resource) ? 'abandoned' : 'idle')
      controller.abort()
    }
  }

  // ══════════════════════════ 后台执行 ══════════════════════════

  /**
   * 执行位置（`queue` / `running` / `Resource.controller`）的唯一写入点：
   * `queued`（在队）／`running`（占着并发账本的一格）／`abandoned`（实例已回收、这次执行已撤销，
   * 但在跑的请求仍占着那一格）／`idle`（都不在）。
   *
   * `controller` 跟着一起迁移：进入 `queued` 时诞生，离开 `running` 或进入 `abandoned` 时清空——
   * 所以「`controller === null`」这一个事实同时表达「没有在执行」与「这次结束不再算数」。
   */
  private place(resource: Resource, position: 'queued' | 'running' | 'abandoned' | 'idle'): void {
    this.queue.delete(resource)
    this.running.delete(resource)
    if (position === 'queued') {
      this.queue.add(resource)
      resource.controller = new AbortController()
    }
    if (position === 'running' || position === 'abandoned') this.running.add(resource)
    if (position !== 'queued' && position !== 'running') resource.controller = null
  }

  /** 登记一次后台执行；全部调用点都先确认没有当前执行，因此不替换、不 abort 在途。 */
  private enqueue(resource: Resource): void {
    this.place(resource, 'queued')
  }

  /** 本轮结束后还有未满足的要求时补一次；唯一来源是写表触发的同步重入（DESIGN §3.9）。 */
  private refill(resource: Resource): void {
    if (resource.waiters.size === 0 || resource.controller !== null) return
    this.enqueue(resource)
  }

  /**
   * 撤销一个配置的刷新要求；它可能是本实例最后一个要求，因此顺手判断这个实例还要不要留着。
   * **核心私有**：实例只交出「谁在等」，回收由核心决定（ADR-65）。
   */
  private settleRequest(resource: Resource, config: Config): void {
    if (!resource.waiters.delete(config)) return
    this.releaseIfUnused(resource)
  }

  /**
   * 执行一次后台请求：结算 → 写表 → 释放槽位 → 补后继请求，「一次取数的收尾顺序」只有这一处（ADR-65）。
   *
   * 框架**不设自己的取数上限**：请求必然终止由注入的传输负责（axios 的 `timeout`、反向代理，
   * 或宿主自己的截止）。因此一个实例同时只会有一个执行，一个请求也只占一个槽位。
   */
  private async run(resource: Resource): Promise<void> {
    const controller = resource.controller
    if (controller === null) return
    try {
      // 每一轮都交出一份副本：请求体改不动身份键描述的那份值（ADR-52）。URL 与参数值一起决定身份，
      // 因此「同一个 URL ＋ 同一份参数值」在这里只会有一条执行（合并发生在 `resourceFor`）。
      const response = await this.http.post(
        resource.url,
        structuredClone(resource.parameters.args),
        { signal: controller.signal },
      )
      // 复制结果前后各复核一次「这次还是不是当前执行」：释放实例、换身份、销毁都会把它置空。
      if (resource.controller !== controller) return
      const data = copyResult(response.data)
      if (resource.controller !== controller) return
      const at = Date.now()
      const satisfied = resource.settle(at)
      this.writeResult(resource, data, at)
      for (const config of satisfied) this.settleRequest(resource, config)
    } catch (error) {
      if (resource.controller !== controller) return
      const at = Date.now()
      const satisfied = resource.fail(at)
      this.writeFailure(resource, error, at)
      for (const config of satisfied) this.settleRequest(resource, config)
    } finally {
      this.place(resource, 'idle')
      this.refill(resource)
      this.flushSoon()
    }
  }

  /** 把一次成功写进结果表（表在 `sink` 手上，实例不碰它）。 */
  private writeResult(resource: Resource, data: unknown, updatedAt: number): void {
    this.sink.write(resource.url, resource.parameters.key, data, updatedAt)
  }

  /** 把一次失败写进结果表同一格（数据保留）。与 `writeResult` 对称。 */
  private writeFailure(resource: Resource, error: unknown, failedAt: number): void {
    this.sink.fail(resource.url, resource.parameters.key, error, failedAt)
  }

  // ══════════════════════════ 调度 ══════════════════════════

  /** 安排一次合并调度；同一轮内的多次请求合并成一个微任务。 */
  private flushSoon(): void {
    if (this.flushing || this.disposed) return
    this.flushing = true
    queueMicrotask(() => { this.flush() })
  }

  /** 一次 flush：到期入队 → 按 FIFO 用可用槽位启动 → 设置唯一唤醒 Timer。 */
  private flush(): void {
    this.flushing = false
    if (this.disposed) return
    this.clearWakeup()
    const next = this.enqueueDue(Date.now())
    this.startQueued()
    this.scheduleWakeup(next)
  }

  /** 第一步：把到期的实例登记进队列，返回最早的下次到期时刻（`Infinity`＝没有要等的）。 */
  private enqueueDue(now: number): number {
    let next = Infinity
    for (const resource of this.all()) {
      // 有当前执行的实例不重复入队（A08）。
      if (resource.controller !== null) continue
      const due = resource.dueAt(now, this.visible)
      // `Infinity` ＝ 这个身份没有有资格的声明者：不取数，也不参与唤醒时刻。
      if (due <= now) this.enqueue(resource)
      else next = Math.min(next, due)
    }
    return next
  }

  /**
   * 第二步：按 FIFO 用当前可用槽位启动。
   *
   * 队列里只装「还没有执行、且确实在等」的实例——`queue` 的唯一写入者是 `place`，它进入 `queued`
   * 时就建好这次执行的 `controller`（DESIGN §3.5 第 4 条）。因此这里不再需要复核归属。
   * 满槽时由请求真实结束唤醒（不自旋）；本轮内新增的请求留给下一轮。
   */
  private startQueued(): void {
    for (const resource of [...this.queue]) {
      if (this.running.size >= this.maxConcurrent) break
      this.place(resource, 'running')
      void this.run(resource)
    }
  }

  /** 第三步：队列已清空且还有明确的到期时刻时，安排唯一唤醒 Timer。 */
  private scheduleWakeup(next: number): void {
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

import type { RefreshFailure, SubmitResult } from './public-types.ts'
import type { Parameters } from './source.ts'

/**
 * 共享取数与调度核心：**只管跨实例的事**——注册表、需求名册、可见性与销毁、FIFO 队列、并发槽、
 * 唯一唤醒 Timer、只读投影。一个身份自己的全部状态与操作在 `Resource` 里。
 *
 * 一次取数与交付的链路（唯一路径）见 DESIGN §2.1；「同一份关系不另立镜像」的理由见 DESIGN §3.1。
 */

/** 配置快照：开启意愿、刷新间隔、这一页是否激活三项，由适配层写入；读不出时为 `null`（后果见 DESIGN §6.1）。 */
export interface Config {
  readonly enabled: boolean
  readonly every: number
  /** 这一页是否挂载/激活（KeepAlive 失活为假）。它与「浏览器可见」是两件事，后者在核心上是全局的一项。 */
  readonly active: boolean
}

/**
 * 一个页面对某个身份的**需求**：核心认识的全部内容。它**只有数据**——URL（身份的一半）、
 * 配置快照（开启意愿／间隔／是否激活）、已声明的身份（另一半）；没有定义对象、没有回调，
 * 核心因此不执行任何调用方代码：参数准入与准备都在适配层的提交边界完成（ADR-64）。
 *
 * 两件事不存字段：**是否已释放**是 `RefreshCore.demands` 的名册成员资格（DESIGN §3.7）、
 * **声明了哪个身份**是那个实例 `declarers` 的成员资格（DESIGN §3.5 第 1 条）；
 * **资格**（开启意愿 ＋ 激活 ＋ 浏览器可见）由配置快照与核心的全局可见性现算，不另存。
 */
export interface Demand {
  /** 取数 URL：身份的一半，也决定结果表分区的第一级。适配层从定义点取，核心只读。 */
  readonly url: string
  /** 最近一次配置快照；适配层每读到新值就改写，核心只读。 */
  config: Config | null
  /** 已声明的身份（URL ＋ 参数键）；核心独占写入，未声明时为 `null`。 */
  parameters: Parameters | null
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

/**
 * 结果表的一格：**最后一次成功的结果 ＋ 最近一次失败**，一次取数的成败都只落在这里。
 *
 * 失败不覆盖数据（旧址照旧）也不清空它；成功后失败被清掉（`failure` 回到 `null`）。
 * 只有整格是新对象这一件事代表「变过」——读取面据此比较引用就知道要不要抄（ADR-63）。
 */
export interface ResultCell {
  /** 最后一次成功；**从未成功过**（首查就失败）时为 `null`。 */
  readonly entry: Entry | null
  /** 最近一次失败；之后成功过就清空。 */
  readonly failure: RefreshFailure | null
}

/** 结果表的一行。 */
export interface ResultRow {
  readonly url: string
  readonly key: string
  readonly cell: ResultCell
}

/**
 * 结果表：**结果的唯一真值**，按「URL → 参数键」两级分组。
 *
 * 内核只经这四个动作碰它：成功时 `write`、失败时 `fail`、实例释放时 `remove`、只读投影时 `list`。
 * 适配层把它接到 Pinia（`src/store.ts`），因此 `core.ts` 仍然零运行时依赖。
 */
export interface ResultSink {
  write(url: string, key: string, entry: Entry): void
  /** 写失败：**保留这一格已有的数据**，只换掉失败那一项。 */
  fail(url: string, key: string, failure: RefreshFailure): void
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
  /** 取数 URL：身份的一半，也是结果表分区的第一级。 */
  readonly url: string
  readonly parameters: Parameters
  /**
   * 声明了本身份的需求（页面挂载期间一直算，暂停/失活/隐藏都不撤销）。
   *
   * 「声明」决定实例与结果的生死，「资格」只决定要不要取数——两条正交规则。资格由
   * `config.enabled && config.active && 核心的全局可见性` 现算，不在这里维护第二份集合。
   */
  readonly declarers = new Set<Demand>()
  /** 仍想要一次取数的需求（显式刷新登记的要求）。它是**标志**而不是队列：重复刷新同一个需求只留一份。 */
  readonly waiters = new Set<Demand>()
  /** 最近一次正常结束（成功或失败）的时刻；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null = null
  task: Task | null = null

  constructor(core: RefreshCore, url: string, parameters: Parameters) {
    this.core = core
    this.url = url
    this.parameters = parameters
  }

  /**
   * 环境允许：这一页激活且浏览器可见。它与「开启意愿」是两件事——暂停只关掉意愿，
   * 环境仍然允许，所以暂停页仍可显式刷新一次（A05）。
   */
  isPresent(demand: Demand, visible: boolean): boolean {
    const config = demand.config
    return visible && config !== null && config.active
  }

  /** 一个声明者此刻是否有资格取数：环境允许 ＋ 开启意愿为真。 */
  isEligible(demand: Demand, visible: boolean): boolean {
    const config = demand.config
    return this.isPresent(demand, visible) && config !== null && config.enabled
  }

  /** 有效间隔现算：**有资格**的声明者里最小的 `every`；没有有资格的人就是 `Infinity`（不取数）。 */
  eligibleEvery(visible: boolean): number {
    let every = Infinity
    for (const demand of this.declarers) {
      if (!this.isEligible(demand, visible)) continue
      const config = demand.config
      if (config) every = Math.min(every, config.every)
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
   * 成功结算：记结算时刻、把结果写进结果表（唯一真值），再满足这一批刷新要求。
   *
   * 这里**没有交付循环**：谁在读、读几次、读到的是哪一版，都由读的人在结果表上自己取（ADR-59、ADR-63）。
   * 顺序固定：先落定结果，再结算要求——要求结算可能让实例当场释放，而释放会把结果删掉（A06）。
   * 两份「先定下这一批要求、再写结果表」的理由是同一个：写结果表会同步触发页面代码。
   */
  settle(entry: Entry): void {
    this.settledAt = Date.now()
    // 这一批要满足的要求**先定下来再写结果**：写结果表会同步触发页面代码（例如 `flush: 'sync'` 的 watcher），
    // 它可能当场 `refresh()`；那条新要求不在这一批里，只能由 `refill` 的后继请求满足（§3.9 第一条）。
    const satisfied = [...this.waiters]
    this.core.writeResult(this, entry)
    for (const demand of satisfied) this.clearRequest(demand)
  }

  /**
   * 失败结算：把失败写进结果表这一格（**读取面按自己的节拍取**，框架不再推送），
   * 然后撤销本实例全部未完成的刷新要求。
   *
   * 数据保持原样：失败只让「这一格当前处于失败态」，不动最后一次成功的结果。
   * 与 `settle` 同序（先定下这批要求、再写表），理由也相同：写表会同步触发页面代码。
   */
  fail(error: unknown): void {
    this.settledAt = Date.now()
    const satisfied = [...this.waiters]
    this.core.writeFailure(this, { cause: error, at: this.settledAt })
    for (const demand of satisfied) this.clearRequest(demand)
  }

  /** 撤销一个需求的刷新要求；它可能是本实例的最后一个需求，因此顺手让核心判断要不要回收这个实例。 */
  clearRequest(demand: Demand): void {
    if (!this.waiters.delete(demand)) return
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

/** 结果边界：拒绝 `undefined`，其余原生复制；业务合法性由请求适配器负责。 */
function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('取数结果不能是 undefined')
  return structuredClone(input)
}

/** 取数传输：框架只需要一个 POST。真实的 axios 实例在结构上满足它（见 `createRefreshManager`）。 */
export interface RefreshHttp {
  post(url: string, data: unknown, config: { readonly signal: AbortSignal }): Promise<{ readonly data: unknown }>
}

/** 跨实例的协调者：实例注册表、需求名册、FIFO 队列与并发槽、唯一唤醒 Timer、可见性与销毁。 */
export class RefreshCore {
  private readonly maxConcurrent: number
  /** 取数用的 axios 实例；内核只调它的 `post`，因此 core.ts 仍然零运行时依赖。 */
  private readonly http: RefreshHttp
  /** 结果表：结果的唯一真值，适配层接在 Pinia 上（`src/store.ts`）。 */
  private readonly sink: ResultSink
  /** URL → 参数键 → 实例。 */
  private readonly buckets = new Map<string, Map<string, Resource>>()
  /** 全部需求；可见性变化时按它们重新协调。 */
  private readonly demands = new Set<Demand>()
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
    for (const demand of [...this.demands]) this.coordinate(demand)
    this.flushSoon()
  }

  /** 登记一个需求并协调它。调用方保证协调者尚未销毁：`useRefresh` 在造出需求之前就查过 `isDisposed`。 */
  addDemand(demand: Demand): void {
    this.demands.add(demand)
    this.reconcile(demand)
  }

  /** 释放一个需求：先结算它的刷新要求，再撤销声明并停止接纳。名册成员资格就是「是否已释放」。 */
  removeDemand(demand: Demand): void {
    if (!this.demands.has(demand)) return
    this.demands.delete(demand)
    // 撤销声明要按身份找实例，因此必须在清空 `parameters` 之前（它与 `clearRefreshes` 都读身份）。
    this.clearRefreshes(demand)
    this.dropDeclaration(demand)
    demand.parameters = null
    this.flushSoon()
  }

  /**
   * 配置或生命周期变化后的唯一入口：先协调关系，再安排一次合并调度。
   *
   * 两步必须分开：`coordinate` 在 `flush` 遍历需求时也要跑，而那里不能再排一轮 flush。
   */
  reconcile(demand: Demand): void {
    this.coordinate(demand)
    this.flushSoon()
  }

  // ══════════════════════════ 页面操作 ══════════════════════════

  /**
   * 声明或更新身份；相同参数值幂等。
   *
   * **参数先由适配层准备好再交进来**——复制、值域检查、身份键编码与 `validate` 都在提交边界完成（ADR-64），
   * 因此这里没有 try/catch，也不会产生 `rejected`：输入问题由适配层自己的同步返回值说清楚（ADR-51），
   * 而核心从头到尾不执行调用方代码。无效声明不改动任何状态。
   */
  submit(demand: Demand, parameters: Parameters): SubmitResult {
    if (this.disposed || !this.demands.has(demand)) return { status: 'cancelled' }
    const declared = demand.parameters
    if (declared && declared.key === parameters.key) return { status: 'accepted' }

    // 顺序固定：先用旧身份撤销刷新要求（它可能落在旧实例上），再撤掉旧身份的声明，最后换身份并重新协调。
    this.clearRefreshes(demand)
    this.dropDeclaration(demand)
    demand.parameters = parameters
    this.reconcile(demand)
    return { status: 'accepted' }
  }

  /**
   * 显式刷新：有当前请求就直接用它的结果，没有就当场登记一次；不恢复自动刷新，也不改写调用方的开关。
   *
   * **不回执**：成功与失败都只经结果表（`display` 那一侧）。入口条件不成立时直接返回、不产生副作用也不写表。
   */
  refresh(demand: Demand): void {
    if (this.disposed || !this.demands.has(demand)) return
    const config = demand.config
    if (config === null) return
    if (!(config.active && this.visible)) return
    const parameters = demand.parameters
    if (parameters === null) return

    const resource = this.resourceFor(demand.url, parameters)
    // 有请求就直接用：`enqueue` 的三个调用点都先确认没有当前任务，因此有 `task` 时它就是本实例唯一的请求；
    // 没有请求时由本次登记的任务满足。同一个需求重复刷新只留一份要求。
    resource.waiters.add(demand)
    if (!resource.task) this.enqueue(resource)
    this.flushSoon()
  }

  // ══════════════════════════ 观测面 ══════════════════════════

  /** 只读计数投影：给演示面板、基准脚本与集成测试看状态。**不属于包契约**，也不提供改状态的入口。 */
  snapshot(): {
    demands: readonly Demand[]
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
      demands: [...this.demands],
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
    for (const demand of [...this.demands]) this.removeDemand(demand)
    this.buckets.clear()
  }

  // ══════════════════════════ 需求关系 ══════════════════════════

  /**
   * 按最新配置与生命周期协调一个需求；资格成立则接入或更新订阅，否则退订。
   *
   * 四组事实缺一不可：存活、已声明身份、环境允许（激活且浏览器可见）、配置明确开启且有周期。
   * 刷新要求不参与资格：它由 `refresh` 的入口闸与 `waiters` 的归属表达，因此暂停页仍可刷新。
   */
  private coordinate(demand: Demand): void {
    if (this.disposed || !this.demands.has(demand)) return
    const parameters = demand.parameters

    // 失去身份就等于撤销声明：实例与结果随最后一个声明者离开而回收（A06）。
    if (parameters === null) {
      this.dropDeclaration(demand)
      return
    }
    // 声明即归属：页面挂载期间一直算（暂停、失活、隐藏都不撤销），取数才看资格。
    const resource = this.resourceOf(demand)
    const target = resource ?? this.resourceFor(demand.url, parameters)
    // 一个身份只保留一份参数对象：后加入者采用实例已持有的那一份（同键等值）。这份是框架私有权威副本，
    // 外发给每个消费者（`validate`／每轮请求体）时各复制一份（ADR-52）。
    demand.parameters = target.parameters
    target.declarers.add(demand)

    // 撤销刷新要求只看**环境**（失活、隐藏、卸载）：暂停只关掉开启意愿，环境仍允许，
    // 因此暂停页刚登记的那次刷新不会被下一轮 flush 抹掉（A05、G6）。
    // 资格只影响自动取数与读者身份：没有资格就不再是读者（画面冻结，ADR-60），但声明还留着，
    // 所以在途请求不取消、结果也不删（失活/暂停恢复后直接读回）。
    if (!target.isPresent(demand, this.visible)) this.clearRefreshes(demand)
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

    const resource = new Resource(this, url, parameters)
    bucket.set(parameters.key, resource)
    return resource
  }

  /** 本页已声明身份所在的实例；只查不建（协调资格、结算刷新要求、退订都用它）。 */
  private resourceOf(demand: Demand): Resource | undefined {
    const parameters = demand.parameters
    return parameters ? this.buckets.get(demand.url)?.get(parameters.key) : undefined
  }

  /** 撤销一个需求的声明；撤销后若声明与要求都空了，实例随之被回收。 */
  private dropDeclaration(demand: Demand): void {
    const resource = this.resourceOf(demand)
    if (!resource?.declarers.delete(demand)) return
    this.releaseIfUnused(resource)
  }

  /**
   * 没有声明者也没有刷新要求：删实例与排队任务，abort 在途；迟到的结束在任务身份复核处失效。**实例入口**。
   * 只判「都空」就够：注销是唯一的删除路径，此刻这个键指向的必定是它自己（§3.5 第 11 条）。
   * 注意「声明」与「资格」是两件事：暂停、失活、隐藏都不撤销声明，所以它们不会把实例收掉。
   */
  releaseIfUnused(resource: Resource): void {
    if (resource.declarers.size > 0 || resource.waiters.size > 0) return
    const bucket = this.buckets.get(resource.url)
    bucket?.delete(resource.parameters.key)
    if (bucket?.size === 0) this.buckets.delete(resource.url)

    const task = resource.task
    // 结果随实例释放即删：结果表里没有「没人要的」条目，读的人也就不会读到过期数据。
    this.sink.remove(resource.url, resource.parameters.key)
    if (task) {
      // 在跑的那次不能当场交还槽位：它仍占着并发账本，必须等迟到的结束自己交还（`detached`）。
      this.placeTask(task, this.running.has(task) ? 'detached' : 'settled')
      task.controller.abort()
    }
  }

  /**
   * 这个需求此刻算不算该身份的**读者**：声明着它并且有资格（开启意愿 ＋ 激活 ＋ 浏览器可见），
   * 或在它上面有未撤销的刷新要求。
   *
   * 视图层据此决定「要不要跟随结果表的新值」：读者跟随，不是读者（暂停、失活、隐藏、卸载中）
   * 就冻结在最后一帧；暂停页自己 `refresh()` 那一次仍在要求里，因此那次结果照样更新画面（A05、G6）。
   */
  isReader(demand: Demand): boolean {
    const resource = this.resourceOf(demand)
    if (resource === undefined) return false
    return resource.declarers.has(demand)
      && (resource.isEligible(demand, this.visible) || resource.waiters.has(demand))
  }

  /** 把一次成功写进结果表。**实例入口**：结果住结果表，实例只在成功这一刻与它打交道。 */
  writeResult(resource: Resource, entry: Entry): void {
    this.sink.write(resource.url, resource.parameters.key, entry)
  }

  /** 把一次失败写进结果表同一格（数据保留）。**实例入口**，与 `writeResult` 对称。 */
  writeFailure(resource: Resource, failure: RefreshFailure): void {
    this.sink.fail(resource.url, resource.parameters.key, failure)
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
        resource.url,
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

  /** 撤销一个需求未完成的刷新要求（失去身份、卸载、销毁都由它收尾）。 */
  private clearRefreshes(demand: Demand): void {
    const resource = this.resourceOf(demand)
    if (resource) resource.clearRequest(demand)
  }

  // ══════════════════════════ 调度 ══════════════════════════

  /** 安排一次合并调度；同一轮内的多次请求合并成一个微任务。 */
  private flushSoon(): void {
    if (this.flushing || this.disposed) return
    this.flushing = true
    queueMicrotask(() => { this.flush() })
  }

  /** 一次 flush：协调需求 → 到期入队 → 按 FIFO 用可用槽位启动 → 设置唯一唤醒 Timer。 */
  private flush(): void {
    this.flushing = false
    if (this.disposed) return
    this.clearWakeup()
    this.coordinateAll()
    const next = this.enqueueDue(Date.now())
    this.startQueued()
    this.scheduleWakeup(next)
  }

  /** 第一步：让每个在册需求按最新事实重新协调（资格变化在这里被吸收）。 */
  private coordinateAll(): void {
    for (const demand of [...this.demands]) this.coordinate(demand)
  }

  /** 第二步：把到期的实例登记进队列，返回最早的下次到期时刻（`Infinity`＝没有要等的）。 */
  private enqueueDue(now: number): number {
    let next = Infinity
    for (const bucket of this.buckets.values()) {
      for (const resource of bucket.values()) {
        // 有当前执行的实例不重复入队（A08）。
        if (resource.task) continue
        const due = resource.dueAt(now, this.visible)
        // `Infinity` ＝ 这个身份没有有资格的声明者：不取数，也不参与唤醒时刻。
        if (due <= now) this.enqueue(resource)
        else next = Math.min(next, due)
      }
    }
    return next
  }

  /**
   * 第三步：按 FIFO 用当前可用槽位启动。
   *
   * 队列里的任务必定就是它实例的当前执行——`queue` 的唯一写入者是 `placeTask`，它只在
   * 「这个任务就是当前执行」时才把它放进队列（§3.5 第 4 条）。因此这里不再需要复核归属。
   * 满槽时由任务结束唤醒（不自旋）；本轮内新增的请求留给下一轮。
   */
  private startQueued(): void {
    for (const task of [...this.queue]) {
      if (this.running.size >= this.maxConcurrent) break
      this.placeTask(task, 'running')
      void this.runTask(task)
    }
  }

  /** 第四步：队列已清空且还有明确的到期时刻时，安排唯一唤醒 Timer。 */
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

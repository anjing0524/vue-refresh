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
  /** 只读列举：给观测面（测试侧的支撑模块）用，不是包契约。 */
  list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[]
}

/**
 * 一个「URL ＋ 参数值」的共享实例：这个身份的**全部状态与判定**都在这个类里。
 *
 * 它不持有核心、也不持有页面：谁声明着它（`declarers` 的成员资格）、什么时候到期（`settledAt`）、
 * 这一轮的结果产出了没有（`produced` / `needsNext`）、哪一次执行还算数（`controller`）——
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
   * 这一轮的结果**已经产出**了没有（写表之前置起、一轮结束时清掉）。
   *
   * 它只回答「此刻这句刷新，本轮的结果还够不够用」：产出之前够——直接等这一轮就行（A14，不追发）；
   * 产出之后不够——这一轮已经写完了新的结果，要的必然是下一轮。
   */
  produced = false
  /** 产出之后又有人点过刷新：本轮结束后再排一次（插到队头，ADR-70）。 */
  needsNext = false
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

  /** 这个身份此刻**有没有执行**（在队或在跑）。 */
  hasExecution(): boolean {
    return this.controller !== null
  }

  /**
   * 这次执行**还是不是当前执行**？
   *
   * 不是就整段丢掉：实例被释放、页面换了身份、协调者销毁，都会把把手清空（`place` 是唯一写入点）。
   * 迟到的结果与迟到的异常都靠它判「还算不算数」。
   */
  isCurrent(controller: AbortController): boolean {
    return this.controller === controller
  }

  /** 还有人要它吗：还有声明者。没有就该回收（G4）——刷新是给身份的命令，不留账（ADR-70）。 */
  isWanted(): boolean {
    return this.declarers.size > 0
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
   * 结算一次执行：记下结算时刻，并标上「这一轮的结果已经产出」。
   *
   * **成功与失败都走它**（失败也算结算，因此不自动重试——A13）：两者的区别只在核心写结果表的哪个
   * 动作，实例侧没有任何差别，所以这里只有一个方法。
   *
   * 必须在写表**之前**调用：写表会同步触发页面代码（例如 `flush: 'sync'` 的 watcher），它可能当场
   * `refresh()`——有了这个标记，核心才知道那一刻点的是**下一轮**（DESIGN §3.9 第一条）。
   */
  settle(at: number): void {
    this.settledAt = at
    this.produced = true
  }
}

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/**
 * 身份键：`身份 = URL ＋ 参数值稳定键` 在运行期的字面形式（NUL 分隔，两个字符串里都不会出现）。
 *
 * 它是**注册表与结果表共用的那一个键**——两处各写一遍 `\0` 拼接就是一处会悄悄走样的重复。
 */
export function identityOf(url: string, key: string): string {
  return `${url}\u0000${key}`
}

/**
 * 身份键拆回两级（`store.list()` 用）：与 `identityOf` 紧挨着放，改分隔符不会只改到拼的那一半。
 *
 * 分隔符只在这一对函数里出现。`identityOf` 的注释点过「两处各写一遍拼接就是一处会悄悄走样的重复」，
 * 拆的那一半原先留在 `store.ts` 里（`indexOf('\0')` ＋ 两次 `slice`），正是同一类重复——而且走样时
 * 没有断言拦得住：整条键会被当成 `key` 返回，观测面的 `results[].key` 悄悄变形。
 *
 * **前提**：入参一定是 `identityOf` 的产物（结果表的键只有那一个写入点），所以第一个 NUL 必然存在、
 * 也必然是分界。不为不存在的输入补分支——真拿到不含分隔符的字符串时 `key` 会是空串、`url` 是整条，
 * 比悄悄截掉一个字符更容易看出不对。
 */
export function splitIdentity(identity: string): { readonly url: string; readonly key: string } {
  const sep = identity.indexOf('\u0000')
  return { url: identity.slice(0, sep), key: identity.slice(sep + 1) }
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
  /** 身份键 → 实例（键由 `identityOf` 构造；与结果表同一个键）。 */
  private readonly identities = new Map<string, Resource>()
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

  /** 销毁：幂等、不可复用。未结束的执行仍会真实结束，并在自己的 `finally` 里释放槽位。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWakeup()
    this.queue.clear()
    // 逐个实例撤销声明并回收：abort 在途、删结果表条目。
    // 不撤声明就回收不了，迟到的结果还会写进表（A17 把这条钉住了）。
    for (const resource of this.all()) {
      resource.declarers.clear()
      this.releaseIfUnused(resource)
    }
    this.identities.clear()
  }

  // ══════════════════════════ 页面操作 ══════════════════════════

  /**
   * 声明或更新身份；相同身份幂等。
   *
   * **参数先由适配层准备好再交进来**——复制、值域检查与身份键编码都在提交边界完成，框架不跑任何
   * 调用方回调（ADR-64、ADR-74）。
   * 换身份＝把这份配置从旧实例的 `declarers` 里摘掉、挂到新实例上；旧实例若因此没人要了就地回收。
   */
  submit(config: Config, url: string, parameters: Parameters): SubmitResult {
    if (this.disposed) return { status: 'cancelled' }

    const current = this.resourceOf(config)
    if (current && current.url === url && current.parameters.key === parameters.key) {
      return { status: 'accepted' }
    }
    if (current) {
      // 只摘声明：换身份后这一页在旧身份上没有任何残余（刷新不留账，ADR-70）。
      current.declarers.delete(config)
      this.releaseIfUnused(current)
    }
    this.resourceFor(url, parameters).declarers.add(config)
    this.flushSoon()
    return { status: 'accepted' }
  }

  /**
   * 显式刷新：让**这个身份**再取一次。核心不记是谁点的——调用方要的是数据新鲜，不是一张欠条（ADR-70）。
   *
   * 三条分支：没有执行 → 插到队头；有执行、结果还没产出 → 本轮结果就够，不追发（A14）；
   * 有执行、结果已经产出 → 这一轮满足不了它，记一笔，本轮结束再插一次队头。
   *
   * 返回值只说**这句命令收下了没有**（入口条件不成立时 `false`），不是取数回执：成功与失败都只经结果表。
   * 适配层用它决定自己那一页要不要跟着这一拍（读闸门在适配层，ADR-66）。
   */
  refresh(config: Config, url: string, key: string): boolean {
    if (this.disposed) return false
    if (!config.active || config.every === null || !this.visible) return false
    const resource = this.find(url, key)
    if (resource === undefined) return false

    if (!resource.hasExecution()) this.enqueueAtHead(resource)
    else if (resource.produced) resource.needsNext = true
    this.flushSoon()
    return true
  }

  /** 这一份配置此刻有没有取数资格：有资格 ＝ 环境允许 ＋ 开启意愿（G3/G4 的判定）。 */
  isEligible(config: Config, url: string, key: string): boolean {
    return this.find(url, key)?.isEligible(config, this.visible) ?? false
  }

  /** 释放一页：撤销它的声明（组件卸载、销毁都由它收尾）。撤销后若实例没人要了就地回收。 */
  undeclare(config: Config): void {
    const resource = this.resourceOf(config)
    if (resource === undefined) return
    resource.declarers.delete(config)
    this.releaseIfUnused(resource)
    this.flushSoon()
  }

  // ══════════════════════════ 身份注册表 ══════════════════════════

  /** 全部实例的一份快照（遍历时可能回收，所以先取出来）。 */
  private all(): Resource[] {
    return [...this.identities.values()]
  }

  /** 按身份键查找，没有就建立实例。 */
  private resourceFor(url: string, parameters: Parameters): Resource {
    const identity = identityOf(url, parameters.key)
    const existing = this.identities.get(identity)
    if (existing) return existing

    const resource = new Resource(url, parameters)
    this.identities.set(identity, resource)
    return resource
  }

  /** 按身份键找实例；只查不建。找不到＝这个身份不成立（没声明过，或已经被回收）。 */
  private find(url: string, key: string): Resource | undefined {
    return this.identities.get(identityOf(url, key))
  }

  /**
   * 这份配置登记在哪个实例上；只查不建。
   *
   * 扫描是「不存反向字段」的代价（ADR-57）：`declarers` 的成员资格是唯一事实，
   * 一次换身份／一次卸载各扫一遍注册表（用户动作级，规模是几十个身份）。
   */
  private resourceOf(config: Config): Resource | undefined {
    for (const resource of this.identities.values()) {
      if (resource.declarers.has(config)) return resource
    }
    return undefined
  }

  /**
   * 没有声明者了：删实例、abort 在途、删结果表条目。迟到的结束在身份复核处失效。**核心私有**。
   */
  private releaseIfUnused(resource: Resource): void {
    if (resource.isWanted()) return
    this.identities.delete(identityOf(resource.url, resource.parameters.key))

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

  /**
   * 插到队头：手动刷新是一次「人正等着」的取数，应当排在周期取数前面。
   *
   * `Set` 只记得住加入顺序，所以先 `place` 再按「它最前、其余保持原序」重建一次
   * （队列的规模是同时待取的身份数，几十个以内）。
   */
  private enqueueAtHead(resource: Resource): void {
    this.place(resource, 'queued')
    const waiting = [...this.queue].filter(other => other !== resource)
    this.queue.clear()
    this.queue.add(resource)
    for (const other of waiting) this.queue.add(other)
  }

  /**
   * 一轮结束后：产出之后又有人点过刷新，就补一次（插到队头）。
   * 唯一来源是写表触发的同步重入（DESIGN §3.9 第一条）。
   */
  private refill(resource: Resource): void {
    if (!resource.needsNext || resource.hasExecution()) return
    resource.needsNext = false
    this.enqueueAtHead(resource)
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
      if (!resource.isCurrent(controller)) return
      const data = copyResult(response.data)
      if (!resource.isCurrent(controller)) return
      const at = Date.now()
      // 先记结算时刻（上面那条同步重入靠它区分「这一轮」与「下一轮」），再写这一格。
      resource.settle(at)
      this.sink.write(resource.url, resource.parameters.key, data, at)
    } catch (error) {
      if (!resource.isCurrent(controller)) return
      const at = Date.now()
      // 失败也是这一轮的结算，只是写的是同一格的另一对字段（`sink.fail` 保留已有数据与时间）。
      resource.settle(at)
      this.sink.fail(resource.url, resource.parameters.key, error, at)
    } finally {
      this.place(resource, 'idle')
      resource.produced = false
      this.refill(resource)
      this.flushSoon()
    }
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
      if (resource.hasExecution()) continue
      const due = resource.dueAt(now, this.visible)
      // `Infinity` ＝ 这个身份没有有资格的声明者：不取数，也不参与唤醒时刻。
      // 这里已经跳过有当前执行的实例，所以入队只可能是「从没有执行到在队」，不替换、也不 abort 在途。
      if (due <= now) this.place(resource, 'queued')
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

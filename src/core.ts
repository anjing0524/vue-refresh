import type { SubmitResult } from './public-types.ts'
import type { Parameters } from './source.ts'

/** 共享取数与调度核心：只管一个身份自己的账（谁声明着它、还要不要再取、什么时候到期、哪次执行还算数），
 * 加上三件跨实例的事：身份注册表、FIFO 队列与并发槽、唯一唤醒 Timer。它不持有页面。 */

/** 一页报给核心的配置快照，同时就是这一页在核心里的登记。`every === null` ＝ 这一拍配置非法。 */
export interface Config {
  enabled: boolean
  every: number | null
  active: boolean
}

/** 结果表的一格：最后一次成功 ＋ 最近一次失败，四个字段全平。
 * `updatedAt === null` ⟺ 从未成功过；`failedAt === null` ⟺ 自最后一次成功以来没失败过。
 * 只有整格是新对象这一件事代表「变过」。 */
export interface ResultCell {
  readonly data: unknown
  readonly updatedAt: number | null
  readonly error: unknown
  readonly failedAt: number | null
}

/** 结果表：结果的唯一真值。核心只经这四个动作碰它。 */
export interface ResultSink {
  /** 写成功：整格替换（失败随之清空）。 */
  write(url: string, key: string, data: unknown, updatedAt: number): void
  /** 写失败：保留这一格已有的数据，只换掉失败那一对字段。 */
  fail(url: string, key: string, error: unknown, failedAt: number): void
  remove(url: string, key: string): void
  /** 只读列举：给观测面用，不是包契约。 */
  list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[]
}

/** 一个「URL ＋ 参数值」的共享实例：这个身份的全部状态与判定。它不持有核心、也不持有页面。 */
export class Resource {
  /** 取数 URL：身份的一半，也是结果表分区的第一级。 */
  readonly url: string
  readonly parameters: Parameters
  /** 声明了本身份的配置（页面挂载期间一直算，暂停、失活、隐藏都不撤销）。 */
  readonly declarers = new Set<Config>()
  /** 这一轮的结果已经产出了没有（写表之前置起、一轮结束时清掉）。 */
  produced = false
  /** 产出之后又有人点过刷新：本轮结束后再排一次。 */
  needsNext = false
  /** 最近一次正常结束的时刻；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null = null
  /** 这次执行的身份与取消把手；`null` ＝ 本实例此刻没有执行。 */
  controller: AbortController | null = null

  constructor(url: string, parameters: Parameters) {
    this.url = url
    this.parameters = parameters
  }

  /** 环境允许：这一页激活、配置有效、浏览器可见（与「开启意愿」是两件事）。 */
  isPresent(config: Config, visible: boolean): boolean {
    return visible && config.every !== null && config.active
  }

  /** 这个身份此刻有没有执行（在队或在跑）。 */
  hasExecution(): boolean {
    return this.controller !== null
  }

  /** 这次执行还是不是当前执行。 */
  isCurrent(controller: AbortController): boolean {
    return this.controller === controller
  }

  /** 还有人要它吗：还有声明者。 */
  isWanted(): boolean {
    return this.declarers.size > 0
  }

  /** 一个声明者此刻是否有资格取数：环境允许 ＋ 开启意愿为真。 */
  isEligible(config: Config, visible: boolean): boolean {
    return this.isPresent(config, visible) && config.enabled
  }

  /** 有效间隔现算：有资格的声明者里最小的 `every`；没有就是 `Infinity`。 */
  eligibleEvery(visible: boolean): number {
    let every = Infinity
    for (const config of this.declarers) {
      if (!this.isEligible(config, visible)) continue
      const value = config.every
      if (value !== null) every = Math.min(every, value)
    }
    return every
  }

  /** 下次到期时刻：`settledAt ＋ 当前最小间隔`；从未结算过的立即到期；没有有资格的人返回 `Infinity`。 */
  dueAt(now: number, visible: boolean): number {
    const every = this.eligibleEvery(visible)
    if (every === Infinity) return Infinity
    return this.settledAt === null ? now : this.settledAt + every
  }

  /** 结算一次执行：记下结算时刻并标上「这一轮的结果已经产出」（成功与失败都走它）。 */
  settle(at: number): void {
    this.settledAt = at
    this.produced = true
  }
}

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 身份键 `URL ＋ 参数值稳定键` 的字面形式（NUL 分隔）。注册表与结果表共用这一个键。 */
export function identityOf(url: string, key: string): string {
  return `${url}\u0000${key}`
}

/** 身份键拆回两级（`store.list()` 用）；与 `identityOf` 成对。前提：入参一定是 `identityOf` 的产物。 */
export function splitIdentity(identity: string): { readonly url: string; readonly key: string } {
  const sep = identity.indexOf('\u0000')
  return { url: identity.slice(0, sep), key: identity.slice(sep + 1) }
}

/** 结果边界：拒绝 `undefined`，其余原生复制。 */
function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('取数结果不能是 undefined')
  return structuredClone(input)
}

/** 取数传输：框架只需要一个 POST。 */
export interface RefreshHttp {
  post(url: string, data: unknown, config: { readonly signal: AbortSignal }): Promise<{ readonly data: unknown }>
}

/** 跨身份的协调者：身份注册表、FIFO 队列与并发槽、唯一唤醒 Timer、可见性与销毁。 */
export class RefreshCore {
  private readonly maxConcurrent: number
  private readonly http: RefreshHttp
  private readonly sink: ResultSink
  /** 身份键 → 实例。 */
  private readonly identities = new Map<string, Resource>()
  /** FIFO 待执行的实例（一个实例至多一个执行）。 */
  private readonly queue = new Set<Resource>()
  /** 真实尚未结束的请求；并发槽的唯一事实。 */
  private readonly running = new Set<Resource>()
  /** 唯一 Timer 的取消句柄。 */
  private wakeup: (() => void) | null = null
  /** 已安排、尚未执行的一轮合并调度。 */
  private flushing = false
  /** 浏览器可见性。 */
  private visible = true
  private disposed = false

  constructor(maxConcurrent: number, http: RefreshHttp, sink: ResultSink) {
    this.maxConcurrent = maxConcurrent
    this.http = http
    this.sink = sink
  }

  // ══════════════════════════ 状态观测与生命周期 ══════════════════════════

  /** 协调者是否已销毁。 */
  isDisposed(): boolean {
    return this.disposed
  }

  /** 浏览器此刻是否可见。 */
  isVisible(): boolean {
    return this.visible
  }

  /** 浏览器可见性：隐藏让所有页面失去资格，已经发出的请求不受影响。 */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    this.flushSoon()
  }

  /** 配置或生命周期变化后重新算一次到期与唤醒。 */
  reconcile(): void {
    this.flushSoon()
  }

  /** 销毁：幂等、不可复用。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWakeup()
    this.queue.clear()
    for (const resource of this.all()) {
      resource.declarers.clear()
      this.releaseIfUnused(resource)
    }
    this.identities.clear()
  }

  // ══════════════════════════ 页面操作 ══════════════════════════

  /** 声明或更新身份；相同身份幂等。换身份＝把这份配置从旧实例摘掉、挂到新实例上。 */
  submit(config: Config, url: string, parameters: Parameters): SubmitResult {
    if (this.disposed) return { status: 'cancelled' }

    const current = this.resourceOf(config)
    if (current && current.url === url && current.parameters.key === parameters.key) {
      return { status: 'accepted' }
    }
    if (current) {
      current.declarers.delete(config)
      this.releaseIfUnused(current)
    }
    this.resourceFor(url, parameters).declarers.add(config)
    this.flushSoon()
    return { status: 'accepted' }
  }

  /** 显式刷新：让这个身份再取一次。返回值只说这句命令收下了没有，不是取数回执。 */
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

  /** 这一份配置此刻有没有取数资格。 */
  isEligible(config: Config, url: string, key: string): boolean {
    return this.find(url, key)?.isEligible(config, this.visible) ?? false
  }

  /** 释放一页：撤销它的声明；没人要了就就地回收。 */
  undeclare(config: Config): void {
    const resource = this.resourceOf(config)
    if (resource === undefined) return
    resource.declarers.delete(config)
    this.releaseIfUnused(resource)
    this.flushSoon()
  }

  // ══════════════════════════ 身份注册表 ══════════════════════════

  /** 全部实例的一份快照（遍历时可能回收）。 */
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

  /** 按身份键找实例；只查不建。 */
  private find(url: string, key: string): Resource | undefined {
    return this.identities.get(identityOf(url, key))
  }

  /** 这份配置登记在哪个实例上；只查不建（扫描是不存反向字段的代价）。 */
  private resourceOf(config: Config): Resource | undefined {
    for (const resource of this.identities.values()) {
      if (resource.declarers.has(config)) return resource
    }
    return undefined
  }

  /** 没有声明者了：删实例、abort 在途、删结果表条目。 */
  private releaseIfUnused(resource: Resource): void {
    if (resource.isWanted()) return
    this.identities.delete(identityOf(resource.url, resource.parameters.key))

    this.sink.remove(resource.url, resource.parameters.key)
    const controller = resource.controller
    if (controller) {
      // 在跑的那次不能当场交还槽位：占位的是请求，不是实例。
      this.place(resource, this.running.has(resource) ? 'abandoned' : 'idle')
      controller.abort()
    }
  }

  // ══════════════════════════ 后台执行 ══════════════════════════

  /** 执行位置的唯一写入点：`queued`／`running`／`abandoned`（实例已回收、在跑请求仍占槽）／`idle`。 */
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

  /** 插到队头：手动刷新排在周期取数前面。 */
  private enqueueAtHead(resource: Resource): void {
    this.place(resource, 'queued')
    const waiting = [...this.queue].filter(other => other !== resource)
    this.queue.clear()
    this.queue.add(resource)
    for (const other of waiting) this.queue.add(other)
  }

  /** 一轮结束后：产出之后又有人点过刷新，就补一次。 */
  private refill(resource: Resource): void {
    if (!resource.needsNext || resource.hasExecution()) return
    resource.needsNext = false
    this.enqueueAtHead(resource)
  }

  /** 执行一次后台请求：结算 → 写表 → 释放槽位 → 补后继请求。框架不设自己的取数上限。 */
  private async run(resource: Resource): Promise<void> {
    const controller = resource.controller
    if (controller === null) return
    try {
      // 每一轮都交出一份参数副本：请求体改不动身份键描述的那份值。
      const response = await this.http.post(
        resource.url,
        structuredClone(resource.parameters.args),
        { signal: controller.signal },
      )
      // 复制结果前后各复核一次「这次还是不是当前执行」。
      if (!resource.isCurrent(controller)) return
      const data = copyResult(response.data)
      if (!resource.isCurrent(controller)) return
      const at = Date.now()
      // 先记结算时刻，再写这一格。
      resource.settle(at)
      this.sink.write(resource.url, resource.parameters.key, data, at)
    } catch (error) {
      if (!resource.isCurrent(controller)) return
      const at = Date.now()
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
      if (resource.hasExecution()) continue
      const due = resource.dueAt(now, this.visible)
      if (due <= now) this.place(resource, 'queued')
      else next = Math.min(next, due)
    }
    return next
  }

  /** 第二步：按 FIFO 用当前可用槽位启动。满槽时由请求真实结束唤醒。 */
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

  /** 取消唯一唤醒 Timer。 */
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

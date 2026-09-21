import type { SubmitResult } from './public-types.ts'
import type { Parameters } from './source.ts'
import { Resource, type Config } from './resource.ts'

/** 共享取数与调度核心：三件跨实例的事——身份注册表、待取队列与在途集合、唯一唤醒 Timer
 * （一个身份自己的账在 `resource.ts`）。它不持有页面。 */

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
  /** 读这一格；读取面（适配层）用它。 */
  read(url: string, key: string): ResultCell | undefined
}

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

/** 身份键 `URL ＋ 参数值稳定键` 的字面形式（NUL 分隔）。注册表与结果表共用这一个键。 */
export function identityOf(url: string, key: string): string {
  return `${url}\u0000${key}`
}

/** 身份键拆回两级（`store.list()` 用）：分隔符取最后一个 NUL——键里的 NUL 一定被 JSON 编码转义，URL 里可能有。 */
export function splitIdentity(identity: string): { readonly url: string; readonly key: string } {
  const sep = identity.lastIndexOf('\u0000')
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

/** 跨身份的协调者：身份注册表、待取队列与在途集合、唯一唤醒 Timer、可见性与销毁。 */
export class RefreshCore {
  private readonly maxConcurrent: number
  private readonly http: RefreshHttp
  private readonly sink: ResultSink
  /** 身份键 → 实例。 */
  private readonly identities = new Map<string, Resource>()
  /** 待取队列：**只表达顺序**（手动刷新与补的那一轮插到队头）；队里的实例都握着这次执行的把手。 */
  private readonly queue: Resource[] = []
  /** 在途集合：请求已经发出、还没结束的实例；并发槽的唯一事实。 */
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

  /** 把这一页的配置写进它自己那份槽并重排调度；三个值非法时只把 `every` 置 `null`（＝这一拍配置非法）。 */
  setConfig(config: Config, enabled: unknown, every: unknown, active: boolean): void {
    if (typeof enabled !== 'boolean' || typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1) {
      config.every = null
    } else {
      config.enabled = enabled
      config.every = every
      config.active = active
    }
    this.flushSoon()
  }

  /** 销毁：幂等、不可复用。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearWakeup()
    // 逐个实例撤销声明并回收；回收会把实例从注册表与队列里摘掉，所以两个集合循环后必然已空。
    for (const resource of [...this.identities.values()]) {
      resource.declarers.clear()
      this.releaseIfUnused(resource)
    }
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
    const resource = this.identities.get(identityOf(url, key))
    if (resource === undefined) return false
    if (!resource.isPresent(config, this.visible)) return false

    if (!resource.hasExecution()) this.enqueue(resource, true)
    // 结果已经产出了才需要「再来一轮」；还没产出的话本轮结果就够。
    else if (resource.produced) resource.needsNext = true
    this.flushSoon()
    return true
  }

  /** 这一份配置此刻有没有取数资格。 */
  isEligible(config: Config, url: string, key: string): boolean {
    return this.identities.get(identityOf(url, key))?.isEligible(config, this.visible) ?? false
  }

  /** 读这一格的结果；读取面（适配层）用它。 */
  readResult(url: string, key: string): ResultCell | undefined {
    return this.sink.read(url, key)
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

  /** 按身份键查找，没有就建立实例。 */
  private resourceFor(url: string, parameters: Parameters): Resource {
    const identity = identityOf(url, parameters.key)
    const existing = this.identities.get(identity)
    if (existing) return existing

    const resource = new Resource(url, parameters)
    this.identities.set(identity, resource)
    return resource
  }

  /** 这份配置登记在哪个实例上；只查不建（扫描是不存反向字段的代价）。 */
  private resourceOf(config: Config): Resource | undefined {
    for (const resource of this.identities.values()) {
      if (resource.declarers.has(config)) return resource
    }
    return undefined
  }

  /** 没有声明者了：删实例与结果表条目，并把这一份账一笔勾销（在途请求仍占着槽位，但结果不再算数）。 */
  private releaseIfUnused(resource: Resource): void {
    if (resource.isWanted()) return
    this.identities.delete(identityOf(resource.url, resource.parameters.key))

    this.sink.remove(resource.url, resource.parameters.key)
    // 身份没了，欠的那一轮与这次执行的认人一起作废——否则收尾时会把已释放的实例重新排进队列。
    resource.needsNext = false
    const controller = resource.controller
    this.dequeue(resource)
    resource.controller = null
    if (controller) controller.abort()
  }

  // ══════════════════════════ 后台执行 ══════════════════════════

  /** 排进待取队列（`first` 插到队头），并给它这次执行的把手；调用点都保证它此刻不在队里。 */
  private enqueue(resource: Resource, first = false): void {
    if (first) this.queue.unshift(resource)
    else this.queue.push(resource)
    resource.controller = new AbortController()
  }

  /** 从待取队列里摘掉；不在队里就什么也不做。 */
  private dequeue(resource: Resource): void {
    const index = this.queue.indexOf(resource)
    if (index >= 0) this.queue.splice(index, 1)
  }

  /** 执行一次后台请求：结算 → 写表 → 交还槽位 → 补后继请求。框架不设自己的取数上限。 */
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
      // 复制结果前后各复核一次「这次还是不是当前执行」：复制要读属性，取值器可能同步重入。
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
      this.running.delete(resource)
      resource.controller = null
      resource.produced = false
      // 产出之后又有人点过刷新：本轮结束再补一次，插到队头。
      if (resource.needsNext) {
        resource.needsNext = false
        this.enqueue(resource, true)
      }
      this.flushSoon()
    }
  }

  // ══════════════════════════ 调度 ══════════════════════════

  /** 安排一次合并调度；同一轮内的多次变更合并成一个微任务。 */
  private flushSoon(): void {
    if (this.flushing || this.disposed) return
    this.flushing = true
    queueMicrotask(() => { this.flush() })
  }

  /** 一次调度：到期入队 → 用可用槽位启动 → 队列空了就安排唯一唤醒 Timer。 */
  private flush(): void {
    this.flushing = false
    if (this.disposed) return
    this.clearWakeup()
    const next = this.enqueueDue(Date.now())
    this.startQueued()
    if (this.queue.length === 0 && next < Infinity) this.setWakeup(next)
  }

  /** 第一步：把到期的实例排进队列，返回最早的下次到期时刻（`Infinity`＝没有要等的）。 */
  private enqueueDue(now: number): number {
    let next = Infinity
    for (const resource of [...this.identities.values()]) {
      if (resource.hasExecution()) continue
      const due = resource.dueAt(now, this.visible)
      if (due <= now) this.enqueue(resource)
      else next = Math.min(next, due)
    }
    return next
  }

  /** 第二步：按队列顺序用当前可用槽位启动。满槽时由请求真实结束唤醒。 */
  private startQueued(): void {
    while (this.running.size < this.maxConcurrent) {
      const resource = this.queue.shift()
      if (resource === undefined) break
      this.running.add(resource)
      void this.run(resource)
    }
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

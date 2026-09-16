import type { Clock, Resource, ScheduleHost, ScheduleInspection, Task } from './model.ts'
import type { SourceRuntime } from './source.ts'

/**
 * 后台调度：唯一 Timer、FIFO 队列与真实并发槽位的所有者。
 *
 * 从 `Manager` 外移出来的只有「何时、按什么顺序执行」这一类事实；「什么算到期」
 * （Resource 的订阅间隔与上次结束时间）、「谁该被登记」、「怎么执行」都由 `ScheduleHost`
 * 提供的回调回到编排层。这样拆的理由是这几条不变量互不相关却原来混在一个类里：
 * 一个 Timer、队列 FIFO、槽位按真实结束释放、满槽不自旋。
 *
 * 顺序约束：`flush` 内部固定是「协调句柄 → 到期入队 → 占用槽位启动 → 安排下次唤醒」，
 * 且每一步都可能被同步重入打断，因此每一步都重新读事实，不缓存上一阶段的结论。
 *
 * `Manager.dispose()` 之后本类不再安排任何调度；已启动的任务仍会真实结束，
 * 并在自己的 `finally` 里释放槽位。
 */

/** `setTimeout` 的平台上限（约 24.8 天）；更远的到期时间必须分段等待。 */
const MAX_TIMER_DELAY = 2_147_483_647

export class Scheduler {
  private readonly clock: Clock
  private readonly maxConcurrent: number
  private readonly host: ScheduleHost
  /** Source → 参数键 → 运行实例；调度要遍历全部活跃 Resource，因此构造时注入。 */
  private readonly buckets: ReadonlyMap<SourceRuntime, ReadonlyMap<string, Resource>>
  /** FIFO 待执行任务。 */
  private readonly queue = new Set<Task>()
  /** 真实尚未结束的任务；并发槽位的唯一事实。 */
  private readonly running = new Set<Task>()
  /** 唯一 Timer 的取消函数；字段保存的就是取消句柄，调用即取消。 */
  private cancelTimer: (() => void) | null = null
  private flushPending = false

  constructor(
    clock: Clock,
    maxConcurrent: number,
    buckets: ReadonlyMap<SourceRuntime, ReadonlyMap<string, Resource>>,
    host: ScheduleHost,
  ) {
    this.clock = clock
    this.maxConcurrent = maxConcurrent
    this.buckets = buckets
    this.host = host
  }

  /** 只读投影：集合是副本，调用方改不动调度状态。 */
  inspect(): ScheduleInspection {
    return {
      queued: [...this.queue],
      running: [...this.running],
      scheduled: this.cancelTimer !== null,
      pendingFlush: this.flushPending,
    }
  }

  /** 登记一次排队任务；同一 Resource 的旧任务由调用方先行取消。 */
  add(task: Task): void {
    this.queue.add(task)
  }

  /** 取消一个尚未开始的排队任务；已在 running 的任务不受影响。 */
  cancel(task: Task): void {
    this.queue.delete(task)
  }

  /** 释放一个真实结束的任务所占的物理槽位。 */
  release(task: Task): void {
    this.running.delete(task)
  }

  /** 安排一次 flush；同一轮内的多次请求合并成一次微任务。 */
  requestFlush(): void {
    if (this.host.isDisposed() || this.flushPending) return
    this.flushPending = true
    queueMicrotask(() => this.flush())
  }

  /**
   * 一次 flush：协调句柄并加入需求 → 到期入队 → 按 FIFO 用可用槽位执行 → 设置唯一 Timer。
   * flush 期间新增的请求留给下一轮。
   */
  private flush(): void {
    this.flushPending = false
    if (this.host.isDisposed()) return

    this.clearTimer()
    this.host.reconcileHandles()
    const nextDue = this.enqueueDue(this.clock.now())
    this.startQueuedTasks()
    if (!this.host.isDisposed() && !this.flushPending) this.setWakeup(nextDue)
  }

  /** 停止调度：幂等。排队任务全部作废；已启动的任务由各自的 finally 释放槽位。 */
  dispose(): void {
    this.clearTimer()
    this.queue.clear()
  }

  /** 全部活跃 Resource；按 Source 分桶遍历，不逐条扫描聚合。 */
  private *activeResources(): Generator<Resource> {
    for (const bucket of this.buckets.values()) yield* bucket.values()
  }

  /**
   * 该 Resource 在 `now` 时刻的下次到期时间：有效间隔取当前所有订阅的最小值（现算，不缓存）；
   * 从未正常结束过的 Resource 立即到期，即等于传入的 `now`。
   *
   * `now` 必须由调用方一次读定并传进来，不能在函数内再读一次时钟：真实时钟在一次 flush 内
   * 会前进，两次读数会把「立即到期」变成 `due > now`，于是首次入队被推迟到一个 0ms Timer。
   */
  private dueAt(resource: Resource, now: number): number {
    let every = Infinity
    for (const subscription of resource.subscribers) every = Math.min(every, subscription.every)
    return resource.lastSettledAt === null ? now : resource.lastSettledAt + every
  }

  /**
   * 一趟遍历收齐两件事：到期该入队的 Resource，以及剩下 Resource 的最早到期时间。
   *
   * 两件事必须同一趟算：入队动作本身把 Resource 变成「已有当前任务」，而「下次何时唤醒」
   * 只关心还没有任务的 Resource。分两趟写就要扫两遍活跃 Resource，且第二遍必须重新判断
   * 第一遍刚改过的 `resource.task`。
   */
  private enqueueDue(now: number): number {
    let next = Infinity
    for (const resource of this.activeResources()) {
      if (resource.task) continue
      const due = this.dueAt(resource, now)
      if (due <= now) this.host.enqueueTask(resource)
      else next = Math.min(next, due)
    }
    return next
  }

  /** 按 FIFO 把排队任务移入 running 并启动，直到占满并发槽位。 */
  private startQueuedTasks(): void {
    for (const task of [...this.queue]) {
      // load 的同步前缀可以改变后续任务，因此每一项在启动前都重查身份。
      if (!this.host.isCurrentTask(task)) {
        this.queue.delete(task)
        continue
      }
      if (this.running.size >= this.maxConcurrent) return
      this.queue.delete(task)
      this.running.add(task)
      this.host.startTask(task)
    }
  }

  /** 取消当前 Timer；字段保存的是取消句柄，因此调用即取消。 */
  private clearTimer(): void {
    const cancel = this.cancelTimer
    this.cancelTimer = null
    cancel?.()
  }

  /** 设置唯一的下次唤醒 Timer；`nextDue` 为 Infinity 时保持无 Timer（满槽由真实 finally 唤醒）。 */
  private setWakeup(nextDue: number): void {
    if (nextDue === Infinity) return
    const delay = Math.min(MAX_TIMER_DELAY, Math.max(0, nextDue - this.clock.now()))
    this.cancelTimer = this.clock.setTimer(() => {
      this.cancelTimer = null
      this.requestFlush()
    }, delay)
  }
}

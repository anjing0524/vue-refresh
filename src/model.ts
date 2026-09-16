import type { Parameters, SourceRuntime } from './source.ts'
import type { RefreshDisplay, RefreshError, RefreshResult } from './public-types.ts'

/**
 * 内部模型：核心拥有的运行时事实。
 *
 * 只保存必须保存的事实，不放派生值：Task 的执行位置由 `Scheduler` 的 queue/running 决定；
 * 最短间隔由各 Subscription.every 现算；资格由配置快照、生命周期、可见性和
 * 当前声明推导。字段的写入者与释放时机见统一文档「数据模型」一节。
 */

/** 页面整体发布值；Vue 通过 shallowRef 持有，核心不保存副本。 */
export type Display = RefreshDisplay<object, unknown>

/** 某个 Resource 最近一次有效后台结果。 */
export interface StoreEntry {
  /** 产生该结果的 Resource 任务版本。 */
  readonly version: number
  /** 独立复制的 DTO。 */
  readonly data: unknown
  /** 结果产生时的墙钟时间；随结果一起存放，后加入的订阅者读到的是原时间。 */
  readonly updatedAt: number
}

/** 核心使用的结果存储端口；不向核心暴露 Pinia 实现。 */
export interface ResultStore {
  readonly entries: Readonly<Partial<Record<string, StoreEntry>>>
  put(id: string, entry: StoreEntry): void
  remove(id: string): void
  dispose(): void
}

/**
 * 资格成立时的配置快照：开启意愿为真，因此周期必然存在（由 `readConfiguration` 保证）。
 * 单独成一个接口，资格判定就能直接陈述「有周期」这个事实，调用方不需要再判别或断言。
 */
export interface EnabledInput {
  readonly valid: true
  readonly enabled: true
  /** 刷新间隔（毫秒）。 */
  readonly every: number
  readonly visible: boolean
}

/** 三项配置都已成功读取；未开启时允许不给周期（`every` 为 `null`，此时不会建立订阅）。 */
export type ValidInput =
  | EnabledInput
  | { readonly valid: true; readonly enabled: false; readonly every: number | null; readonly visible: boolean }

/** 至少一项读取失败；读不到的开关或可见性保留为 null，不推断为关闭。 */
export interface InvalidInput {
  readonly valid: false
  readonly enabled: boolean | null
  readonly visible: boolean | null
  /** 首个失败项的异常；其余失败项不进入这个快照。 */
  readonly error: unknown
}

/** Vue 配置读取结果；核心只读这个快照，不重新调用业务 getter。 */
export type Input = ValidInput | InvalidInput

/** 页面与共享 Resource 的一次周期连接；退出即失效。 */
export interface Subscription {
  readonly owner: Handle
  readonly resource: Resource
  /** 该连接当前的刷新间隔（毫秒）；Resource 取所有订阅的最小值。 */
  every: number
}

/**
 * 一次显式刷新在共享资源上的临时要求。
 *
 * `minVersion` 是这次动作要求的下限：必须由一个「在本次刷新之后启动」的任务提供结果。
 * 排队未启动的任务已经算「之后启动」，因此可以直接满足它；已在执行的任务不算，
 * 本次刷新等它结束后由 `refillWaiters` 补一次后继请求。
 *
 * `settle` 是原生 Promise 的 resolver：只有第一次结算生效，因此不需要 settled 镜像。
 */
export interface RefreshWaiter {
  readonly owner: Handle
  readonly resource: Resource
  readonly minVersion: number
  readonly settle: (result: RefreshResult) => void
}

/** 句柄已声明的订阅身份；声明是幂等的，新身份整体替换旧身份。 */
export interface Submission {
  readonly parameters: Parameters
}

/** 组件需求的所有者。 */
export interface Handle {
  /** 该句柄的固定资源定义；创建后不变。 */
  readonly source: SourceRuntime
  /** 读取最近一次 Vue 配置快照；绝不调用业务 getter。 */
  readonly readInput: () => Input
  /** 发布本页快照（args/data/origin 同次整体替换）。 */
  readonly publish: (display: Display) => void
  /** 错误通知出口；框架立即观察其异步拒绝，但不等待。 */
  readonly onError: (error: RefreshError) => void | Promise<void>
  /** 作用域释放回调；至多一个，卸载时执行。 */
  cleanup: (() => void) | null
  /** 声明代次；用于识别「本次声明是否仍被接纳」。 */
  operationId: number
  /** 当前已声明的身份；没有有效声明时为 null。 */
  submission: Submission | null
  /** 当前周期订阅；资格成立时存在。 */
  subscription: Subscription | null
  /** 尚未结算的刷新要求；与订阅互不排斥，可同时存在。 */
  refreshes: Set<RefreshWaiter>
  /** 组件是否处于挂载/激活状态；由 Vue 生命周期维护。 */
  lifecycleActive: boolean
  /** 句柄已释放；释放后不再接纳操作。 */
  disposed: boolean
}

/** 同一定义、同一组参数值的一次共享生存期；最后一个订阅与刷新要求都退出即销毁。 */
export interface Resource {
  /** 资源实例 id（`命名空间:序号`），标识一次生存期而非数据范围。 */
  readonly id: string
  readonly source: SourceRuntime
  /** 创建该实例时已准备的参数；后加入者不改写它。 */
  readonly parameters: Parameters
  readonly subscribers: Set<Subscription>
  /** 尚未结算的刷新要求；有它时实例不因最后一个订阅退出而销毁。 */
  readonly waiters: Set<RefreshWaiter>
  /** 任务版本分配计数，与 Task.version 处于同一版本域。 */
  issuedVersion: number
  /** 至多一个当前后台任务；没有当前任务时由到期或刷新要求登记。 */
  task: Task | null
  /** 最近一次正常结束（成功或失败）的时间；取消不更新。 */
  lastSettledAt: number | null
}

/** 一次后台执行；队列位置由 `Scheduler` 的 `queue` / `running` 决定。 */
export interface Task {
  readonly resource: Resource
  readonly version: number
  readonly controller: AbortController
}

/**
 * 可控时间端口；适配器持有平台 Timer ID，核心只持有取消能力。
 *
 * 实现必须满足三条契约，核心的调度依赖它们：
 * - `now()` 单调不减，只用于调度与到期计算；它不是墙钟，校时不影响它；
 * - `timestamp()` 是墙钟读数，允许回拨，只用于对外交付的结果时间；
 * - `setTimer` 返回的取消函数幂等，且**不得同步回调**：同步回调会在赋值完成前重入
 *   调度，把已经清空的取消句柄又覆盖回去（见 `Scheduler.setWakeup`）。
 */
export interface Clock {
  /** 单调时间，只用于调度与到期计算。 */
  now(): number
  /** 墙钟 epoch 毫秒，只用于对外交付的结果时间；不与 `now()` 混用。 */
  timestamp(): number
  setTimer(callback: () => void, ms: number): () => void
}

/**
 * 配置适配层看到的编排层窄端口。
 *
 * 组件适配只用这两件事：配置变化后的协调，以及被同步替换时的一次调度。
 * `Manager` 在结构上满足它，因此不需要转发类，依赖方向也不必为它破例。
 */
export interface ConfigurationHost {
  /** 按最新配置快照协调一个句柄。 */
  reconcile(handle: Handle): void
  /** 安排一次合并调度。 */
  requestFlush(): void
}

/** 调度器对外只读投影；与 {@link ManagerInspection} 同一口径。 */
export interface ScheduleInspection {
  readonly queued: readonly Task[]
  readonly running: readonly Task[]
  /** 存在唯一的唤醒 Timer。 */
  readonly scheduled: boolean
  /** 已安排、尚未执行的一轮合并调度。 */
  readonly pendingFlush: boolean
}

/**
 * 调度器回到编排层取事实的窄端口。
 *
 * 调度器只管「何时、按什么顺序执行」；「谁该被登记」「怎么执行」都留在 `Manager`。
 * `Manager` 在构造时用一个对象字面量满足它，因此这里不需要转发类；这些回调也不进入
 * `Manager` 的公共面。活跃 Resource 的遍历归调度器：构造时注入注册表，它自己分桶遍历。
 */
export interface ScheduleHost {
  /** Manager 是否已销毁；销毁后调度立即停止。 */
  isDisposed(): boolean
  /** 一轮 flush 的编排：协调每个句柄并接入需求。 */
  reconcileHandles(): void
  /** 为 Resource 登记一次后台执行（分配版本）。 */
  enqueueTask(resource: Resource): void
  /** 任务是否仍是所属 Resource 的当前任务。 */
  isCurrentTask(task: Task): boolean
  /** 真正执行一次后台任务；调度器不等待它结束。 */
  startTask(task: Task): void
}

/**
 * Manager 内部事实的只读投影。
 *
 * 给测试与开发面板使用：集合是调用当时的副本，不暴露 `Set` / `Map` 本身，因此调用方
 * 无法增删核心状态；元素仍是核心对象（比较身份是这些断言的要点），所以它是观察面，
 * 不是安全边界，也不属于公开契约。
 */
export interface ManagerInspection {
  readonly disposed: boolean
  /** 浏览器可见性这一项事实。 */
  readonly visible: boolean
  /** 已安排、尚未执行的一轮合并调度。 */
  readonly pendingFlush: boolean
  /** 存在唯一的唤醒 Timer。 */
  readonly scheduled: boolean
  readonly handles: readonly Handle[]
  readonly resources: readonly Resource[]
  readonly queued: readonly Task[]
  readonly running: readonly Task[]
  readonly entries: Readonly<Partial<Record<string, StoreEntry>>>
}

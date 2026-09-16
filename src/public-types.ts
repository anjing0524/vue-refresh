import type { App, Ref, ShallowRef } from 'vue'
import type { Pinia } from 'pinia'

/**
 * 公共契约：本文件是正式 API 类型的唯一代码入口。
 * 这些签名与统一文档「公共 API 契约」一节共同构成对外约定。
 */

/** 递归只读视图；函数类型保持原样，避免把回调参数也变成只读。 */
export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T

/** 可以是值、只读 Ref 或 getter；Vue 适配层统一解包。 */
export type RefreshInput<T> = T | Readonly<Ref<T>> | (() => T)

// ─── 状态取值 ──────────────────────────────────────────────────────────────
// 每个封闭状态域枚举为一个常量对象（成员名 + 字面量），类型由对象推导：新增、删除或
// 收敛一个状态只改这里。句柄活动判别只在核心内部使用，放在 `model.ts`。
// 不使用 TS enum —— erasableSyntaxOnly 与 Node 的类型擦除都不接受它。

/** 一次请求的来源。 */
export const RequestOrigin = {
  /** 页面主动查询。 */
  Query: 'query',
  /** 框架后台刷新。 */
  Background: 'background',
} as const
export type RequestOrigin = (typeof RequestOrigin)[keyof typeof RequestOrigin]

/**
 * 错误的来源：**哪一步失败了**。
 * - `execution`：页面查询的执行失败（runner 抛错或拒绝）。`QueryResult` 的 `origin` 与
 *   `onError` 的 `origin` 因此对同一次失败给出同一个取值；后台刷新失败另用 `background`；
 * - `background`：共享条目的后台刷新失败（条目暂不可得）；
 * - `validation` / `configuration`：参数准备失败 / 入口配置非法。
 * 框架自身的 observer 诊断只写日志、不经 `onError` 投递，因此不在这个取值域内。
 */
export const ErrorOrigin = {
  /** 请求执行失败。 */
  Execution: 'execution',
  /** 后台刷新失败；与 `RequestOrigin.Background` 同一字面量。 */
  Background: RequestOrigin.Background,
  /** 参数准备失败。 */
  Validation: 'validation',
  /** 入口配置非法。 */
  Configuration: 'configuration',
} as const
export type ErrorOrigin = (typeof ErrorOrigin)[keyof typeof ErrorOrigin]

/**
 * 独立查询的失败来源：`ErrorOrigin` 里可由 `query` 结算产生的取值。
 * 不单独维护常量对象——取值以成员引用表达，这里只收窄类型。
 */
export type QueryErrorOrigin = Exclude<ErrorOrigin, 'background'>

/** 取消原因。 */
export const CancelReason = {
  /** 被同一句柄的新操作替代。 */
  Superseded: 'superseded',
  /**
   * 因「不再允许」而取消：`enabled` 关闭，或失去激活、隐藏。
   * 两种情况对调用方的可执行含义相同，且原因信息在调用方自己手里，因此不再区分成两个取值。
   */
  Unavailable: 'unavailable',
  /** 句柄或 Manager 已销毁。 */
  Disposed: 'disposed',
} as const
export type CancelReason = (typeof CancelReason)[keyof typeof CancelReason]

/**
 * `submit` 能产生的取消原因：`CancelReason` 的可达子集。
 * 与 `QueryErrorOrigin` 同一做法——由常量对象推导而不是手写字面量，成员被重命名或删除时
 * 这里会一起报错，不会留下类型上仍合法、语义上已不存在的取值。
 */
export type SubmitCancelReason = Exclude<CancelReason, typeof CancelReason.Unavailable>

declare const sourceBrand: unique symbol

/**
 * 固定资源定义。品牌字段只存在于类型层：`P` 与 `T` 必须与定义时一致，
 * 因此不能用更宽的泛型绕过参数或结果类型检查。
 */
export interface RefreshSource<P extends object, T> {
  readonly [sourceBrand]: { readonly args: (value: P) => P; readonly data: (value: T) => T }
}

/** 框架请求（load / runner）收到的上下文。 */
export interface RefreshLoadContext { readonly signal: AbortSignal }

/**
 * 独立查询的上下文：额外提供受有效性保护的同步副作用入口。
 *
 * `commit` 只在当前查询仍然有效时执行 `effect` 并返回 `true`，失效返回 `false` 且不执行。
 * `effect` 必须同步返回 `undefined`：其它返回值按违约处理——同步抛错给 runner，该次查询随之以
 * `execution` 结算为失败并通知，异步返回的 Promise 拒绝只走 observer 诊断（统一文档 §2.5）。
 */
export interface RefreshQueryContext extends RefreshLoadContext { commit(effect: () => undefined): boolean }

/**
 * 错误通知值。
 * `error` 是原始异常，供页面自行判断；框架自身的诊断日志不会输出它的内容。
 * 通知不携带 `operationId` / `resourceId` / `taskVersion` 这类框架身份：它们无法被调用方用于
 * 比较或续传，只在 observer 诊断事件里做日志关联（见 DESIGN.md §3.8），不进公开契约。
 */
export interface RefreshError {
  readonly origin: ErrorOrigin
  readonly error: unknown
}

/**
 * `submit` 的同步结果。
 * `accepted` 只表示参数已被记录，不代表请求成功；参数被拒时来源必然是校验，
 * 因此不需要额外的 origin 字段。取消原因收窄为可达的两种（`SubmitCancelReason`）：
 * `submit` 没有入口配置与可见性检查，不会被 `unavailable` 取消。
 */
export type SubmitResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'cancelled'; readonly reason: SubmitCancelReason }

/**
 * `query` 的结算结果。取消立即结算，不等底层请求真正结束。
 * `origin` 是失败发生的那一步，取值域与 `RefreshError['origin']` 一致但不含 `background`：
 * 查询路径不会产生「后台条目暂不可得」。
 */
export type QueryResult =
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly origin: QueryErrorOrigin; readonly error: unknown }
  | { readonly status: 'cancelled'; readonly reason: CancelReason }

/**
 * 页面独立快照：展示参数、数据、来源与结果产生时间同次整体发布。
 * `updatedAt` 是产生本条结果的墙钟 epoch 毫秒：后加入的订阅者读到已有结果时，
 * 拿到的仍是原结果时间，因此可以据此显示数据多旧。
 */
export interface RefreshDisplay<P extends object, T> {
  readonly args: DeepReadonly<P>
  readonly data: DeepReadonly<T>
  readonly origin: RequestOrigin
  readonly updatedAt: number
}

/**
 * 组件刷新需求配置。`P` 由 `useRefresh(source)` 推断，不在这里重复声明。
 *
 * 本对象是 setup 期参数：框架持有这个对象本身，运行期只重新读取它的字段。
 * 整体替换调用方手里的对象（例如把 `options.value` 换成新对象）不会传到这里，
 * 需要动态切换某项输入时让该字段本身是 Ref / getter，而不是换掉整个对象。
 */
export interface RefreshOptions {
  /**
   * 唯一开启意愿。框架只读取它，**从不写入**：查询执行失败只结算并通知，
   * 是否停止轮询由调用方在 `onError` 里自行决定。
   */
  readonly enabled: RefreshInput<boolean>
  /** 刷新间隔（毫秒）；只接受正安全整数，不自动转换或取整。 */
  readonly every: RefreshInput<number>
  /** 额外可见条件（如自定义页签）；缺省视为可见。 */
  readonly visible?: RefreshInput<boolean>
  /**
   * 错误通知；框架立即观察其异步拒绝，但不等待完成。
   * 每次通知都重新读取本字段，因此 `options.onError = next` 立即生效（换掉整个对象不生效，见上）。
   */
  readonly onError?: (error: RefreshError) => void | Promise<void>
}

/** 组件句柄：表达刷新需求并读取本页快照。 */
export interface RefreshHandle<P extends object, T> {
  /** 本页最近一次发布值；只读、整体替换，不做深响应式。 */
  readonly display: Readonly<ShallowRef<RefreshDisplay<P, T> | null>>
  submit(args: P): SubmitResult
  query(args: P, runner: (args: DeepReadonly<P>, context: RefreshQueryContext) => Promise<T>): Promise<QueryResult>
}

/** 创建 Manager 的必填配置。参数边界见[统一文档](./统一刷新管理.md) §5 G01。 */
export interface RefreshManagerOptions {
  readonly pinia: Pinia
  /** 后台任务的并发上限；独立查询不占该槽位。 */
  readonly maxConcurrent: number
}

/** 应用级协调者：安装、只读快照与销毁。 */
export interface RefreshManager {
  install(app: App): void
  /** 按参数值定位共享结果并返回独立副本；不创建资源、不延长生存期，无分区返回 undefined。 */
  readSnapshot<P extends object, T>(source: RefreshSource<P, T>, args: P): DeepReadonly<T> | undefined
  dispose(): void
}

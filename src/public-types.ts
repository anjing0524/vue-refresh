import type { App, Ref, ShallowRef } from 'vue'

/**
 * 公共契约：本文件是正式 API 类型的唯一代码入口，与《统一刷新管理》「公共 API 契约」一节共同构成对外约定。
 *
 * 状态取值都提前枚举为常量对象，公开类型由对象推导：新增、删除或收敛一个取值只改这里。
 * 不使用 `enum` —— `erasableSyntaxOnly` 与 Node 的类型擦除都不接受该语法。
 */

/** 递归只读视图：编译期约束。框架交付的是独立副本，因此拿到只读视图不等于共享对象不可写。 */
export type ReadonlySnapshot<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends object ? { readonly [K in keyof T]: ReadonlySnapshot<T[K]> } : T

/**
 * 错误的来源：**哪一步失败了**。
 * - `request`：共享请求失败（含框架上限到期）；
 * - `validation`：订阅声明的参数准备失败；
 * - `configuration`：刷新入口或配置快照非法。
 */
export const ErrorOrigin = {
  Request: 'request',
  Validation: 'validation',
  Configuration: 'configuration',
} as const
export type ErrorOrigin = (typeof ErrorOrigin)[keyof typeof ErrorOrigin]

/** 取消原因。`enabled` 关闭与失去存在对调用方的可执行含义相同，因此不再拆成两个取值。 */
export const CancelReason = {
  /** 被同一句柄的新声明替代。 */
  Superseded: 'superseded',
  /** 失去存在：失活或浏览器隐藏。 */
  Unavailable: 'unavailable',
  /** 句柄或协调者已销毁。 */
  Disposed: 'disposed',
} as const
export type CancelReason = (typeof CancelReason)[keyof typeof CancelReason]

/**
 * 固定资源定义：`P` 与 `T` 与 `load` 绑定。
 *
 * 两个成员都写成**方法**：方法参数按双变比较，因此具体 Source 可以直接进入框架的擦除视图
 * （`RefreshSource<object, unknown>`）与异步注册表槽位，接收点不必保留类型断言。
 * 代价是「拿一个擦除后的 Source 当具体 Source 用」不再被编译器拦住——与 ADR-24 对 `publish` 的取舍一致。
 */
export interface RefreshSource<P extends object, T> {
  load(args: ReadonlySnapshot<P>, context: { readonly signal: AbortSignal }): Promise<T>
  validate?(args: ReadonlySnapshot<P>): boolean
}

/**
 * 错误通知值。`error` 是原始异常，供页面自行判断。
 * `operationId` 是产生这条错误的声明代次（框架生成、只用于认领）：一个页面里有两处
 * `useRefresh` 且共用同一个 `onError` 时，据此分辨这是谁的失败；尚无有效代次时字段缺席。
 */
export interface RefreshError {
  readonly origin: ErrorOrigin
  readonly error: unknown
  readonly operationId?: number
}

/**
 * `submit` 的同步结果。`accepted` 只表示身份已被记录，不代表请求成功。
 * 取消原因收窄为可达的两种：声明不检查可见性与开启意愿，因此不会被 `unavailable` 取消。
 */
export type SubmitResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'cancelled'; readonly reason: typeof CancelReason.Superseded | typeof CancelReason.Disposed }

/**
 * `refresh` 的结算结果。取消立即结算，不等底层请求真正结束。
 * 它只报「这次刷新有没有拿到新结果」，不携带 DTO：数据仍只经 `display` 交付。
 */
export type RefreshResult =
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly origin: typeof ErrorOrigin.Request | typeof ErrorOrigin.Configuration; readonly error: unknown }
  | { readonly status: 'cancelled'; readonly reason: CancelReason }

/** 交付面：参数、数据与结果产生时间同次整体发布。 */
export interface RefreshDisplay<P extends object, T> {
  readonly args: ReadonlySnapshot<P>
  readonly data: ReadonlySnapshot<T>
  readonly updatedAt: number
}

/**
 * 组件刷新需求配置。**两项都是 `Ref`，且都必需**：格式固定，框架只读 `.value`，不猜、不转换。
 * 改 `enabled.value` 或 `every.value` 都会按新配置重新协调（暂停页仍可刷新一次；改频率立刻生效）。
 * 浏览器可见性由框架自己监听，调用方不需要也不应该再声明一层。
 */
export interface RefreshOptions {
  /** 唯一开启意愿。框架只读取它，**从不写入**。 */
  readonly enabled: Ref<boolean>
  /** 刷新间隔（毫秒）；只接受正安全整数，不自动转换或取整。 */
  readonly every: Ref<number>
  /** 错误通知；框架立即观察其异步拒绝，但不等待完成。每次通知都重新读取本字段。 */
  readonly onError?: (error: RefreshError) => void | Promise<void>
}

/** 组件句柄：声明订阅、主动刷新并读取本页快照。 */
export interface RefreshHandle<P extends object, T> {
  /** 本页最近一次发布值；只读、整体替换，不做深响应式。 */
  readonly display: Readonly<ShallowRef<RefreshDisplay<P, T> | null>>
  /** 声明或更新订阅身份；相同身份重复声明幂等，不隐含刷新。 */
  submit(args: P): SubmitResult
  /** 显式刷新当前身份；与自动刷新共用同一条获取与交付路径。 */
  refresh(): Promise<RefreshResult>
}

/** 应用级协调者：安装、只读快照与销毁。 */
export interface RefreshManager {
  install(app: App): void
  /**
   * 按参数值定位共享结果并返回独立副本；不创建实例、不延长生存期，无结果返回 `undefined`。
   * 只有该 Source 仍有活跃实例（存在订阅或未结算的刷新要求）时才可能查到结果。
   * @throws {TypeError} 参数含循环引用：稳定编码拒绝（其它值按 JSON 语义编码，框架不做合法性判断）
   */
  readSnapshot<P extends object, T>(source: RefreshSource<P, T>, args: P): ReadonlySnapshot<T> | undefined
  dispose(): void
}

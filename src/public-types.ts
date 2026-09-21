import type { App, Ref } from 'vue'

/** 公共契约：本文件是正式 API 类型的唯一代码入口。 */

/** 递归只读视图：编译期约束。交付的 `args` 是每页一份副本，`data` 是结果表里那一份共享对象，
 * 因此它不承诺运行期不可写。 */
export type ReadonlySnapshot<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends object ? { readonly [K in keyof T]: ReadonlySnapshot<T[K]> } : T

/** `submit` 的同步结果；`accepted` 只表示身份已被记录，不代表请求成功。 */
export type SubmitResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'cancelled' }

/** 数据读出口：`args`、`data` 与 `updatedAt` 同次整体发布，只装最后一次成功那一版。 */
export interface RefreshDisplay<P extends object, T> {
  /** 本次发布对应的参数副本。 */
  readonly args: ReadonlySnapshot<P>
  /** 最后一次成功的数据；从未成功过时为 `null`。 */
  readonly data: ReadonlySnapshot<T> | null
  readonly updatedAt: number | null
}

/** 失败读出口：最近一次失败的原始异常与发生时刻；`null` ＝ 自最后一次成功以来没失败过。 */
export interface RefreshFailure {
  /** 最近一次失败的原始异常，原样带出。 */
  readonly error: unknown
  /** 最近一次失败的时刻。 */
  readonly failedAt: number
}

/** 组件刷新需求配置：两项都是 `Ref`，且都必需；框架只读 `.value`，不转换。 */
export interface RefreshOptions {
  /** 唯一开启意愿。框架只读取它，从不写入。 */
  readonly enabled: Ref<boolean>
  /** 刷新间隔（毫秒），只接受正安全整数。它同时是取数间隔与本页读结果表的节流间隔。 */
  readonly every: Ref<number>
}

/** 组件句柄：声明订阅、主动刷新，并读取本页的两个出口。 */
export interface RefreshHandle<P extends object, T> {
  /** 本页看到的数据；按本页 `every` 节流。本页释放后不再更新（保留最后一帧），协调者退场时清回 `null`。 */
  readonly display: Readonly<Ref<RefreshDisplay<P, T> | null>>
  /** 本页看到的最近一次失败；与 `display` 共用一个读者闸门，但不参与数据窗口。 */
  readonly failure: Readonly<Ref<RefreshFailure | null>>
  /** 声明或更新订阅身份；相同身份重复声明幂等，不隐含刷新。 */
  submit(args: P): SubmitResult
  /** 显式刷新当前身份；只登记一次要求，没有回执，结果经 `display` / `failure` 交付。 */
  refresh(): void
}

/** 应用级协调者：安装与销毁。它不提供读取，共享结果只经页面自己的 `display` 交付。 */
export interface RefreshManager {
  /** 安装到应用：注册可见性监听并在卸载时释放。需要浏览器环境。 */
  install(app: App): void
  dispose(): void
}

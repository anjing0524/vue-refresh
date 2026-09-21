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

/** 唯一读出口（ADR-122）：`args` 与「最近一次请求更新这一格之后的样子」同次整体发布——
 * `data` 是最后一次成功的数据，`updatedAt` ／ `failed` ／ `error` 属于**最近一次请求**（成功与失败都算）。
 * 来源是结果表格（`ResultCell`）的投影，另加每页一份 `args` 副本。
 * 注意 `updatedAt` 因此**不再承诺是 `data` 的产生时间**：失败也会把它推进（G7 随之改写）。 */
export interface RefreshDisplay<P extends object, T> {
  /** 本次发布对应的参数副本。 */
  readonly args: ReadonlySnapshot<P>
  /** 最后一次成功的数据；从未成功过时为 `null`。 */
  readonly data: ReadonlySnapshot<T> | null
  /** 最近一次请求（成功与失败都算）更新这一格的墙钟毫秒。类型保留 `null` 让读取面自己判空
   *  （ADR-63、ADR-122）；`display` 只在已结算过的那一版上发布，运行期它总有值。 */
  readonly updatedAt: number | null
  /** 最近一次请求是不是失败。它与 `updatedAt` 同属那一次请求——判它，而不是判 `error` 是不是 `undefined`
   *  （页面 `throw undefined` 时 `error` 读不出这件事）。 */
  readonly failed: boolean
  /** 那一次请求失败时的原始异常，原样带出；那一次请求成功时是 `undefined`。 */
  readonly error: unknown
}

/** 组件刷新需求配置：两项都是 `Ref`，且都必需；框架只读 `.value`，不转换。 */
export interface RefreshOptions {
  /** 唯一开启意愿。框架只读取它，从不写入。 */
  readonly enabled: Ref<boolean>
  /** 刷新间隔（毫秒），只接受正安全整数。它同时是取数间隔与本页读结果表的节流间隔——
   *  两个用途取自同一个值但各计各的：取数到期＝最近结算时刻＋周期，读取窗口＝画面那一版的 `updatedAt`＋周期。 */
  readonly every: Ref<number>
}

/** 组件句柄：声明订阅、主动刷新，并读取本页的画面。 */
export interface RefreshHandle<P extends object, T> {
  /** 本页看到的最近一次结算；按本页 `every` 节流（成功与失败用同一个窗口）。本页释放后不再更新（保留最后一帧），
   *  协调者退场时清回 `null`。 */
  readonly display: Readonly<Ref<RefreshDisplay<P, T> | null>>
  /** 声明或更新订阅身份；相同身份重复声明幂等，不隐含刷新。 */
  submit(args: P): SubmitResult
  /** 显式刷新当前身份；只登记一次要求，没有回执，结果只经 `display` 交付。 */
  refresh(): void
}

/** 应用级协调者：安装与销毁。它不提供读取，共享结果只经页面自己的 `display` 交付。 */
export interface RefreshManager {
  /** 安装到应用：注册可见性监听并在卸载时释放。需要浏览器环境。 */
  install(app: App): void
  dispose(): void
}

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
 * 错误的来源：**失败属于哪一侧**——按调用方能采取的动作分类，不按「哪一步失败的」分类（ADR-48）。
 * - `request`：共享请求失败（含框架上限到期）。同一身份再试有意义；
 * - `caller`：调用方给的参数或配置不能被使用（订阅声明的参数准备失败、刷新入口或配置快照非法）。
 *   重试同一份输入没有意义，要改的是调用方自己的代码或配置。
 */
export const ErrorOrigin = {
  Request: 'request',
  Caller: 'caller',
} as const
export type ErrorOrigin = (typeof ErrorOrigin)[keyof typeof ErrorOrigin]

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
 * 错误通知值。`error` 是原始异常，供页面自行判断；`origin` 说明失败属于哪一侧（要不要重试）。
 * 不交付「由谁触发」：页面若有两处 `useRefresh` 共用同一个 `onError`，用各自闭包里的
 * `display` 或自己的标记分辨即可（ADR-47）。
 */
export interface RefreshError {
  readonly origin: ErrorOrigin
  readonly error: unknown
}

/**
 * `submit` 的同步结果。`accepted` 只表示身份已被记录，不代表请求成功。
 * `cancelled` 不带原因：取消只有一个来源（句柄或协调者已销毁），单成员取值没有信息量（ADR-48）。
 * 声明不检查可见性与开启意愿，换身份也只是撤销本页未完成的刷新要求（那些要求没有回执，见 `refresh`）。
 */
export type SubmitResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly error: unknown }
  | { readonly status: 'cancelled' }

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
  /**
   * 显式刷新当前身份；与自动刷新共用同一条获取与交付路径。
   *
   * 只登记一次要求，**没有回执**：成功只经 `display`，失败只经 `onError`（与自动刷新同一条通道）。
   */
  refresh(): void
}

/**
 * 应用级协调者：安装与销毁。
 *
 * **它不提供读取**（ADR-46）：共享结果只经页面自己的 `display` 交付，需要落在业务 Store 里的页面在自己
 * 的适配层写；框架不做第二个数据出口，也不承担「业务最新数据」这个角色。
 */
export interface RefreshManager {
  /** 安装到应用：注册可见性监听并在卸载时释放。**需要浏览器环境**（本库只服务 SPA）。 */
  install(app: App): void
  dispose(): void
}

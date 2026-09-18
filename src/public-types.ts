import type { App, Ref } from 'vue'

/**
 * 公共契约：本文件是正式 API 类型的唯一代码入口，与《统一刷新管理》「公共 API 契约」一节共同构成对外约定。
 *
 * 这里只有类型与判别联合：取值域直接写在联合里，没有常量对象（ADR-51）。不使用 `enum` ——
 * `erasableSyntaxOnly` 与 Node 的类型擦除都不接受该语法。
 */

/** 递归只读视图：编译期约束。框架交付的每个值都是独立副本，因此只读视图不承诺运行期不可写。 */
export type ReadonlySnapshot<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends object ? { readonly [K in keyof T]: ReadonlySnapshot<T[K]> } : T

/**
 * 固定资源定义：一个 URL 加上可选的参数准入规则。**取数由框架按 URL 发起**（`createRefreshManager`
 * 注入的 axios 实例发 POST，请求体就是参数值），所以定义里不再有取数函数；`T` 只用来携带这个接口的
 * 原始返回结构。
 *
 * `validate` 写成**方法**而不是函数属性：方法参数按双变比较，具体 Source 因此可以直接进入框架的
 * 擦除视图，接收点不必留类型断言（代价见 ADR-24）。`P` 的值域约束见 DESIGN §4.1。
 */
export interface RefreshSource<P extends object, T> {
  /** 身份的一半：POST 的 URL 路径。参数值（请求体）是另一半，两者一起决定共享哪个实例。 */
  readonly name: string
  validate?(args: ReadonlySnapshot<P>): boolean
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

/** 交付面：参数、数据与结果产生时间同次整体发布。**两者都是本页独立副本**（ADR-52）。 */
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
  /**
   * 取数失败通知（**只报共享请求失败**，ADR-51）：参数是原始异常，供页面自行判断。
   * 框架立即观察其异步拒绝，但不等待完成；每次通知都重新读取本字段。
   * 调用方自己的输入问题不走这条通道——参数不可用由 `submit` 同步返回 `rejected`。
   */
  readonly onError?: (error: unknown) => void | Promise<void>
}

/** 组件句柄：声明订阅、主动刷新并读取本页快照。 */
export interface RefreshHandle<P extends object, T> {
  /**
   * 本页看到的画面：按已声明身份从结果表读出来的一个只读视图。
   *
   * `args` 每次读取都复制一份（它是身份键描述的那份值）；`data` 是结果表里**同一个对象**，
   * 要改自己复制。实例被释放时读回 `null`。
   */
  readonly display: Readonly<Ref<RefreshDisplay<P, T> | null>>
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
 * 应用级协调者：安装与销毁。**它不提供读取**——共享结果只经页面自己的 `display` 交付，要落到业务 Store
 * 里的页面在自己的适配层写（ADR-46）。
 */
export interface RefreshManager {
  /** 安装到应用：注册可见性监听并在卸载时释放。**需要浏览器环境**（本库只服务 SPA）。 */
  install(app: App): void
  dispose(): void
}

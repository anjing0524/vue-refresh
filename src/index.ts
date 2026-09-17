/**
 * 包入口：三个正式函数、两个状态常量对象，以及**调用方会持有或接收的 8 个类型**。
 *
 * 只导出这些是刻意的：其余类型（`ReadonlySnapshot` / `RefreshInput` / `RefreshLoadContext` /
 * `RefreshManagerOptions`）只是上面这些类型的组成部分，调用方按推断使用即可，不必也不应再记一个名字。
 * 类型逐个列出而不是 `export type *`：后者需要 TS 5.0+，而声明的消费基线是 TS 4.9；
 * 显式列表同时把契约面钉死，`public-types.ts` 新增类型不会无意中扩大导出面。
 * 常量对象同时具有值涵义与类型涵义，因此只导出一次：消费方可以写 `ErrorOrigin.Request` 比较，也可以把它当类型用。
 */
export { defineRefresh } from './source.ts'
export { createRefreshManager, useRefresh } from './vue.ts'
export { CancelReason, ErrorOrigin } from './public-types.ts'
export type {
  RefreshDisplay, RefreshError, RefreshHandle, RefreshManager, RefreshOptions, RefreshResult, RefreshSource,
  SubmitResult,
} from './public-types.ts'

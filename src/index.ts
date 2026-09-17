/**
 * 包入口：只导出三个正式函数、三个状态常量对象与公共类型。
 * 类型逐个列出而不是 `export type *`：后者需要 TS 5.0+，而声明的消费基线是 TS 4.9；
 * 显式列表同时把契约面钉死，`public-types.ts` 新增类型不会无意中扩大导出面。
 * 常量对象同时具有值涵义与类型涵义，因此只在这里导出一次（不再出现在下面的类型列表里）：
 * 消费方可以写 `ErrorOrigin.Request` 比较，也可以把它当类型用。
 */
export { defineRefresh } from './source.ts'
export { createRefreshManager, useRefresh } from './vue.ts'
export { CancelReason, ErrorOrigin, RequestOrigin } from './public-types.ts'
export type {
  ReadonlySnapshot, RefreshDisplay, RefreshError, RefreshHandle, RefreshInput, RefreshLoadContext,
  RefreshManager, RefreshManagerOptions, RefreshOptions, RefreshResult, RefreshSource, SubmitResult,
} from './public-types.ts'

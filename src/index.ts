/**
 * 包入口：只导出三个正式函数与公共类型。
 * 类型逐个列出而不是 `export type *`：后者需要 TS 5.0+，而声明的消费基线是 TS 4.9；
 * 显式列表同时把契约面钉死，`public-types.ts` 新增类型不会无意中扩大导出面。
 */
export { defineRefresh } from './source.ts'
export { createRefreshManager, useRefresh } from './vue.ts'
export type {
  CancelReason, ErrorOrigin, ReadonlySnapshot, RefreshDisplay, RefreshError, RefreshHandle, RefreshInput,
  RefreshLoadContext, RefreshManager, RefreshManagerOptions, RefreshOptions, RefreshResult, RefreshSource,
  RequestOrigin, SubmitResult,
} from './public-types.ts'

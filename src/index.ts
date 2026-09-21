/** 包入口：两个正式函数，以及调用方会持有或接收的 5 个类型（逐个列出，不用 `export type *`，以支持 TS 4.9）。 */
export { createRefreshManager, useRefresh } from './vue.ts'
export type {
  RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, SubmitResult,
} from './public-types.ts'

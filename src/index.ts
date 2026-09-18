/**
 * 包入口：三个正式函数，以及**调用方会持有或接收的 6 个类型**。这里**没有常量对象**：
 * 取值域直接写在判别联合里。
 *
 * 类型逐个列出而不是 `export type *`：后者需要 TS 5.0+，而声明的消费基线是 TS 4.9；显式列表同时把
 * 契约面钉死。工具型别名（`ReadonlySnapshot` 与单字段形状）刻意不导出——调用方按推断使用即可。
 */
export { defineRefresh } from './source.ts'
export { createRefreshManager, useRefresh } from './vue.ts'
export type {
  RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource, SubmitResult,
} from './public-types.ts'

/**
 * 包入口：三个正式函数，以及**调用方会持有或接收的 6 个类型**。这里**没有常量对象**：
 * 取值域直接写在判别联合里（ADR-51）。
 *
 * 只导出这些是刻意的：`ReadonlySnapshot` 只是上面这些类型的组成部分，
 * 调用方按推断使用即可，不必也不应再记一个名字；单字段的形状（如 `load` 的上下文、协调者的配置）
 * 直接在签名里写出来，不为它单独起名。
 * 类型逐个列出而不是 `export type *`：后者需要 TS 5.0+，而声明的消费基线是 TS 4.9；
 * 显式列表同时把契约面钉死，`public-types.ts` 新增类型不会无意中扩大导出面。
 */
export { defineRefresh } from './source.ts'
export { createRefreshManager, useRefresh } from './vue.ts'
export type {
  RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource, SubmitResult,
} from './public-types.ts'

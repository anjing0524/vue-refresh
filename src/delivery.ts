import { OBSERVER_FAILED, observeRejection, reportObserverError } from './diagnostics.ts'
import type { FrameworkIdentity } from './diagnostics.ts'
import type { Handle, StoreEntry } from './model.ts'
import type { RefreshError } from './public-types.ts'

/**
 * 结果边界与外部通知隔离。
 *
 * 两条规则贯穿整个框架：
 * - 结果进入框架时建立独立所有权（原生复制），业务结构由请求适配器负责校验；
 * - 任何业务回调（publish / onError / cleanup / Store 通知）抛错或返回拒绝的
 *   Promise，都只进入固定的 observer 诊断出口，不改变已结算的结果。
 */

/** 结果边界：拒绝 undefined，其余用原生复制取得独立副本。 */
export function copyResult(input: unknown): unknown {
  if (input === undefined) throw new TypeError('A request must return a result')
  return structuredClone(input)
}

/**
 * 交付副本的唯一入口：页面 display、Store 分区与只读快照都复制同一份 DTO，
 * 「交付面无别名」这条不变式只在这里维护。
 */
export function cloneSnapshot(entry: StoreEntry): unknown {
  return structuredClone(entry.data)
}

/**
 * 调用一次可能重入或异步失败的外部效果，并隔离其异常。
 *
 * 同步抛错与返回的 Promise 拒绝都只报告一次 observer；不等待 Promise，
 * 因此一个慢速或 pending 的通知不会阻塞其他接收者。
 */
export function observe(effect: () => unknown, identity: FrameworkIdentity = {}): void {
  try {
    observeRejection(effect(), OBSERVER_FAILED, identity)
  } catch {
    reportObserverError(OBSERVER_FAILED, identity)
  }
}

/**
 * 声明代次身份：`0` 不是有效操作号，那一条诊断就不带 `operationId`——
 * 字段「缺席」才表示不属于某次页面操作（框架身份只用于日志关联，见 §2.4）。
 */
export function declarationIdentity(handle: Handle): FrameworkIdentity {
  return handle.operationId === 0 ? {} : { operationId: handle.operationId }
}

/**
 * 通过句柄的 onError 通知页面；异常隔离规则与 {@link observe} 相同。
 * `identity` 只在本条通知自身失败、需要写诊断日志时使用，不进入 `RefreshError`。
 */
export function notify(handle: Handle, event: RefreshError, identity: FrameworkIdentity = {}): void {
  observe(() => handle.onError(event), identity)
}

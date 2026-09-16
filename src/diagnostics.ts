/**
 * observer 诊断出口与返回值观察。
 *
 * 这是最底层的零依赖模块：结果边界（`delivery.ts`）与参数边界（`source.ts`）都要上报，
 * 挂在任何一侧都会让另一侧横向依赖，因此单独成为叶子。
 *
 * 两条规则：
 * - 只输出固定说明与框架生成的身份标识，不读取原异常的 message/stack/cause，也不序列化它；
 * - 诊断自身失败被吞掉，不改变调用方的清理与后续交付。
 */

/** 观察者自身失败时的固定说明；`observe` 与 `notify` 共用。 */
export const OBSERVER_FAILED = 'observer notification failed'

/** 诊断事件里允许出现的框架身份标识；不包含原始异常内容，也不属于公开契约。 */
export interface FrameworkIdentity {
  readonly operationId?: number
  readonly resourceId?: string
  readonly taskVersion?: number
}

/**
 * 写一条 observer 诊断事件。
 *
 * 这条事件不属于 `RefreshError`：它只写日志，从不经 `onError` 投递，
 * 所以 `origin: 'observer'` 不参与错误来源的取值域。
 * `reason` 在 `identity` 之前：多数调用点只有一个固定说明，不需要写占位对象。
 */
export function reportObserverError(
  reason: string = OBSERVER_FAILED,
  identity: FrameworkIdentity = {},
): void {
  const event: Record<string, unknown> = { origin: 'observer', error: reason }
  for (const field of ['operationId', 'resourceId', 'taskVersion'] as const) {
    if (identity[field] !== undefined) event[field] = identity[field]
  }
  try {
    console.error('[vue-refresh]', event)
  } catch {
    // 诊断失败不影响调用方的清理与后续交付。
  }
}

/**
 * 观察一个可能拒绝的返回值：不等待，也不读取拒绝原因。
 *
 * 只用于「调用方违约、框架已经同步抛错」的场景。抛错是权威信号，这里只保证被丢弃的
 * Promise 不会变成未处理拒绝，因此它与 observer 共用同一个出口。
 * `undefined` 表示没有异步副作用，直接返回。
 */
export function observeRejection(
  result: unknown,
  reason: string = OBSERVER_FAILED,
  identity: FrameworkIdentity = {},
): void {
  if (result === undefined) return
  void Promise.resolve(result).catch(() => reportObserverError(reason, identity))
}

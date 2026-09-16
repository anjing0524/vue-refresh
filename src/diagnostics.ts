/**
 * observer 诊断出口与返回值观察。
 *
 * 这是最底层的零依赖模块：结果边界（`delivery.ts`）与参数边界（`source.ts`）都要上报，
 * 挂在任何一侧都会让另一侧横向依赖，因此单独成为叶子。
 *
 * 两条规则：
 * - 只输出固定说明、异常的**类别**（构造器名，或原始值的 `typeof`）与框架生成的身份标识；
 *   不读取 message/stack/cause，也不序列化原对象，因此日志里不会出现业务内容；
 * - 诊断自身失败（含读取类别时抛错）被吞掉，不改变调用方的清理与后续交付。
 */

/** 诊断事件里允许出现的框架身份标识；不包含原始异常内容，也不属于公开契约。 */
export interface FrameworkIdentity {
  readonly operationId?: number
  readonly resourceId?: string
  readonly taskVersion?: number
}

/**
 * 异常的类别：对象的构造器名，原始值的 `typeof`。
 *
 * 只读取 `constructor` 与它的 `name` 两个属性；这两个读取也在 `reportObserverError` 的
 * try 内完成，因此恶意 getter 抛错只会吞掉这一条日志，不会影响调用方。
 */
function errorKind(error: unknown): string {
  if (error === null) return 'null'
  if (typeof error !== 'object' && typeof error !== 'function') return typeof error
  const constructor: unknown = Reflect.get(error, 'constructor')
  if (typeof constructor !== 'function') return 'UnknownError'
  const name: unknown = Reflect.get(constructor, 'name')
  return typeof name === 'string' && name !== '' ? name : 'UnknownError'
}

/**
 * 写一条 observer 诊断事件。
 *
 * 这条事件不属于 `RefreshError`：它只写日志，从不经 `onError` 投递，
 * 所以 `origin: 'observer'` 不参与错误来源的取值域。
 * `reason` 必填且在 `error` 之前：每个调用点都有自己固定的那句说明，不写占位对象。
 * `error` 只用来取类别（`errorKind`），原对象与它的内容不进日志。
 */
export function reportObserverError(
  reason: string,
  error: unknown,
  identity: FrameworkIdentity = {},
): void {
  try {
    const event: Record<string, unknown> = { origin: 'observer', reason, errorKind: errorKind(error) }
    if (identity.operationId !== undefined) event.operationId = identity.operationId
    if (identity.resourceId !== undefined) event.resourceId = identity.resourceId
    if (identity.taskVersion !== undefined) event.taskVersion = identity.taskVersion
    console.error('[vue-refresh]', event)
  } catch {
    // 诊断失败（含读取异常类别时抛错）不影响调用方的清理与后续交付。
  }
}

/**
 * 观察一个可能拒绝的返回值：不等待，只取拒绝的类别。
 *
 * 只用于「调用方违约、框架已经同步抛错」的场景。抛错是权威信号，这里只保证被丢弃的
 * Promise 不会变成未处理拒绝，因此它与 observer 共用同一个出口。
 * `undefined` 表示没有异步副作用，直接返回。
 */
export function observeRejection(
  result: unknown,
  reason: string,
  identity: FrameworkIdentity = {},
): void {
  if (result === undefined) return
  void Promise.resolve(result).catch(error => reportObserverError(reason, error, identity))
}

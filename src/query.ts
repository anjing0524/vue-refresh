import { copyResult, notify, observe } from './delivery.ts'
import { observeRejection } from './diagnostics.ts'
import type { Handle, QueryHost, QueryRun } from './model.ts'
import type { Parameters } from './source.ts'
import { ErrorOrigin, RequestOrigin } from './public-types.ts'
import type { QueryErrorOrigin, RefreshQueryContext } from './public-types.ts'

/**
 * 独立查询（页面主动查询）的执行路径。
 *
 * 它和后台任务共享同一套参数快照与结果复制规则，但不进入后台队列：
 * 取消只负责让 QueryRun 失效并立即结算，底层请求什么时候真正结束由请求层决定。
 */

/** 页面提供的请求函数；signature 与 `RefreshHandle.query` 的 runner 一致。 */
export type QueryRunner = (args: object, context: RefreshQueryContext) => Promise<unknown>

/** `commit` 的 effect 必须同步返回 `undefined`；其它返回值是调用方违约，抛错与诊断共用这句说明。 */
const ASYNC_COMMIT = 'commit requires a synchronous undefined return'

/** 该句柄的操作号仍然是本次操作；用于参数准备阶段的复核。 */
export function currentOperation(owner: QueryHost, handle: Handle, id: number): boolean {
  return !owner.isDisposed() && !handle.disposed && handle.operationId === id
}

/** 该 QueryRun 仍是句柄的当前活动；所有外部效果的统一有效性判据。 */
export function currentQuery(owner: QueryHost, handle: Handle, run: QueryRun): boolean {
  return !owner.isDisposed() && !handle.disposed && handle.activity === run
}

/**
 * 查询失败的唯一结算序列：结算 → 解除活动登记 → 通知 → 安排调度。
 *
 * 参数准备失败（`validation`）与执行失败（`execution`）只在这一步的来源上不同，
 * 序列本身相同，因此两处调用点共用这一份实现。身份复核在函数内完成，
 * 调用方不必重复判断，也不需要在外面再包一层 try/catch。
 */
export function failQuery(
  owner: QueryHost,
  handle: Handle,
  run: QueryRun,
  origin: QueryErrorOrigin,
  error: unknown,
): void {
  if (!currentQuery(owner, handle, run)) return
  // 先结算再通知；通知可能同步重入（调用方可在 onError 里改 enabled 或发起新查询）。
  run.settle({ status: 'error', origin, error })
  owner.forgetActivity(handle, run)
  notify(handle, { origin, error }, { operationId: handle.operationId })
  owner.requestFlush()
}

/**
 * 执行一次独立查询。
 *
 * `runner` 由 async 函数调用，因此它的同步前缀在返回 Promise 之前就已经跑完。
 * 取消结算与底层结束彼此独立：取消后 `run` 不再是当前活动，晚到的成功、失败
 * 和 commit 都不会产生任何副作用。
 */
export async function executeQuery(
  owner: QueryHost,
  handle: Handle,
  run: QueryRun,
  parameters: Parameters,
  runner: QueryRunner,
): Promise<void> {
  const operationId = handle.operationId
  const context: RefreshQueryContext = {
    signal: run.controller.signal,
    commit: effect => {
      if (!currentQuery(owner, handle, run)) return false
      const result = effect()
      // commit 只接受同步副作用；异步返回按契约失败：同步抛错给 runner，
      // 返回的 Promise 拒绝同样走统一诊断出口，不被静默吞掉。
      if (result !== undefined) {
        observeRejection(result, ASYNC_COMMIT, { operationId })
        throw new TypeError(ASYNC_COMMIT)
      }
      return true
    },
  }

  try {
    const raw = await runner(parameters.args, context)
    if (!currentQuery(owner, handle, run)) return
    const data = copyResult(raw)
    if (!currentQuery(owner, handle, run)) return

    observe(
      () => handle.publish({
        args: parameters.args, data, origin: RequestOrigin.Query, updatedAt: owner.clock.timestamp(),
      }),
      { operationId },
    )
    // 发布 shallowRef 可能同步启动另一个操作；结算前再复核一次身份。
    if (!currentQuery(owner, handle, run)) return
    run.settle({ status: 'success' })
    owner.forgetActivity(handle, run)
    owner.requestFlush()
  } catch (error) {
    failQuery(owner, handle, run, ErrorOrigin.Execution, error)
  }
}

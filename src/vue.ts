import {
  getCurrentInstance,
  inject,
  onActivated,
  onDeactivated,
  onMounted,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
} from 'vue'
import { managerKey } from './app.ts'
import { declarationIdentity, notify } from './delivery.ts'
import { prepareParameters, sourceRuntime } from './source.ts'
import type { ConfigurationHost, Handle, Input } from './model.ts'
import { ErrorOrigin } from './public-types.ts'
import type { RefreshDisplay, RefreshHandle, RefreshInput, RefreshOptions, RefreshSource } from './public-types.ts'

/**
 * 把 enabled / every / visible 三个响应式输入投影成不可变的配置快照。
 *
 * 这个函数同时是 Vue watch 的取值函数，所以它访问到的响应式依赖就是框架跟踪的全部依赖。
 * 它必须同步、纯，并且不调用任何业务回调；参数和表单草稿不在这里，也不会触发调度。
 * 整个 options 也可以是 Ref / getter：先 `toValue` 再读字段，因此替换整个对象同样被跟踪。
 */

/** 读一个布尔输入：只接受解包后的布尔值，读不到就抛，绝不猜测。 */
function readBoolean(input: RefreshInput<boolean>, label: string): boolean {
  const value: unknown = toValue(input)
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

/**
 * 读刷新间隔：只接受正安全整数毫秒，不自动转换、不取整。
 * 省略（`undefined`）读作「没有周期」，与「给了但非法」分开——后者抛错。
 */
function readEvery(input: RefreshInput<number> | undefined): number | null {
  if (input === undefined) return null
  const value: unknown = toValue(input)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('every must be a positive safe integer')
  }
  return value
}

function readConfiguration(
  options: RefreshInput<RefreshOptions>,
): Input {
  const resolved = toValue(options)
  let enabled: boolean | null = null
  let visible: boolean | null = null
  let every: number | null = null
  let everyInvalid = false
  let failure: unknown

  // 三项各自独立捕错：一个 getter 抛错不能掩盖其余项的依赖收集。
  try {
    enabled = readBoolean(resolved.enabled, 'enabled')
  } catch (error) {
    failure ??= error
  }

  try {
    // 缺省视为可见：`undefined` 直接短路，不产生对这一项的依赖。
    visible = readBoolean(resolved.visible === undefined ? true : resolved.visible, 'visible')
  } catch (error) {
    failure ??= error
  }

  try {
    // 周期只在开启意愿为真时必需：省略读作 `null`（未开启合法，开启则按下面的分支拒绝）。
    every = readEvery(resolved.every)
  } catch (error) {
    everyInvalid = true
    failure ??= error
  }

  if (enabled === null || visible === null || everyInvalid) {
    // 读不到的开关或可见性保留为 null，绝不推断成 false。
    return { valid: false, enabled, visible, error: failure }
  }
  if (!enabled) return { valid: true, enabled: false, every, visible }
  if (every === null) {
    return {
      valid: false, enabled: true, visible,
      error: failure ?? new TypeError('every is required when enabled is true'),
    }
  }
  return { valid: true, enabled: true, every, visible }
}

/**
 * 组件适配层：把响应式配置和生命周期转换为框架需求，并独立持有本页快照。
 *
 * - 只监听 enabled / every / visible，不监听参数、表单或结果；
 * - 只向核心提交「配置快照」和「参数准备动作」，不替核心做资格判断；
 * - Display 由这里唯一的 shallowRef 持有，核心只通过 publish 整体替换。
 */
/**
 * 组件配置的适配层状态机：快照、连续非法配置的通知去重，以及唯一的配置 watcher。
 *
 * 这两项状态天生只属于适配层：核心只拿到一个电平快照，也不该关心通知去重。
 * `snapshot` 由调用方持有，因为 `Handle.readInput` 必须先于本函数建立。
 *
 * 回调顺序固定，不能改：先写快照 → 处理错误阶段 → 按代次是否被替代决定后续动作。
 * `onError` 可能同步引发新的配置变化，旧回调不得再覆盖它，但仍要安排一次调度。
 */
function createConfigurationBinding(
  manager: ConfigurationHost,
  handle: Handle,
  options: RefreshInput<RefreshOptions>,
  snapshot: { current: Input },
): () => void {
  let reported = false

  return watch(() => readConfiguration(options), input => {
    const operationId = handle.operationId
    snapshot.current = input

    if (input.valid) {
      reported = false
    } else if (!reported) {
      // 先标记再通知：同步重入不能重复报告同一错误阶段。
      reported = true
      // 同一份身份既进公开错误（用于认领）也进诊断；尚无有效操作代次时两处都缺席。
      const identity = declarationIdentity(handle)
      notify(handle, { origin: ErrorOrigin.Configuration, error: input.error, ...identity }, identity)
    }

    if (handle.operationId === operationId) manager.reconcile(handle)
    else manager.requestFlush()
  }, { flush: 'sync', immediate: true })
}

export function useRefresh<P extends object, T>(
  source: RefreshSource<P, T>,
  options: RefreshInput<RefreshOptions>,
): RefreshHandle<P, T> {
  if (!getCurrentInstance()) throw new Error('useRefresh must run synchronously in component setup')
  const binding = inject(managerKey)
  if (!binding || binding.manager.isDisposed()) throw new Error('A live refresh manager must be installed')
  const manager = binding.manager

  const runtime = sourceRuntime(source)
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /** 最近一次成功读取的配置；核心只读这一份快照（由下面唯一的 watcher 写入）。 */
  const snapshot: { current: Input } = { current: { valid: false, enabled: null, visible: null, error: undefined } }

  // Manager 保存异构 Source。P/T 只在这个适配边界还原：本句柄的 Source 不变，
  // 且 DTO 在发布前已经由框架建立了独立所有权。
  const handle: Handle = {
    source: runtime,
    readInput: () => snapshot.current,
    publish: value => { display.value = value as RefreshDisplay<P, T> },
    onError: error => toValue(options).onError?.(error),
    cleanup: null,
    operationId: 0,
    submission: null,
    subscription: null,
    refreshes: new Set(),
    lifecycleActive: false,
    disposed: false,
  }
  manager.addHandle(handle)

  // 只跟踪配置：已提交参数和结果永不进入 watcher。
  const stopWatching = createConfigurationBinding(manager, handle, options, snapshot)
  // immediate 回调可能同步销毁 Manager；此时不要再注册已经被释放的 watcher。
  if (handle.disposed || manager.isDisposed()) stopWatching()
  else manager.setHandleCleanup(handle, stopWatching)

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  onMounted(() => manager.activate(handle))
  onActivated(() => manager.activate(handle))
  onDeactivated(() => manager.deactivate(handle))
  onScopeDispose(() => manager.removeHandle(handle))

  return {
    display,
    submit: args => manager.submit(handle, () => prepareParameters(args, runtime.validate)),
    refresh: () => manager.refresh(handle),
  }
}

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
import { notify } from './delivery.ts'
import { prepareParameters, sourceRuntime } from './source.ts'
import type { ConfigurationHost, Handle, Input } from './model.ts'
import { ErrorOrigin } from './public-types.ts'
import type { DeepReadonly, RefreshDisplay, RefreshHandle, RefreshInput, RefreshOptions, RefreshSource } from './public-types.ts'

/**
 * 把 enabled / every / visible 三个响应式输入投影成不可变的配置快照。
 *
 * 这个函数同时是 Vue watch 的取值函数，所以它访问到的响应式依赖就是框架跟踪的全部依赖。
 * 它必须同步、纯，并且不调用任何业务回调；参数和表单草稿不在这里，也不会触发调度。
 */

/** 读一个布尔输入：只接受解包后的布尔值，读不到就抛，绝不猜测。 */
function readBoolean(input: RefreshInput<boolean>, label: string): boolean {
  const value: unknown = toValue(input)
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

/** 读刷新间隔：只接受正安全整数毫秒，不自动转换、不取整。 */
function readEvery(input: RefreshInput<number>): number {
  const value: unknown = toValue(input)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('every must be a positive safe integer')
  }
  return value
}

function readConfiguration(
  options: Pick<RefreshOptions, 'enabled' | 'every' | 'visible'>,
): Input {
  let enabled: boolean | null = null
  let visible: boolean | null = null
  let every: number | undefined
  let failure: unknown

  // 三项各自独立捕错：一个 getter 抛错不能掩盖其余项的依赖收集。
  try {
    enabled = readBoolean(options.enabled, 'enabled')
  } catch (error) {
    failure ??= error
  }

  try {
    // 缺省视为可见：`undefined` 直接短路，不产生对这一项的依赖。
    visible = readBoolean(options.visible === undefined ? true : options.visible, 'visible')
  } catch (error) {
    failure ??= error
  }

  try {
    every = readEvery(options.every)
  } catch (error) {
    failure ??= error
  }

  if (enabled !== null && visible !== null && every !== undefined) {
    return { valid: true, enabled, visible, every }
  }
  // 读不到的开关或可见性保留为 null，绝不推断成 false。
  return { valid: false, enabled, visible, error: failure }
}

/**
 * 组件适配层：把响应式配置和生命周期转换为框架需求，并独立持有本页快照。
 *
 * - 只监听 enabled / every / visible，不监听参数、表单或结果；
 * - 只向核心提交「配置快照」和「参数准备动作」，不替核心做资格判断；
 * - Display 由这里唯一的 shallowRef 持有，核心只通过 publish 整体替换。
 */
/**
 * 组件配置的适配层状态机：快照、关闭边沿、连续非法配置的通知去重，以及唯一的配置 watcher。
 *
 * 这三项状态天生只属于适配层：核心只拿到一个电平快照，拿不到「上一次的 enabled」，也不该
 * 关心通知去重。`snapshot` 由调用方持有，因为 `Handle.readInput` 必须先于本函数建立。
 *
 * 回调顺序固定，不能改：先写快照 → 处理边沿与错误阶段 → 按操作号是否被替代决定后续动作。
 * `onError` 可能同步引发新的配置变化，旧回调不得再覆盖它，但仍要安排一次调度。
 */
function createConfigurationBinding(
  manager: ConfigurationHost,
  handle: Handle,
  options: Pick<RefreshOptions, 'enabled' | 'every' | 'visible'>,
  snapshot: { current: Input },
): () => void {
  // 边沿信息天生只在适配层：核心只拿到电平（当前配置），拿不到「上一次的 enabled」。
  let lastEnabled: boolean | undefined
  let reported = false

  return watch(() => readConfiguration(options), input => {
    const operationId = handle.operationId
    snapshot.current = input

    const closed = lastEnabled === true && input.enabled === false
    if (input.enabled !== null) lastEnabled = input.enabled
    if (closed) manager.closeQuery(handle)

    if (input.valid) {
      reported = false
    } else if (!reported) {
      // 先标记再通知：同步重入不能重复报告同一错误阶段。
      reported = true
      // 尚无任何页面操作时不带 operationId：诊断身份的「缺席」才表示不属于某次操作，0 不是有效操作号。
      notify(handle, { origin: ErrorOrigin.Configuration, error: input.error },
        operationId === 0 ? {} : { operationId })
    }

    if (handle.operationId === operationId) manager.reconcile(handle)
    else manager.requestFlush()
  }, { flush: 'sync', immediate: true })
}

export function useRefresh<P extends object, T>(
  source: RefreshSource<P, T>,
  options: RefreshOptions,
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
    onError: error => options.onError?.(error),
    cleanup: null,
    operationId: 0,
    submission: null,
    activity: null,
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
    query: (args, runner) => manager.query(
      handle,
      () => prepareParameters(args, runtime.validate),
      (snapshot, context) => runner(snapshot as DeepReadonly<P>, context),
    ),
  }
}

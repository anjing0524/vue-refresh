import {
  getCurrentInstance, inject, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, toValue, watch,
} from 'vue'
import type { App, InjectionKey } from 'vue'
import { RefreshCore, report } from './core.ts'
import type { Config, Handle } from './core.ts'
import { prepareParameters } from './source.ts'
import { ErrorOrigin } from './public-types.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshHandle, RefreshInput, RefreshManager,
  RefreshOptions, RefreshSource,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，并独立持有本页快照。
 *
 * 只跟踪 `enabled` / `every` / `visible` 三项配置，不跟踪参数、表单草稿或结果；
 * 参数只在 `submit` 时准备一次。核心只读适配层交出的配置快照，不重新调用业务 getter。
 */

/** 注入槽位；槽位对象稳定，同一 App 重建协调者时原地替换内容。 */
export const managerKey: InjectionKey<{ core: RefreshCore }> = Symbol('refresh-manager')

/** 每个 App 只 `provide` 一次。 */
const slots = new WeakMap<App, { core: RefreshCore }>()

/**
 * 读三项配置。任一项读不出或值非法都按「配置非法」处理（返回 `null`）：页面可以用 `computed`
 * 表达暂态条件，框架下一轮再读，绝不把读不到的开关猜成关闭。
 */
function readConfig(options: RefreshInput<RefreshOptions>): Config | null {
  try {
    const resolved = toValue(options)
    const enabled: unknown = toValue(resolved.enabled)
    const visible: unknown = resolved.visible === undefined ? true : toValue(resolved.visible)
    const every: unknown = resolved.every === undefined ? null : toValue(resolved.every)
    if (typeof enabled !== 'boolean' || typeof visible !== 'boolean') return null
    if (every !== null && (typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1)) return null
    if (enabled && every === null) return null
    return { enabled, every, visible }
  } catch {
    return null
  }
}

export function useRefresh<P extends object, T>(
  source: RefreshSource<P, T>,
  options: RefreshInput<RefreshOptions>,
): RefreshHandle<P, T> {
  if (!getCurrentInstance()) throw new Error('useRefresh must run synchronously in component setup')
  const binding = inject(managerKey)
  if (!binding || binding.core.isDisposed()) throw new Error('A live refresh coordinator must be installed')
  const core = binding.core
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)

  let snapshot: Config | null = null
  let reported = false

  // Manager 保存异构 Source。P/T 只在这个适配边界还原：本句柄的 Source 不变，
  // 且 DTO 在发布前已经由框架建立了独立所有权。
  const handle: Handle<P, T> = {
    source,
    config: () => snapshot,
    publish: value => { display.value = value },
    onError: error => toValue(options).onError?.(error),
    cleanup: null,
    operationId: 0,
    parameters: null,
    subscription: null,
    active: false,
    disposed: false,
  }
  core.addHandle(handle)

  // 唯一的配置 watcher：先写快照，再按当前资格协调；连续非法只通知一次。
  const stopWatching = watch(() => readConfig(options), config => {
    snapshot = config
    if (config) reported = false
    else if (!reported) {
      reported = true
      // 配置非法是本页自己的输入事实，不是某次取数的归属，因此不带声明代次。
      report(handle, { origin: ErrorOrigin.Configuration, error: new TypeError('Invalid refresh configuration') })
    }
    core.reconcile(handle)
  }, { flush: 'sync', immediate: true })

  if (handle.disposed || core.isDisposed()) stopWatching()
  else handle.cleanup = stopWatching

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  onMounted(() => core.activate(handle))
  onActivated(() => core.activate(handle))
  onDeactivated(() => core.deactivate(handle))
  onScopeDispose(() => core.removeHandle(handle))

  return {
    display,
    submit: args => core.submit(handle, () => prepareParameters(args, source)),
    refresh: () => core.refresh(handle),
  }
}

/** 创建应用级协调者：注册可见性监听与卸载释放；SSR 下不发请求。 */
/** 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限（显式刷新与自动刷新共用这些槽位）。 */
export function createRefreshManager(options: { readonly maxConcurrent: number }): RefreshManager {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('Invalid concurrency')
  }
  const core = new RefreshCore(options.maxConcurrent)
  let installed: App | null = null

  return {
    install(app) {
      if (core.isDisposed() || (installed !== null && installed !== app)) {
        throw new Error('Refresh coordinator installation conflict')
      }
      if (installed === app) return // 同实例同 App 重复安装无副作用。
      const slot = slots.get(app)
      if (slot) {
        // 上一个实例已销毁则原地接管（HMR、会话切换）；仍活跃则拒绝，被拒的安装不改动已有绑定。
        if (!slot.core.isDisposed()) throw new Error('Refresh coordinator installation conflict')
        slot.core = core
      } else {
        const created = { core }
        slots.set(app, created)
        app.provide(managerKey, created)
      }
      installed = app

      if (typeof document === 'undefined') {
        core.setVisible(false) // SSR：不可见，因此不发请求，也不注册监听。
      } else {
        const onVisibilityChange = (): void => core.setVisible(!document.hidden)
        document.addEventListener('visibilitychange', onVisibilityChange)
        core.setCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange))
        core.setVisible(!document.hidden)
      }
      app.onUnmount(() => core.dispose())
    },

    readSnapshot(source, args) {
      // 只计算参数键并直读实例；不准备参数、不校验、不创建实例。
      return core.readSnapshot(source, args) as ReadonlySnapshot<never> | undefined
    },

    dispose: () => core.dispose(),
  }
}

import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch,
} from 'vue'
import type { App } from 'vue'
import { INVALID_CONFIG_MESSAGE, RefreshCore, report } from './core.ts'
import type { Config, Handle } from './core.ts'
import { prepareParameters } from './source.ts'
import { ErrorOrigin } from './public-types.ts'
import type {
  RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，并独立持有本页快照。
 *
 * 只跟踪 `enabled` 与 `every` 两项配置（都是 `Ref`），不跟踪参数、表单草稿或结果；
 * 参数只在 `submit` 时准备一次。核心只读适配层交出的配置快照，不重新调用业务 getter。
 * 本库是 SPA 单例：当前协调者放在模块级变量里，组件适配不经过 `provide` / `inject`（ADR-37）。
 */

/** 当前生效的协调者；`install` 写入，已销毁时可被下一个实例替换（HMR、会话切换）。 */
let current: RefreshCore | null = null

/** 读当前生效的协调者；给演示面板与基准脚本用，不在包导出面里。 */
export function currentCore(): RefreshCore | null {
  return current
}

/**
 * 读三项配置。任一项读不出或值非法都按「配置非法」处理（返回 `null`）：页面可以用 `computed`
 * 表达暂态条件，框架下一轮再读，绝不把读不到的开关猜成关闭。
 */
function readConfig(options: RefreshOptions): Config | null {
  try {
    const enabled: unknown = options.enabled.value
    const every: unknown = options.every.value
    if (typeof enabled !== 'boolean') return null
    if (typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1) return null
    return { enabled, every }
  } catch {
    return null
  }
}

export function useRefresh<P extends object, T>(
  source: RefreshSource<P, T>,
  options: RefreshOptions,
): RefreshHandle<P, T> {
  if (!getCurrentInstance()) throw new Error('useRefresh 必须在组件的 setup 中同步调用')
  if (!current || current.isDisposed()) throw new Error('需要先安装一个存活的刷新协调者')
  const core = current
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)

  let snapshot: Config | null = null
  let reported = false

  // Manager 保存异构 Source。P/T 只在这个适配边界还原：本句柄的 Source 不变，
  // 且 DTO 在发布前已经由框架建立了独立所有权。
  const handle: Handle<P, T> = {
    source,
    config: () => snapshot,
    publish: value => { display.value = value },
    onError: error => options.onError?.(error),
    cleanup: null,
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
      // 配置非法是本页自己的输入事实，不是某次取数的归属。
      report(handle, { origin: ErrorOrigin.Configuration, error: new TypeError(INVALID_CONFIG_MESSAGE) })
    }
    core.reconcile(handle)
  }, { flush: 'sync', immediate: true })

  if (core.isDisposed()) stopWatching()
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

/** 创建应用级协调者：注册可见性监听与卸载释放。**需要浏览器环境**（本库只服务 SPA）。 */
/** 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限（显式刷新与自动刷新共用这些槽位）。 */
export function createRefreshManager(options: { readonly maxConcurrent: number }): RefreshManager {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('maxConcurrent 必须是正安全整数')
  }
  const core = new RefreshCore(options.maxConcurrent)
  let installed: App | null = null

  return {
    install(app) {
      if (core.isDisposed() || (installed !== null && installed !== app)) {
        throw new Error('刷新协调者安装冲突：同一个实例不能安装到两个 App，已销毁的实例也不能再安装')
      }
      if (installed === app) return // 同实例同 App 重复安装无副作用。
      // 单例：现有协调者还活着就拒绝；已销毁（HMR、会话切换）就直接替换。
      if (current !== null && !current.isDisposed() && current !== core) {
        throw new Error('刷新协调者安装冲突：同一进程里已有一个存活的实例')
      }
      current = core
      installed = app

      // 浏览器可见性由框架自己监听；本库是 SPA，不再有 SSR 分支。
      const onVisibilityChange = (): void => core.setVisible(!document.hidden)
      document.addEventListener('visibilitychange', onVisibilityChange)
      core.setCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange))
      core.setVisible(!document.hidden)
      app.onUnmount(() => core.dispose())
    },

    dispose: () => core.dispose(),
  }
}

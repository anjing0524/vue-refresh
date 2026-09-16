import type { App, InjectionKey } from 'vue'
import { Manager } from './manager.ts'
import { parameterKey, sourceRuntime } from './source.ts'
import { createResultStore } from './store.ts'
import type { Clock } from './model.ts'
import type {
  DeepReadonly, RefreshManager, RefreshManagerOptions, RefreshSource,
} from './public-types.ts'

/**
 * 应用边界：安装绑定、浏览器可见性、只读快照与销毁。
 *
 * 每个应用创建独立 Manager 与私有 Pinia 分区；SSR 下不注册浏览器监听、
 * 不启动 Timer，也不发请求。
 */

/** 注入值：当前生效的 Manager。槽位对象稳定，重建 Manager 时原地替换。 */
export type RefreshBinding = { manager: Manager }

/** 内部注入键，不由包入口导出。 */
export const managerKey: InjectionKey<RefreshBinding> = Symbol('refresh-manager')

/**
 * 每个 App 只 `provide` 一次的绑定对象，同时是「谁占有这个 App」的唯一事实。
 * 同一 App 重建 Manager 时原地替换内容：既不重复 `provide`，也不留下指向旧实例的第二份记录。
 */
const bindings = new WeakMap<App, RefreshBinding>()

/**
 * Manager 命名空间：只用于区分同一 Pinia 下的多个实例，不承担安全用途。
 * `crypto.randomUUID` 是安全上下文 API，纯 http 内网部署下不存在；此时回退到
 * `getRandomValues`（非安全上下文可用），再不行用时间戳＋随机数，唯一性目标不变。
 */
function createNamespace(): string {
  const source = globalThis.crypto
  if (typeof source?.randomUUID === 'function') return `refresh-${source.randomUUID()}`
  if (typeof source?.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16))
    return `refresh-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `refresh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** 创建应用级 Manager。要求应用 Pinia 与正安全整数并发上限。 */
export function createRefreshManager(options: RefreshManagerOptions): RefreshManager {
  if (!options.pinia) throw new TypeError('An application Pinia instance is required')
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('Invalid concurrency')
  }
  const namespace = createNamespace()
  const clock: Clock = {
    now: () => performance.now(),
    timestamp: () => Date.now(),
    setTimer(callback, ms) {
      const timerId = setTimeout(callback, ms)
      return () => clearTimeout(timerId)
    },
  }
  const manager = new Manager(createResultStore(options.pinia, namespace), clock, options.maxConcurrent, namespace)

  let installedApp: App | null = null

  return {
    install(app) {
      if (manager.isDisposed() || (installedApp !== null && installedApp !== app)) {
        throw new Error('Refresh manager installation conflict')
      }
      if (installedApp === app) return // 同实例同 App 重复安装无副作用。
      const binding = bindings.get(app)
      if (binding) {
        // 上一个实例已销毁则原地接管；仍活跃则拒绝，被拒的安装不改动任何已有绑定。
        if (!binding.manager.isDisposed()) throw new Error('Refresh manager installation conflict')
        binding.manager = manager
      } else {
        const created: RefreshBinding = { manager }
        bindings.set(app, created)
        app.provide(managerKey, created)
      }
      installedApp = app

      if (typeof document === 'undefined') {
        manager.setBrowserVisible(false) // SSR：不可见，因此不发请求。
      } else {
        // 可见性是核心的事实：这里只上报变化，重新协调句柄由核心完成。
        const onVisibilityChange = (): void => manager.setBrowserVisible(!document.hidden)
        document.addEventListener('visibilitychange', onVisibilityChange)
        manager.setCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange))
        manager.setBrowserVisible(!document.hidden)
      }
      app.onUnmount(() => manager.dispose())
    },

    readSnapshot<P extends object, T>(source: RefreshSource<P, T>, args: P): DeepReadonly<T> | undefined {
      if (manager.isDisposed()) return undefined
      // 只计算参数键并直读分区；不准备参数、不校验、不创建资源。
      return manager.readSnapshot(sourceRuntime(source), parameterKey(args)) as DeepReadonly<T> | undefined
    },

    dispose: () => manager.dispose(),
  }
}

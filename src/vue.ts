import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch, watchEffect,
} from 'vue'
import type { App } from 'vue'
import type { Pinia } from 'pinia'
import { RefreshCore } from './core.ts'
import type { Config, Handle, RefreshHttp } from './core.ts'
import { prepareParameters } from './source.ts'
import { useRefreshStore } from './store.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，把结果表接到 Pinia。
 *
 * 只跟踪 `enabled` 与 `every` 两项配置（都是 `Ref`），不跟踪参数、表单草稿或结果；
 * 本库是 SPA 单例，组件适配不经过 `provide` / `inject`（ADR-37，见 DESIGN §6.3）。
 */

/** 当前生效的协调者；`install` 写入，已销毁时可被下一个实例替换（HMR、会话切换）。 */
let current: RefreshCore | null = null

/** 当前生效的结果表（与协调者同源）；读的一侧从这里取，写的一侧由内核的 sink 写入。 */
let currentStore: ReturnType<typeof useRefreshStore> | null = null

/** 读当前生效的协调者；给演示面板与基准脚本用，不在包导出面里。 */
export function currentCore(): RefreshCore | null {
  return current
}

/** 读配置快照；任一项读不出或值非法都返回 `null`（为什么不猜成关闭见 DESIGN §6.1）。 */
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

/**
 * 组件侧入口：登记本页需求句柄，跟踪配置与生命周期，返回只读交付面与两个动作。
 *
 * 必须在组件的 `setup` 中同步调用，且此前已安装一个存活的协调者。
 */
export function useRefresh<P extends object, T>(
  source: RefreshSource<P, T>,
  options: RefreshOptions,
): RefreshHandle<P, T> {
  if (!getCurrentInstance()) throw new Error('useRefresh 必须在组件的 setup 中同步调用')
  if (!current || current.isDisposed()) throw new Error('需要先安装一个存活的刷新协调者')
  const core = current
  const store = currentStore
  if (!store) throw new Error('需要先安装一个存活的刷新协调者')

  // Manager 保存异构 Source。P/T 只在这个适配边界还原：本句柄的 Source 不变，
  // 且 DTO 的所有权已经在结果表那一侧定下来。
  const handle: Handle<P, T> = {
    source,
    config: null,
    onError: error => options.onError?.(error),
    cleanup: null,
    parameters: null,
    active: false,
  }
  core.addHandle(handle)

  /**
   * 本页此刻按哪个身份读结果：由提交成功那一刻确立。
   *
   * 它是一份**输入**（画面该读哪一条），不是结果的副本：唯一的写入点就是下面 `submit` 的包装。
   * 之所以要一个 `Ref`：句柄自己的 `parameters` 是普通字段、不可响应，而画面必须随身份变化重算。
   */
  const identity = shallowRef<string | null>(null)

  /**
   * 本页看到的画面：按已声明身份从结果表读，读到就整条替换。
   *
   * - 参数每次读取复制一份：它是身份键描述的那份值，被页面改掉会污染键与下一轮请求（ADR-52）。
   * - 数据就是结果表里那**同一个对象**（不再逐个接收者复制）；要改自己复制，只读视图由类型约束（ADR-59）。
   * - **没有条目时不写 `null`，保留上一次画面**：条目随实例释放即删（A06 在结果表这一层不变），
   *   而页面上「刚才那份数据」不该因为没人订阅了就变空——这也与旧推送模型下页面自己那份副本的表现一致。
   * - **读结果表这一步必须无条件先做**（在任何 `return` 之前）：否则这个副作用记不住对结果表的依赖，
   *   之后的写入唤不醒它（浏览器用例抓到过这个真实缺陷）。
   */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  watchEffect(() => {
    const key = identity.value
    const entry = store.read(source.name, key ?? '')
    if (key === null || !entry) return
    const parameters = handle.parameters
    if (parameters === null) return
    display.value = {
      args: structuredClone(parameters.args) as unknown as ReadonlySnapshot<P>,
      data: entry.data as ReadonlySnapshot<T>,
      updatedAt: entry.updatedAt,
    }
  }, { flush: 'sync' })

  // 唯一的配置 watcher：先写快照，再按当前资格协调。非法配置不通知——它是本页自己的输入事实，
  // 页面读自己的 refs 就知道；框架只负责不订阅、不请求，修正后自动恢复（ADR-51）。
  const stopWatching = watch(() => readConfig(options), config => {
    handle.config = config
    core.reconcile(handle)
  }, { flush: 'sync', immediate: true })

  if (core.isDisposed()) stopWatching()
  else handle.cleanup = stopWatching

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  onMounted(() => core.activate(handle))
  onActivated(() => core.activate(handle))
  onDeactivated(() => core.deactivate(handle))
  onScopeDispose(() => {
    core.removeHandle(handle)
    identity.value = null
  })

  return {
    display,
    submit: args => {
      const result = core.submit(handle, () => prepareParameters(args, source))
      if (result.status === 'accepted') identity.value = handle.parameters?.key ?? null
      return result
    },
    refresh: () => core.refresh(handle),
  }
}

/**
 * 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限（显式刷新与自动刷新共用这些槽位）；
 * `axios` 是取数用的实例——框架按资源定义里的 URL 发 `post(url, 参数值, { signal })`，
 * 所以你配好的 baseURL／拦截器／鉴权头都照旧生效；`pinia` 是你 `app.use()` 的那个实例，
 * 结果表挂在它上面（库不代装）；需要浏览器环境。
 */
export function createRefreshManager(options: {
  readonly maxConcurrent: number
  readonly axios: RefreshHttp
  readonly pinia: Pinia
}): RefreshManager {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('maxConcurrent 必须是正安全整数')
  }
  const store = useRefreshStore(options.pinia)
  // 内核只经这三个动作碰结果表：成功写、释放删、观测列举。
  const core = new RefreshCore(options.maxConcurrent, options.axios, {
    write: (url, key, entry) => { store.write(url, key, entry) },
    remove: (url, key) => { store.remove(url, key) },
    list: () => store.list(),
  })
  let installed: App | null = null

  return {
    /** 安装到应用：接上可见性监听与卸载释放；同一实例只能装到一个 App。 */
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
      currentStore = store
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

import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch, watchEffect,
} from 'vue'
import type { Pinia } from 'pinia'
import { RefreshCore } from './core.ts'
import type { RefreshHttp, ResultCell } from './core.ts'
import type { Config } from './resource.ts'
import { prepareParameters } from './source.ts'
import type { JsonParameters, Parameters } from './source.ts'
import { useRefreshStore } from './store.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshFailure, RefreshHandle, RefreshManager, RefreshOptions,
} from './public-types.ts'

/** Vue 适配层：把响应式配置与组件生命周期翻译成核心的登记与调度，并把结果表接到 Pinia。 */

/**
 * 当前安装的协调者（SPA 单例）。`null` ＝ 没有存活的协调者。
 * 它是读取副作用的依赖：协调者退场时置空，每一页因此重新判一次闸门。
 */
const installed = shallowRef<RefreshCore | null>(null)

/** 读此刻活着的协调者；页面入口与演示面板、基准脚本共用这一个读点。 */
export function currentCore(): RefreshCore | null {
  return installed.value
}

/** 读这一页的两个 `Ref` ＋ 生命周期；读不出或抛错都回 `[undefined, undefined, active]`。 */
function readConfig(options: RefreshOptions, active: boolean): readonly [enabled: unknown, every: unknown, active: boolean] {
  try {
    return [options.enabled.value, options.every.value, active]
  } catch {
    return [undefined, undefined, active]
  }
}

/** 组件侧入口：登记本页需求，跟踪配置与生命周期，返回两个读出口与两个动作。
 * 必须在组件的 `setup` 中同步调用，且此前已安装一个存活的协调者。 */
export function useRefresh<P extends JsonParameters<P>, T>(
  url: string,
  options: RefreshOptions,
): RefreshHandle<P, T> {
  if (url.length === 0) throw new TypeError('useRefresh 需要一个非空的 URL：它是身份的一半')
  if (!getCurrentInstance()) throw new Error('useRefresh 必须在组件的 setup 中同步调用')
  if (installed.value === null) throw new Error('需要先安装一个存活的刷新协调者')

  /** 这一页在核心里的全部内容：一页一份配置快照，按身份挂在实例的 `declarers` 里。 */
  const config: Config = { enabled: false, every: null, active: false }

  /** 把配置报给此刻活着的协调者；没有协调者时不写槽、不通知。 */
  const reportConfig = (): void => {
    const viewer = currentCore()
    if (viewer === null) return
    const [nextEnabled, nextEvery, nextActive] = readConfig(options, active.value)
    viewer.setConfig(config, nextEnabled, nextEvery, nextActive)
  }

  /** 本页已提交的声明（身份键 ＋ 参数副本）；`null` ＝ 还没提交过。 */
  const submitted = shallowRef<Parameters | null>(null)

  /** 这一页是否已被释放；释放后 `submit`／`refresh` 一概不产生事实。 */
  let released = false

  /** 本页看到的数据：由写入事件驱动、按本页 `every` 节流抄来的一份副本。 */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /** 本页看到的最近一次失败；与数据同一个来源，但不参与数据窗口。`null` ＝ 没有失败。 */
  const failure = shallowRef<RefreshFailure | null>(null)
  /** 上次读取时间（`ResultCell.updatedAt`）；`null` ＝ 还没有读取过，下一份数据直接读。 */
  let lastReadAt: number | null = null

  /** 数据出口：同一版不抄第二遍，只发布窗口已到的那一版。 */
  const publishData = (cell: ResultCell, parameters: Parameters): void => {
    const shown = display.value
    if (shown !== null && cell.updatedAt === shown.updatedAt) return
    // 窗口没到就不换画面；没有可比的时间（从未成功、或本页还没读到过）直接读。
    const every = config.every
    if (lastReadAt !== null && every !== null
      && cell.updatedAt !== null
      && lastReadAt + every > cell.updatedAt) return
    display.value = {
      args: structuredClone(parameters.args) as unknown as ReadonlySnapshot<P>,
      data: cell.updatedAt === null ? null : cell.data as ReadonlySnapshot<T>,
      updatedAt: cell.updatedAt,
    }
    lastReadAt = cell.updatedAt
  }

  /** 失败出口：这一格换了一笔新的失败就立刻发布，成功就清回 `null`。 */
  const publishFailure = (cell: ResultCell): void => {
    const shown = failure.value
    if (cell.failedAt === null ? shown === null : shown !== null && shown.failedAt === cell.failedAt) return
    failure.value = cell.failedAt === null ? null : { error: cell.error, failedAt: cell.failedAt }
  }

  watchEffect(() => {
    // 先读安装槽：它同时是这个副作用唯一的失效信号。
    const bound = installed.value
    const params = submitted.value
    // 没有协调者：两个出口一起清回 `null`。
    if (bound === null) {
      display.value = null
      failure.value = null
      lastReadAt = null
      return
    }
    // 还没提交过：没有可抄的格，也没有依赖可登记。
    if (params === null) return
    // 先读这一格（这一次读同时登记依赖），后面的写入才唤得醒这个副作用。
    const cell = bound.readResult(url, params.key)
    // 没有写过这一格：画面停在上一帧。
    if (cell === undefined) return
    // 读闸门：有资格，或还没读取过且浏览器可见。
    if (!bound.isEligible(config, url, params.key) && !(lastReadAt === null && bound.isVisible())) return
    publishFailure(cell)
    publishData(cell, params)
  }, { flush: 'sync' })

  /** 这一页是否挂载/激活（KeepAlive 失活为假）。 */
  const active = shallowRef(false)

  // 唯一的配置写入口；安装槽也在依赖里，所以换了协调者会重新报一次。非法配置不通知。
  const stopWatching = watch(() => [installed.value, ...readConfig(options, active.value)] as const, () => {
    reportConfig()
    // 重新成为读者时清掉读取基准，下一份写入就不等窗口；失去资格那一侧不动。
    const viewer = currentCore()
    if (viewer === null) return
    const changed = submitted.value
    if (changed !== null && viewer.isEligible(config, url, changed.key)) lastReadAt = null
  }, { flush: 'sync', immediate: true })

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  onMounted(() => { active.value = true })
  onActivated(() => { active.value = true })
  onDeactivated(() => { active.value = false })
  onScopeDispose(() => {
    released = true
    stopWatching()
    currentCore()?.undeclare(config)
    submitted.value = null
  })

  return {
    display,
    failure,
    submit: args => {
      const bound = currentCore()
      if (released || bound === null) return { status: 'cancelled' }
      // 参数准备是这一层的活：输入问题在这里就地变成 `rejected`。
      let parameters: Parameters
      try {
        parameters = prepareParameters(args)
      } catch (error) {
        return { status: 'rejected', error }
      }
      const result = bound.submit(config, url, parameters)
      if (result.status === 'accepted') {
        // 新身份的第一份内容不等窗口。
        lastReadAt = null
        submitted.value = parameters
      }
      return result
    },
    refresh: () => {
      const bound = currentCore()
      if (released || bound === null) return
      const params = submitted.value
      if (params === null) return
      // 显式刷新不等窗口：清掉读取基准，数据一到就抄。
      if (bound.refresh(config, url, params.key)) lastReadAt = null
    },
  }
}

/** 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限，`axios` 是取数实例，`pinia` 承载结果表。 */
export function createRefreshManager(options: {
  readonly maxConcurrent: number
  readonly axios: RefreshHttp
  readonly pinia: Pinia
}): RefreshManager {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('maxConcurrent 必须是正安全整数')
  }
  const store = useRefreshStore(options.pinia)
  // 结果表的四个动作签名与核心的端口一致，直接把 store 交进去。
  const core = new RefreshCore(options.maxConcurrent, options.axios, store)
  /** 摘掉可见性监听。 */
  let stopWatchingVisibility: (() => void) | null = null

  /** 从模块级的安装槽里退场。 */
  const uninstall = (): void => {
    stopWatchingVisibility?.()
    stopWatchingVisibility = null
    if (installed.value === core) installed.value = null
  }

  return {
    /** 安装到应用：接上可见性监听与卸载释放。SPA 单例，已有存活实例时拒绝。 */
    install(app) {
      if (core.isDisposed()) throw new Error('已销毁的刷新协调者不能再安装')
      const current = installed.value
      if (current === core) return // 同一个实例重复安装无副作用。
      if (current !== null && !current.isDisposed()) {
        throw new Error('刷新协调者安装冲突：同一进程里已有一个存活的实例')
      }
      installed.value = core

      // 浏览器可见性由框架自己监听。
      const onVisibilityChange = (): void => core.setVisible(!document.hidden)
      document.addEventListener('visibilitychange', onVisibilityChange)
      stopWatchingVisibility = () => document.removeEventListener('visibilitychange', onVisibilityChange)
      core.setVisible(!document.hidden)
      app.onUnmount(() => { uninstall(); core.dispose() })
    },

    dispose: () => {
      uninstall()
      core.dispose()
    },
  }
}

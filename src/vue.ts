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

/** 浏览器此刻是否可见：唯一的写入点是安装与可见性监听；配置 watcher 依赖它重排调度。
 * 它是 **watcher 的依赖源**；读闸门 `canRead` 不读它、直读 `document.hidden`（避免把可见性登记成依赖）——
 * 同一事实的两种取用方式，改这里时两处要一起想。 */
const visible = shallowRef(true)

/** 读此刻活着的协调者；页面入口与演示面板、基准脚本共用这一个读点。 */
export function currentCore(): RefreshCore | null {
  return installed.value
}

/** 读这一页的两个 `Ref` ＋ 生命周期与可见性，合成这一页报给核心的「环境允许」；读不出或抛错都按非法值回。 */
function readConfig(options: RefreshOptions, active: boolean, shown: boolean): {
  readonly enabled: unknown
  readonly every: unknown
  readonly present: boolean
} {
  const present = active && shown
  try {
    return { enabled: options.enabled.value, every: options.every.value, present }
  } catch {
    return { enabled: undefined, every: undefined, present }
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
  const config: Config = { enabled: false, every: null, present: false }

  /** 本页已提交的声明（身份键 ＋ 参数副本）；`null` ＝ 还没提交过。只装数据，不作事件总线用。 */
  const submitted = shallowRef<Parameters | null>(null)

  /** 读取面的显式唤醒信号：`wakeReader()` 在下一拍递增它，让读取副作用重跑一次。
   * 与 `submitted` 分工：后者是「当前声明是什么」的数据，值不变也要重读的场合归这里。 */
  const readTick = shallowRef(0)

  /** 这一页是否已被释放；释放后 `submit`／`refresh` 一概不产生事实。 */
  let released = false

  /** 本页看到的数据：由写入事件驱动、按本页 `every` 节流抄来的一份副本。 */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /** 本页看到的最近一次失败；与数据同一个来源，但不参与数据窗口。`null` ＝ 没有失败。 */
  const failure = shallowRef<RefreshFailure | null>(null)
  /** 读取面的「上一帧」账本（三个事实集中一处，重置只有下面两个具名入口）：
   *  数据出口那一版的身份与基准、失败出口那一笔的身份。
   *  `dataBaseline` 就是 §0.5 的「读取基准」：上一份抄进 `display` 那一版的 `updatedAt`，`null` ＝ 下一份数据直接读。
   *  它与 `display.updatedAt` 是同一事实的两份，只在「基准被置空、画面保留最后一帧」（三处不等窗口）时分叉。
   *  **换身份后同一个时间戳不算「同一版」**（两个从未成功的格 `updatedAt` 都是 `null`，只比时间会把新身份的 args 挡在外面）。 */
  const readState: {
    dataIdentity: string | null
    dataBaseline: number | null
    failureIdentity: string | null
  } = { dataIdentity: null, dataBaseline: null, failureIdentity: null }

  /** 基准置空：三处不等窗口（身份落定、重新成为读者、显式 `refresh()`）共用——下一份数据直接读，不比对窗口。 */
  const resetBaseline = (): void => {
    readState.dataBaseline = null
  }

  /** 账本整组重置：协调者退场、两个出口一起清回 `null` 时用。 */
  const resetReadState = (): void => {
    readState.dataIdentity = null
    readState.dataBaseline = null
    readState.failureIdentity = null
  }

  /** 数据出口：**同一身份**的同一版不抄第二遍，只发布窗口已到的那一版。
   *  第一个守卫比的是**画面那一版**（`shown.updatedAt`）而不是基准：基准刚被置空时画面还留着旧帧，
   *  此时同一版不得重发（U12「同一身份同一版不发布第二遍」）；第二个守卫才比基准（窗口）。 */
  const publishData = (cell: ResultCell, parameters: Parameters): void => {
    const shown = display.value
    if (shown !== null && readState.dataIdentity === parameters.key && cell.updatedAt === shown.updatedAt) return
    // 窗口没到就不换画面；没有可比的时间（从未成功、或本页还没读到过）直接读。
    const every = config.every
    if (readState.dataBaseline !== null && every !== null
      && cell.updatedAt !== null
      && readState.dataBaseline + every > cell.updatedAt) return
    display.value = {
      args: structuredClone(parameters.args) as unknown as ReadonlySnapshot<P>,
      data: cell.updatedAt === null ? null : cell.data as ReadonlySnapshot<T>,
      updatedAt: cell.updatedAt,
    }
    readState.dataIdentity = parameters.key
    readState.dataBaseline = cell.updatedAt
  }

  /** 失败出口：这一格换了一笔新的失败就立刻发布，成功就清回 `null`。 */
  const publishFailure = (cell: ResultCell, key: string): void => {
    const shown = failure.value
    if (readState.failureIdentity === key && (cell.failedAt === null ? shown === null : shown !== null && shown.failedAt === cell.failedAt)) return
    readState.failureIdentity = key
    failure.value = cell.failedAt === null ? null : { error: cell.error, failedAt: cell.failedAt }
  }

  /** 取数资格（§0.4 的「资格」，四组输入的合取；「声明还在」由实例存在蕴含）。
   *  具名判定让读闸门与配置边沿检测各自引用同一句口径，不再各自展开。 */
  const canPoll = (core: RefreshCore, key: string): boolean => core.isEligible(config, url, key)

  /** 读者资格（§0.5 的「读者」）：有资格，或还没读取过且浏览器可见。
   *  问「浏览器可见」读 DOM 而不是 `visible` 那个 ref，否则这一读会被登记成依赖，
   *  「恢复可见那一刻就把表里已有的新版本上屏」会顶掉既有口径（重新成为读者要等下一份写入）。 */
  const canRead = (core: RefreshCore, key: string): boolean =>
    canPoll(core, key) || (readState.dataBaseline === null && !document.hidden)

  /** 唤醒读取面一次（下一拍，走独立的信号通道）。两处用它：发布期间换了身份（或这一页被释放）时要
   *  重新订上新身份那一格的依赖；重新成为读者时要立刻读回该身份当前那一版。
   *  正在运行的副作用不会被自己触发的变更唤醒。 */
  const wakeReader = (): void => { queueMicrotask(() => { readTick.value++ }) }

  watchEffect(() => {
    // 先读唤醒信号与安装槽：前者是 `wakeReader()` 的落点，后者是协调者退场的失效信号。
    void readTick.value
    const bound = installed.value
    const params = submitted.value
    // 没有协调者：两个出口一起清回 `null`，账本整组重置。
    if (bound === null) {
      display.value = null
      failure.value = null
      resetReadState()
      return
    }
    // 还没提交过：没有可抄的格，也没有依赖可登记。
    if (params === null) return
    // 先读这一格（这一次读同时登记依赖），后面的写入才唤得醒这个副作用。
    const cell = bound.readResult(url, params.key)
    // 没有写过这一格：画面停在上一帧。
    if (cell === undefined) return
    // 读闸门（读者资格）：有资格，或还没读取过且浏览器可见（见 `canRead` 的注释）。
    if (!canRead(bound, params.key)) return
    publishFailure(cell, params.key)
    // 发布是同步的：页面 watcher 可能就在上面那一步里换了身份或卸载，本轮快照随即过期。
    if (submitted.value !== params) { wakeReader(); return }
    publishData(cell, params)
    if (submitted.value !== params) wakeReader()
  }, { flush: 'sync' })

  /** 这一页是否挂载/激活（KeepAlive 失活为假）。 */
  const active = shallowRef(false)

  // 唯一的配置写入口，取值函数同时收齐这一拍的三项与安装槽；回调直接用当轮新值，不再重读一次 refs。
  const stopWatching = watch(
    () => ({ core: installed.value, ...readConfig(options, active.value, visible.value) }),
    next => {
      const key = submitted.value?.key ?? null
      // 先按**旧**配置问一句资格：本页配置槽的唯一写入口就在下一行，核心此刻手里还是旧值。
      const before = key !== null && next.core !== null && canPoll(next.core, key)
      if (next.core !== null) next.core.setConfig(config, next.enabled, next.every, next.present)
      const viewer = currentCore()
      const after = key !== null && viewer !== null && canPoll(viewer, key)
      // 只有「之前没资格、现在有资格」这一条边是 U12 的「重新成为读者」：把读取基准置空，并唤醒读取面
      // 立刻读回该身份**当前**那一版（后台更新过的最新数据），而不是停在失活前那一帧。
      // 同一份配置内的变化（改频率、改可见性）只重排调度，不动基准——否则它们会白白放行一次窗口。
      if (after && !before) {
        resetBaseline()
        wakeReader()
      }
    },
    { flush: 'sync', immediate: true },
  )

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
        // 新身份的第一份内容不等窗口；相同身份重复声明幂等（核心那一侧不摘不挂），不动读取基准。
        const previous = submitted.value
        if (previous === null || previous.key !== parameters.key) resetBaseline()
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
      if (bound.refresh(config, url, params.key)) resetBaseline()
    },
  }
}

/** 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限，`http` 是取数传输（只需要 `post`，接入方通常传自己的 axios 实例），`pinia` 承载结果表。 */
export function createRefreshManager(options: {
  readonly maxConcurrent: number
  readonly http: RefreshHttp
  readonly pinia: Pinia
}): RefreshManager {
  if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new TypeError('maxConcurrent 必须是正安全整数')
  }
  // 结果表的四个动作签名与核心的端口一致，直接把 store 交进去。
  const core = new RefreshCore(options.maxConcurrent, options.http, useRefreshStore(options.pinia))
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
      // 槽里只会有活着的协调者（`uninstall` 在 `core.dispose()` 之前把槽置空），因此有占位者就是冲突。
      if (current !== null) throw new Error('刷新协调者安装冲突：同一进程里已有一个存活的实例')
      installed.value = core

      // 浏览器可见性由框架自己监听。
      const onVisibilityChange = (): void => { visible.value = !document.hidden }
      document.addEventListener('visibilitychange', onVisibilityChange)
      stopWatchingVisibility = () => document.removeEventListener('visibilitychange', onVisibilityChange)
      visible.value = !document.hidden
      app.onUnmount(() => { uninstall(); core.dispose() })
    },

    dispose: () => {
      uninstall()
      core.dispose()
    },
  }
}

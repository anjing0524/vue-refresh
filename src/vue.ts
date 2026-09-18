import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch, watchEffect,
} from 'vue'
import type { App } from 'vue'
import type { Pinia } from 'pinia'
import { RefreshCore } from './core.ts'
import type { Config, Demand, RefreshHttp, ResultCell } from './core.ts'
import { prepareParameters } from './source.ts'
import type { Parameters } from './source.ts'
import { useRefreshStore } from './store.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，按本页频率从结果表采样，把结果表接到 Pinia。
 *
 * 只跟踪 `enabled` 与 `every` 两项配置（都是 `Ref`），不跟踪参数、表单草稿或结果；
 * 本库是 SPA 单例，组件适配不经过 `provide` / `inject`（ADR-37，见 DESIGN §6.3）。
 */

/** 当前生效的协调者；`install` 写入，已销毁时可被下一个实例替换（HMR、会话切换）。 */
let current: RefreshCore | null = null

/** `setInterval` 的平台上限（约 24.8 天）；更长的 `every` 在这里封顶，否则溢出成 1ms 空转。 */
const MAX_PULSE_DELAY = 2_147_483_647

/** 当前生效的结果表（与协调者同源）；读的一侧从这里取，写的一侧由内核的 sink 写入。 */
let currentStore: ReturnType<typeof useRefreshStore> | null = null

/** 读当前生效的协调者；给演示面板与基准脚本用，不在包导出面里。 */
export function currentCore(): RefreshCore | null {
  return current
}

/**
 * 读配置快照；任一项读不出或值非法都返回 `null`（为什么不猜成关闭见 DESIGN §6.1）。
 *
 * `active` 是这一页自己的生命周期状态（适配层持有），三项一起构成资格的唯一来源：
 * `config.enabled && config.active && 核心的全局可见性`。
 */
function readConfig(options: RefreshOptions, active: boolean): Config | null {
  try {
    const enabled: unknown = options.enabled.value
    const every: unknown = options.every.value
    if (typeof enabled !== 'boolean') return null
    if (typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1) return null
    return { enabled, every, active }
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

  // 交给核心的只有**数据**：URL、配置快照与已声明的身份。定义（含 `validate`）与参数准备留在这一层，
  // 核心因此不认识页面、也不执行任何调用方代码（ADR-64）。
  const demand: Demand = { url: source.name, config: null, parameters: null }
  core.addDemand(demand)

  /**
   * 本页此刻按哪个身份读结果：由提交成功那一刻确立。
   *
   * 它是一份**输入**（画面该读哪一条），不是结果的副本：唯一的写入点就是下面 `submit` 的包装。
   * 之所以要一个 `Ref`：句柄自己的 `parameters` 是普通字段、不可响应，而画面必须随身份变化重算。
   */
  const identity = shallowRef<string | null>(null)

  /** 资格边沿的计数器：`activate` 与配置变化之后 +1，让下面那个副作用重新判定「本页还是不是读者」。 */
  const eligible = shallowRef(0)

  /**
   * 本页看到的画面：**某一拍的副本**，按本页 `every` 从结果表抄来。
   *
   * - **读者才跟随**：`core.isReader(demand)`（声明着且够资格，或它上面有无撤销的刷新要求）为真时才抄；
   *   暂停、失活、卸载中都不是读者，画面**冻结在最后一帧**。暂停页自己 `refresh()` 那一次仍在要求里，
   *   而且那一次不等拍（`immediate`），所以照样更新画面（A05、G6）。
   * - **按本页频率采样**（ADR-63）：脉搏每 `every` 毫秒敲一次，一拍最多抄一次；两拍之间结果表里的新版本
   *   不改变画面——慢页面主动要的就是「不跟着快页面跳」。三处不等拍：身份刚落定的第一份内容、
   *   本页刚重新成为读者、本页刚显式刷新。
   * - **没东西可抄时保留上一次画面**：条目随实例释放即删（A06 在结果表这一层不变），
   *   而页面上「刚才那份数据」不该因为没人订阅了就变空。
   * - **先无条件读结果表**（在任何 `return` 之前）：否则这个副作用记不住对结果表的依赖，
   *   之后的写入唤不醒它（浏览器用例抓到过这个真实缺陷）。`eligible` 只负责资格边沿重新判定。
   *
   * 依赖粒度：`store.read(url, key)` 现在返回的是那一个 cell ref 的 `.value`，副作用收在那一个 ref 上；
   * 写别的格不会唤醒这个副作用。
   */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /** 采样脉搏：只在「本页可能跟着结果表走」（愿意开且激活）时装上，周期就是这一页自己的 `every`。 */
  const pulse = shallowRef(0)
  /** 上一拍抄到的格；引用比较就是版本比较，因此不引版本号（ADR-43／45／47）。`undefined`＝还没抄到过。 */
  let sampled: ResultCell | undefined
  /** 上次抄写时的脉搏值：相等就说明这一拍已经抄过，新版本留到下一拍。 */
  let sampledPulse = -1
  /** 欠一拍：下一份内容立即抄，不等脉搏（身份落定、重新成为读者、显式刷新都置它）。 */
  let immediate = true

  watchEffect(() => {
    const key = identity.value
    const cell = store.read(source.name, key ?? '')
    pulse.value
    eligible.value
    if (key === null || cell === undefined || !core.isReader(demand)) return
    // 这一格既没成功过也没失败过：没有可抄的东西，画面停在上一帧（不发布空副本）。
    if (cell.entry === null && cell.failure === null) return
    if (cell === sampled) return
    // 本拍已经抄过、又不欠拍：让画面留到下一拍再看表（这就是「按本页频率采样」）。
    if (!immediate && pulse.value === sampledPulse) return
    const parameters = demand.parameters
    if (parameters === null) return
    display.value = {
      args: structuredClone(parameters.args) as unknown as ReadonlySnapshot<P>,
      data: cell.entry === null ? null : cell.entry.data as ReadonlySnapshot<T>,
      updatedAt: cell.entry === null ? null : cell.entry.updatedAt,
      failure: cell.failure,
    }
    sampled = cell
    sampledPulse = pulse.value
    immediate = false
  }, { flush: 'sync' })

  /** 这一页是否挂载/激活（KeepAlive 失活为假）。它与「浏览器可见」是两件事，后者由核心统一监听。 */
  const active = shallowRef(false)

  /** 采样脉搏的 Timer；`null` 表示没在敲。 */
  let pulseTimer: ReturnType<typeof setInterval> | null = null
  const stopPulse = (): void => {
    if (pulseTimer === null) return
    clearInterval(pulseTimer)
    pulseTimer = null
  }
  /**
   * 重新装脉搏：只在有资格时敲（暂停/失活的页面不跟着结果表走，不必起床）。周期超平台上限时封顶，
   * 否则 `setInterval` 会溢出成 1ms 空转。
   */
  const restartPulse = (config: Config | null): void => {
    stopPulse()
    if (config === null || !config.enabled || !config.active) return
    pulseTimer = setInterval(() => {
      // 协调者已经不在了（HMR、会话切换）：脉搏自己停掉，不必让核心回头叫这一页。
      if (core.isDisposed()) { stopPulse(); return }
      pulse.value += 1
    }, Math.min(MAX_PULSE_DELAY, config.every))
  }

  // 唯一的配置写入口：两个 `Ref` ＋ 这一页的激活状态合成一份快照，再按当前资格协调。
  // 非法配置不通知——它是本页自己的输入事实，页面读自己的 refs 就知道；框架只负责不订阅、
  // 不请求，修正后自动恢复（ADR-51）。`active` 也在依赖里，所以挂载/激活/失活只需改它。
  const stopWatching = watch(() => readConfig(options, active.value), config => {
    demand.config = config
    core.reconcile(demand)
    eligible.value += 1
    // 配置或生命周期刚变：下一份内容不等拍（失活恢复直接读回、修正非法配置后立刻上屏都在这里）。
    immediate = true
    restartPulse(config)
  }, { flush: 'sync', immediate: true })

  // 拆卸由这一层自己做：核心不再持有任何回调配额，所以释放时是这里主动停表、再把它摘出名册。
  if (core.isDisposed()) {
    stopWatching()
    stopPulse()
  }

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  // 只改 `active`：快照、协调与脉搏由上面那个 `flush: 'sync'` 的 watcher 完成（单一写入口）。
  onMounted(() => { active.value = true })
  onActivated(() => { active.value = true })
  onDeactivated(() => { active.value = false })
  onScopeDispose(() => {
    stopWatching()
    stopPulse()
    core.removeDemand(demand)
    identity.value = null
  })

  return {
    display,
    submit: args => {
      // 参数准备（复制、值域、编码、`validate`）是这一层的活：输入问题在这里就地变成 `rejected`，
      // 核心拿到的一定是一份可用身份——它没有 try/catch，也不会执行调用方代码（ADR-64）。
      let parameters: Parameters
      try {
        parameters = prepareParameters(args, source)
      } catch (error) {
        return { status: 'rejected', error }
      }
      const result = core.submit(demand, parameters)
      if (result.status === 'accepted') {
        // 新身份的第一份内容不等拍：否则慢页面上屏要等一个 `every`，看起来像坏了。
        immediate = true
        identity.value = demand.parameters?.key ?? null
      }
      return result
    },
    refresh: () => {
      // 用户点名要的那一次不等拍：结果一到就抄（这是「显式刷新一定会被看见」的全部机制）。
      immediate = true
      core.refresh(demand)
    },
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
  // 内核只经这四个动作碰结果表：成功写、失败写、释放删、观测列举。
  const core = new RefreshCore(options.maxConcurrent, options.axios, {
    write: (url, key, entry) => { store.write(url, key, entry) },
    fail: (url, key, failure) => { store.fail(url, key, failure) },
    remove: (url, key) => { store.remove(url, key) },
    list: () => store.list(),
  })
  let installed: App | null = null
  /** 摘掉可见性监听；装上过一次之后才有。核心不再持有任何回调，所以这由适配层自己收尾（ADR-64）。 */
  let stopWatchingVisibility: (() => void) | null = null

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
      stopWatchingVisibility = () => document.removeEventListener('visibilitychange', onVisibilityChange)
      core.setVisible(!document.hidden)
      app.onUnmount(() => { stopWatchingVisibility?.(); core.dispose() })
    },

    dispose: () => {
      stopWatchingVisibility?.()
      stopWatchingVisibility = null
      core.dispose()
    },
  }
}

import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch, watchEffect,
} from 'vue'
import type { App } from 'vue'
import type { Pinia } from 'pinia'
import { RefreshCore } from './core.ts'
import type { Config, RefreshHttp, ResultCell } from './core.ts'
import { prepareParameters } from './source.ts'
import type { Parameters } from './source.ts'
import { useRefreshStore } from './store.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions, RefreshSource,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，在每次写入时按 `updatedAt` 时间差节流地抄结果表，
 * 把结果表接到 Pinia。
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

/**
 * 读这一页的两个 `Ref` ＋ 生命周期，作为 watch 的取值函数；任一项读不出或抛错都回 `[undefined, undefined, active]`
 * （为什么读不出不猜成关闭见 DESIGN §6.1）。返回数组只为让 watch 拿到一份可比较的值，不做别的用。
 */
function readConfig(options: RefreshOptions, active: boolean): readonly [unknown, unknown, boolean] {
  try {
    return [options.enabled.value, options.every.value, active]
  } catch {
    return [undefined, undefined, active]
  }
}

/**
 * 把读到的那三个值写进这一页的配置槽；值非法就把 `every` 置 `null`（＝这一拍配置非法）。
 *
 * 这是**唯一的写入口**，而且必须在一个同步块里写完：槽是可变对象（ADR-66），读者看不到半更新
 * 全靠「中间不调用任何会回到框架的东西」。非法时只翻 `every`——`isPresent` 先看它，
 * 因此 `enabled`／`active` 的旧值在非法期间不会被信任。
 */
function applyConfig(target: Config, read: readonly [unknown, unknown, boolean]): void {
  const [enabled, every, active] = read
  if (typeof enabled !== 'boolean' || typeof every !== 'number' || !Number.isSafeInteger(every) || every < 1) {
    target.every = null
    return
  }
  target.enabled = enabled
  target.every = every
  target.active = active
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

  /**
   * 这一页在核心里的**全部内容**：一页一份配置快照，原地改写，按身份挂在实例的 `declarers` 里。
   * 定义（含 `validate`）与参数准备留在这一层，核心因此不认识页面、也不执行任何调用方代码（ADR-64、ADR-66）。
   */
  const config: Config = { enabled: false, every: null, active: false }

  /**
   * 本页此刻按哪个身份读结果：由提交成功那一刻确立。**页面 → 身份这条映射只在这里**（ADR-66）。
   *
   * 它是一份**输入**（画面该读哪一条），不是结果的副本；它必须是个 `Ref`，画面才能随身份变化重算。
   */
  const identity = shallowRef<string | null>(null)

  /** 本页已提交身份的框架私有副本；`display.args` 从它复制（参数隔离见 ADR-52）。 */
  let declared: Parameters | null = null

  /** 这一页是否已被释放（`onScopeDispose` 置位）：释放后再调 `submit`／`refresh` 一概不产生事实。 */
  let released = false

  /**
   * 本页看到的画面：**由写入事件驱动、按本页 `every` 节流抄来的一份副本**。
   *
   * - **读者才跟随**：这一页有资格（`core.isEligible`），或它**点过一次刷新、还没看到那一拍**（`pending`）
   *   且此刻浏览器可见时抄；失活、隐藏、卸载中都不是读者，画面**冻结在最后一帧**。暂停页自己 `refresh()`
   *   那一次由 `pending` 放行，而且那一次不等节流，所以照样更新画面（A05、G6）；**没点过刷新的暂停页
   *   什么都不抄**——包括它从未上过屏时到达的第一份结果（真 Chrome 的 A11 用例钉住了）。
   * - **按 `updatedAt` 时间差节流**：新格的 `updatedAt` 距展示中那份满一个本页 `every` 才换画面——
   *   慢页面主动要的就是「不跟着快页面跳」。写端稀于本页 `every` 时写入即抄（比固定拍更及时）；
   *   写端密且 `every` 非整数倍时实际更新周期被量化到写入网格（ADR-67 接受的代价）。
   *   三处不等节流（身份刚落定、本页刚重新成为读者、本页刚显式刷新）走的是同一条规则：把读取基准
   *   清掉——「没有读取时间就直接读」（所以它们不必再各带一个标志）。
   * - **没东西可抄时保留上一次画面**：条目随实例释放即删（A06 在结果表这一层不变），
   *   而页面上「刚才那份数据」不该因为没人订阅了就变空。
   * - **先无条件读结果表**（在任何 `return` 之前）：否则这个副作用记不住对结果表的依赖，
   *   之后的写入唤不醒它（浏览器用例抓到过这个真实缺陷）。
   *
   * 依赖粒度：`store.read(url, key)` 现在返回的是那一个 cell ref 的 `.value`，副作用收在那一个 ref 上；
   * 写别的格不会唤醒这个副作用。**唤醒它的只有两件事：这一格被写入、这一页换了身份**（`identity`）——
   * 配置变化不改画面，只改「下一次写入时怎么判定」（`lastReadAt` 由下面那个 watcher 负责，ADR-73）。
   */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /**
   * **上次读取时间**：上一次抄进画面的那一版数据的时间（`ResultCell.updatedAt`）。
   * `null` ＝ 还没有读取过——第一次读取、刚点过刷新、刚换身份、刚重新成为读者（ADR-72）。
   *
   * 判定只有一句话：`上次读取时间 ＋ 本页 every > 新数据的 updatedAt` 就不换画面；没有读取时间
   * 就直接读。刷新不动别的东西，只把这一页的上次读取时间置 `null`——数据一到自然就换了。
   */
  let lastReadAt: number | null = null

  watchEffect(() => {
    const key = identity.value
    const cell = store.read(source.name, key ?? '')
    // 从来没有写过这一格：没有可抄的东西，画面停在上一帧（不发布空副本）。
    if (key === null || cell === undefined) return
    // 读闸门：有资格（声明着它、配置有效、开启、激活且浏览器可见），或**还没读取过**（第一次，或
    // 刚点过刷新）且此刻浏览器可见。第二项就是「没有读取时间就直接读」——它是暂停页自己点刷新那
    // 一次能上屏的唯一机制（A05、G6）。入口闸在点的那一刻已经判过环境，所以这里不补 `active`。
    if (!core.isEligible(config, source.name, key) && !(lastReadAt === null && core.isVisible())) return
    // 同一版不抄第二遍：格子的数据时间与失败位都跟画面里那份一样，就是「没有新东西」。它不需要另存
    // 状态——画面本身就是已经抄到的那一版；失败那一笔`updatedAt` 不动、只有失败位变，靠这一行才看得见。
    const shown = display.value
    if (shown !== null && cell.updatedAt === shown.updatedAt && cell.failedAt === shown.failedAt) return
    // 上次读取时间 ＋ 本页 every > 新数据的时间 ⇒ 窗口没到，不换画面（慢页面要的就是不跟快页面跳）。
    // 上一次从未成功过、或本页还没读到过：没有可比的时间，直接读。配置非法（`every === null`）不抄。
    const every = config.every
    if (lastReadAt !== null && every !== null
      && cell.updatedAt !== null
      && lastReadAt + every > cell.updatedAt) return
    if (declared === null) return
    display.value = {
      args: structuredClone(declared.args) as unknown as ReadonlySnapshot<P>,
      data: cell.updatedAt === null ? null : cell.data as ReadonlySnapshot<T>,
      updatedAt: cell.updatedAt,
      error: cell.error,
      failedAt: cell.failedAt,
    }
    lastReadAt = cell.updatedAt
  }, { flush: 'sync' })

  /** 这一页是否挂载/激活（KeepAlive 失活为假）。它与「浏览器可见」是两件事，后者由核心统一监听。 */
  const active = shallowRef(false)

  // 唯一的配置写入口：两个 `Ref` ＋ 这一页的激活状态写进同一份槽，再让核心重算一次调度。
  // 非法配置不通知——它是本页自己的输入事实，页面读自己的 refs 就知道；框架只负责不取数、
  // 不刷新，修正后自动恢复（ADR-51）。`active` 也在依赖里，所以挂载/激活/失活只需改它。
  const stopWatching = watch(() => readConfig(options, active.value), read => {
    applyConfig(config, read)
    core.reconcile()
    // 重新成为读者（激活、开起来、修好配置）：把上次读取时间置 `null`，**下一份写入**因此不等窗口。
    // **失去资格那一侧（暂停、失活、隐藏）不动**——那一侧若也置 `null`，读闸门第二项就会把整个
    // 失活期都放行，画面在后台一路跟下去，「失活冻结」就没了（ADR-72）。
    // 这里**不需要**再叫醒副作用：它只由数据写入与换身份唤醒，配置变化只影响「下一份写入怎么判定」。
    const changed = identity.value
    if (changed !== null && core.isEligible(config, source.name, changed)) lastReadAt = null
  }, { flush: 'sync', immediate: true })

  // 拆卸由这一层自己做：核心不再持有任何回调配额，所以释放时是这里主动停表、再把它摘出名册。
  if (core.isDisposed()) {
    stopWatching()
  }

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  // 只改 `active`：快照与协调由上面那个 `flush: 'sync'` 的 watcher 完成（单一写入口）。
  onMounted(() => { active.value = true })
  onActivated(() => { active.value = true })
  onDeactivated(() => { active.value = false })
  onScopeDispose(() => {
    released = true
    stopWatching()
    core.undeclare(config)
    identity.value = null
  })

  return {
    display,
    submit: args => {
      // 释放之后这一页不再产生任何事实（§2.4「取消只有一个来源（句柄或协调者已销毁）」）。
      if (released || core.isDisposed()) return { status: 'cancelled' }
      // 参数准备（复制、值域、编码、`validate`）是这一层的活：输入问题在这里就地变成 `rejected`，
      // 核心拿到的一定是一份可用身份——它没有 try/catch，也不会执行调用方代码（ADR-64）。
      let parameters: Parameters
      try {
        parameters = prepareParameters(args, source)
      } catch (error) {
        return { status: 'rejected', error }
      }
      const result = core.submit(config, source.name, parameters)
      if (result.status === 'accepted') {
        declared = parameters
        // 新身份的第一份内容不等窗口（换了身份就没有可比的上次读取时间）：否则慢页面上屏要等一个
        // `every`，看起来像坏了。
        lastReadAt = null
        identity.value = parameters.key
      }
      return result
    },
    refresh: () => {
      if (released || core.isDisposed()) return
      const key = identity.value
      if (key === null) return
      // 用户点名要的那一次不等窗口、也不问资格：把上次读取时间置 `null`，数据一到就抄——这就是
      // 「显式刷新一定会被看见」的全部机制（核心没有回执，所以只能这样问一声）。
      if (core.refresh(config, source.name, key)) lastReadAt = null
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
    write: (url, key, data, updatedAt) => { store.write(url, key, data, updatedAt) },
    fail: (url, key, error, failedAt) => { store.fail(url, key, error, failedAt) },
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

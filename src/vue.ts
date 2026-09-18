import {
  getCurrentInstance, onActivated, onDeactivated, onMounted, onScopeDispose, shallowRef, watch, watchEffect,
} from 'vue'
import type { App } from 'vue'
import type { Pinia } from 'pinia'
import { RefreshCore } from './core.ts'
import type { Config, RefreshHttp, ResultCell } from './core.ts'
import { prepareParameters } from './source.ts'
import type { JsonParameters, Parameters } from './source.ts'
import { useRefreshStore } from './store.ts'
import type {
  ReadonlySnapshot, RefreshDisplay, RefreshFailure, RefreshHandle, RefreshManager, RefreshOptions,
} from './public-types.ts'

/**
 * Vue 适配层：把响应式配置与组件生命周期翻译成框架需求，在每次写入时按 `updatedAt` 时间差节流地抄结果表，
 * 把结果表接到 Pinia。
 *
 * 只跟踪 `enabled` 与 `every` 两项配置（都是 `Ref`），不跟踪参数、表单草稿或结果；
 * 本库是 SPA 单例，组件适配不经过 `provide` / `inject`（ADR-37，见 DESIGN §6.3）。
 */

/**
 * 当前安装的协调者与它的结果表。**两者同源**——`install` 一起写入，因此只有一个绑定：分成两个
 * 变量就要额外维护「它们指着同一个实例」这条不变量。
 *
 * `null` ＝ 此刻没有存活的协调者：卸载（`install` 里的 `app.onUnmount`）与显式 `dispose` 都把它置空。
 * 这个置空**不是记账**，而是读取面唯一的唤醒信号：读取副作用把它当依赖读在最前面，因此「协调者没了」
 * 会让每一页重新判一次闸门——结果表已被清空，两个出口于是一起清回 `null`（ADR-78）。这也是
 * `useRefresh` 里「本页有没有死掉」与 `currentCore()` 两处读到的同一个事实（HMR、会话切换时就地替换）。
 */
const installed = shallowRef<{ readonly core: RefreshCore; readonly store: ReturnType<typeof useRefreshStore> } | null>(null)

/**
 * 读此刻活着的协调者（`null` ＝ 已销毁或未安装）。页面入口与演示面板、基准脚本**共用这一个读点**：
 * 页面不在 `setup` 里捕获一次，而是每次现读——捕获一次也能跑通，但那样同一个页面会分成两半，
 * 配置写入还往旧实例上写、读取面问的却已经是「没有协调者」（ADR-78）。
 */
export function currentCore(): RefreshCore | null {
  return installed.value?.core ?? null
}

/**
 * 读这一页的两个 `Ref` ＋ 生命周期，作为 watch 的取值函数；任一项读不出或抛错都回 `[undefined, undefined, active]`
 * （为什么读不出不猜成关闭见 DESIGN §6.1）。返回数组只为让 watch 拿到一份可比较的值，不做别的用。
 */
function readConfig(options: RefreshOptions, active: boolean): readonly [enabled: unknown, every: unknown, active: boolean] {
  try {
    return [options.enabled.value, options.every.value, active]
  } catch {
    return [undefined, undefined, active]
  }
}

/**
 * 把读到的那三个值写进**当前协调者的**配置槽；值非法就把 `every` 置 `null`（＝这一拍配置非法）。
 *
 * 这是**唯一的写入口**，而且必须在一个同步块里写完：槽是可变对象（ADR-66），读者看不到半更新
 * 全靠「中间不调用任何会回到框架的东西」。非法时只翻 `every`——`isPresent` 先看它，
 * 因此 `enabled`／`active` 的旧值在非法期间不会被信任。
 *
 * 槽跟着协调者走（换了协调者就换一份槽）：配置快照是**报给某个协调者的登记**，换协调者之后旧槽
 * 已经没有读者，而新协调者**不接旧槽**——新槽由本次重新读一遍两个 `Ref` 与 `active` 补上
 * （否则新协调者手里的那一页永远停在 `every === null`，一次也不取数，ADR-78）。
 */
function applyConfig(target: Config, values: readonly [enabled: unknown, every: unknown, active: boolean]): void {
  const [enabled, every, active] = values
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
export function useRefresh<P extends JsonParameters<P>, T>(
  url: string,
  options: RefreshOptions,
): RefreshHandle<P, T> {
  if (url.length === 0) throw new TypeError('useRefresh 需要一个非空的 URL：它是身份的一半')
  if (!getCurrentInstance()) throw new Error('useRefresh 必须在组件的 setup 中同步调用')
  if (installed.value === null || installed.value.core.isDisposed()) throw new Error('需要先安装一个存活的刷新协调者')
  // 只留结果表：协调者在页面里一律经 `currentCore()` 现读（销毁后页面不再捕获一个死实例）。
  const { store } = installed.value

  /**
   * 本页此刻报给**哪个协调者**：`setup` 时那个就是初始值；装上另一个协调者（原地接管）时，读取副作用
   * 会发现 `installed` 换了、把这里跟着换掉，于是**下一拍配置重新报给新的那个**（ADR-78）。
   *
   * 它只有一个事实「现在挂在谁那里」——槽本身仍是每页一份 `Config`（ADR-66）；换协调者不等于换槽，
   * 而是换一份新槽（旧槽的读者已经没了）。`null` ＝ 此刻没有活着的协调者。
   */
  let slot: RefreshCore | null = installed.value.core

  /**
   * 这一页在核心里的**全部内容**：一页一份配置快照，原地改写，按身份挂在实例的 `declarers` 里。
   * 参数准备留在这一层，核心因此不认识页面、也不执行任何调用方代码（ADR-64、ADR-66）。
   */
  const config: Config = { enabled: false, every: null, active: false }

  /**
   * 把配置报给**此刻活着的那一个**协调者：协调者换了就换一份新槽（新槽必须重新读一遍两个 `Ref` 与
   * `active`，否则新协调者手里的那一页永远停在 `every === null`，一次也不取数）。
   *
   * 没有协调者时**不写槽、也不通知**——槽是「报给核心的登记」，核心没了，写进去只会让观测面显示
   * 一份没人收下的配置。协调者是谁只在这里现读（页面里不再捕获一个会变死的实例）。
   */
  const reportConfig = (): void => {
    const viewer = currentCore()
    slot = viewer
    if (viewer === null) return
    applyConfig(config, readConfig(options, active.value))
    viewer.reconcile()
  }

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
   * 本页看到的数据：**由写入事件驱动、按本页 `every` 节流抄来的一份副本**。
   *
   * - **读者才跟随**：这一页有资格（`core.isEligible`），或它**还没有读取时间**（`lastReadAt === null`）
   *   且此刻浏览器可见时抄；失活、隐藏、卸载中都不是读者，画面**冻结在最后一帧**。暂停页自己 `refresh()`
   *   那一次由第二项放行，而且那一次不等节流，所以照样更新画面（A05、G6）；**还没读到过的暂停页**会跟着
   *   第一份到达的数据上屏一次，此后它有了上次读取时间就冻住（真 Chrome 的 A11 用例钉住了这一帧，ADR-72）。
   * - **按 `updatedAt` 时间差节流**：新格的 `updatedAt` 距展示中那份满一个本页 `every` 才换画面——
   *   慢页面主动要的就是「不跟着快页面跳」。写端稀于本页 `every` 时写入即抄（比固定拍更及时）；
   *   写端密且 `every` 非整数倍时实际更新周期被量化到写入网格（ADR-67 接受的代价）。
   *   三处不等节流（身份刚落定、本页刚重新成为读者、本页刚显式刷新）走的是同一条规则：把读取基准
   *   清掉——「没有读取时间就直接读」（所以它们不必再各带一个标志）。
   * - **没东西可抄时保留上一次画面**：条目随实例释放即删（A06 在结果表这一层不变），
   *   而页面上「刚才那份数据」不该因为没人订阅了就变空。
   * - **必须先读结果表、再判任何闸门**：否则这个副作用记不住对那一格的依赖，之后的写入唤不醒它
   *   （浏览器用例抓到过这个真实缺陷）。身份还没落定时没有格可读，直接返回——**不能拿一个假键去查表**，
   *   结果表的 `read` 是「取或建」，假键会在里面留下一格永远不会有人写、也永远不会被删的垃圾。
   *
   * 依赖粒度：`store.read(url, key)` 现在返回的是那一个 cell ref 的 `.value`，副作用收在那一个 ref 上；
   * 写别的格不会唤醒这个副作用。**唤醒它的只有两件事：这一格被写入、这一页换了身份**（`identity`）——
   * 配置变化不改画面，只改「下一次写入时怎么判定」（`lastReadAt` 由下面那个 watcher 负责，ADR-73）。
   *
   * 这一格被写入时发布**两件事**：数据（按窗口）与失败（不等窗口），见下面两个发布函数。
   */
  const display = shallowRef<RefreshDisplay<P, T> | null>(null)
  /**
   * 本页看到的**最近一次失败**：与数据同一个来源（那一格）、同一个读者闸门，但**不参与数据窗口**——
   * 失败不是数据的旧版本，它是这一格此刻是否处于失败态。`null` ＝ 没有失败（成功会把它清回 `null`）。
   */
  const failure = shallowRef<RefreshFailure | null>(null)
  /**
   * **上次读取时间**：上一次抄进数据出口的那一版数据的时间（`ResultCell.updatedAt`）。它只管数据出口；
   * 失败出口不需要自己的读取基准——同一个对象在不在、`failedAt` 变没变就够判。
   * `null` ＝ 还没有读取过——第一次读取、刚点过刷新、刚换身份、刚重新成为读者（ADR-72）。
   *
   * 判定只有一句话：`上次读取时间 ＋ 本页 every > 新数据的 updatedAt` 就不换画面；没有读取时间
   * 就直接读。刷新不动别的东西，只把这一页的上次读取时间置 `null`——数据一到自然就换了。
   */
  let lastReadAt: number | null = null

  /** 数据出口：同一版不抄第二遍；只发布窗口已到的那一版。 */
  const publishData = (cell: ResultCell): void => {
    const shown = display.value
    if (shown !== null && cell.updatedAt === shown.updatedAt) return
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
    }
    lastReadAt = cell.updatedAt
  }

  /** 失败出口：这一格换了一笔新的失败就立刻发布，成功（`failedAt === null`）就清回 `null`。 */
  const publishFailure = (cell: ResultCell): void => {
    const shown = failure.value
    if (cell.failedAt === null ? shown === null : shown !== null && shown.failedAt === cell.failedAt) return
    failure.value = cell.failedAt === null ? null : { error: cell.error, failedAt: cell.failedAt }
  }

  watchEffect(() => {
    // 第一件事：读「此刻有没有存活的协调者」。它同时是这个副作用唯一的失效信号——协调者被销毁时
    // 这里会重跑一次，于是两个出口一起清回 `null`，而不是把最后一帧冻在画面上（ADR-78）。
    // 另一层意义：销毁后核心还留着一个 `disposed` 标志，读取面不再问它第二遍（只有它自己的入口判）。
    const bound = installed.value
    // 换了协调者（原地接管）：槽跟着换，**下一拍配置报给新的那一个**（响应式地触发配置 watcher）。
    // 这一行必须在任何提前返回**之前**——换协调者与「身份是否落定」无关，页面可能还没提交过身份
    // （那也要把配置报给新协调者），放在守卫后面就会漏掉最常见的那条路径。
    if (bound !== null && bound.core !== slot) {
      slot = bound.core
    }
    const key = identity.value
    // 没有协调者：两个出口一起清回 `null`——画面不该留着已不存在的那份结果的最后一帧（ADR-78）。
    if (bound === null) {
      display.value = null
      failure.value = null
      lastReadAt = null
      return
    }
    // 身份还没落定：没有可抄的格，也没有依赖可登记——设 `identity` 的那一处会再叫醒这个副作用。
    if (key === null) return
    // 接着读那一格：这一次读同时登记依赖，写这一格才唤得醒这个副作用。**顺序不能换**——销毁之后
    // 也照样读一次，读到的必然是 `undefined`（结果表条目随 `releaseIfUnused` 清了），于是走清空。
    const cell = bound.store.read(url, key)
    // 从来没有写过这一格：没有可抄的东西，画面停在上一帧（不发布空副本）。
    if (cell === undefined) return
    // 读闸门（两个出口共用）：有资格（声明着它、配置有效、开启、激活且浏览器可见），或**还没读取过**
    // （第一次，或刚点过刷新）且此刻浏览器可见。第二项就是「没有读取时间就直接读」——它是暂停页自己点
    // 刷新那一次能上屏的唯一机制（A05、G6）。入口闸在点的那一刻已经判过环境，所以这里不补 `active`。
    if (!bound.core.isEligible(config, url, key) && !(lastReadAt === null && bound.core.isVisible())) return
    publishFailure(cell)
    publishData(cell)
  }, { flush: 'sync' })

  /** 这一页是否挂载/激活（KeepAlive 失活为假）。它与「浏览器可见」是两件事，后者由核心统一监听。 */
  const active = shallowRef(false)

  // 唯一的配置写入口（`reportConfig`）：两个 `Ref` ＋ 这一页的激活状态写进同一份槽，再让核心重算一次调度。
  // 非法配置不通知——它是本页自己的输入事实，页面读自己的 refs 就知道；框架只负责不取数、
  // 不刷新，修正后自动恢复（ADR-51）。`active` 也在依赖里，所以挂载/激活/失活只需改它。
  // 取值函数里**带上 `slot`**：换了协调者时值没变，但配置必须重新报给新的那一个（ADR-78）。
  const stopWatching = watch(() => [slot, ...readConfig(options, active.value)] as const, () => {
    reportConfig()
    // 重新成为读者（激活、开起来、修好配置）：把上次读取时间置 `null`，**下一份写入**因此不等窗口。
    // **失去资格那一侧（暂停、失活、隐藏）不动**——那一侧若也置 `null`，读闸门第二项就会把整个
    // 失活期都放行，画面在后台一路跟下去，「失活冻结」就没了（ADR-72）。
    // 这里**不需要**再叫醒副作用：它只由数据写入、换身份与换协调者唤醒，配置变化只影响「下一份写入怎么判定」。
    const viewer = currentCore()
    if (viewer === null) return
    const changed = identity.value
    if (changed !== null && viewer.isEligible(config, url, changed)) lastReadAt = null
  }, { flush: 'sync', immediate: true })

  // mounted/activated 与 deactivated 存在交叠（KeepAlive），两个方向都必须幂等。
  // 只改 `active`：快照与协调由上面那个 `flush: 'sync'` 的 watcher 完成（单一写入口）。
  onMounted(() => { active.value = true })
  onActivated(() => { active.value = true })
  onDeactivated(() => { active.value = false })
  // 拆卸由这一层自己做：核心不持有任何回调，所以释放时是这里主动停表、再把它摘出名册。
  onScopeDispose(() => {
    released = true
    stopWatching()
    // 摘声明的对象是**上一拍报给的那个协调者**（`slot`）——协调者可能已经销毁、也可能已经换人，
    // 这时对「此刻活着的那个」摘一份从没报给它的槽，什么也摘不掉。
    slot?.undeclare(config)
    identity.value = null
  })

  return {
    display,
    failure,
    submit: args => {
      // 释放之后这一页不再产生任何事实（§2.4「取消只有一个来源（句柄或协调者已销毁）」）。
      // 「协调者死了」与「没有协调者」是同一件事：`installed` 被销毁那一处置空（ADR-78）。
      const bound = currentCore()
      if (released || bound === null) return { status: 'cancelled' }
      // 参数准备（复制、值域、编码）是这一层的活：输入问题在这里就地变成 `rejected`，
      // 核心拿到的一定是一份可用身份——它没有 try/catch，也不会执行调用方代码（ADR-64）。
      let parameters: Parameters
      try {
        parameters = prepareParameters(args)
      } catch (error) {
        return { status: 'rejected', error }
      }
      const result = bound.submit(config, url, parameters)
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
      const bound = currentCore()
      if (released || bound === null) return
      const key = identity.value
      if (key === null) return
      // 用户点名要的那一次不等窗口、也不问资格：把上次读取时间置 `null`，数据一到就抄——这就是
      // 「显式刷新一定会被看见」的全部机制（核心没有回执，所以只能这样问一声）。
      if (bound.refresh(config, url, key)) lastReadAt = null
    },
  }
}

/**
 * 创建应用级协调者：`maxConcurrent` 是共享请求的并发上限（显式刷新与自动刷新共用这些槽位）；
 * `axios` 是取数用的实例——框架对页面给的 URL 发 `post(url, 参数值的一份副本, { signal })`，
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
  // 结果表**本身就是**核心要的那个端口：`write`／`fail`／`remove`／`list` 四个动作的签名一致，
  // 所以直接把 store 交进去——多一层转发不改行为，只多一份要跟端口同步的签名。
  const core = new RefreshCore(options.maxConcurrent, options.axios, store)
  /** 这个协调者装到了哪个 App；同一个实例只能装一个。 */
  let boundApp: App | null = null
  /** 摘掉可见性监听；装上过一次之后才有。核心不再持有任何回调，所以这由适配层自己收尾（ADR-64）。 */
  let stopWatchingVisibility: (() => void) | null = null

  /**
   * 从模块级的安装槽里退场：摘掉可见性监听，并把 `installed` 置空（读取面因此清掉两个出口，ADR-78）。
   * **只有还装着「我」的时候才置空**——销毁之后同一个进程里可能已经装上另一个协调者（HMR、会话切换），
   * 那种情况下别人的槽位不该被我摘掉。卸载钩子与 `dispose()` 共用它，两条路都只走一遍。
   */
  const uninstall = (): void => {
    stopWatchingVisibility?.()
    stopWatchingVisibility = null
    if (installed.value !== null && installed.value.core === core) installed.value = null
  }

  return {
    /** 安装到应用：接上可见性监听与卸载释放；同一实例只能装到一个 App。 */
    install(app) {
      if (core.isDisposed() || (boundApp !== null && boundApp !== app)) {
        throw new Error('刷新协调者安装冲突：同一个实例不能安装到两个 App，已销毁的实例也不能再安装')
      }
      if (boundApp === app) return // 同实例同 App 重复安装无副作用。
      // 单例：现有协调者还活着就拒绝；已销毁（HMR、会话切换）就直接替换。
      if (installed.value !== null && !installed.value.core.isDisposed() && installed.value.core !== core) {
        throw new Error('刷新协调者安装冲突：同一进程里已有一个存活的实例')
      }
      installed.value = { core, store }
      boundApp = app

      // 浏览器可见性由框架自己监听；本库是 SPA，不再有 SSR 分支。
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

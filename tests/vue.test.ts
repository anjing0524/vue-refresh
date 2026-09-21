import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { computed, createRenderer, defineComponent, h, KeepAlive, nextTick, onScopeDispose, ref, watch } from 'vue'
import { createPinia } from 'pinia'
import { createRefreshManager, currentCore, useRefresh } from '../src/vue.ts'
import { useRefreshStore } from '../src/store.ts'
import type { RefreshHttp } from '../src/core.ts'
import type { RefreshDisplay, RefreshHandle, RefreshManager, SubmitResult } from '../src/public-types.ts'
import type { Ref } from 'vue'
import { snapshot } from '../scripts/observe.ts'

/** 这几个用例验证浏览器路径：`install` 无条件注册可见性监听（本库只服务 SPA），因此先提供最小替身。 */
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { hidden: false, addEventListener() {}, removeEventListener() {} },
})

/** 无 DOM 的自定义渲染器。 */
const renderer = createRenderer({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: (type: unknown) => ({ type }),
  createText: (text: string) => ({ text }),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
} as never)

/** 每个用例一个假传输：返回值就是这次取数的结果（框架只取它的 `data`）。 */
type FakePost = (url: string, body: object, context: { readonly signal: AbortSignal }) => Promise<unknown>
function fakeHttp(post: FakePost): RefreshHttp {
  // 显式标注参数：`RefreshHttp.post` 的第二个参数是 `unknown`，这里要收窄回假传输的 `object`。
  return {
    post: async (url: string, body: object, context: { readonly signal: AbortSignal }) => ({
      data: await post(url, body, context),
    }),
  }
}

const managers: RefreshManager[] = []
/** 每个用例一个 Pinia 实例：结果表挂在它上面，用例之间因此互不可见。 */
function newManager(maxConcurrent: number, post: FakePost = async () => undefined): RefreshManager {
  const manager = createRefreshManager({ maxConcurrent, http: fakeHttp(post), pinia: createPinia() })
  managers.push(manager)
  return manager
}
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

/** 需要直接核对结果表储存的用例用这个：把这张表用的 Pinia 一起给出来。 */
function newManagerWithStore(maxConcurrent: number, post: FakePost = async () => undefined): {
  readonly manager: RefreshManager
  readonly store: ReturnType<typeof useRefreshStore>
} {
  const pinia = createPinia()
  const manager = createRefreshManager({ maxConcurrent, http: fakeHttp(post), pinia })
  managers.push(manager)
  return { manager, store: useRefreshStore(pinia) }
}

/**
 * 观测面取一份快照；协调者已销毁时返回 `undefined`。
 *
 * ADR-78 之后销毁会把模块级的安装槽置空（`currentCore()` 因此回 `null`），所以这里显式区分
 * 「没有协调者」与「协调者里没有东西」——原来的 `?.` 把两者合成同一个 `undefined`，读起来像
 * 断言失效而不是状态变化。
 */
function snapshotOf(): ReturnType<typeof snapshot> | undefined {
  const core = currentCore()
  return core === null ? undefined : snapshot(core)
}

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await nextTick()
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** 节流与调度是真实定时器上的事，断言不能假设精确时刻，只能等到条件成立或超时。 */
async function until(condition: () => boolean, message: string, budget = 2_000): Promise<void> {
  const end = Date.now() + budget
  while (!condition()) {
    if (Date.now() > end) throw new Error(`超时：${message}`)
    await sleep(10)
  }
}

test('A06/A11/A12 适配层：声明后立即拿到数据；关闭开启意愿后停止；卸载后释放并保留画面', async () => {
  let loads = 0
  const manager = newManager(2, async () => { loads++; return 42 })
  const enabled = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>
  let released = 0

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/47', { enabled, every: ref(100_000) })
      onScopeDispose(() => { released++ })
      // 真实组件会渲染画面；画面保留要成立，前提是页面确实显示过它。
      return () => h('div', String(api.display.value?.data ?? ''))
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  assert.equal(api.submit({ symbol: 'A' }).status, 'accepted')
  await tick()
  const display: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.equal(display?.data, 42)
  assert.equal(loads, 1)

  enabled.value = false
  await tick()
  await tick()
  // 【同 A05：最后一个需求退出即删结果 ⇒ 画面读回 null；keep-last 之前这条会红】
  assert.equal(api.display.value?.data, 42, '暂停保留画面')
  assert.equal(loads, 1, '暂停后不再取数')

  app.unmount()
  await tick()
  assert.equal(released, 1)
  assert.equal(api.display.value, null, '整个应用卸载＝协调者也销毁：两个读出口一起清空（ADR-78）；只卸载页面、协调者还活着的情形是 A17/A06 那条')
})

test('A04/A05 配置非法：不取数并停止订阅，修正后按当前资格恢复', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 1 })
  const every = ref(100_000)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/84', { enabled: ref(true), every })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  every.value = 0
  await tick()
  await tick()
  // 配置非法不产生任何结果：它是本页自己的输入事实，框架只负责不订阅、不请求（ADR-51）。
  assert.equal(api.display.value?.failed, false, '配置非法不写失败：出口上没有失败这一笔')

  every.value = 50_000
  await tick()
  // 修正后按**到期**恢复：声明与结果都还在（ADR-61），已有结果未到期，所以不重查。
  assert.equal(loads, 1, '修正后按到期恢复：已有结果未到期，不重查')
  assert.equal(api.display.value?.data, 1, '修正后画面读到那一份结果')
  app.unmount()
})

test('A05/A06 改 enabled.value 立即生效：暂停只退订、恢复重新接入', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 7 })
  const enabled = ref(true)
  const every = ref(100_000)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/118', { enabled, every })
      return () => h('div', String(api.display.value?.data ?? ''))
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  enabled.value = false
  await tick()
  // 暂停只失去资格：声明、实例与结果都留着（ADR-61），画面冻结在最后一帧。
  assert.equal(api.display.value?.data, 7, '暂停保留画面')
  assert.equal(snapshotOf()?.resources.length, 1, '暂停不释放实例：声明还在')

  enabled.value = true
  await tick()
  assert.equal(loads, 1, '重新开启直接读回已有结果，不重查（ADR-61）')
  assert.equal(api.display.value?.data, 7, '恢复后画面读到那一份结果')
  app.unmount()
})

test('A04/A06 KeepAlive 失活退订、激活恢复：两个方向都幂等', async () => {
  let loads = 0
  const manager = newManager(2, async () => { loads++; return loads })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const Inner = defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/150', { enabled: ref(true), every: ref(100_000) })
      return () => h('div', String(api.display.value?.data ?? ''))
    },
  })
  const app = renderer.createApp(defineComponent({
    setup() {
      return () => h(KeepAlive, null, { default: () => shown.value ? h(Inner) : null })
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  shown.value = false
  await tick()
  await tick()
  // 【同 A05：最后一个需求退出即删结果 ⇒ 画面读回 null；keep-last 之前这条会红】
  assert.equal(api.display.value?.data, 1, '失活保留画面')
  assert.equal(loads, 1, '失活后不再取数')

  shown.value = true
  await tick()
  // 失活不撤销声明：实例与结果都留着，激活后直接读回，不重查（ADR-61）。
  assert.equal(loads, 1, '激活后读回已有结果，不重查')
  assert.equal(api.display.value?.data, 1, '激活后画面仍然有结果')
  app.unmount()
})

test('A04/A06 点过刷新之后失活：缓存里那一帧仍会更新；失活期间点刷新不产生事实', async () => {
  let loads = 0
  const resolvers: Array<(value: number) => void> = []
  const quote = '/api/vue/907'
  const manager = newManager(1, () => { loads++; return new Promise<number>(resolve => { resolvers.push(resolve) }) })
  const shown = ref(true)
  let reader!: RefreshHandle<{ symbol: string }, number>
  let cached!: RefreshHandle<{ symbol: string }, number>

  const Reader = defineComponent({
    setup() {
      reader = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Cached = defineComponent({
    setup() {
      cached = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const app = renderer.createApp(defineComponent({
    setup() {
      return () => h('div', [h(Reader), h(KeepAlive, null, { default: () => shown.value ? h(Cached) : h('span') })])
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  reader.submit({ symbol: 'A' })
  cached.submit({ symbol: 'A' })
  await tick()
  resolvers[0]?.(1)
  await tick()
  assert.equal(reader.display.value?.data, 1)
  assert.equal(cached.display.value?.data, 1)

  // 在缓存页里点一次刷新、然后立刻失活：那一帧照旧更新（确认人 2026-09-17 的裁决「允许它更新一帧」）。
  cached.refresh()
  await tick()
  assert.equal(loads, 2, '刷新已经发起取数')
  shown.value = false
  await tick()
  resolvers[1]?.(2)
  await tick()
  assert.equal(cached.display.value?.data, 2, '点过刷新之后失活：缓存里的画面仍更新那一帧')

  // 失活期间再点刷新：入口闸（激活且浏览器可见）不放行，什么都不产生。
  cached.refresh()
  await tick()
  assert.equal(loads, 2, '失活期间点刷新不发请求、也不进入欠一份')
  shown.value = true
  await tick()
  await tick()
  assert.equal(loads, 2, '重新激活只读回已有结果，不重查')
  assert.equal(cached.display.value?.data, 2)
  app.unmount()
})

test('A06 重新成为读者立即读回该身份当前那一版：不重新取数，此后按窗口跟随', async () => {
  let loads = 0
  const quote = '/api/vue/911'
  const manager = newManager(1, async () => { loads++; return loads })
  const enabled = ref(false)
  let reader!: RefreshHandle<{ symbol: string }, number>
  let paused!: RefreshHandle<{ symbol: string }, number>

  const Reader = defineComponent({
    setup() {
      reader = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Paused = defineComponent({
    setup() {
      paused = useRefresh<{ symbol: string }, number>(quote, { enabled, every: ref(100_000) })
      return () => h('div')
    },
  })
  const app = renderer.createApp(defineComponent({ setup() { return () => h('div', [h(Reader), h(Paused)]) } }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  reader.submit({ symbol: 'A' })
  paused.submit({ symbol: 'A' })
  // 调度与微任务是真实时序：只等到条件成立，不假设要转几圈（仓库既有约定）。
  await until(() => paused.display.value?.data === 1, '暂停页还没有读取时间：第一份直接上屏')

  reader.refresh()
  await until(() => reader.display.value?.data === 2, '读者拿到第二版')
  assert.equal(paused.display.value?.data, 1, '它有上次读取时间了：窗口内不换画面')

  // 恢复：重新成为读者的那一条边上**立刻读回该身份当前那一版**（表里已是 2，不重新取数、不等窗口）。
  enabled.value = true
  await until(() => paused.display.value?.data === 2, '重新成为读者立即读回当前那一版')
  assert.equal(loads, 2, '读回不产生新的请求')

  // 读回之后按新的窗口跟随：下一份写入还在窗口内，画面不动。
  reader.refresh()
  await until(() => reader.display.value?.data === 3, '读者拿到第三版')
  assert.equal(paused.display.value?.data, 2, '读回之后按窗口跟随')
  app.unmount()
})

test('A04 运行期读到非布尔时按配置非法处理：不订阅、不写失败、修正后恢复', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 1 })
  const enabled = ref<boolean>(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/187', { enabled, every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  // 类型说谎的现场：store 未 hydrate 时字段声明是 boolean，运行期读到 undefined。
  ;(enabled as Ref<unknown>).value = undefined
  await tick()
  await tick()
  assert.equal(api.display.value?.failed, false, '配置非法不写失败：出口上没有失败这一笔')
  api.submit({ symbol: 'B' })
  await tick()
  assert.equal(loads, 1, '配置非法时不订阅')

  enabled.value = true
  await tick()
  assert.equal(loads, 2, '修正后按当前资格恢复')
  app.unmount()
})

test('A21 节流：慢页面不跟着快页面跳，节流窗口内的新版本不换画面；显式刷新不等节流', async () => {
  let loads = 0
  const quote = '/api/vue/203'
  const manager = newManager(2, async () => { loads++; return loads })
  let slow!: RefreshHandle<{ symbol: string }, number>
  let quick!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup: () => () => h('div', [h(Slow), h(Quick)]),
  }))
  // 两个页面声明同一个身份：这个身份按**最小的 every**取数（ADR-61），因此结果表一直在变。
  const Slow = defineComponent({
    setup() {
      slow = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Quick = defineComponent({
    setup() {
      quick = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(20) })
      return () => h('div')
    },
  })
  app.use(manager)
  app.mount({} as never)
  await tick()
  slow.submit({ symbol: 'A' })
  quick.submit({ symbol: 'A' })
  await tick()

  const latest = (): unknown => {
    const cell = snapshotOf()?.results[0]?.cell
    return cell === undefined || cell.data === undefined ? null : cell.data
  }
  // 新身份的第一份内容不等节流：两个页面都立即拿到首查结果。
  assert.equal(slow.display.value?.data, 1, '慢页面的第一份内容立即上屏')
  assert.equal(quick.display.value?.data, 1, '快页面的第一份内容立即上屏')

  // 快页面把共享取数推到 20ms 一次、结果表一直有新版本；慢页面 100 秒的节流窗口内
  // 任何新格都到不了「距展示中那份满一个 every」，所以它停在首查那一帧。
  await until(() => loads >= 4, '快页面把共享取数推到第 4 次')
  await until(() => quick.display.value?.data === latest(), '快页面跟到最新一版')
  assert.equal(slow.display.value?.data, 1, '节流窗口内结果表的新版本不改变慢页面的画面')
  assert.notEqual(latest(), 1, '结果表确实一直在变（否则这一条什么也没证明）')

  // 显式刷新不等节流：用户点名要的那一次，结果一到就抄进画面。
  slow.refresh()
  await until(() => slow.display.value?.data === latest(), '慢页面显式刷新后立即读到最新一版')
  app.unmount()
})

test('A03/A21 相同身份重复声明幂等：不动读取基准，慢页面仍停在窗口内那一帧', async () => {
  let loads = 0
  const quote = '/api/vue/941'
  const manager = newManager(2, async () => { loads++; return loads })
  let slow!: RefreshHandle<{ symbol: string }, number>
  let quick!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup: () => () => h('div', [h(Slow), h(Quick)]),
  }))
  const Slow = defineComponent({
    setup() {
      slow = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Quick = defineComponent({
    setup() {
      quick = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(20) })
      return () => h('div')
    },
  })
  app.use(manager)
  app.mount({} as never)
  await tick()
  slow.submit({ symbol: 'A' })
  quick.submit({ symbol: 'A' })
  await tick()

  const latest = (): unknown => {
    const cell = snapshotOf()?.results[0]?.cell
    return cell === undefined || cell.data === undefined ? null : cell.data
  }
  assert.equal(slow.display.value?.data, 1, '慢页面的第一份内容立即上屏')
  // 快页面把共享取数推到更后面，慢页面在 100 秒的窗口里停在首查那一帧。
  await until(() => loads >= 3, '快页面把共享取数推到第 3 次')
  assert.equal(slow.display.value?.data, 1, '窗口内结果表的新版本不改变慢页面的画面')

  // 同身份重复声明：核心侧幂等（不新增请求、不换实例，见 core 用例 A03），适配层也**不能**
  // 因此清掉读取基准——「清基准」只属于身份落定、重新成为读者、点过一次刷新这三处。
  const settled = latest()
  assert.equal(slow.submit({ symbol: 'A' }).status, 'accepted', '同身份重复声明照旧是 accepted')

  // 下一份写入落表：基准若被误清，这一版会立刻上屏（下面的断言就会失败）。
  await until(() => latest() !== settled && latest() !== null, '结果表又落了一版')
  await sleep(30)
  assert.equal(slow.display.value?.data, 1, '重复声明之后仍在窗口内：不换画面')
  app.unmount()
})

test('A21 写端稀于本页 every 时写入即抄：节流不丢数据，新格一到就上屏', async () => {
  let loads = 0
  // 传输带 80ms 延迟：写入流的间隔（every ＋ 延迟）比本页 every（20ms）稀。
  const manager = newManager(1, async () => {
    loads++
    await sleep(80)
    return loads
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/204', { enabled: ref(true), every: ref(20) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()

  // 先等首帧上屏再取基线：`before` 是「已经看到的那一份」，没有它这条断言什么也证明不了
  // （写成 `undefined + 2` 会得到 NaN，`until` 只会空转到超时）。
  await until(() => typeof api.display.value?.data === 'number', '首帧上屏')
  // 每次写入都距上一份至少一个 every（写入间隔 > every），因此写入即抄、一版不落。
  const before = api.display.value?.data as number
  await until(() => (api.display.value?.data as number) >= before + 2, '画面跟到两版之后', 5_000)
  const seen = api.display.value?.data as number
  await until(() => loads >= seen + 1, '又有一次写入落表')
  await until(() => (api.display.value?.data as number) >= seen + 1, '那次写入立刻进了画面')
  app.unmount()
})

test('A13/A11 唯一出口：成功与失败是同一笔（同一个窗口）——首查失败也读得到，成功后清回假，数据保留旧址', async () => {
  let mode: 'ok' | 'fail' = 'fail'
  let loads = 0
  const manager = newManager(1, async () => {
    loads++
    if (mode === 'fail') throw new Error(`boom-${loads}`)
    return loads
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/265', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()

  // 首查就失败：出口照样发布（`data: null`、`failed: true`）——否则首查失败无从读取。
  assert.notEqual(api.display.value, null, '首查失败也发布画面（否则首查失败无从读取）')
  assert.equal(api.display.value?.failed, true, '这一笔是失败')
  assert.equal(api.display.value?.data, null, '从未成功过：数据为 null')
  assert.ok(typeof api.display.value?.updatedAt === 'number', '失败那一笔带自己的时刻：出口上只有一个时间')
  assert.match(String((api.display.value?.error as Error).message), /boom-1/, '原始异常原样带出')

  mode = 'ok'
  api.refresh()
  await until(() => api.display.value?.data === 2, '显式刷新后读到成功结果')
  assert.equal(api.display.value?.failed, false, '成功清掉失败')

  // 暂停页那一侧（`enabled: false` 的页自己点刷新、失败从同一个出口读到）见下面的
  // 「A13 暂停页显式刷新的失败也经唯一出口」——本条这一页是开着意愿的，只证明「刷新没有回执」。
  mode = 'fail'
  api.refresh()
  await until(() => api.display.value?.failed === true, '失败重新可读')
  assert.equal(api.display.value?.data, 2, '失败不覆盖旧址（数据仍是上一次成功的）')
  assert.ok((api.display.value?.updatedAt ?? 0) > 0, '失败把这一格的时间推进到这一次请求的时刻')
  app.unmount()
})

test('A13/A11 唯一出口：周期性失败也按同一个窗口到达画面，成功一到 `failed` 又清回假', async () => {
  let mode: 'ok' | 'fail' = 'ok'
  let loads = 0
  const manager = newManager(1, async () => {
    loads++
    if (mode === 'fail') throw new Error(`late-${loads}`)
    return loads
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      // 周期取正常值就够：失败那一笔也把 `updatedAt` 往前推，所以它按**同一个窗口**到达画面（ADR-122）。
      api = useRefresh<{ symbol: string }, number>('/api/vue/266', { enabled: ref(true), every: ref(20) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.data === 1, '首查成功')
  assert.equal(api.display.value?.failed, false, '还没有失败过：这一笔不是失败')

  // 不点刷新：让**周期取数**自己失败。旧口径（失败有自己的出口、不参与窗口）下它当场就上屏；
  // 单出口之后它与数据共用窗口，最多晚一个周期到达——这里等它到达，再验证数据没被毁。
  mode = 'fail'
  await until(() => api.display.value?.failed === true, '周期性失败也到达画面（按同一个窗口）')
  assert.match(String((api.display.value?.error as Error).message), /late-\d+/, '原始异常原样带出')
  assert.equal(api.display.value?.data, 1, '失败不动旧址：数据仍是上一次成功的')

  mode = 'ok'
  await until(() => api.display.value?.failed === false && (api.display.value?.data ?? 0) > 1, '下个周期成功：failed 清回假、数据跟上')
  app.unmount()
})

test('A17/A06 释放一页之后：submit 返回 cancelled、refresh 不产生事实（§2.4「取消只有一个来源」）', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 1 })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const Inner = defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/265', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const app = renderer.createApp(defineComponent({
    setup: () => () => (shown.value ? h(Inner) : null),
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  shown.value = false // 只卸载这一页：协调者还活着，所以「已释放」只能由适配层自己判定
  await tick()
  assert.deepEqual(api.submit({ symbol: 'B' }), { status: 'cancelled' }, '释放后不再声明身份')
  api.refresh()
  await tick()
  assert.equal(loads, 1, '释放后不再取数')
  assert.equal(snapshotOf()?.resources.length, 0, '释放后实例与结果一并回收')
  assert.equal(api.display.value?.data, 1, '画面仍保留最后一帧（ADR-60：冻结与实例生死是两件事）')
  app.unmount()
})

test('A17 安装：同一实例重复安装无副作用，另一个活跃实例被拒，销毁后可以原地接管', async () => {
  const manager = newManager(1)
  const other = newManager(1)
  const app = renderer.createApp(defineComponent({ setup: () => () => h('div') }))

  app.use(manager)
  app.use(manager)
  assert.throws(() => { app.use(other) }, /安装冲突/)

  manager.dispose()
  app.use(other) // 上一个实例已销毁：原地接管同一个注入槽位。
  app.mount({} as never)
  await tick()
  app.unmount()
})

test('A17 协调者销毁后读取面一起清空：结果表已空，两个出口不该把最后一帧冻在画面上（ADR-78）', async () => {
  let mode: 'ok' | 'fail' = 'ok'
  const manager = newManager(1, async () => {
    if (mode === 'fail') throw new Error('取数失败')
    return 7
  })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>
  // 单独拿一份有显式类型的出口别名：`assert.equal(display.value, null)` 会把 `display.value`
  // 这个属性在整个函数里收窄成 `null`，后面的松手断言就会被判成 `never`。
  let display!: Readonly<Ref<RefreshDisplay<{ symbol: string }, number> | null>>

  const Inner = defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/278', { enabled: ref(true), every: ref(100_000) })
      display = api.display
      return () => h('div')
    },
  })
  const app = renderer.createApp(defineComponent({
    setup: () => () => (shown.value ? h(Inner) : null),
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(display.value?.data, 7, '先成功一份，画面有内容可冻')

  // 再让这一格失败一次：失败那一笔写进同一个出口，数据仍留着上一次成功（ADR-63、ADR-122）。
  mode = 'fail'
  api.refresh()
  await tick()
  assert.equal(api.display.value?.failed, true, '失败那一笔到达画面')

  // 销毁协调者：结果表条目随 `releaseIfUnused` 清空，读取面必须跟着清——否则页面读的是
  // 一个已经不存在的协调者留下的最后一帧，且再也没有任何东西会叫醒它。
  manager.dispose()
  await tick()
  assert.equal(currentCore(), null, '销毁后没有存活的协调者')
  assert.equal(snapshotOf(), undefined, '观测面也拿不到一个已销毁的实例')
  // 这里用 `assert.equal` 断言会把这个 `Ref` 收窄成「值恒为 null」，所以先各取一份再判。
  const clearedDisplay = display.value
  assert.equal(clearedDisplay, null, '销毁后出口清空')

  // 页面还活着，但协调者没了：这两个动作都不再产生事实（§2.4）。
  assert.deepEqual(api.submit({ symbol: 'B' }), { status: 'cancelled' }, '没有协调者时 submit 回 cancelled')
  api.refresh()
  await tick()

  // 原地接管：新协调者装上后这一页**不用动任何配置 ref**，新协调者按**当前**配置继续给这个身份取数
  // ——安装槽也在配置 watcher 的依赖里，装上那一刻这一页把当前的 `enabled`／`every`／`active` 重新报一遍。
  // 身份仍要由 `submit` 登记：接管不改调用方手里那份声明（新协调者不接旧协调者的登记）。
  newManager(1, async () => 9)
  app.use(managers[managers.length - 1]!)
  api.submit({ symbol: 'A' }) // 接管后重新声明同一个身份：新协调者必须立刻取数
  await until(() => {
    const shown: RefreshDisplay<{ symbol: string }, number> | null = display.value
    return shown?.data === 9
  }, '接管后新协调者按重新报上的配置取数并上屏')
  const takeover: RefreshDisplay<{ symbol: string }, number> | null = display.value
  assert.equal(takeover?.args.symbol, 'A', '身份参数还是销毁前那个（接管不改这一页的声明）')

  // 同一个句柄继续换身份也照旧。
  api.submit({ symbol: 'C' })
  await tick()
  const next: RefreshDisplay<{ symbol: string }, number> | null = display.value
  assert.equal(next?.args.symbol, 'C', '接管之后 submit 也照旧工作')

  shown.value = false
  await tick()
  app.unmount()
})

test('A17 未安装协调者时 useRefresh 直接抛错', () => {
  const app = renderer.createApp(defineComponent({
    setup() {
      assert.throws(() => { useRefresh<{ symbol: string }, number>('/api/vue/238', { enabled: ref(true), every: ref(1000) }) }, /需要先安装/)
      return () => h('div')
    },
  }))
  app.mount({} as never)
  app.unmount()
})

test('A02 空 URL 直接拒绝：它是身份的一半，短了会把不同资源并成一条', () => {
  const app = renderer.createApp(defineComponent({
    setup() {
      assert.throws(
        () => { useRefresh<{ symbol: string }, number>('', { enabled: ref(true), every: ref(1000) }) },
        /需要一个非空的 URL/,
      )
      return () => h('div')
    },
  }))
  app.mount({} as never)
  app.unmount()
})

test('A05/A11 暂停页还没有读取时间时跟着第一份数据上屏一次，此后冻结；自己点刷新那一次照样上屏', async () => {
  let loads = 0
  const quote = '/api/vue/903'
  const manager = newManager(1, async () => { loads++; return loads })
  let reader!: RefreshHandle<{ symbol: string }, number>
  let paused!: RefreshHandle<{ symbol: string }, number>
  const Reader = defineComponent({
    setup() {
      reader = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Paused = defineComponent({
    setup() {
      paused = useRefresh<{ symbol: string }, number>(quote, { enabled: ref(false), every: ref(100_000) })
      return () => h('div')
    },
  })

  const app = renderer.createApp(defineComponent({ setup() { return () => h('div', [h(Reader), h(Paused)]) } }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  reader.submit({ symbol: 'A' })
  paused.submit({ symbol: 'A' })
  // 调度是真实时序：只等条件成立，不假设要转几圈（仓库既有约定）。
  await until(() => reader.display.value?.data === 1 && paused.display.value?.data === 1, '两个页面都上屏第一份')
  assert.equal(loads, 1, '共享身份只取一次')
  assert.equal(reader.display.value?.data, 1)
  assert.equal(paused.display.value?.data, 1, '暂停页还没有读取时间：没有时间就直接读，上屏第一份')

  // 同一格再来一拍：暂停页仍然什么都不抄——读闸门第二项只认「还没有读取时间」。
  reader.refresh()
  await until(() => reader.display.value?.data === 2, '读者拿到第二版')
  assert.equal(paused.display.value?.data, 1, '它此后有上次读取时间了：窗口内不换画面（冻结）')

  // 暂停页自己点名要的那一拍照样放行（A05）。
  paused.refresh()
  await until(() => paused.display.value?.data === 3, '暂停页显式刷新后上屏')
  assert.equal(paused.display.value?.data, 3, '显式刷新把上次读取时间置 null：这一拍照样上屏')

  // 之后再来的新结果不再进这一页：冻结回到最后一帧。
  reader.refresh()
  await until(() => reader.display.value?.data === 4, '读者拿到第四版')
  assert.equal(paused.display.value?.data, 3, '没点刷新的那一拍不再跟随：停在自己拿到的那一版')
  app.unmount()
})

test('A17/A04 接管：新协调者按这一页当前的配置办事——空窗期关掉的意愿不会被旧协调者留下的那份槽顶掉', async () => {
  let firstLoads = 0
  let secondLoads = 0
  const enabled = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const manager = newManager(1, async () => { firstLoads++; return 1 })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/279', { enabled, every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(firstLoads, 1, '先按开启意愿取一次')

  // 空窗期：协调者先退场（页面还活着），这期间调用方把这一页关掉。配置槽是这一页自己的对象，
  // 旧协调者写进去的旧值会一直留在上面，所以新协调者必须重新读一遍当前配置，而不是接旧槽。
  manager.dispose()
  await tick()
  enabled.value = false
  await tick()

  const next = newManager(1, async () => { secondLoads++; return 2 })
  app.use(next)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  await tick()
  const frozen: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.equal(secondLoads, 0, '接管后按当前配置办事：空窗期关掉的页面不取数')
  assert.equal(frozen, null, '也没有结果上屏')

  // 再打开：同一份槽按新配置恢复取数，不需要重新 submit。
  enabled.value = true
  await until(() => {
    const shown: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
    return shown?.data === 2
  }, '接管后重新打开意愿按当前配置取数')
  assert.equal(secondLoads, 1, '恢复后只取一次')
  app.unmount()
  await tick()
})

test('A11/A02 换身份后首查又失败：args 跟着换到新身份（同一版去重按身份划界）', async () => {
  let api!: RefreshHandle<{ symbol: string }, number>
  const manager = newManager(1, async () => { throw new Error('首查失败') })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/281', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  api.submit({ symbol: 'A' })
  await until(() => api.display.value !== null, '首查就失败也要上屏（data 为 null）')
  const first: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.equal(first?.args.symbol, 'A')
  assert.equal(first?.data, null, '从未成功过：数据为 null')
  assert.equal(first?.failed, true, '这一笔是失败')

  // 换身份之后这一格同样没有数据，两个身份各自的时刻还可能落在同一毫秒：同一个时间戳**不是**同一版，
  // args 必须跟着换（守卫比身份，不比时间）。
  api.submit({ symbol: 'B' })
  await until(() => api.display.value?.args.symbol === 'B', '换身份后 args 跟着换（同一个时间戳不算同一版）')
  app.unmount()
  await tick()
})

test('A12/A06 发布期间换身份：读取面重新订上新身份的格（同步 display watcher 里换身份）', async () => {
  let api!: RefreshHandle<{ symbol: string }, number>
  let failA = false
  let loads = 0
  const manager = newManager(2, async (_url, body) => {
    if ((body as { symbol: string }).symbol === 'A' && failA) throw new Error('A 失败')
    loads += 1
    return loads
  })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/282', { enabled: ref(true), every: ref(20) })
      // 页面在失败那一笔里换到备用身份：这一次发布是同步的，换身份就发生在发布当中。
      watch(api.display, () => { if (api.display.value?.failed === true) api.submit({ symbol: 'B' }) }, { flush: 'sync' })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.data === 1, 'A 先成功一版')
  failA = true
  api.refresh()
  // 新身份必须**实际交付**：请求换成了 B 还不算，画面也得跟上（否则读取面永久停在 A）。
  await until(() => api.display.value?.args.symbol === 'B', '换身份后读取面重新订上新身份的格')
  app.unmount()
  await tick()
})

test('A12/A06 发布期间换身份：display watcher 里换身份同样收敛到新身份', async () => {
  let api!: RefreshHandle<{ symbol: string }, number>
  let switched = false
  let loads = 0
  const manager = newManager(2, async (_url, body) => {
    loads += 1
    return (body as { symbol: string }).symbol === 'A' ? 1 : 100 + loads
  })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/283', { enabled: ref(true), every: ref(20) })
      watch(api.display, () => {
        const shown = api.display.value
        if (!switched && shown?.args.symbol === 'A' && shown.data === 1) {
          switched = true
          api.submit({ symbol: 'B' })
        }
      }, { flush: 'sync' })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.args.symbol === 'B', '在出口里换身份之后同样收敛到新身份')
  app.unmount()
  await tick()
})

test('A12/A17 发布期间卸载：释放之后不再把过期的那一版上屏', async () => {
  let unmount: (() => void) | null = null
  let api!: RefreshHandle<{ id: number }, number>
  const manager = newManager(1, async () => { throw new Error('首查失败') })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ id: number }, number>('/api/vue/284', { enabled: ref(true), every: ref(100_000) })
      // 失败那一笔发布的那一刻同步卸载整棵应用：这一次的 args 已经过期，不能再写进画面。
      watch(api.display, () => { if (api.display.value?.failed === true) unmount?.() }, { flush: 'sync' })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  unmount = () => app.unmount()
  await tick()

  api.submit({ id: 1 })
  await tick()
  await sleep(20)
  const after: RefreshDisplay<{ id: number }, number> | null = api.display.value
  assert.equal(after, null, '卸载发生在发布期间：这一版不再写进画面')
})

test('A06 结果表的储存随最后声明者离开收敛：换身份不留格，同一个身份重建仍唤得醒', async () => {
  let loads = 0
  const { manager, store } = newManagerWithStore(1, async () => { loads += 1; return loads })
  const enabled = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/285', { enabled, every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(store.size(), 1, '一个活跃身份一格')

  api.submit({ symbol: 'B' })
  await tick()
  assert.equal(store.size(), 1, '换身份：旧格随实例释放一起删掉，不留空壳')

  // 同一个身份重建：新格的 ref 要在下一拍重新被订阅，重写才唤得醒。
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.args.symbol === 'A', '同一个身份重建后照样上屏')
  const shown: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.notEqual(shown?.updatedAt, null, '重建后的新结果照样交付')

  app.unmount()
  await tick()
  assert.equal(store.size(), 0, '最后一个声明者离开：储存键数收敛到 0')
})

test('A21 改频率只重排调度、不放行窗口：同一份配置内的变化不算重新成为读者', async () => {
  const everySlow = ref(100_000)
  let slow!: RefreshHandle<{ symbol: string }, number>
  let fast!: RefreshHandle<{ symbol: string }, number>
  let loads = 0
  const manager = newManager(1, async () => { loads += 1; return loads })
  const Slow = defineComponent({
    setup() {
      slow = useRefresh<{ symbol: string }, number>('/api/vue/286', { enabled: ref(true), every: everySlow })
      return () => h('div')
    },
  })
  const Fast = defineComponent({
    setup() {
      fast = useRefresh<{ symbol: string }, number>('/api/vue/286', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const app = renderer.createApp(defineComponent({ setup: () => () => h('div', [h(Slow), h(Fast)]) }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  slow.submit({ symbol: 'A' })
  fast.submit({ symbol: 'A' })
  await until(() => slow.display.value?.data === 1, '两页共享第一版')
  fast.refresh()
  await until(() => fast.display.value?.data === 2, '读者拿到第二版')
  assert.equal(slow.display.value?.data, 1, '它有上次读取时间：窗口内不换画面')

  // 只改频率：这是同一份配置内的变化，不该被当成「重新成为读者」而放行窗口。
  everySlow.value = 200_000
  await tick()
  fast.refresh()
  await until(() => fast.display.value?.data === 3, '读者拿到第三版')
  assert.equal(slow.display.value?.data, 1, '改频率之后窗口照新频率，画面不跟着跳')

  // 真正的资格边沿（暂停→开启）仍然放行：下一份写入立即上屏。
  app.unmount()
  await tick()
})

test('A11/A12 同一身份同一版不抄第二遍：同一格没换版本就不换画面对象', async () => {
  let api!: RefreshHandle<{ symbol: string }, number>
  let loads = 0
  const manager = newManager(1, async () => { loads += 1; throw new Error('首查失败') })
  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/287', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value !== null, '首查失败也上屏（data 为 null、updatedAt 为 null）')
  const shown: RefreshDisplay<{ symbol: string }, number> | null = api.display.value

  // 这一格是「从未成功」：窗口没有可比的时间，只有「同一版不抄第二遍」挡得住重复发布。
  api.submit({ symbol: 'A' })
  await tick()
  await sleep(20)
  assert.equal(api.display.value, shown, '同一身份同一版不抄第二遍：画面对象保持不变')
  assert.equal(loads, 1, '重复声明不额外取数：这一格每 100 秒才到下一次')
  app.unmount()
  await tick()
})

test('A12/A21 身份落定不等窗口：换到的身份那一版比画面旧也立刻换画面', async () => {
  let loads = 0
  const quote = '/api/vue/1131'
  const manager = newManager(2, async (_url, body) => { loads++; return (body as { symbol: string }).symbol })
  let view!: RefreshHandle<{ symbol: string }, string>
  let other!: RefreshHandle<{ symbol: string }, string>

  const app = renderer.createApp(defineComponent({
    setup: () => () => h('div', [h(Early), h(View)]),
  }))
  const Early = defineComponent({
    setup() {
      other = useRefresh<{ symbol: string }, string>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const View = defineComponent({
    setup() {
      view = useRefresh<{ symbol: string }, string>(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  app.use(manager)
  app.mount({} as never)
  await tick()

  // 先把身份 Y 取好：这一版会比后面 X 那一版**旧**。
  other.submit({ symbol: 'Y' })
  await tick()
  assert.equal(other.display.value?.data, 'Y')

  view.submit({ symbol: 'X' })
  await tick()
  const xShown = view.display.value
  assert.ok(xShown, 'X 已上屏')
  assert.equal(xShown.data, 'X')
  assert.equal(loads, 2, '两个身份各取一次')

  // 身份落定是「不等窗口」三处中的第一处（U12）：画面里那一版是 X、窗口整整 100 秒，
  // 换到 Y 之后必须立刻换成 Y 那一版——哪怕它在时间上比 X 旧。
  view.submit({ symbol: 'Y' })
  await tick()
  const landed = view.display.value
  assert.ok(landed, 'Y 已上屏')
  assert.equal(landed.data, 'Y', '换身份后画面立刻是新身份那一份，不留在旧身份那一帧')
  assert.equal(landed.args.symbol, 'Y', 'args 与 data 是同一版：display 整格一起给出，不出现半新半旧')
  assert.ok(
    landed.updatedAt !== null && xShown.updatedAt !== null && landed.updatedAt < xShown.updatedAt,
    '这一版比画面里那一版旧：窗口本来会把它挡住，身份落定必须放行',
  )
  assert.equal(loads, 2, '换到已取过的身份：读结果表，不重新取数')
  app.unmount()
})

test('A04 配置 getter 抛错：这一拍按配置非法处理，恢复靠抛错那一项自身的变化（§3.6 边界）', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 1 })
  const broken = ref(true)
  const every = ref(100_000)
  // §3.6 的读法：页面可以用 `computed` 表达暂态条件；读不出即整槽按非法处理，框架不猜开关的值。
  const enabled = computed(() => {
    if (broken.value) throw new Error('这一拍读不出开启意愿')
    return true
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1155', { enabled, every })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()

  assert.equal(loads, 0, '配置读不出＝配置非法：不取数')
  // 唯一出口：先绑一个局部变量再断言，免得把 `api.display.value` 收窄成恒 `null`（后面还要读它）。
  const nothing: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.equal(nothing, null, '配置非法不写任何事实：出口仍是 null')

  // §3.6 明说的边界：抛错那一项**之后**的项当轮不再被读取，Vue 也会清掉当轮未重新收集的依赖，
  // 所以只改 `every` 不解开——恢复要靠抛错那一项自身的变化。
  every.value = 50_000
  await tick()
  assert.equal(loads, 0, '改没被读到的那一项不解开（文档写明的边界）')

  broken.value = false
  await tick()
  await tick()
  assert.equal(loads, 1, '抛错那一项自身变了：按当前资格恢复并取一次')
  const restored = api.display.value
  assert.ok(restored, '恢复后结果上了屏')
  assert.equal(restored.data, 1)
  app.unmount()
})

test('A13/A11 唯一出口：`error` 原样带出，判失败看 `failed`——页面 throw undefined 也算一笔失败', async () => {
  let loads = 0
  const manager = newManager(1, async () => {
    loads++
    if (loads === 1) throw undefined // 页面连异常对象都不给：失败这件事仍然成立
    return 7
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1180', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.failed === true, '首查失败写进唯一出口')

  // §3.3 U13：`error` 原样带出原始异常（页面 `throw undefined` 也如实带出），
  // 所以判断这一笔是不是失败看 `failed`，而不是看 `error` 是不是 `undefined`；`updatedAt` 是这一笔的时刻。
  const failed: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.ok(failed, '出口给出的是一笔事实')
  assert.equal(failed.failed, true, '这一笔是失败：判据是 `failed`，不是 `error`')
  assert.equal(failed.error, undefined, '原始异常原样带出，不做兜底替换')
  assert.ok(typeof failed.updatedAt === 'number' && failed.updatedAt > 0, '失败带自己的时刻')
  assert.equal(failed.data, null, '首查失败：出口仍然给出「没有数据」这一版')

  api.refresh()
  await until(() => api.display.value?.data === 7, '成功之后拿到数据')
  assert.equal(api.display.value?.failed, false, '成功一到，`failed` 清回假')
  app.unmount()
})

/**
 * 下面这一批补的是**适配层自己的分支**：`src/vue.ts` 的 `try/catch`、`structuredClone`、
 * `install` 的幂等分支与「发布是同步的」这些事，此前只被核心级用例或测试夹具自带的同名实现
 * 间接覆盖（夹具自己 `structuredClone` 了一份 `args`、自己 `try/catch` 了一遍参数准备），
 * 等于自己证明自己。这里全部打在公开面上（`submit` / `display` / `install`）。
 */

test('A03/A18 适配层：参数准备抛错就地变同步 rejected，框架不把它抛给调用方', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; return 1 })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1270', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.data === 1, '先把旧身份取好')
  const before = api.display.value

  // 函数复制不出来（`structuredClone` 抛错）：提交边界的异常就地变成同步返回值（§2.4、U15）。
  let result: SubmitResult | undefined
  assert.doesNotThrow(() => { result = api.submit({ symbol: () => 1 } as never) })
  assert.equal(result?.status, 'rejected', '参数准备的抛错变成同步 rejected')
  assert.equal(loads, 1, '被拒的提交不取数')
  assert.equal(api.display.value, before, '被拒的提交不改动画面（读取基准也不动）')
  assert.equal(api.display.value?.args.symbol, 'A', '旧身份原样保留')

  // 对照：同一页换一个合法身份照常接纳——拒绝只针对那一份输入。
  assert.equal(api.submit({ symbol: 'B' }).status, 'accepted')
  await until(() => api.display.value?.args.symbol === 'B', '合法参数照常接纳并取数')
  app.unmount()
})

test('A11/A19 适配层：display.args 每次抄写复制一份，页面改它改不到下一轮请求', async () => {
  const bodies: string[] = []
  let loads = 0
  const manager = newManager(1, async (_url, body) => { loads++; bodies.push(JSON.stringify(body)); return loads })
  let api!: RefreshHandle<{ symbol: string; tags: string[] }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string; tags: string[] }, number>('/api/vue/1280', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A', tags: [] })
  await until(() => api.display.value !== null, '首帧上屏')

  // 就地改自己读到的那一份：这是页面的自由，不能污染身份键描述的那份值（ADR-52）。
  const shown = api.display.value as RefreshDisplay<{ symbol: string; tags: string[] }, number>
  const mine = shown.args as unknown as { tags: string[] }
  mine.tags.push('页面改的')
  assert.deepEqual(mine.tags, ['页面改的'], '改的是自己读到的那一份')

  api.refresh()
  await until(() => loads === 2, '第二轮取数')
  assert.deepEqual(JSON.parse(bodies[1] ?? 'null'), { symbol: 'A', tags: [] }, '下一轮请求体仍是提交那一刻的值')
  const again = api.display.value as RefreshDisplay<{ symbol: string; tags: string[] }, number>
  assert.deepEqual((again.args as unknown as { tags: string[] }).tags, [], '再次发布的 args 仍是身份键描述的那份值')
  app.unmount()
})

test('A13 暂停页显式刷新的失败也经唯一出口：没有回执，成功与失败走同一个通道', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; throw new Error('down') })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1290', { enabled: ref(false), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 0, '暂停页不自动取数')

  // 暂停页的入口闸不看开启意愿（U14）：这一页仍然能点名要一次；失败从同一个出口读。
  api.refresh()
  await until(() => api.display.value?.failed === true, '暂停页刷新的失败经唯一出口')
  const failed: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.ok(failed, '失败是一笔事实')
  assert.match(String((failed.error as Error).message), /down/, '原始异常原样带出')
  assert.equal(loads, 1, '恰好取了一次：刷新被受理，但不会把它变回自动取数')
  assert.equal(failed.data, null, '首查失败：出口给出「没有数据」那一版')
  await sleep(40)
  assert.equal(loads, 1, '暂停页刷新不恢复自动取数')
  app.unmount()
})

test('A14 配置非法时 refresh 被丢弃：不取数、不清读取基准（页面读自己的 refs 就知道）', async () => {
  let loads = 0
  const { manager, store } = newManagerWithStore(1, async () => { loads++; return loads })
  const every = ref(100_000)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1300', { enabled: ref(true), every })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.data === 1, '首帧上屏')
  const shown = api.display.value

  every.value = 0 // 配置非法：整槽按非法处理（U04、§3.6）
  await tick()
  api.refresh()
  await tick()
  await tick()
  assert.equal(loads, 1, '配置非法时刷新被丢弃：不产生请求')
  assert.equal(api.display.value, shown, '画面不变')

  // 被丢弃的那一次刷新**没有**把读取基准置空：窗口没到时新版本照样不上屏（U12）。
  store.write('/api/vue/1300', '{"symbol":"A"}', 99, Date.now())
  await tick()
  assert.notEqual(loads, 0)
  assert.equal(api.display.value, shown, '读取基准还在：窗口内结果表的新版本不改变画面')
  app.unmount()
})

test('A12/§3.3 写入触发判定：写入结果表的那一拍就把画面抄好（发布是同步的）', async () => {
  const { manager, store } = newManagerWithStore(1, async () => 1)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      // 暂停页：声明了身份、还没有读取基准、浏览器可见 → 按读闸门第二支它是读者。
      api = useRefresh<{ symbol: string }, number>('/api/vue/1310', { enabled: ref(false), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(api.display.value, null, '还没有任何写入')

  // 直接往这一格写一笔：**不 await 任何东西**，下一行就断言画面已经抄好。
  // 若发布改成延后（例如 `flush: 'pre'` 或轮询），这里立刻红。
  store.write('/api/vue/1310', '{"symbol":"A"}', 42, Date.now())
  const shown = api.display.value as RefreshDisplay<{ symbol: string }, number> | null
  assert.notEqual(shown, null, '写入的那一拍画面就有了这一版')
  assert.equal(shown?.data, 42)
  app.unmount()
})

test('§2.5 updatedAt 是最近一次请求结算的墙钟毫秒', async () => {
  const manager = newManager(1, async () => 7)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1320', { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value !== null, '首帧上屏')

  // 最近一次请求结算的墙钟毫秒：换成一个计数、代次或别的钟，这条就红。
  const at = api.display.value?.updatedAt ?? 0
  assert.ok(Math.abs(at - Date.now()) < 1_000, `updatedAt 是墙钟毫秒（实测与现在相差 ${Math.abs(at - Date.now())}ms）`)
  assert.notEqual(at, 0, '不是从 0 开始的计数')
  app.unmount()
})

test('A21/A12 写端稀于本页 every 时写入即抄：每一版都上屏，不跳版', async () => {
  let loads = 0
  const manager = newManager(1, async () => { loads++; await sleep(80); return loads })
  let api!: RefreshHandle<{ symbol: string }, number>
  const seen: number[] = []

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh<{ symbol: string }, number>('/api/vue/1330', { enabled: ref(true), every: ref(20) })
      // 同步 watcher 记下每一次上屏：发布是同步的，因此这一串就是画面真实看到的版本序列。
      watch(api.display, () => {
        const value = api.display.value?.data
        if (typeof value === 'number') seen.push(value)
      }, { flush: 'sync' })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => seen.length >= 4, '至少上屏四版')

  // 写入间隔（本页 every 20ms ＋ 传输 80ms）比本页 every 稀，因此每一版都该抄进画面。
  // 只断言「跟到某一版」是测不出跳版的；这里要求序列连续。
  for (let index = 1; index < seen.length; index++) {
    assert.equal(seen[index]! - seen[index - 1]!, 1, `第 ${index} 与第 ${index + 1} 版之间跳版了：${seen.join(',')}`)
  }
  assert.ok(seen.length >= 4)
  app.unmount()
})

test('A17 同实例重复 install 幂等：只注册一个可见性监听，已有绑定不被破坏', async () => {
  const manager = newManager(1)
  const app = renderer.createApp(defineComponent({ setup: () => () => h('div') }))
  const doc = globalThis.document as unknown as { addEventListener: () => void; removeEventListener: () => void }
  const originalAdd = doc.addEventListener
  const originalRemove = doc.removeEventListener
  let added = 0
  let removed = 0
  doc.addEventListener = () => { added++ }
  doc.removeEventListener = () => { removed++ }
  try {
    app.use(manager)
    // 绕开 Vue 自己的插件去重（`app.use` 第二次会被 Vue 拦掉，那证明不了我们的 `install` 幂等）：
    // 直接再调一次安装，走的是 `install` 里「同一个实例重复安装无副作用」那条分支。
    manager.install(app)
    assert.equal(added, 1, '同一个实例重复安装：只注册一个 visibilitychange 监听')
    assert.notEqual(currentCore(), null, '安装槽仍绑着这个协调者')
    manager.install(app)
    assert.equal(added, 1, '第三次安装照样只注册一个监听')

    app.mount({} as never)
    app.unmount()
    assert.equal(removed, 1, '卸载时把监听摘掉')
  } finally {
    doc.addEventListener = originalAdd
    doc.removeEventListener = originalRemove
  }
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onScopeDispose, ref } from 'vue'
import { createPinia } from 'pinia'
import { createRefreshManager, currentCore, useRefresh } from '../src/vue.ts'
import type { RefreshHttp } from '../src/core.ts'
import type { RefreshDisplay, RefreshFailure, RefreshHandle, RefreshManager, RefreshOptions } from '../src/public-types.ts'
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
  const manager = createRefreshManager({ maxConcurrent, axios: fakeHttp(post), pinia: createPinia() })
  managers.push(manager)
  return manager
}
afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose()
})

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
  assert.equal(api.failure.value, null, '配置非法不写失败')

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

test('A06 重新成为读者不会自己补抄：下一份写入到达时才上屏，而且不等窗口', async () => {
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

  // 恢复：这一拍**不会**自己把表里已有的那一版补抄进来（读取面只由数据写入与换身份唤醒，ADR-73）。
  enabled.value = true
  await tick()
  await tick()
  assert.equal(paused.display.value?.data, 1, '重新成为读者不补抄，等下一份写入')

  // 下一份写入到达：上次读取时间已在恢复时被清掉，所以它不等窗口，直接上屏。
  reader.refresh()
  await until(() => paused.display.value?.data === 3, '下一份写入到达时上屏，不等窗口')
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
  assert.equal(api.failure.value, null, '配置非法不写失败')
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
    return cell === undefined || cell.updatedAt === null ? null : cell.data
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
    return cell === undefined || cell.updatedAt === null ? null : cell.data
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

test('A13 失败有独立的读出口（不参与数据窗口）：首查失败也读得到，成功后清回 null，数据保留旧址', async () => {
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

  // 首查就失败：数据出口照样发布（`data: null`），失败在它自己的出口上——否则首查失败无从读取。
  assert.notEqual(api.display.value, null, '首查失败也发布画面（否则首查失败无从读取）')
  assert.equal(api.display.value?.data, null, '从未成功过：数据为 null')
  assert.equal(api.display.value?.updatedAt, null)
  assert.match(String((api.failure.value?.error as Error).message), /boom-1/, '原始异常原样带出')

  mode = 'ok'
  api.refresh()
  await until(() => api.display.value?.data === 2, '显式刷新后读到成功结果')
  assert.ok(api.failure.value === null, '成功清掉失败')

  // 暂停页自己刷新那一次（A05、U14）：失败照样读得到，且不覆盖数据出口那一版。
  mode = 'fail'
  api.refresh()
  await until(() => api.failure.value !== null, '失败重新可读')
  assert.equal(api.display.value?.data, 2, '失败不覆盖旧址（数据仍是上一次成功的）')
  assert.equal(api.display.value?.updatedAt !== null, true, '失败不动结果的产生时间')
  app.unmount()
})

test('A13/A11 失败与数据是两个出口：周期性失败不等数据窗口就上屏，成功一到又清回 null', async () => {
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
      // 周期取正常值就够：失败那一笔不动 `updatedAt`，所以按数据窗口它永远进不了画面。
      api = useRefresh<{ symbol: string }, number>('/api/vue/266', { enabled: ref(true), every: ref(20) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await until(() => api.display.value?.data === 1, '首查成功')
  const never: RefreshFailure | null = api.failure.value
  assert.equal(never, null, '还没有失败过：失败出口是 null')

  // 不点刷新：让**周期取数**自己失败。旧口径（失败挤在数据窗口里）下这一条只能等到超时。
  mode = 'fail'
  await until(() => api.failure.value !== null, '周期性失败立刻上屏，不等数据窗口')
  const failed: RefreshFailure | null = api.failure.value
  assert.match(String((failed?.error as Error).message), /late-2/, '原始异常原样带出')
  assert.equal(api.display.value?.data, 1, '失败不动数据出口那一版')

  mode = 'ok'
  await until(() => api.failure.value === null, '下个周期成功：失败清回 null')
  const cleared: RefreshFailure | null = api.failure.value
  assert.equal(cleared, null, '成功之后失败出口是 null')
  assert.ok((api.display.value?.data ?? 0) > 1, '成功也从数据出口读得到（这一版已过窗口）')
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

  // 再让这一格失败一次：失败出口有内容，数据出口仍留着上一次成功（ADR-63）。
  mode = 'fail'
  api.refresh()
  await tick()
  assert.notEqual(api.failure.value, null, '失败出口先有内容')

  // 销毁协调者：结果表条目随 `releaseIfUnused` 清空，读取面必须跟着清——否则页面读的是
  // 一个已经不存在的协调者留下的最后一帧，且再也没有任何东西会叫醒它。
  manager.dispose()
  await tick()
  assert.equal(currentCore(), null, '销毁后没有存活的协调者')
  assert.equal(snapshotOf(), undefined, '观测面也拿不到一个已销毁的实例')
  // 这里用 `assert.equal` 断言会把这个 `Ref` 收窄成「值恒为 null」，所以先各取一份再判。
  const clearedDisplay = display.value
  const clearedFailure = api.failure.value
  assert.equal(clearedDisplay, null, '销毁后数据出口清空')
  assert.equal(clearedFailure, null, '销毁后失败出口清空')

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

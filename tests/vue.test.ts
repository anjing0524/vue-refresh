import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onScopeDispose, ref } from 'vue'
import { createPinia } from 'pinia'
import { createRefreshManager, currentCore, useRefresh } from '../src/vue.ts'
import type { RefreshHttp } from '../src/core.ts'
import { defineRefresh } from '../src/source.ts'
import type { RefreshDisplay, RefreshHandle, RefreshManager, RefreshOptions } from '../src/public-types.ts'
import type { Ref } from 'vue'

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
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/47')
  const manager = newManager(2, async () => { loads++; return 42 })
  const enabled = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>
  let released = 0

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled, every: ref(100_000) })
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
  assert.equal(currentCore()?.snapshot().resources.length, 0, '卸载后实例与结果一并消失')
})

test('A04/A05 配置非法：不取数并停止订阅，修正后按当前资格恢复', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/84')
  const manager = newManager(1, async () => { loads++; return 1 })
  const every = ref(100_000)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every })
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
  assert.equal(api.display.value?.failedAt, null, '配置非法不写失败')

  every.value = 50_000
  await tick()
  // 修正后按**到期**恢复：声明与结果都还在（ADR-61），已有结果未到期，所以不重查。
  assert.equal(loads, 1, '修正后按到期恢复：已有结果未到期，不重查')
  assert.equal(api.display.value?.data, 1, '修正后画面读到那一份结果')
  app.unmount()
})

test('A05/A06 改 enabled.value 立即生效：暂停只退订、恢复重新接入', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/118')
  const manager = newManager(1, async () => { loads++; return 7 })
  const enabled = ref(true)
  const every = ref(100_000)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled, every })
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
  assert.equal(currentCore()?.snapshot().resources.length, 1, '暂停不释放实例：声明还在')

  enabled.value = true
  await tick()
  assert.equal(loads, 1, '重新开启直接读回已有结果，不重查（ADR-61）')
  assert.equal(api.display.value?.data, 7, '恢复后画面读到那一份结果')
  app.unmount()
})

test('A04/A06 KeepAlive 失活退订、激活恢复：两个方向都幂等', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/150')
  const manager = newManager(2, async () => { loads++; return loads })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const Inner = defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
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
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/907')
  const manager = newManager(1, () => { loads++; return new Promise<number>(resolve => { resolvers.push(resolve) }) })
  const shown = ref(true)
  let reader!: RefreshHandle<{ symbol: string }, number>
  let cached!: RefreshHandle<{ symbol: string }, number>

  const Reader = defineComponent({
    setup() {
      reader = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Cached = defineComponent({
    setup() {
      cached = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
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
  assert.equal(loads, 2, '重新激活只读回已有结果')
  assert.equal(cached.display.value?.data, 2)
  app.unmount()
})

test('A04 运行期读到非布尔时按配置非法处理：不订阅、不写失败、修正后恢复', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/187')
  const manager = newManager(1, async () => { loads++; return 1 })
  const enabled = ref<boolean>(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled, every: ref(100_000) })
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
  assert.equal(api.display.value?.failedAt, null, '配置非法不写失败')
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
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/203')
  const manager = newManager(2, async () => { loads++; return loads })
  let slow!: RefreshHandle<{ symbol: string }, number>
  let quick!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup: () => () => h('div', [h(Slow), h(Quick)]),
  }))
  // 两个页面声明同一个身份：这个身份按**最小的 every**取数（ADR-61），因此结果表一直在变。
  const Slow = defineComponent({
    setup() {
      slow = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Quick = defineComponent({
    setup() {
      quick = useRefresh(quote, { enabled: ref(true), every: ref(20) })
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
    const cell = currentCore()?.snapshot().results[0]?.cell
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

test('A21 写端稀于本页 every 时写入即抄：节流不丢数据，新格一到就上屏', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/204')
  // 传输带 80ms 延迟：写入流的间隔（every ＋ 延迟）比本页 every（20ms）稀。
  const manager = newManager(1, async () => {
    loads++
    await sleep(80)
    return loads
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every: ref(20) })
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

test('A13 失败写进结果表那一格：首查失败也读得到，成功后失败被清掉，数据保留旧址', async () => {
  let mode: 'ok' | 'fail' = 'fail'
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/265')
  const manager = newManager(1, async () => {
    loads++
    if (mode === 'fail') throw new Error(`boom-${loads}`)
    return loads
  })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()

  // 首查就失败：画面不能是 `null`，否则这个页面永远没有失败可读；`data` 为 `null` 表示从未成功过。
  assert.notEqual(api.display.value, null, '首查失败也发布画面（否则首查失败无从读取）')
  assert.equal(api.display.value?.data, null, '从未成功过：数据为 null')
  assert.equal(api.display.value?.updatedAt, null)
  assert.match(String((api.display.value?.error as Error).message), /boom-1/, '原始异常原样带出')

  mode = 'ok'
  api.refresh()
  await until(() => api.display.value?.data === 2, '显式刷新后读到成功结果')
  assert.equal(api.display.value?.failedAt, null, '成功清掉失败')

  mode = 'fail'
  api.refresh()
  await until(() => api.display.value?.failedAt !== null, '失败重新可读')
  assert.equal(api.display.value?.data, 2, '失败不覆盖旧址（数据仍是上一次成功的）')
  assert.equal(api.display.value?.updatedAt !== null, true, '失败不动结果的产生时间')
  app.unmount()
})

test('A17/A06 释放一页之后：submit 返回 cancelled、refresh 不产生事实（§2.4「取消只有一个来源」）', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/265')
  const manager = newManager(1, async () => { loads++; return 1 })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const Inner = defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
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
  assert.equal(currentCore()?.snapshot().resources.length, 0, '释放后实例与结果一并回收')
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

test('A17 未安装协调者时 useRefresh 直接抛错', () => {
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/238')
  const app = renderer.createApp(defineComponent({
    setup() {
      assert.throws(() => { useRefresh(quote, { enabled: ref(true), every: ref(1000) }) }, /需要先安装/)
      return () => h('div')
    },
  }))
  app.mount({} as never)
  app.unmount()
})

test('A05/A11 暂停页不点刷新就不上屏；自己点一次才上屏，之后重新冻结', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/903')
  const manager = newManager(1, async () => { loads++; return loads })
  let reader!: RefreshHandle<{ symbol: string }, number>
  let paused!: RefreshHandle<{ symbol: string }, number>
  const Reader = defineComponent({
    setup() {
      reader = useRefresh(quote, { enabled: ref(true), every: ref(100_000) })
      return () => h('div')
    },
  })
  const Paused = defineComponent({
    setup() {
      paused = useRefresh(quote, { enabled: ref(false), every: ref(100_000) })
      return () => h('div')
    },
  })

  const app = renderer.createApp(defineComponent({ setup() { return () => h('div', [h(Reader), h(Paused)]) } }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  reader.submit({ symbol: 'A' })
  paused.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1, '共享身份只取一次')
  assert.equal(reader.display.value?.data, 1)
  const frozen = paused.display.value
  assert.equal(frozen, null, '暂停页没点过刷新：结果到达也不上屏（画面冻结）')

  // 同一格再来一拍：暂停页仍然什么都不抄——读闸门只认「刚点过刷新、基线已置空」。
  reader.refresh()
  await tick()
  assert.equal(reader.display.value?.data, 2)
  const stillFrozen = paused.display.value
  assert.equal(stillFrozen, null, '暂停页不跟随新结果')

  // 暂停页自己点名要的那一拍照样放行（A05）。
  paused.refresh()
  await tick()
  assert.equal(paused.display.value?.data, 3, '显式刷新会把这一页带到最新一版')

  // 之后再来的新结果不再进这一页：冻结回到最后一帧。
  reader.refresh()
  await tick()
  assert.equal(reader.display.value?.data, 4)
  assert.equal(paused.display.value?.data, 3, '这一次它没点刷新，画面停在自己拿到的那一版')
  app.unmount()
})

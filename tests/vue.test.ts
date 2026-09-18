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

test('A04/A05 配置非法：不通知并停止订阅，修正后按当前资格恢复', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/84')
  const manager = newManager(1, async () => { loads++; return 1 })
  const every = ref(100_000)
  const errors: unknown[] = []
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: ref(true), every, onError: error => { errors.push(error) } })
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
  // 配置非法不通知：它是本页自己的输入事实，框架只负责不订阅、不请求（ADR-51）。
  assert.equal(errors.length, 0)

  every.value = 50_000
  await tick()
  assert.equal(loads, 2, '修正后按当前资格恢复')
  assert.equal(api.display.value?.data, 1)
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
  // 【同 A05：最后一个需求退出即删结果 ⇒ 画面读回 null；keep-last 之前这条会红】
  assert.equal(api.display.value?.data, 7, '暂停保留画面')
  assert.equal(currentCore()?.snapshot().resources.length, 0, '失去最后一个需求即清实例')

  enabled.value = true
  await tick()
  assert.equal(loads, 2, '重新开启恢复订阅并首查')
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
  assert.equal(loads, 2, '激活后首查')
  app.unmount()
})

test('A04 运行期读到非布尔时按配置非法处理：不订阅、不通知、修正后恢复', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>('/api/vue/187')
  const manager = newManager(1, async () => { loads++; return 1 })
  const enabled = ref<boolean>(true)
  const errors: unknown[] = []
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled, every: ref(100_000), onError: error => { errors.push(error) } })
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
  assert.equal(errors.length, 0, '配置非法不通知')
  api.submit({ symbol: 'B' })
  await tick()
  assert.equal(loads, 1, '配置非法时不订阅')

  enabled.value = true
  await tick()
  assert.equal(loads, 2, '修正后按当前资格恢复')
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

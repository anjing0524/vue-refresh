import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createRenderer, defineComponent, h, KeepAlive, nextTick, onScopeDispose, ref } from 'vue'
import { createRefreshManager, useRefresh } from '../src/vue.ts'
import { defineRefresh } from '../src/source.ts'
import type { RefreshDisplay, RefreshHandle, RefreshManager, RefreshManagerOptions, RefreshOptions } from '../src/public-types.ts'

/** 这几个用例验证浏览器路径：`install` 靠 `typeof document` 区分 SSR，因此先提供最小替身。 */
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

const managers: RefreshManager[] = []
function newManager(options: RefreshManagerOptions): RefreshManager {
  const manager = createRefreshManager(options)
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
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => { loads++; return 42 } })
  const manager = newManager({ maxConcurrent: 2 })
  const enabled = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>
  let released = 0

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled, every: 100_000 })
      onScopeDispose(() => { released++ })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()

  assert.equal(api.submit({ symbol: 'A' }).status, 'accepted')
  await tick()
  const display: RefreshDisplay<{ symbol: string }, number> | null = api.display.value
  assert.equal(display?.data, 42)
  assert.equal(display?.origin, 'background')
  assert.equal(loads, 1)

  enabled.value = false
  await tick()
  await tick()
  assert.equal(api.display.value?.data, 42, '暂停保留画面')
  assert.equal(loads, 1, '暂停后不再取数')

  app.unmount()
  await tick()
  assert.equal(released, 1)
  assert.equal(manager.readSnapshot(quote, { symbol: 'A' }), undefined, '卸载后实例与结果一并消失')
})

test('A04/A05 配置非法：只报告一次并停止订阅，修正后按当前资格恢复', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => { loads++; return 1 } })
  const manager = newManager({ maxConcurrent: 1 })
  const every = ref(100_000)
  const errors: Array<{ origin: string; operationId?: number }> = []
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: true, every, onError: error => { errors.push(error) } })
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
  assert.equal(errors.length, 1, '连续非法只报告一次')
  assert.equal(errors[0]?.origin, 'configuration')

  every.value = 50_000
  await tick()
  assert.equal(loads, 2, '修正后按当前资格恢复')
  assert.equal(api.display.value?.data, 1)
  app.unmount()
})

test('A05/A06 整个 options 也可以是 Ref：换掉对象按新配置重新协调', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => { loads++; return 7 } })
  const manager = newManager({ maxConcurrent: 1 })
  const options = ref<RefreshOptions>({ enabled: true, every: 100_000 })
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, options)
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 1)

  options.value = { enabled: false, every: 100_000 }
  await tick()
  assert.equal(api.display.value?.data, 7, '暂停保留画面')
  assert.equal(manager.readSnapshot(quote, { symbol: 'A' }), undefined, '失去最后一个需求即清实例')

  options.value = { enabled: true, every: 100_000 }
  await tick()
  assert.equal(loads, 2, '重新开启恢复订阅并首查')
  app.unmount()
})

test('A04/A06 KeepAlive 失活退订、激活恢复：两个方向都幂等', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => { loads++; return loads } })
  const manager = newManager({ maxConcurrent: 2 })
  const shown = ref(true)
  let api!: RefreshHandle<{ symbol: string }, number>

  const Inner = defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: true, every: 100_000 })
      return () => h('div')
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
  assert.equal(api.display.value?.data, 1, '失活保留画面')
  assert.equal(loads, 1, '失活后不再取数')

  shown.value = true
  await tick()
  assert.equal(loads, 2, '激活后首查')
  app.unmount()
})

test('A04 visible 为假时不订阅；改回真时接入', async () => {
  let loads = 0
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => { loads++; return 1 } })
  const manager = newManager({ maxConcurrent: 1 })
  const visible = ref(false)
  let api!: RefreshHandle<{ symbol: string }, number>

  const app = renderer.createApp(defineComponent({
    setup() {
      api = useRefresh(quote, { enabled: true, every: 100_000, visible })
      return () => h('div')
    },
  }))
  app.use(manager)
  app.mount({} as never)
  await tick()
  api.submit({ symbol: 'A' })
  await tick()
  assert.equal(loads, 0, '不满足可见条件就不订阅')

  visible.value = true
  await tick()
  assert.equal(loads, 1)
  app.unmount()
})

test('A17 安装：同一实例重复安装无副作用，另一个活跃实例被拒，销毁后可以原地接管', async () => {
  const manager = newManager({ maxConcurrent: 1 })
  const other = newManager({ maxConcurrent: 1 })
  const app = renderer.createApp(defineComponent({ setup: () => () => h('div') }))

  app.use(manager)
  app.use(manager)
  assert.throws(() => { app.use(other) }, /installation conflict/)

  manager.dispose()
  app.use(other) // 上一个实例已销毁：原地接管同一个注入槽位。
  app.mount({} as never)
  await tick()
  app.unmount()
})

test('A17 未安装协调者时 useRefresh 直接抛错', () => {
  const quote = defineRefresh<{ symbol: string }, number>({ load: async () => 1 })
  const app = renderer.createApp(defineComponent({
    setup() {
      assert.throws(() => { useRefresh(quote, { enabled: true, every: 1000 }) }, /installed/)
      return () => h('div')
    },
  }))
  app.mount({} as never)
  app.unmount()
})

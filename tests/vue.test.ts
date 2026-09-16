import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, createRenderer, customRef, defineComponent, h, inject, KeepAlive, nextTick, onMounted, ref, watch } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp } from 'vue'
import type { Ref } from 'vue'
import { createRefreshManager, managerKey } from '../src/app.ts'
import { useRefresh } from '../src/vue.ts'
import { defineRefresh } from '../src/source.ts'
import type { Manager } from '../src/manager.ts'
import type { RefreshHandle, RefreshError, RefreshInput, RefreshOptions, RefreshResult } from '../src/public-types.ts'
import { captureConsoleError, deferred } from './fixture.ts'

interface Host { parent: Host | null; children: Host[]; text: string }
const node = (text = ''): Host => ({ parent: null, children: [], text })
const renderer = createRenderer<Host, Host>({
  createElement: node, createText: node, createComment: node,
  setText(el, text) { el.text = text }, setElementText(el, text) { el.text = text },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp() {},
  insert(el, parent, anchor = null) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, el); el.parent = parent
  },
  remove(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null },
})
const tick = async () => { for (let i = 0; i < 12; i++) await nextTick() }
interface Params { symbol: string }
interface DTO { price: number }
function fixture(customOptions?: (enabled: Ref<boolean>, errors: RefreshError[]) => RefreshOptions) {
  const enabled = ref(true), visible = ref(true), every = ref(100_000), shown = ref(true), errors: RefreshError[] = []
  const calls: Array<ReturnType<typeof deferred<DTO>> & { signal: AbortSignal }> = []
  const source = defineRefresh<Params, DTO>({ load(_, { signal }) {
    const call = { ...deferred<DTO>(), signal }; calls.push(call); return call.promise
  } })
  let task!: RefreshHandle<Params, DTO>, core!: Manager
  const component = defineComponent({ setup() {
    core = inject(managerKey)!.manager
    // Custom renderer tests Vue lifecycle without pretending to be browser visibility tests.
    core.setBrowserVisible(true)
    task = useRefresh(source, customOptions?.(enabled, errors) ?? { enabled, visible, every, onError: e => { errors.push(e) } })
    return () => h('span', String(task.display.value?.data.price ?? ''))
  } })
  const app = renderer.createApp({ render: () => h(KeepAlive, null, { default: () => shown.value ? h(component) : null }) })
  const pinia = createPinia()
  const manager = createRefreshManager({ pinia, maxConcurrent: 1 })
  app.use(pinia); app.use(manager); app.mount(node())
  return { app, manager, pinia, source, get task() { return task }, get core() { return core },
    enabled, visible, every, shown, errors, calls }
}

test('L05/L07/L10/M01: actual KeepAlive deactivation, duplicate mount/activation, restoration and unmount', async () => {
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    assert.equal(f.calls.length, 1)
    assert.equal(f.core.inspect().handles[0]!.subscription?.owner, f.core.inspect().handles[0])
    f.calls[0]!.resolve({ price: 1 }); await tick()
    f.shown.value = false; await tick()
    assert.equal(f.core.inspect().resources.length, 0); assert.equal(f.task.display.value!.data.price, 1)
    f.shown.value = true; await tick(); assert.equal(f.calls.length, 2)
    f.enabled.value = false; await tick()
    assert.ok(f.calls[1]!.signal.aborted)
    f.shown.value = false; await tick(); f.shown.value = true; await tick()
    assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ price: 99 }); await tick()
    assert.equal(f.task.display.value!.data.price, 1)
  } finally { f.app.unmount() }
  assert.ok(f.core.isDisposed()); assert.deepEqual(Object.keys(f.pinia.state.value), [])
})

test('A07/B08/F09: 配置非法拒绝新刷新并按资格退出订阅；修正后恢复', async () => {
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    assert.equal(f.calls.length, 1)
    f.every.value = NaN; await tick()
    assert.equal(f.errors.length, 1)
    assert.equal(f.errors[0]!.origin, 'configuration')
    assert.ok(f.calls[0]!.signal.aborted)                  // 资格不再成立：退出订阅并取消在途
    assert.deepEqual(f.core.inspect().resources, [])
    f.calls[0]!.resolve({ price: 0 }); await tick()        // 真实结束才释放物理槽位
    // 入口拒绝：非法配置下不产生任何新请求。
    const rejected = await f.task.refresh()
    assert.equal(rejected.status, 'error')
    if (rejected.status === 'error') assert.equal(rejected.origin, 'configuration')
    assert.equal(f.calls.length, 1)
    assert.equal(f.core.inspect().handles[0]!.operationId, 1)
    // 修正后按当前资格恢复：重建实例并首查。
    f.every.value = 100_000; await tick()
    assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ price: 2 }); await tick()
    assert.equal(f.task.display.value!.data.price, 2)
    // 连续非法状态不忙循环，也不重复通知。
    f.every.value = 0; await tick()
    assert.equal(f.errors.length, 2)
    await tick(); assert.equal(f.calls.length, 2)
  } finally { f.app.unmount() }
})

test('A07/C1e: a configuration notification before any page operation carries no framework identity', async () => {
  let unreadable = false, trigger!: () => void
  const enabled = customRef<boolean>((track, notify) => {
    trigger = notify
    return { get() { track(); if (unreadable) throw new Error('unreadable'); return true },
      set() { notify() } }
  })
  const { logs, restore } = captureConsoleError()
  // onError 失败时框架才需要写诊断；框架身份只在诊断里出现，公开通知不再携带。
  const f = fixture((_, errors) => ({ enabled, every: 100_000, onError: e => { errors.push(e); throw new Error('onError failed') } }))
  try {
    assert.equal(f.core.inspect().handles[0]!.operationId, 0)
    assert.equal(f.errors.length, 0)
    unreadable = true; trigger(); await tick()
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0]!.origin, 'configuration')
    assert.deepEqual(Object.keys(f.errors[0]!).sort(), ['error', 'origin'])
    // 尚无操作：诊断身份的键缺席，而不是一个看起来像真操作号的 0。
    const event = logs[0]![1] as Record<string, unknown>
    assert.equal(event.origin, 'observer'); assert.equal('operationId' in event, false)
  } finally { restore(); f.app.unmount() }
})

for (const initiallyEnabled of [true, false]) test('F10/B05: enabled ' + initiallyEnabled + ' → unreadable → false', async () => {
  let unreadable = false, readValue = initiallyEnabled, trigger!: () => void
  const enabled = customRef<boolean>((track, notify) => {
    trigger = notify
    return { get() { track(); if (unreadable) throw new Error('unreadable'); return readValue },
      set(value) { readValue = value; notify() } }
  })
  const f = fixture((_, errors) => ({ enabled, every: 100_000, onError: e => { errors.push(e) } }))
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    // 先结算订阅首查（暂停页没有订阅时这里没有请求），把断言隔离到「刷新前没有在途任务」；
    // 重复 resolve 是 no-op，因此不必判断是否已结束。
    for (const call of f.calls) call.resolve({ price: 0 })
    await tick()
    const before = f.calls.length
    const refreshing = f.task.refresh()
    await tick()
    assert.equal(f.calls.length, before + 1)               // 刷新登记了一次请求
    unreadable = true; trigger()                           // 未知不猜 false：按无效快照报一次
    unreadable = false; readValue = false; trigger()        // false 边沿只按资格退订
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0]!.origin, 'configuration')
    const last = f.calls.at(-1)!
    assert.equal(last.signal.aborted, false)               // enabled 边沿不取消已发起的刷新
    assert.equal(f.core.inspect().resources.length, 1)      // 等待者保活实例
    last.resolve({ price: 1 }); await tick()
    assert.deepEqual(await refreshing, { status: 'success' })
    assert.equal(f.task.display.value!.data.price, 1)
  } finally { f.app.unmount() }
})

test('F05/A05: onError reentry cannot be overwritten by old failure', async () => {
  const f = fixture((enabled, errors) => ({ enabled: computed({
    get: () => enabled.value,
    set(value) { enabled.value = value },
  }), every: 100_000, onError: e => { errors.push(e); enabled.value = false } }))
  try {
    let redeclared = false
    const stop = watch(f.enabled, value => {
      if (!value && !redeclared) { redeclared = true; f.task.submit({ symbol: 'B' }) }
    }, { flush: 'sync' })
    f.task.submit({ symbol: 'A' }); await tick()
    f.calls[0]!.reject('failed'); await tick()
    assert.equal(f.errors.length, 1)                       // A 的失败已结算并通知一次
    assert.equal(f.task.display.value, null)
    f.enabled.value = true; await tick()
    assert.equal(f.calls.length, 2)                        // 重入时的声明保留并首查
    f.calls[1]!.resolve({ price: 2 }); await tick()
    assert.equal(f.task.display.value!.data.price, 2)
    assert.equal(f.errors.length, 1)
    stop()
  } finally { f.app.unmount() }
})

test('F04: real Pinia synchronous watcher during delivery', async () => {
  // 变体 01：Store 通知里改频率——本次结果仍然有效并交付，不因此重取。
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    const entries = () => f.core.inspect().entries
    const stop = watch(entries, () => { if (Object.keys(entries()).length) f.every.value += 1 }, { flush: 'sync' })
    f.calls[0]!.resolve({ price: 1 }); await tick()
    assert.equal(f.task.display.value!.data.price, 1)
    assert.equal(f.calls.length, 1)
    stop()
  } finally { f.app.unmount() }

  // 变体 02：Store 通知里退订——本页不再接收本次交付，其他接收者不受影响。
  const g = fixture()
  try {
    g.task.submit({ symbol: 'A' }); await tick()
    const entries = () => g.core.inspect().entries
    const stop = watch(entries, () => { if (Object.keys(entries()).length) g.enabled.value = false }, { flush: 'sync' })
    g.calls[0]!.resolve({ price: 1 }); await tick()
    assert.equal(g.task.display.value, null)
    stop()
  } finally { g.app.unmount() }
})

test('A05/S05/S07: install ownership, repeated dispose, shared Pinia business state retained', () => {
  const pinia = createPinia(), a = renderer.createApp({ render: () => null }), b = renderer.createApp({ render: () => null })
  const options = { pinia, maxConcurrent: 1 }
  const business = defineStore('business', { state: () => ({ value: 7 }) })(pinia)
  const first = createRefreshManager(options), second = createRefreshManager(options)
  first.install(a); first.install(a)
  assert.throws(() => first.install(b)); assert.throws(() => second.install(a))
  first.dispose(); first.dispose(); second.install(a)
  assert.throws(() => first.install(a)); assert.throws(() => first.install(b))
  first.dispose()
  const third = createRefreshManager(options)
  assert.throws(() => third.install(a))
  second.dispose(); third.dispose()
  assert.equal(business.value, 7)
  assert.deepEqual(Object.keys(pinia.state.value), ['business'])
  for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createRefreshManager({ ...options, maxConcurrent: value }))
  }
})

test('S05: two real SSR renders create no request, timer or shared state', async () => {
  let loads = 0
  const source = defineRefresh<Params, DTO>({ async load() { loads++; return { price: 1 } } })
  for (let i = 0; i < 2; i++) {
    const pinia = createPinia(), manager = createRefreshManager({ pinia, maxConcurrent: 1 })
    let core!: Manager
    const app = createSSRApp({ setup() {
      core = inject(managerKey)!.manager
      const task = useRefresh(source, { enabled: ref(true), every: 1 })
      task.submit({ symbol: 'A' }); onMounted(() => { throw new Error('SSR must not mount') })
      return () => h('span', 'server')
    } })
    app.use(pinia); app.use(manager)
    assert.equal(await renderToString(app), '<span>server</span>')
    await tick(); assert.equal(loads, 0); assert.equal(core.inspect().scheduled, false)
    manager.dispose(); assert.deepEqual(Object.keys(pinia.state.value), [])
  }
})

test('P01/B08: error callback dependencies never enter the configuration watcher', async () => {
  const unrelated = ref(0), frequency = ref(NaN)
  let reads = 0
  const f = fixture(enabled => ({ enabled, every: () => { reads++; return frequency.value }, onError() { void unrelated.value } }))
  try {
    await tick()
    const before = reads
    unrelated.value++
    await tick()
    assert.equal(reads, before)
    frequency.value = 100_000
    await tick()
    assert.ok(reads > before)
  } finally { f.app.unmount() }
})

test('API-06: onError is resolved per notification, so replacing it at runtime takes effect', async () => {
  const seen: string[] = []
  // 可变对象是这条断言的前提：句柄持有它，运行期替换其上的 onError 必须生效。
  const options = {
    enabled: ref(true) as RefreshInput<boolean>,
    every: 100_000 as RefreshInput<number>,
    onError: (() => { seen.push('first') }) as RefreshOptions['onError'],
  }
  const f = fixture(enabled => { options.enabled = enabled; return options })
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    f.calls[0]!.resolve({ price: 0 }); await tick()
    const first = f.task.refresh(); await tick()
    f.calls[1]!.reject(new Error('boom')); await tick()
    assert.equal((await first).status, 'error')
    assert.deepEqual(seen, ['first'])
    options.onError = () => { seen.push('second') }
    const second = f.task.refresh(); await tick()
    f.calls[2]!.reject(new Error('boom')); await tick()
    assert.equal((await second).status, 'error')
    assert.deepEqual(seen, ['first', 'second'])
  } finally { f.app.unmount() }
})

test('B10/L10/A05: initial error notification disposing manager also stops the newly created watcher', async () => {
  const pinia = createPinia(), manager = createRefreshManager({ pinia, maxConcurrent: 1 })
  const every = ref(NaN)
  let reads = 0
  const source = defineRefresh<Params, DTO>({ async load() { throw new Error('must not load') } })
  const app = renderer.createApp({ setup() {
    useRefresh(source, { enabled: ref(true), every: () => { reads++; return every.value }, onError() { manager.dispose() } })
    return () => null
  } })
  app.use(pinia); app.use(manager); app.mount(node())
  const before = reads
  every.value = 1000; await tick()
  assert.equal(reads, before)
  assert.deepEqual(Object.keys(pinia.state.value), [])
  app.unmount()
})

test('P01/C03/C13: resource validation runs once per submission, never on restore or lookup', async () => {
  let validations = 0
  const enabled = ref(true)
  const source = defineRefresh<Params, DTO>({
    validate(params) { validations++; return params.symbol.length > 0 },
    async load() { return { price: 7 } },
  })
  let task!: RefreshHandle<Params, DTO>
  const pinia = createPinia()
  const manager = createRefreshManager({ pinia, maxConcurrent: 1 })
  const app = renderer.createApp({ setup() {
    inject(managerKey)!.manager.setBrowserVisible(true)
    task = useRefresh(source, { enabled, every: 100_000 })
    return () => null
  } })
  app.use(pinia); app.use(manager); app.mount(node())
  try {
    task.submit({ symbol: 'A' }); await tick()
    assert.equal(validations, 1)
    assert.deepEqual(manager.readSnapshot(source, { symbol: 'A' }), { price: 7 })
    enabled.value = false; enabled.value = true; await tick()
    assert.equal(validations, 1)
    // 新身份只由声明引入；刷新复用已准备参数，不重跑 validate。
    task.submit({ symbol: 'B' }); await tick()
    assert.equal(validations, 2)
    const refreshed = await task.refresh()
    assert.equal(refreshed.status, 'success')
    assert.equal(validations, 2)
    assert.equal(task.submit({ symbol: '' }).status, 'rejected')
    assert.equal(validations, 3)
  } finally { app.unmount() }
})

test('P01/F04: core processing never resamples Vue configuration getters', async () => {
  let reads = 0
  const f = fixture(enabled => ({ enabled, every: () => { reads++; return 100_000 } }))
  try {
    const initialReads = reads
    f.task.submit({ symbol: 'A' }); await tick()
    f.calls[0]!.resolve({ price: 1 }); await tick()
    f.core.requestFlush(); await tick()
    f.manager.readSnapshot(f.source, { symbol: 'A' })
    assert.equal(reads, initialReads)
  } finally { f.app.unmount() }
})

/**
 * 逐 ID 证据补齐（§7 13.1 的未验证清单）：这四条叶子此前没有任何断言。
 */
test('C06: useRefresh outside a synchronous setup is rejected without creating a handle', async () => {
  const f = fixture()
  try {
    await tick()
    assert.equal(f.core.inspect().handles.length, 1)
    assert.throws(() => useRefresh(f.source, { enabled: true, every: 1000 }),
      /useRefresh must run synchronously in component setup/)
    // 被拒绝的调用没有留下没有生命周期清理的句柄。
    assert.equal(f.core.inspect().handles.length, 1)
  } finally { f.app.unmount() }
})

test('L06: deactivation during the first load reports no failure and restores with a first query', async () => {
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    assert.equal(f.calls.length, 1)
    f.shown.value = false; await tick()               // 首查中失活 → 取消在途请求
    assert.ok(f.calls[0]!.signal.aborted)
    f.calls[0]!.reject(new Error('aborted in flight')); await tick()
    assert.equal(f.errors.length, 0)                  // 不报首查失败
    assert.equal(f.task.display.value, null)
    f.shown.value = true; await tick()
    assert.equal(f.calls.length, 2)                   // 恢复可重新首查
    f.calls[1]!.resolve({ price: 5 }); await tick()
    assert.equal(f.task.display.value!.data.price, 5)
  } finally { f.app.unmount() }
})

test('L08: a hidden tab never queries first and unsubscribes at once when hidden', async () => {
  // 变体 01：运行中自定义页签隐藏 → 立即退订、不再请求，画面保留；恢复规则与首次一致。
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    f.calls[0]!.resolve({ price: 1 }); await tick()
    f.visible.value = false; await tick()
    assert.equal(f.core.inspect().resources.length, 0)
    assert.equal(f.task.display.value!.data.price, 1)
    assert.equal(f.calls.length, 1)
    f.visible.value = true; await tick()
    assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ price: 2 }); await tick()
    assert.equal(f.task.display.value!.data.price, 2)
  } finally { f.app.unmount() }

  // 变体 02：初始 visible=false 挂载 → 一个请求都不发，也不是先发后取消。
  const hidden = ref(false)
  const g = fixture(enabled => ({ enabled, visible: hidden, every: 100_000 }))
  try {
    g.task.submit({ symbol: 'A' }); await tick()
    assert.equal(g.calls.length, 0)
    hidden.value = true; await tick()
    assert.equal(g.calls.length, 1)
    g.calls[0]!.resolve({ price: 3 }); await tick()
    assert.equal(g.task.display.value!.data.price, 3)
  } finally { g.app.unmount() }

  // 变体 03：浏览器隐藏时挂载（安装路径上报不可见的等价形态）→ 不请求，可见后才首查。
  const loads: number[] = []
  const source = defineRefresh<Params, DTO>({ async load() { loads.push(1); return { price: 4 } } })
  const pinia = createPinia(), manager = createRefreshManager({ pinia, maxConcurrent: 1 })
  let core!: Manager, task!: RefreshHandle<Params, DTO>
  const app = renderer.createApp({ setup() {
    core = inject(managerKey)!.manager
    core.setBrowserVisible(false)
    task = useRefresh(source, { enabled: ref(true), every: 100_000 })
    task.submit({ symbol: 'A' })
    return () => null
  } })
  app.use(pinia); app.use(manager); app.mount(node())
  try {
    await tick()
    assert.equal(loads.length, 0)
    assert.equal(task.display.value, null)
    core.setBrowserVisible(true); await tick()
    assert.equal(loads.length, 1)
    assert.equal(task.display.value!.data.price, 4)
  } finally { app.unmount() }
})

test('S06: a late response from the previous session writes no store and delivers nowhere', async () => {
  const pinia = createPinia()
  const pending = deferred<DTO>()
  const source = defineRefresh<Params, DTO>({ load: () => pending.promise })
  const managerA = createRefreshManager({ pinia, maxConcurrent: 1 })
  let coreA!: Manager, taskA!: RefreshHandle<Params, DTO>
  const appA = renderer.createApp({ setup() {
    coreA = inject(managerKey)!.manager
    coreA.setBrowserVisible(true)
    taskA = useRefresh(source, { enabled: ref(true), every: 100_000 })
    taskA.submit({ symbol: 'A' })
    return () => null
  } })
  appA.use(pinia); appA.use(managerA); appA.mount(node())
  const managerB = createRefreshManager({ pinia, maxConcurrent: 1 })
  const appB = renderer.createApp({ render: () => null })
  try {
    await tick()
    assert.equal(coreA.inspect().running.length, 1)
    managerA.dispose()                                 // 会话切换：旧会话整体销毁
    appB.use(pinia); appB.use(managerB); appB.mount(node())
    pending.resolve({ price: 1 })                      // 旧会话的在途响应此刻才回来
    await tick()
    assert.equal(taskA.display.value, null)            // 不交付任何页面
    assert.deepEqual(coreA.inspect().entries, {})
    assert.equal(managerB.readSnapshot(source, { symbol: 'A' }), undefined)
    const partitions = Object.keys(pinia.state.value).filter(key => key.startsWith('refresh-'))
    assert.equal(partitions.length, 1)                 // 只剩新会话的私有分区
  } finally { appB.unmount(); appA.unmount(); managerB.dispose(); managerA.dispose() }
})

test('T14: every 的完整数值域——只接受正安全整数，非法值明确拒绝且不忙循环', async () => {
  // 非法值：全部按配置非法拒绝，既不请求也不建立订阅。
  const every = ref<unknown>(NaN)
  const rejected = fixture((enabled, errors) => ({ enabled, every: every as never, onError: e => { errors.push(e) } }))
  try {
    await tick()
    assert.equal(rejected.errors.length, 1)                 // 初始非法值已报告一次
    for (const value of [NaN, 0, -1, 0.5, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1, '500', null, undefined, true, 5n]) {
      every.value = value
      await tick()
      // 连续非法状态只报一次（A07.05 的去重），但每个取值都必须被拒绝。
      assert.equal(rejected.errors.length, 1, `every=${String(value)} 必须被拒绝且不重复通知`)
      assert.equal(rejected.errors[0]!.origin, 'configuration')
      assert.equal(rejected.calls.length, 0)
      assert.deepEqual(rejected.core.inspect().resources, [])
    }
  } finally { rejected.app.unmount() }

  // 合法值：1、500 与安全整数上界都被接受。
  const accepted = ref<unknown>(1)
  const ok = fixture((enabled, errors) => ({ enabled, every: accepted as never, onError: e => { errors.push(e) } }))
  try {
    ok.task.submit({ symbol: 'A' })
    for (const value of [1, 500, Number.MAX_SAFE_INTEGER]) {
      accepted.value = value
      await tick()
      assert.equal(ok.errors.length, 0, `every=${value} 必须被接受`)
    }
    assert.ok(ok.calls.length >= 1)
  } finally { ok.app.unmount() }

  // getter 形态解包后使用同一判定。
  const viaGetter = ref<unknown>(0)
  const getter = fixture((enabled, errors) => ({ enabled, every: (() => viaGetter.value) as never, onError: e => { errors.push(e) } }))
  try {
    getter.task.submit({ symbol: 'A' })
    await tick()
    assert.equal(getter.errors.length, 1)
    viaGetter.value = 200
    await tick()
    assert.equal(getter.errors.length, 1)
    assert.equal(getter.core.inspect().resources.length, 1)
  } finally { getter.app.unmount() }
})

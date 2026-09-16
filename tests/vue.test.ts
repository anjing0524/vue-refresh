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
import type { RefreshHandle, RefreshError, RefreshInput, RefreshOptions, QueryResult } from '../src/public-types.ts'
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
    assert.equal(f.core.inspect().handles[0]!.activity?.kind, 'subscription')
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

test('A07/B08/F09: invalid configuration rejects new query, preserves current query and recovers', async () => {
  const f = fixture(), result = deferred<DTO>()
  try {
    const first = f.task.query({ symbol: 'B' }, () => result.promise)
    const operation = f.core.inspect().handles[0]!.operationId
    f.every.value = NaN
    assert.equal(f.errors.length, 1)
    let ran = false
    const rejected = await f.task.query({ symbol: 'C' }, async () => { ran = true; return { price: 3 } })
    assert.equal(rejected.status, 'error'); assert.equal(ran, false)
    assert.equal(f.core.inspect().handles[0]!.operationId, operation)
    assert.equal(f.errors.length, 1); assert.equal(f.enabled.value, true)
    result.resolve({ price: 2 }); assert.deepEqual(await first, { status: 'success' })
    await tick(); assert.equal(f.calls.length, 0)
    f.every.value = 100_000; await tick()
    assert.equal(f.calls.length, 1)
    f.every.value = 0; await tick(); assert.equal(f.errors.length, 2)
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
    const result = deferred<DTO>(), query = f.task.query({ symbol: 'A' }, () => result.promise)
    unreadable = true; trigger()
    unreadable = false; readValue = false; trigger()
    result.resolve({ price: 1 })
    assert.deepEqual(await query, initiallyEnabled ? { status: 'cancelled', reason: 'unavailable' } : { status: 'success' })
    await tick(); assert.equal(f.calls.length, 0)
  } finally { f.app.unmount() }
})

test('F05/A05: onError reentry cannot be overwritten by old failure', async () => {
  const f = fixture((enabled, errors) => ({ enabled: computed({
    get: () => enabled.value,
    set(value) { enabled.value = value },
  }), every: 100_000, onError: e => { errors.push(e); enabled.value = false } }))
  try {
    const a = deferred<DTO>(), b = deferred<DTO>()
    let second!: Promise<QueryResult>
    const stop = watch(f.enabled, value => { if (!value) second = f.task.query({ symbol: 'B' }, () => b.promise) }, { flush: 'sync' })
    const first = f.task.query({ symbol: 'A' }, () => a.promise)
    a.reject('failed')
    assert.equal((await first).status, 'error'); await tick()
    b.resolve({ price: 2 }); assert.deepEqual(await second, { status: 'success' })
    assert.equal(f.task.display.value!.data.price, 2); assert.equal(f.errors.length, 1)
    stop()
  } finally { f.app.unmount() }
})

test('F04: real Pinia synchronous watcher replaces current task before page delivery', async () => {
  const f = fixture()
  try {
    f.task.submit({ symbol: 'A' }); await tick()
    const entries = () => f.core.inspect().entries
    const stop = watch(entries, () => { if (Object.keys(entries()).length) f.every.value += 1 }, { flush: 'sync' })
    f.calls[0]!.resolve({ price: 1 }); await tick()
    assert.equal(f.task.display.value, null); assert.equal(f.calls.length, 2)
    stop(); f.calls[1]!.resolve({ price: 2 }); await tick()
    assert.equal(f.task.display.value!.data.price, 2)
  } finally { f.app.unmount() }
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
    const first = f.task.query({ symbol: 'B' }, async () => { throw new Error('boom') })
    assert.equal((await first).status, 'error')
    assert.deepEqual(seen, ['first'])
    options.onError = () => { seen.push('second') }
    const second = f.task.query({ symbol: 'C' }, async () => { throw new Error('boom') })
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
    assert.equal((await task.query({ symbol: 'B' }, async () => ({ price: 8 }))).status, 'success')
    await tick(); assert.equal(validations, 2)
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

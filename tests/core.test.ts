import test from 'node:test'
import assert from 'node:assert/strict'
import { defineRefresh, parameterKey, prepareParameters, sourceRuntime } from '../src/source.ts'
import { copyResult } from '../src/delivery.ts'
import { Manager } from '../src/manager.ts'
import type { Clock, Display, Handle, Input, ResultStore, StoreEntry } from '../src/model.ts'
import type { RefreshError, RefreshResult } from '../src/public-types.ts'
import { captureConsoleError, deferred } from './fixture.ts'
import { runInNewContext } from 'node:vm'

// 墙钟起点：与虚拟单调时钟分离，据此判断交付的是「结果产生时间」还是「交付时刻」。
const epoch = 1_700_000_000_000
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture(maxConcurrent = 2, onStart?: () => void) {
  let now = 0
  const timers = new Map<object, { at: number; callback: () => void }>()
  const clock: Clock = { now: () => now, timestamp: () => epoch + now,
    setTimer(callback, ms) {
      const cancel = () => { timers.delete(cancel) }
      timers.set(cancel, { at: now + ms, callback })
      return cancel
    } }
  const entries: Record<string, StoreEntry> = {}
  const store: ResultStore = { entries, put(id, value) { entries[id] = value }, remove(id) { delete entries[id] },
    dispose() { for (const id of Object.keys(entries)) delete entries[id] } }
  const manager = new Manager(store, clock, maxConcurrent, 'test')
  const calls: Array<ReturnType<typeof deferred> & { args: object; signal: AbortSignal }> = []
  const source = sourceRuntime(defineRefresh<object, unknown>({ load(args, { signal }) {
    const call = { ...deferred(), args, signal }; calls.push(call); onStart?.(); return call.promise
  } }))
  let validate = (_: object) => true
  function page(input: Input = { valid: true, enabled: true, visible: true, every: 100 }) {
    let current = input, display: Display | null = null
    const errors: RefreshError[] = []
    const handle: Handle = { source, readInput: () => current,
      publish(value) { display = value }, onError(error) { errors.push(error) },
      cleanup: null, operationId: 0, submission: null, subscription: null, refreshes: new Set(),
      lifecycleActive: true, disposed: false }
    function set(next: Input) {
      const old = current; current = next
      // 与适配层同一条规则：关闭边沿只调用核心的命名操作，不自己判断归属与取消原因。
      if (old.enabled === true && next.enabled === false) manager.cancelRefresh(handle)
      manager.reconcile(handle)
    }
    manager.addHandle(handle)
    return { handle, errors, get display() { return display }, get input() { return current },
      set, submit: (args: unknown) => manager.submit(handle, () => prepareParameters(args as object, validate)),
      refresh: () => manager.refresh(handle) }
  }
  async function advance(ms: number) {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback() }
    await tick()
  }
  const readSnapshot = (args: unknown) => manager.isDisposed() ? undefined : manager.readSnapshot(source, parameterKey(args as object))
  return { manager, calls, source, page, entries, store, timers, advance, readSnapshot, setValidate(fn: (args: object) => boolean) { validate = fn } }
}
const active = { valid: true, enabled: true, visible: true, every: 100 } as const

test('C01/C02/P02: full-value object keys, sorted nested fields, arrays and scalar distinctions', () => {
  const key = (x: object) => prepareParameters(x).key
  assert.equal(key({ b: { z: 0, a: '' }, a: [2, 1] }), key({ a: [2, 1], b: { a: '', z: 0 } }))
  assert.notEqual(key({ a: [1, 2] }), key({ a: [2, 1] }))
  assert.notEqual(key({ a: 1 }), key({ a: '1' }))
  assert.notEqual(key({}), key({ a: null }))
  assert.equal(key({ '2': 2, '10': 10 }), '{"10":10,"2":2}')
  const dictionary = Object.assign(Object.create(null), { a: 1 })
  assert.equal(key(dictionary), key({ a: 1 }))
  const dangerous = JSON.parse('{"__proto__":{"x":1},"constructor":"中\\n"}')
  assert.equal(JSON.parse(key(dangerous)).constructor, '中\n')
  const original = { nested: { x: 1 } }, result = prepareParameters(original)
  original.nested.x = 2
  assert.equal((result.args as typeof original).nested.x, 1)
  assert.ok(Object.isFrozen(result.args) && Object.isFrozen((result.args as typeof original).nested))
  assert.ok(!Object.isFrozen(original.nested))
})

test('C03/C13/P10: no business size limit, cycle guard, shared graph by value, validate rejection', () => {
  // 参数规模由应用自己决定：1000 个客户的参数不再被拒（没有字节上限）。
  const many = { customers: Array.from({ length: 1_000 }, (_, index) => ({ id: `customer-${index}`, name: '客户' + index })) }
  assert.doesNotThrow(() => prepareParameters(many))
  // 深度守卫是内部安全边界（source.ts 的 MAX_PARAMETER_DEPTH = 1000），不是业务上限。
  let deep: object = {}
  for (let level = 1; level < 1_000; level++) deep = { child: deep }
  assert.doesNotThrow(() => prepareParameters(deep))
  assert.throws(() => prepareParameters({ child: deep }))
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  assert.throws(() => prepareParameters(cycle))
  const shared = { n: {} }
  assert.equal(prepareParameters({ a: shared, b: shared }).key, prepareParameters({ a: { n: {} }, b: { n: {} } }).key)
  assert.throws(() => prepareParameters({}, () => false))
  assert.throws(() => prepareParameters({}, (() => Promise.reject('ignored')) as never))
  assert.throws(() => prepareParameters({ a: {} }, args => { (args as { a: { x: number } }).a.x = 1; return true }))
})

// C11 revised: transport owns business validation; the runtime owns cloning.
const badData: Array<[string, () => unknown]> = [
  ['undefined', () => undefined], ['function', () => () => {}],
  ['symbol', () => Symbol()], ['proxy', () => new Proxy({}, {})],
]
test('C11: native clone preserves supported values and independent ownership', () => {
  const raw = { date: new Date(0), map: new Map([['x', 1]]), value: -0 }
  const copy = copyResult(raw) as typeof raw
  assert.notEqual(copy, raw)
  assert.notEqual(copy.map, raw.map)
  assert.equal(copy.date.getTime(), 0)
  assert.ok(Object.is(copy.value, -0))
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  const cloned = copyResult(cycle) as typeof cycle
  assert.equal(cloned.self, cloned)
  assert.throws(() => copyResult(undefined))
})
test('C14: JSON key domain rejects ambiguous values; hostile-object inspection is out of scope', () => {
  for (const value of [undefined, NaN, Infinity, -0, 1n, () => {}]) {
    assert.throws(() => prepareParameters({ value }))
  }
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  assert.throws(() => prepareParameters(cycle))
})

test('P03/L01/L02/L03/L09/P07/R05/A03: share, history, copies, updatedAt, cancel and resource rebirth', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    assert.equal(f.calls.length, 1)
    const raw = { nested: { x: 1 } }; f.calls[0]!.resolve(raw); await tick()
    raw.nested.x = 9
    assert.deepEqual(a.display!.data, { nested: { x: 1 } })
    assert.notEqual(a.display!.data, b.display!.data)
    const snapshot = f.readSnapshot({ x: 1 }) as typeof raw
    snapshot.nested.x = 8; assert.deepEqual(b.display!.data, { nested: { x: 1 } })
    a.set({ ...active, enabled: false })
    await f.advance(100)
    assert.equal(f.calls.length, 2)
    b.set({ ...active, enabled: false })
    assert.ok(f.calls[1]!.signal.aborted)
    assert.equal(Object.keys(f.entries).length, 0)
    a.set(active); await tick()
    assert.equal(f.calls.length, 3)
    f.calls[2]!.resolve({ nested: { x: 3 } }); await tick()
    f.calls[1]!.resolve({ nested: { x: 2 } }); await tick()
    assert.deepEqual(a.display!.data, { nested: { x: 3 } })
    assert.equal(a.display!.updatedAt, epoch + 100) // 结果产生时间，不是交付时刻。
    await f.advance(50) // 晚加入发生在结果产生之后：交付时间不应被改写成当前时刻。
    b.set(active); await tick()
    assert.deepEqual(b.display!.data, { nested: { x: 3 } })
    assert.equal(b.display!.updatedAt, a.display!.updatedAt)
    assert.equal(f.calls.length, 3)
  } finally { f.manager.dispose() }
})

test('U03/M05/A01/B01: 同一身份重复声明幂等；只有新身份才换订阅与实例', async () => {
  const f = fixture(), a = f.page()
  try {
    assert.deepEqual(a.submit({ x: 1 }), { status: 'accepted' })
    await tick()
    assert.equal(f.calls.length, 1)
    const subscription = a.handle.subscription
    assert.ok(subscription)
    // 同参再声明：不产生新请求，也不重建订阅（旧契约的「首次/后续提交差异」已删除）。
    assert.deepEqual(a.submit({ x: 1 }), { status: 'accepted' })
    await tick()
    assert.equal(f.calls.length, 1)
    assert.equal(a.handle.subscription, subscription)
    assert.equal(f.manager.inspect().resources.length, 1)
    // 新身份：换实例、首查。
    assert.deepEqual(a.submit({ x: 2 }), { status: 'accepted' })
    await tick()
    assert.notEqual(a.handle.subscription, subscription)
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1]!.args, { x: 2 })
    // 暂停后同参再声明同样是幂等的：不因为「没有实例」而变成强制刷新。
    a.set({ ...active, enabled: false }); await tick()
    assert.equal(f.manager.inspect().resources.length, 0)
    assert.deepEqual(a.submit({ x: 2 }), { status: 'accepted' })
    await tick()
    assert.equal(f.calls.length, 2)
    assert.equal(f.manager.inspect().resources.length, 0)   // 暂停：声明不建立实例
  } finally { f.manager.dispose() }
})

test('Q01/Q04/B05/Q13: 暂停页刷新走共享路径，交付本页与有效订阅，不惊动其他暂停页', async () => {
  const f = fixture()
  const writer = f.page({ ...active, enabled: false }), reader = f.page(), idle = f.page({ ...active, enabled: false })
  try {
    writer.submit({ x: 1 }); reader.submit({ x: 1 }); idle.submit({ x: 1 })
    await tick()
    assert.equal(f.calls.length, 1)                        // 只有有效订阅产生自动请求
    f.calls[0]!.resolve({ v: 'auto' }); await tick()
    assert.deepEqual(reader.display!.data, { v: 'auto' })
    assert.equal(writer.display, null); assert.equal(idle.display, null)
    assert.equal(Object.keys(f.entries).length, 1)         // 刷新前的共享结果已进分区

    const refreshing = writer.refresh()                    // 暂停页主动刷新：同一条获取路径
    await tick()                                           // 共享路径：请求由下一轮 flush 启动
    assert.equal(f.calls.length, 2)                        // 共用共享队列，不绕过后台槽位
    assert.deepEqual(f.manager.inspect().running.length, 1)
    f.calls[1]!.resolve({ v: 'fresh' }); await tick()
    assert.deepEqual(await refreshing, { status: 'success' })
    assert.deepEqual(writer.display!.data, { v: 'fresh' })
    assert.equal(writer.display!.origin, 'refresh')
    assert.deepEqual(reader.display!.data, { v: 'fresh' }) // 其他有效订阅也收到共享结果
    assert.equal(reader.display!.origin, 'background')
    assert.equal(idle.display, null)                       // 其他暂停页不接收
    assert.equal(writer.input.enabled, false)              // 刷新不恢复轮询
    assert.deepEqual(f.manager.inspect().entries['test:1']!.data, { v: 'fresh' })
    await f.advance(300)
    assert.equal(f.calls.length, 3)                        // 有效订阅照常按最短间隔刷新
    f.calls[2]!.resolve({ v: 'later' }); await tick()
    assert.deepEqual(reader.display!.data, { v: 'later' })
    assert.deepEqual(writer.display!.data, { v: 'fresh' }) // 暂停页只保留自己那次刷新的结果
    assert.equal(writer.input.enabled, false)              // 刷新没有被当成恢复轮询
  } finally { f.manager.dispose() }
})

test('Q06/M05/F15/T12: 在途任务不能满足刷新；它结束后补一次，动作前的多次刷新合并', async () => {
  const f = fixture(2), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    assert.equal(f.calls.length, 1)                        // 自动首查已在执行
    const first = a.refresh(), second = a.refresh()
    await tick()
    assert.equal(f.calls.length, 1)                        // 不 abort 在途请求，也不重复登记
    assert.equal(f.calls[0]!.signal.aborted, false)
    assert.equal(f.manager.inspect().queued.length, 0)
    f.calls[0]!.resolve({ v: 'in-flight' }); await tick()
    // 在途结果不算「动作之后启动」：超预算产生一次后继请求，两个刷新合并到它。
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[1]!.args, { x: 1 })
    f.calls[1]!.resolve({ v: 'follow-up' }); await tick()
    assert.deepEqual(await first, { status: 'success' })
    assert.deepEqual(await second, { status: 'success' })
    assert.deepEqual(a.display!.data, { v: 'follow-up' })
    assert.equal(a.handle.refreshes.size, 0)
  } finally { f.manager.dispose() }
})

test('Q13/M05: 排队未启动的任务已经算「动作之后启动」，刷新不再追加请求', async () => {
  const f = fixture(1), holder = f.page(), a = f.page()
  try {
    holder.submit({ hold: true }); await tick()            // 占满唯一槽位
    assert.equal(f.calls.length, 1)
    a.submit({ x: 1 }); await tick()                       // a 的任务排队
    assert.equal(f.manager.inspect().queued.length, 1)
    const refreshing = a.refresh()
    await tick()
    assert.equal(f.calls.length, 1)                        // 不追加请求
    assert.equal(f.manager.inspect().queued.length, 1)
    f.calls[0]!.resolve(null); await tick()                // 槽位真实释放，排队任务启动
    assert.deepEqual(f.calls[1]!.args, { x: 1 })
    f.calls[1]!.resolve({ v: 'queued' }); await tick()
    assert.deepEqual(await refreshing, { status: 'success' })
    assert.deepEqual(a.display!.data, { v: 'queued' })
  } finally { f.manager.dispose() }
})

test('Q03/A02/D03/B02/F02: 刷新失败结算本次等待、保留旧画面，订阅下周期继续', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ v: 'old' }); await tick()
    const refreshing = a.refresh(); await tick()
    assert.equal(f.calls.length, 2)
    f.calls[1]!.reject(new Error('boom')); await tick()
    const result = await refreshing
    assert.equal(result.status, 'error')
    if (result.status === 'error') {
      assert.equal(result.origin, 'background')
      assert.equal((result.error as Error).message, 'boom')
    }
    assert.deepEqual(a.display!.data, { v: 'old' })        // 旧画面保留
    assert.equal(a.errors.length, 1); assert.equal(a.errors[0]!.origin, 'background')
    await f.advance(100); assert.equal(f.calls.length, 3)  // 订阅仍在：下周期继续
  } finally { f.manager.dispose() }
})

test('A07/B06/P08/A01: 刷新入口闸——未声明身份、配置非法、失活、暂停、销毁', async () => {
  const f = fixture(), a = f.page()
  try {
    assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'unavailable' })
    a.set({ valid: false, enabled: true, visible: true, error: 'every' })
    assert.deepEqual(await a.refresh(), { status: 'error', origin: 'configuration', error: 'every' })
    assert.equal(f.calls.length, 0); assert.equal(f.manager.inspect().resources.length, 0)
    // 配置非法仍可声明身份（A01.05），修正后按当前资格恢复。
    assert.deepEqual(a.submit({ x: 1 }), { status: 'accepted' })
    assert.deepEqual(a.handle.submission!.parameters.args, { x: 1 })
    await tick(); assert.equal(f.calls.length, 0)
    a.set(active); await tick(); assert.equal(f.calls.length, 1)
    f.calls[0]!.resolve({ v: 'ok' }); await tick()
    // 失活：刷新不可用，声明保留；实例随最后一个订阅退出而销毁。
    f.manager.deactivate(a.handle)
    assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'unavailable' })
    assert.ok(a.handle.submission)
    assert.deepEqual(f.manager.inspect().resources, [])
    f.manager.activate(a.handle); await tick()
    assert.equal(f.calls.length, 2)                        // 恢复：重建实例并首查
    f.calls[1]!.resolve({ v: 'again' }); await tick()
    assert.deepEqual(a.display!.data, { v: 'again' })
    // 暂停不参与刷新入口闸。
    a.set({ ...active, enabled: false }); await tick()
    const paused = a.refresh(); await tick()
    assert.equal(f.calls.length, 3)
    f.calls[2]!.resolve({ v: 'paused' }); await tick()
    assert.deepEqual(await paused, { status: 'success' })
    assert.deepEqual(a.display!.data, { v: 'paused' })
    f.manager.dispose()
    assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'disposed' })
  } finally { f.manager.dispose() }
})

test('Q07/D01/D02/D04/F09/L10: 刷新要求随隐藏、暂停边沿与卸载作废；恢复不重放刷新', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ v: 'base' }); await tick()
    const hidden = a.refresh(); await tick()
    assert.equal(f.calls.length, 2)
    f.manager.setBrowserVisible(false)
    assert.deepEqual(await hidden, { status: 'cancelled', reason: 'unavailable' })
    assert.ok(f.calls[1]!.signal.aborted)
    assert.deepEqual(f.manager.inspect().resources, [])
    f.calls[1]!.resolve(null); await tick()                // abort 不释放槽位：真实结束才释放
    // 恢复按订阅规则：实例已删除则重建首查，不重放刷新动作。
    f.manager.setBrowserVisible(true); await tick()
    assert.equal(f.calls.length, 3)
    f.calls[2]!.resolve({ v: 'recovered' }); await tick()
    assert.deepEqual(a.display!.data, { v: 'recovered' })
    // 暂停边沿（true→false）结算未完成的刷新要求。
    const paused = a.refresh(); await tick()
    assert.equal(f.calls.length, 4)
    a.set({ ...active, enabled: false })
    assert.deepEqual(await paused, { status: 'cancelled', reason: 'unavailable' })
    assert.ok(f.calls[3]!.signal.aborted)
    f.calls[3]!.resolve(null); await tick()
    // 暂停之后再刷新仍允许（false→false 不构成关闭边沿）。
    const once = a.refresh(); await tick()
    assert.equal(f.calls.length, 5)
    f.calls[4]!.resolve({ v: 'once' }); await tick()
    assert.deepEqual(await once, { status: 'success' })
    assert.deepEqual(a.display!.data, { v: 'once' })
    assert.deepEqual(f.manager.inspect().resources, [])    // 结算后无人订阅与要求 → 清理
    // 卸载：句柄释放后不再接纳刷新。
    f.manager.removeHandle(a.handle)
    assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'disposed' })
  } finally { f.manager.dispose() }
})

test('M02/U05: 刷新要求与订阅可同时存在，同一句柄只交付一次', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ v: 'base' }); await tick()
    let publishes = 0
    const publish = a.handle.publish
    Object.assign(a.handle, { publish(value: Display) { publishes += 1; publish(value) } })
    const refreshing = a.refresh(); await tick()
    assert.equal(a.handle.refreshes.size, 1)
    assert.ok(a.handle.subscription)                       // 两者可以同时存在
    f.calls[1]!.resolve({ v: 'fresh' }); await tick()
    assert.deepEqual(await refreshing, { status: 'success' })
    assert.equal(publishes, 1)                             // 订阅与刷新要求指向同一句柄：只发布一次
    assert.equal(a.handle.refreshes.size, 0)
    assert.equal(a.handle.subscription?.resource, f.manager.inspect().resources[0])
  } finally { f.manager.dispose() }
})

test('F06/F07/A01.04: 校验重入与替换身份时的 abort 重入都由新声明接管', async () => {
  const f = fixture(), a = f.page()
  try {
    let nested = false
    f.setValidate(() => {
      if (!nested) { nested = true; assert.deepEqual(a.submit({ x: 2 }), { status: 'accepted' }) }
      return true
    })
    assert.deepEqual(a.submit({ x: 1 }), { status: 'cancelled', reason: 'superseded' })
    assert.deepEqual(a.handle.submission!.parameters.args, { x: 2 })
    await tick()
    assert.deepEqual(f.calls.at(-1)!.args, { x: 2 })

    // 替换身份时的 abort 回调同步提交：外层返回 superseded，新声明拥有结果。
    f.calls[0]!.signal.addEventListener('abort', () => { a.submit({ x: 3 }) })
    assert.deepEqual(a.submit({ x: 4 }), { status: 'cancelled', reason: 'superseded' })
    assert.deepEqual(a.handle.submission!.parameters.args, { x: 3 })
    await tick()
    assert.deepEqual(f.calls.at(-1)!.args, { x: 3 })
  } finally { f.manager.dispose() }
})

test('F11/T10/T11/T12/M04: FIFO 顺序、真实结束释放槽位、退订作废排队任务', async () => {
  const f = fixture(1), a = f.page(), b = f.page(), c = f.page()
  try {
    a.submit({ x: 'A' }); b.submit({ x: 'B' }); c.submit({ x: 'C' }); await tick()
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.calls[0]!.args, { x: 'A' })
    assert.deepEqual(f.manager.inspect().queued.map(task => task.resource.parameters.args), [{ x: 'B' }, { x: 'C' }])
    const view = f.manager.inspect()
    assert.equal(view.scheduled, false); assert.equal(view.pendingFlush, false)
    await f.advance(10_000); assert.equal(f.calls.length, 1)   // 满槽不自旋、不用 Timer 查队列
    // 退订者作废自己的排队任务，队列不留下已失效项。
    b.set({ ...active, enabled: false }); await tick()
    assert.deepEqual(f.manager.inspect().queued.map(task => task.resource.parameters.args), [{ x: 'C' }])
    f.calls[0]!.resolve(null); await tick()
    assert.deepEqual(f.calls[1]!.args, { x: 'C' })
    f.calls[1]!.resolve(null); await tick()
    assert.equal(f.calls.length, 2)
  } finally { f.manager.dispose() }
})

test('T12/M09: abort 不释放物理槽位，真实结束后才释放', async () => {
  const f = fixture(1), a = f.page(), b = f.page()
  try {
    a.submit({ x: 'A' }); b.submit({ x: 'B' }); await tick()
    assert.equal(f.calls.length, 1)
    a.set({ ...active, enabled: false })                   // 退订：实例销毁并 abort 在途
    await tick()
    assert.ok(f.calls[0]!.signal.aborted)
    assert.equal(f.manager.inspect().running.length, 1)    // 槽位仍被占
    assert.equal(f.calls.length, 1)                        // 排队任务不能启动
    f.calls[0]!.resolve(null); await tick()
    assert.deepEqual(f.calls[1]!.args, { x: 'B' })
  } finally { f.manager.dispose() }
})

test('U11/T04/T01/T02/T06/T07/C09: 改频率只重算到期，保留在途请求；最短间隔与分段等待', async () => {
  const f = fixture(), a = f.page(), b = f.page({ ...active, every: 500 })
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    await f.advance(2000); assert.equal(f.calls.length, 1)
    // 主动改频率不再被解释成数据失效：不 abort 在途，也不立刻补一次。
    b.set({ ...active, every: 50 }); await tick()
    assert.equal(f.calls[0]!.signal.aborted, false)
    assert.equal(f.calls.length, 1)
    f.calls[0]!.resolve(null); await tick()
    await f.advance(49); assert.equal(f.calls.length, 1)   // 从上次正常结束起按新最短间隔计
    await f.advance(1); assert.equal(f.calls.length, 2)
    f.calls[1]!.reject('retry'); await tick()
    await f.advance(50); assert.equal(f.calls.length, 3)   // 失败同样推进周期
    const running = f.calls[2]!
    a.set({ ...active, enabled: false }); await tick()     // 只剩 b 的 every 参与到期计算
    b.set({ ...active, every: Number.MAX_SAFE_INTEGER }); await tick()
    assert.equal(running.signal.aborted, false)            // 改频率不取消在途请求
    running.resolve(null); await tick()
    assert.equal(f.timers.size, 1)
    assert.equal([...f.timers.values()][0]!.at, 2100 + 2_147_483_647)  // 超平台范围时分段等待
  } finally { f.manager.dispose() }
})

test('T03/U11: 缩短间隔到已经到期时立刻入队', async () => {
  const f = fixture(), a = f.page({ ...active, every: 500 })
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve(null); await tick()
    await f.advance(300)
    assert.equal(f.calls.length, 1)
    a.set({ ...active, every: 100 }); await tick()         // 0 + 100 ≤ 300：已到期
    assert.equal(f.calls.length, 2)
  } finally { f.manager.dispose() }
})

test('F04/R08: Store 回调里改频率不打断本次交付；退订者不再接收', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  const put = f.store.put
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    f.store.put = (id, entry) => { put(id, entry); a.set({ ...active, every: 101 }) }
    f.calls[0]!.resolve({ v: 1 }); await tick()
    assert.deepEqual(a.display!.data, { v: 1 })
    assert.deepEqual(b.display!.data, { v: 1 })
    assert.equal(f.calls.length, 1)                        // 结果有效：不因改频率而重取
    // 在 Store 回调里退订：不再接收本次（以及后续）结果，其他订阅照常。
    f.store.put = (id, entry) => { put(id, entry); b.set({ ...active, enabled: false }) }
    await f.advance(101); assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ v: 2 }); await tick()
    assert.deepEqual(a.display!.data, { v: 2 })
    assert.deepEqual(b.display!.data, { v: 1 })
  } finally { f.store.put = put; f.manager.dispose() }
})

test('F14/R01/R02: 后台失败对每个有效订阅各通知一次；onError 里改频率不打断本次通知', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  Object.assign(a.handle, { onError(error: RefreshError) { a.errors.push(error); a.set({ ...active, every: 101 }) } })
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    f.calls[0]!.reject('first'); await tick()
    assert.equal(a.errors.length, 1); assert.equal(b.errors.length, 1)
    assert.equal(b.errors[0]!.origin, 'background')
    assert.equal(b.display, null)
    await f.advance(101); assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ x: 2 }); await tick()
    assert.deepEqual(b.display!.data, { x: 2 })
  } finally { f.manager.dispose() }
})

test('Q05/M03/L04/R05: 旧任务晚到不覆盖新实例的结果，也不重建已删分区', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    a.set({ ...active, enabled: false }); await tick()      // 退订：实例与分区一起删除
    assert.equal(f.manager.inspect().resources.length, 0)
    assert.equal(Object.keys(f.entries).length, 0)
    a.set(active); await tick()                             // 同键重建并首查
    assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ v: 'new' }); await tick()
    assert.deepEqual(a.display!.data, { v: 'new' })
    f.calls[0]!.resolve({ v: 'stale' }); await tick()       // 旧生存期的任务晚到
    assert.deepEqual(a.display!.data, { v: 'new' })
    assert.equal(f.entries['test:1'], undefined)
    assert.deepEqual(f.entries['test:2']!.data, { v: 'new' })
    assert.equal(f.manager.inspect().running.length, 0)
  } finally { f.manager.dispose() }
})

test('B16a: 刷新要求被新声明替代时结算 superseded，旧结果不再发布', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ v: 'base' }); await tick()
    const refreshing = a.refresh(); await tick()
    assert.equal(f.calls.length, 2)
    assert.deepEqual(a.submit({ x: 2 }), { status: 'accepted' })   // 新身份立即成为当前意图
    assert.deepEqual(await refreshing, { status: 'cancelled', reason: 'superseded' })
    assert.ok(f.calls[1]!.signal.aborted)
    await tick()
    f.calls[2]!.resolve({ v: 'new' }); await tick()
    assert.deepEqual(a.display!.data, { v: 'new' })
    assert.deepEqual(f.entries['test:2']!.data, { v: 'new' })     // 旧实例分区已随退订删除
    assert.equal(f.entries['test:1'], undefined)
  } finally { f.manager.dispose() }
})

test('C05: a throwing page delivery keeps the committed Store and the other subscribers', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  const { logs, restore } = captureConsoleError()
  const publish = a.handle.publish
  let fail = true
  Object.assign(a.handle, { publish(value: Display) {
    if (fail) { fail = false; throw new Error('publish failed') }
    publish(value)
  } })
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ x: 'ok' }); await tick()
    // Store 已提交且不回滚；抛错只让本页拿不到这次交付，其他订阅照常收到。
    assert.equal(f.entries['test:1']!.version, 1)
    assert.deepEqual(f.entries['test:1']!.data, { x: 'ok' })
    assert.equal(a.display, null); assert.deepEqual(b.display!.data, { x: 'ok' })
    assert.deepEqual(logs, [['[vue-refresh]', { origin: 'observer', error: 'observer notification failed', resourceId: 'test:1', taskVersion: 1 }]])
    // 诊断出口本身也抛错时，必要清理与后续有效交付仍不受影响。
    await f.advance(100); assert.equal(f.calls.length, 2)
    console.error = () => { throw new Error('report failed') }
    fail = true
    f.calls[1]!.resolve({ x: 'next' }); await tick()
    assert.equal(a.display, null); assert.deepEqual(b.display!.data, { x: 'next' })
    assert.equal(f.manager.inspect().running.length, 0); assert.equal(f.manager.isDisposed(), false)
  } finally { restore(); f.manager.dispose() }
})

test('B10: notifications are nonblocking and diagnostic projection never reads an exception', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  const { logs, restore } = captureConsoleError()
  let touched = 0
  const hostile = Object.defineProperty({}, 'message', { get() { touched++; throw 'secret' } })
  Object.assign(a.handle, { onError() { return Promise.reject(hostile) } })
  try {
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    f.calls[0]!.reject(hostile); await tick()
    assert.equal(b.errors.length, 1); assert.equal(logs.length, 1); assert.equal(touched, 0)
    assert.deepEqual(logs[0], ['[vue-refresh]', { origin: 'observer', error: 'observer notification failed', resourceId: 'test:1', taskVersion: 1 }])
    console.error = () => { throw hostile }
    a.submit(undefined); await tick()
  } finally { restore(); f.manager.dispose() }
})

/**
 * `DESIGN.md` §6.5 的三条加固场景取得定向用例后按 §4.1 通则移回 `B10` 变体，
 * 复用原编号 06 / 08 / 09，不重排其余编号。
 */
test('B10.06: a rejection arriving after the notification was replaced or disposed only writes diagnostics', async () => {
  const { logs, restore } = captureConsoleError()
  const f = fixture(), a = f.page(), late = deferred()
  const g = fixture(), c = g.page(), afterDispose = deferred()
  try {
    // 任务被替换：第一次失败通知返回的 Promise 在第二次交付之后才拒绝。
    Object.assign(a.handle, { onError(error: RefreshError) { a.errors.push(error); return late.promise } })
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.reject('first failure'); await tick()
    assert.equal(a.errors.length, 1)
    await f.advance(100); assert.equal(f.calls.length, 2)
    f.calls[1]!.resolve({ x: 2 }); await tick()
    const display = a.display, timers = [...f.timers.values()].map(timer => timer.at)
    assert.deepEqual(display!.data, { x: 2 })

    late.reject('late'); await tick()
    // 身份是通知当时捕获的旧任务版本；画面、分区、开启意愿与调度时间都不变。
    assert.equal(logs.length, 1)
    assert.deepEqual(logs[0], ['[vue-refresh]', { origin: 'observer', error: 'observer notification failed', resourceId: 'test:1', taskVersion: 1 }])
    assert.equal(a.display, display); assert.equal(a.errors.length, 1)
    assert.equal(f.entries['test:1']!.version, 2)
    assert.deepEqual([...f.timers.values()].map(timer => timer.at), timers)
    assert.equal(f.manager.inspect().running.length, 0)

    // Manager 已销毁：拒绝仍只写诊断，不复活句柄、队列或运行槽。
    Object.assign(c.handle, { onError(error: RefreshError) { c.errors.push(error); return afterDispose.promise } })
    c.submit({ x: 1 }); await tick()
    g.calls[0]!.reject('failure'); await tick()
    g.manager.dispose()
    afterDispose.reject('late after dispose'); await tick()
    assert.equal(logs.length, 2)
    assert.deepEqual(logs[1], ['[vue-refresh]', { origin: 'observer', error: 'observer notification failed', resourceId: 'test:1', taskVersion: 1 }])
    assert.deepEqual(g.manager.inspect().running, []); assert.deepEqual(g.manager.inspect().queued, [])
    assert.equal(g.manager.isDisposed(), true)
  } finally { restore(); f.manager.dispose(); g.manager.dispose() }
})

test('B10.08: an already rejected onError promise is observed once and a completion value is ignored', async () => {
  const { logs, restore } = captureConsoleError()
  const f = fixture(), a = f.page(), b = f.page()
  const g = fixture(), c = g.page()
  try {
    // 已拒绝的 Promise：立即观察，只报告一次，不影响已结算的失败结果与其他订阅的通知。
    const failure = new Error('background failed')
    Object.assign(a.handle, { onError(error: RefreshError) { a.errors.push(error); return Promise.reject(failure) } })
    a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
    f.calls[0]!.reject(failure); await tick()
    assert.equal(a.errors.length, 1); assert.equal(b.errors.length, 1)
    assert.equal(b.errors[0]!.error, failure); assert.equal(b.errors[0]!.origin, 'background')
    assert.equal(logs.length, 1)
    assert.deepEqual(logs[0], ['[vue-refresh]', { origin: 'observer', error: 'observer notification failed', resourceId: 'test:1', taskVersion: 1 }])
    await tick(); assert.equal(logs.length, 1)

    // 完成值：已 resolve 的 Promise 与普通返回值都只忽略完成值，不产生诊断。
    let calls = 0
    const completions: Array<() => unknown> = [() => Promise.resolve('ok'), () => ({ ignored: true })]
    Object.assign(c.handle, { onError(error: RefreshError) { c.errors.push(error); calls += 1; return completions[calls - 1]!() } })
    c.submit({ x: 1 }); await tick()
    g.calls[0]!.reject('first'); await tick()
    assert.equal(c.errors.length, 1); assert.equal(calls, 1)
    await g.advance(100); assert.equal(g.calls.length, 2)
    g.calls[1]!.reject('second'); await tick()
    assert.equal(c.errors.length, 2); assert.equal(calls, 2)
    await tick(); await tick()
    assert.equal(logs.length, 1)
  } finally { restore(); f.manager.dispose(); g.manager.dispose() }
})

test('B10.09: foreign-realm promises and runtime thenables are observed without instanceof Promise', async () => {
  const { logs, restore } = captureConsoleError()
  const f = fixture(), a = f.page()
  try {
    const factories: Array<() => unknown> = [
      () => {
        const foreign = runInNewContext('Promise.reject(new Error("foreign promise"))') as Promise<never>
        assert.equal(foreign instanceof Promise, false)
        return foreign
      },
      () => {
        const foreign = runInNewContext('({ then(resolve, reject) { reject(new Error("foreign thenable")) } })') as object
        assert.equal(foreign instanceof Promise, false)
        return foreign
      },
      () => ({ then(_resolve: unknown, reject: (reason: unknown) => void) { reject(new Error('local thenable')) } }),
    ]
    let calls = 0
    Object.assign(a.handle, { onError(error: RefreshError) { a.errors.push(error); return factories[calls++]!() } })
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.reject('one'); await tick()
    assert.equal(a.errors.length, 1)
    await f.advance(100); assert.equal(f.calls.length, 2)
    f.calls[1]!.reject('two'); await tick()
    assert.equal(a.errors.length, 2)
    await f.advance(100); assert.equal(f.calls.length, 3)
    f.calls[2]!.reject('three'); await tick()
    assert.equal(a.errors.length, 3); assert.equal(calls, 3)
    // 三条通道各报告一次，身份是各自通知当时捕获的任务版本。
    assert.equal(logs.length, 3)
    assert.deepEqual(logs.map(log => (log[1] as { taskVersion?: number }).taskVersion), [1, 2, 3])
    assert.ok(logs.every(log => (log[1] as { origin?: string }).origin === 'observer'))
  } finally { restore(); f.manager.dispose() }
})

/**
 * 序号耗尽的注入：句柄声明代次与 Manager 资源号是两个独立计数器。
 *
 * 耗尽不在产品行为里（约 2.8×10⁵ 年才会到达上界），但代码路径仍在，
 * 因此保留为回归网：这里用一次显式断言把计数推到上界。
 * 注入只出现在本函数，测试正文不再直接改写核心内部状态。
 */
function exhaustSequence(manager: Manager, page: { handle: Handle }, which: 'operation' | 'resource'): void {
  if (which === 'operation') page.handle.operationId = Number.MAX_SAFE_INTEGER
  if (which === 'resource') (manager as unknown as { nextResourceId: number }).nextResourceId = Number.MAX_SAFE_INTEGER
}

test('B04/F08: 同一同步栈内多次改频率不产生请求；随后关闭让在途失效且不排队', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    assert.equal(f.calls.length, 1)
    // 同一个同步栈内改三次频率后立即关闭，中间不 await。
    a.set({ ...active, every: 101 })
    a.set({ ...active, every: 102 })
    a.set({ ...active, every: 103 })
    a.set({ ...active, enabled: false })
    // 频率变化不再替换任务；关闭边沿才让在途失效，队列里没有中间任务。
    assert.ok(f.calls[0]!.signal.aborted)
    const view = f.manager.inspect()
    assert.equal(view.queued.length, 0); assert.equal(view.running.length, 1)
    await tick()
    assert.equal(f.calls.length, 1); assert.equal(f.manager.inspect().scheduled, false)
    await f.advance(1000); assert.equal(f.calls.length, 1)
    // 在途执行真实结束时只清理自己，不复活资源。
    f.calls[0]!.resolve(null); await tick()
    assert.equal(f.manager.inspect().running.length, 0)
    assert.deepEqual(f.manager.inspect().resources, [])
  } finally { f.manager.dispose() }
})

test('Q06/sequence exhaustion: all three counters dispose the manager once and cancel pending work', async () => {
  const { logs, restore } = captureConsoleError()
  try {
    for (const which of ['operation', 'resource', 'task'] as const) {
      const f = fixture(), a = f.page(), b = f.page({ ...active, enabled: false })
      b.submit({ x: 2 })
      const pending: Promise<RefreshResult> = b.refresh()      // 未结算的刷新要求
      await tick()
      assert.equal(f.calls.length, 1)
      if (which === 'task') {
        a.submit({ x: 1 }); await tick()
        const subscription = a.handle.subscription
        assert.ok(subscription)
        f.calls[1]!.resolve(null); await tick()                // a 的任务结束，没有当前任务
        subscription.resource.nextVersion = Number.MAX_SAFE_INTEGER
        const exhausted = a.refresh()                          // 需要登记新任务 → 序号耗尽
        assert.deepEqual(await exhausted, { status: 'cancelled', reason: 'disposed' })
      } else {
        exhaustSequence(f.manager, a, which)
        a.submit({ x: 1 })
      }
      await tick()
      assert.ok(f.manager.isDisposed())
      assert.deepEqual(await pending, { status: 'cancelled', reason: 'disposed' })
      const view = f.manager.inspect()
      assert.equal(view.resources.length, 0); assert.equal(view.queued.length, 0)
      assert.equal(a.input.enabled, true)
      assert.deepEqual(a.submit({}), { status: 'cancelled', reason: 'disposed' })
      assert.equal(f.readSnapshot(undefined), undefined)
      for (const call of f.calls) call.resolve(null)
      await tick()
      assert.equal(f.manager.inspect().running.length, 0)
    }
    assert.equal(logs.length, 3)
  } finally { restore() }
})

test('disposed manager: a flush request from any port is inert and schedules nothing', async () => {
  const f = fixture(), a = f.page()
  a.submit({ x: 1 }); await tick()
  assert.equal(f.calls.length, 1)
  f.manager.dispose()
  f.manager.requestFlush()
  assert.equal(f.manager.inspect().pendingFlush, false)
  await tick()
  assert.equal(f.manager.inspect().scheduled, false)
  assert.equal(f.manager.inspect().queued.length, 0)
  assert.equal(f.timers.size, 0)
})

for (const [name, make] of badData) test('C11/A02/B12a: ' + name + ' 结果不可复制时走共享请求失败路径', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve(make()); await tick()
    // 框架不改写调用方意愿：失败后 enabled 保持为真，下个周期继续。
    assert.equal(a.input.enabled, true)
    assert.equal(a.display, null)
    assert.equal(Object.keys(f.entries).length, 0)
    assert.equal(a.errors.at(-1)!.origin, 'background')
    await f.advance(100); assert.equal(f.calls.length, 2)
  } finally { f.manager.dispose() }
})

test('A01/A02/A06/B06/P08/Q08: 入口返回契约在正确边界保留或清空需求', async () => {
  const f = fixture(), a = f.page()
  a.handle.lifecycleActive = false
  assert.deepEqual(a.submit({ x: 1 }), { status: 'accepted' })   // 失活仍可声明身份
  const submission = a.handle.submission
  assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'unavailable' })
  assert.equal(a.handle.submission, submission)                  // 入口拒绝不动已声明身份
  assert.equal(f.readSnapshot({ x: 3 }), undefined)
  assert.equal(f.manager.inspect().resources.length, 0)
  assert.throws(() => f.readSnapshot([]))
  a.handle.lifecycleActive = true
  assert.equal(a.submit([]).status, 'rejected')                  // 参数非法：清空本次声明
  assert.equal(a.handle.submission, null); assert.equal(a.input.enabled, true)
  assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'unavailable' })
  a.submit({ x: 1 }); await tick()
  f.calls[0]!.resolve(null); await tick()
  assert.equal(f.readSnapshot({ x: 1 }), null)
  assert.equal(a.submit(undefined).status, 'rejected')
  await tick(); assert.equal(a.handle.submission, null); assert.equal(a.display!.data, null)
  assert.equal(f.manager.inspect().resources.length, 0)          // 声明被清 → 订阅退出
  f.manager.dispose()
  assert.equal(f.readSnapshot([]), undefined)
  assert.deepEqual(await a.refresh(), { status: 'cancelled', reason: 'disposed' })
})

test('P05: the same URL in two different source objects is not merged', async () => {
  const f = fixture(), a = f.page()
  let otherLoads = 0
  // 两个 Source 打到同一个业务 URL（列表接口），但它们是两个独立定义。
  const other = sourceRuntime(defineRefresh<object, unknown>({
    async load() { otherLoads++; return { from: 'other' } },
  }))
  const otherHandle: Handle = { source: other, readInput: () => active, publish() {}, onError() {},
    cleanup: null, operationId: 0, submission: null, subscription: null, refreshes: new Set(),
    lifecycleActive: true, disposed: false }
  f.manager.addHandle(otherHandle)
  try {
    a.submit({ x: 1 })
    assert.equal(f.manager.submit(otherHandle, () => prepareParameters({ x: 1 })).status, 'accepted')
    await tick()
    // 参数键相同也不共享：两个 Source 各自取数，各自一个 Resource。
    assert.equal(f.calls.length, 1); assert.equal(otherLoads, 1)
    const view = f.manager.inspect()
    // 第二个 Source 的 load 立即结束，因此只有 fixture 那条在途；两个 Resource 都在。
    assert.equal(view.resources.length, 2); assert.equal(view.running.length, 1)
    assert.deepEqual(view.resources.map(resource => resource.parameters.key), ['{"x":1}', '{"x":1}'])
    assert.notEqual(view.resources[0]!.source, view.resources[1]!.source)
  } finally { f.manager.dispose() }
})

test('M01–M09/F11/F12: seed 42, 300 有限步保持归属、并发槽与刷新要求', async () => {
  const f = fixture(2), pages = [f.page(), f.page(), f.page()]
  let seed = 42, result = 0
  const finished = new Set<number>()
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  try {
    for (let step = 0; step < 300; step++) {
      const page = pages[random(pages.length)]!
      switch (random(6)) {
        case 0: page.submit({ key: random(3) }); break
        case 1: page.set({ ...active, enabled: random(2) === 1 }); break
        case 2: page.set({ ...active, visible: random(2) === 1, every: 50 + random(5) }); break
        case 3: void page.refresh().then(settled => { assert.ok(['success', 'error', 'cancelled'].includes(settled.status)) }); break
        case 4: {
          const index = random(Math.max(1, f.calls.length)), call = f.calls[index]
          if (call && !finished.has(index)) { finished.add(index); call.resolve({ result: result++ }) }
          break
        }
        case 5: await f.advance(100); break
      }
      await tick()
      const view = f.manager.inspect()
      assert.ok(view.running.length <= 2, 'seed 42 step ' + step)
      for (const task of view.queued) { assert.ok(!view.running.includes(task)); assert.equal(task.resource.task, task) }
      const ids = new Set<string>()
      const waiters = new Set<unknown>()
      for (const resource of view.resources) {
        ids.add(resource.id)
        // 实例要么有有效订阅，要么正好被未结算的刷新要求保活。
        assert.ok(resource.subscribers.size > 0 || resource.waiters.size > 0, 'seed 42 step ' + step)
        for (const subscription of resource.subscribers) {
          assert.equal(subscription.owner.subscription, subscription)
          assert.equal(subscription.resource, resource)
          assert.ok(subscription.owner.submission)
        }
        for (const waiter of resource.waiters) {
          waiters.add(waiter)
          assert.equal(waiter.owner.refreshes.has(waiter), true)
          assert.equal(waiter.resource, resource)
        }
      }
      for (const key of Object.keys(f.entries)) assert.ok(ids.has(key))
      for (const page of pages) {
        if (page.handle.subscription) assert.ok(page.handle.subscription.resource.subscribers.has(page.handle.subscription))
        for (const waiter of page.handle.refreshes) assert.ok(waiters.has(waiter))
      }
    }
    assert.ok(f.calls.length > 0, 'finite exploration must make progress')
  } finally {
    f.manager.dispose()
    for (const call of f.calls) call.resolve(null)
    await tick()
    assert.equal(f.manager.inspect().running.length, 0); assert.equal(f.timers.size, 0)
  }
})

test('F12: a load synchronous prefix submits another resource; next flush makes progress', async () => {
  let added = false
  const f = fixture(2, () => {
    if (!added) { added = true; b.submit({ x: 'B' }) }
  })
  const a = f.page(), b = f.page()
  try {
    a.submit({ x: 'A' }); await tick()
    assert.deepEqual(f.calls.map(call => call.args), [{ x: 'A' }, { x: 'B' }])
    const view = f.manager.inspect()
    assert.equal(view.queued.length, 0)
    assert.equal(view.running.length, 2)
    assert.equal(view.pendingFlush, false)
    for (const call of f.calls) call.resolve(null)
    await tick()
    assert.equal(f.manager.inspect().running.length, 0)
  } finally { f.manager.dispose() }
})

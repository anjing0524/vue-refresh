import test from 'node:test'
import assert from 'node:assert/strict'
import { defineRefresh, parameterKey, prepareParameters, sourceRuntime } from '../src/source.ts'
import { copyResult } from '../src/delivery.ts'
import { Manager } from '../src/manager.ts'
import type { Clock, Display, Handle, Input, ResultStore, StoreEntry } from '../src/model.ts'
import type { QueryResult, RefreshError, RefreshQueryContext } from '../src/public-types.ts'
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
      cleanup: null, operationId: 0, submission: null, activity: null, lifecycleActive: true, disposed: false }
    function set(next: Input) {
      const old = current; current = next
      // 与适配层同一条规则：关闭边沿只调用核心的命名操作，不自己判断 kind 与取消原因。
      if (old.enabled === true && next.enabled === false) manager.closeQuery(handle)
      manager.reconcile(handle)
    }
    manager.addHandle(handle)
    return { handle, errors, get display() { return display }, get input() { return current },
      set, submit: (args: unknown) => manager.submit(handle, () => prepareParameters(args as object, validate)),
      query: (args: unknown, runner: (args: object, context: RefreshQueryContext) => Promise<unknown>) => manager.query(handle, () => prepareParameters(args as object, validate), runner) }
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

test('Q01/Q05/Q12/A04: paused query, superseding, immediate cancellation and stale commit', async () => {
  const f = fixture(), a = f.page({ ...active, enabled: false })
  try {
    const first = deferred(), second = deferred(); let oldContext!: RefreshQueryContext, effects = 0
    const p1 = a.query({ x: 1 }, async (_, context) => { oldContext = context; return first.promise })
    const p2 = a.query({ x: 2 }, async (_, context) => { assert.ok(context.commit(() => { effects++ })); return second.promise })
    assert.deepEqual(await p1, { status: 'cancelled', reason: 'superseded' })
    assert.equal(oldContext.commit(() => { effects++ }), false)
    second.resolve({ x: 2 }); assert.deepEqual(await p2, { status: 'success' })
    first.reject(new Error('old')); await tick()
    assert.equal(effects, 1); assert.deepEqual(a.display!.data, { x: 2 })
    assert.equal(a.display!.origin, 'query'); assert.equal(a.display!.updatedAt, epoch) // 查询结果同样带产生时间。
    assert.equal(a.errors.length, 0); assert.equal(f.calls.length, 0)
    assert.equal(Object.keys(f.entries).length, 0)
  } finally { f.manager.dispose() }
})

test('M02/U05: a query in flight is never replaced by a background subscription', async () => {
  const f = fixture(), a = f.page(), pending = deferred()
  try {
    // 先建立有效提交与共享结果，让后续 flush 具备全部接入资格。
    a.submit({ x: 1 }); await tick()
    f.calls[0]!.resolve({ x: 1 }); await tick()
    assert.ok(a.handle.submission)

    const settled = a.query({ x: 2 }, () => pending.promise)
    assert.equal(a.handle.activity?.kind, 'query')
    const before = f.calls.length
    // 查询进行中的配置变化（含 every）必须只改配置，不能换成后台订阅。
    a.set({ ...active, every: 50 }); await tick()
    assert.equal(a.handle.activity?.kind, 'query')
    assert.equal(f.calls.length, before)
    const view = f.manager.inspect()
    assert.equal(view.queued.length, 0)
    for (const resource of view.resources) assert.equal(resource.subscribers.size, 0)

    // 查询结束后同一份已准备参数仍由后台接管首查（U05），不是永久丢弃。
    pending.resolve({ x: 2 }); assert.deepEqual(await settled, { status: 'success' })
    await tick()
    assert.equal(a.handle.activity?.kind, 'subscription')
    assert.equal(f.calls.length, before + 1)
  } finally { f.manager.dispose() }
})

test('A02/Q03/Q08/F05: execution failure settles and notifies before onError reentry; new query survives', async () => {
  const f = fixture(), a = f.page(), first = deferred(), second = deferred()
  let p2!: Promise<unknown>
  // 框架不再改写 enabled：停止轮询由调用方在 onError 里自己做。
  Object.assign(a.handle, { onError(error: RefreshError) { a.errors.push(error); a.set({ ...active, enabled: false }); p2 = a.query({ x: 2 }, () => second.promise) } })
  const p1 = a.query({ x: 1 }, () => first.promise)
  first.reject(new Error('first'))
  assert.equal((await p1).status, 'error')
  await tick(); second.resolve({ x: 2 })
  assert.deepEqual(await p2, { status: 'success' })
  assert.deepEqual(a.display!.data, { x: 2 })
  assert.equal(a.errors.length, 1); assert.equal(a.errors[0]!.origin, 'execution') // 与 QueryResult.origin 同名（D1′）
  f.manager.dispose()
})

test('D01/D02/D03/D04/F09: inactive query preserves validated demand, not runner; invalid every does not cancel', async () => {
  const f = fixture(), a = f.page(), result = deferred()
  const p = a.query({ x: 2 }, () => result.promise)
  a.set({ valid: false, enabled: true, visible: true, error: 'every' })
  assert.equal(a.handle.activity?.kind, 'query')
  f.manager.deactivate(a.handle)
  assert.deepEqual(await p, { status: 'cancelled', reason: 'unavailable' })
  assert.deepEqual(a.handle.submission!.delivery, { barrier: null })
  f.manager.activate(a.handle); a.set(active); await tick()
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0]!.args, { x: 2 })
  result.resolve({ x: 'old' }); f.calls[0]!.resolve({ x: 'new' }); await tick()
  assert.deepEqual(a.display!.data, { x: 'new' })
  f.manager.dispose()
})

test('Q04/B02/F02/F15: query snapshot barrier survives pause and failed replacement', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  try {
    b.submit({ x: 1 }); await tick(); f.calls[0]!.resolve({ value: 'old' }); await tick()
    assert.deepEqual(await a.query({ x: 1 }, async () => ({ value: 'query' })), { status: 'success' })
    await tick(); assert.equal(f.calls.length, 2)
    f.calls[1]!.reject('failure'); await tick()
    a.set({ ...active, visible: false }); a.set(active); await tick()
    assert.deepEqual(a.display!.data, { value: 'query' })
    await f.advance(100); f.calls[2]!.resolve({ value: 'fresh' }); await tick()
    assert.deepEqual(a.display!.data, { value: 'fresh' })
    assert.equal(a.handle.submission!.delivery, null)
  } finally { f.manager.dispose() }
})

test('F06/F07: abort reentry during preparation owns the new operation before validation', async () => {
  const f = fixture(), a = f.page()
  a.submit({ x: 0 }); await tick()
  f.calls[0]!.signal.addEventListener('abort', () => { a.submit({ x: 2 }) })
  assert.deepEqual(a.submit({ x: 1 }), { status: 'cancelled', reason: 'superseded' })
  assert.deepEqual(a.handle.submission!.parameters.args, { x: 2 })
  await tick()
  f.calls[1]!.signal.addEventListener('abort', () => {
    a.set({ ...active, enabled: false })
  })
  let ran = false
  const result = await a.query({ x: 3 }, async () => { ran = true; return {} })
  assert.deepEqual(result, { status: 'cancelled', reason: 'unavailable' })
  assert.equal(ran, false); assert.equal(a.handle.submission, null)
  f.manager.dispose()
})

test('F11/T10/T11/T12/M04: FIFO replacement moves to tail, abort does not free physical slot', async () => {
  const f = fixture(1), a = f.page(), b = f.page(), c = f.page()
  a.submit({ x: 'running' }); b.submit({ x: 'B' }); c.submit({ x: 'C' }); await tick()
  assert.equal(f.calls.length, 1)
  b.submit({ x: 'B' }); a.set({ ...active, enabled: false }); await tick()
  const view = f.manager.inspect()
  assert.equal(view.queued.length, 2); assert.equal(view.running.length, 1)
  assert.equal(view.scheduled, false); assert.equal(view.pendingFlush, false)
  await f.advance(10_000); assert.equal(f.calls.length, 1)
  f.calls[0]!.resolve(null); await tick()
  assert.deepEqual(f.calls[1]!.args, { x: 'C' })
  f.calls[1]!.resolve(null); await tick()
  assert.deepEqual(f.calls[2]!.args, { x: 'B' })
  f.manager.dispose()
})

test('F04/F14/R08: synchronous Store replacement stops old deliveries and preserves new task', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
  const put = f.store.put
  f.store.put = (id, entry) => { put(id, entry); a.set({ ...active, every: 101 }) }
  f.calls[0]!.resolve({ old: true }); await tick()
  assert.equal(a.display, null); assert.equal(b.display, null)
  assert.equal(f.calls.length, 2)
  f.store.put = put
  f.calls[1]!.resolve({ fresh: true }); await tick()
  assert.deepEqual(a.display!.data, { fresh: true }); assert.deepEqual(b.display!.data, { fresh: true })
  f.manager.dispose()
})

test('F14/R01/R02: first failure callback replaces task; remaining old notifications stop', async () => {
  const f = fixture(), a = f.page(), b = f.page()
  Object.assign(a.handle, { onError() { a.set({ ...active, every: 101 }) } })
  a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
  f.calls[0]!.reject('first'); await tick()
  assert.equal(b.errors.length, 0); assert.equal(f.calls.length, 2)
  f.calls[1]!.resolve({ x: 2 }); await tick()
  assert.deepEqual(b.display!.data, { x: 2 })
  f.manager.dispose()
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
 * 序号耗尽的注入：句柄操作号与 Manager 资源号是两个独立计数器。
 *
 * 耗尽不在产品行为里（约 2.8×10⁶ 年才会到达上界，`C07` 叶子已按裁决删除），但代码路径仍在，
 * 因此保留为回归网：这里用一次显式断言把计数推到上界。
 * 注入只出现在本函数，测试正文不再直接改写核心内部状态；任务版本号那一支由用例自己注入，
 * 因为它需要先真实提交一次才能拿到 Resource。
 */
function exhaustSequence(manager: Manager, page: { handle: Handle }, which: 'operation' | 'resource'): void {
  if (which === 'operation') page.handle.operationId = Number.MAX_SAFE_INTEGER
  if (which === 'resource') (manager as unknown as { nextResourceId: number }).nextResourceId = Number.MAX_SAFE_INTEGER
}

/**
 * 逐 ID 证据补齐（§7 13.1 的未验证清单）：这四条叶子此前没有任何断言。
 */
test('B04/F08: several every changes in one sync stack then close leave no queued load', async () => {
  const f = fixture(), a = f.page()
  try {
    a.submit({ x: 1 }); await tick()
    assert.equal(f.calls.length, 1)
    // 同一个同步栈内改三次频率后立即关闭，中间不 await。
    a.set({ ...active, every: 101 })
    a.set({ ...active, every: 102 })
    a.set({ ...active, every: 103 })
    a.set({ ...active, enabled: false })
    // 微任务执行前的同步事实：在途任务已失效，队列里没有中间任务。
    assert.ok(f.calls[0]!.signal.aborted)
    const view = f.manager.inspect()
    assert.equal(view.queued.length, 0); assert.equal(view.running.length, 1)
    await tick()
    // 唯一的后续 flush 复核已关闭：不请求，也不留下唤醒 Timer。
    assert.equal(f.calls.length, 1); assert.equal(f.manager.inspect().scheduled, false)
    await f.advance(1000); assert.equal(f.calls.length, 1)
    // 在途执行真实结束时只清理自己，不复活资源。
    f.calls[0]!.resolve(null); await tick()
    assert.equal(f.manager.inspect().running.length, 0)
    assert.deepEqual(f.manager.inspect().resources, [])
  } finally { f.manager.dispose() }
})

test('B16a: a commit callback that starts a new query keeps the newer operation', async () => {
  const f = fixture(), a = f.page({ ...active, enabled: false })
  const published: unknown[] = []
  const publish = a.handle.publish
  Object.assign(a.handle, { publish(value: Display) { published.push(value.data); publish(value) } })
  try {
    let second!: Promise<QueryResult>
    const first = a.query({ x: 1 }, async (_, context) => {
      assert.equal(context.commit(() => { second = a.query({ x: 2 }, async () => ({ x: 'second' })) }), true)
      return { x: 'first' }
    })
    // 回调之后旧流程复核身份：旧操作被结算为 superseded，返回值不发布、也不建立订阅。
    assert.deepEqual(await first, { status: 'cancelled', reason: 'superseded' })
    assert.deepEqual(await second, { status: 'success' })
    await tick()
    assert.deepEqual(a.display!.data, { x: 'second' })
    assert.deepEqual(published, [{ x: 'second' }])   // 旧 runner 的返回值从未发布
    assert.equal(f.calls.length, 0)
    assert.equal(f.manager.inspect().resources.length, 0)
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

test('Q06: the same parameters queried again replace the in-flight run', async () => {
  const f = fixture(), a = f.page({ ...active, enabled: false })
  const pending = deferred()
  try {
    const first = a.query({ x: 1 }, () => pending.promise)
    const second = a.query({ x: 1 }, async () => ({ x: 'again' }))
    // 同参不复用在途结果：旧操作被取消，新操作独立执行。
    assert.deepEqual(await first, { status: 'cancelled', reason: 'superseded' })
    assert.deepEqual(await second, { status: 'success' })
    assert.deepEqual(a.display!.data, { x: 'again' })
    pending.resolve({ x: 'stale' }); await tick()
    assert.deepEqual(a.display!.data, { x: 'again' })
  } finally { f.manager.dispose() }
})

test('P05: the same URL in two different source objects is not merged', async () => {
  const f = fixture(), a = f.page()
  let otherLoads = 0
  // 两个 Source 打到同一个业务 URL（列表接口），但它们是两个独立定义。
  const other = sourceRuntime(defineRefresh<object, unknown>({
    async load() { otherLoads++; return { from: 'other' } },
  }))
  const otherHandle: Handle = { source: other, readInput: () => active, publish() {}, onError() {},
    cleanup: null, operationId: 0, submission: null, activity: null, lifecycleActive: true, disposed: false }
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

test('sequence exhaustion: all three counters dispose the manager once and cancel pending work', async () => {
  const { logs, restore } = captureConsoleError()
  try {
    for (const which of ['operation', 'resource', 'task'] as const) {
      const f = fixture(), a = f.page(), b = f.page({ ...active, enabled: false }), result = deferred()
      const pending = b.query({ x: 2 }, () => result.promise)
      if (which === 'task') {
        a.submit({ x: 1 }); await tick()
        const r = a.handle.activity
        assert.equal(r?.kind, 'subscription')
        if (r?.kind === 'subscription') r.resource.nextVersion = Number.MAX_SAFE_INTEGER
        a.set({ ...active, every: 101 })
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
      result.reject('late'); await tick()
      assert.equal(f.manager.inspect().running.length, 0)
    }
    assert.equal(logs.length, 3)
  } finally { restore() }
})

test('T01/T02/T04/T06/T07/C09: min interval, full wait after settlement, segmented timer', async () => {
  const f = fixture(), a = f.page(), b = f.page({ ...active, every: 500 })
  a.submit({ x: 1 }); b.submit({ x: 1 }); await tick()
  await f.advance(2000); assert.equal(f.calls.length, 1)
  f.calls[0]!.resolve(null); await tick()
  a.set({ ...active, enabled: false }); await tick()
  await f.advance(499); assert.equal(f.calls.length, 1)
  await f.advance(1); assert.equal(f.calls.length, 2)
  f.calls[1]!.reject('retry'); await tick()
  await f.advance(500); assert.equal(f.calls.length, 3)
  b.set({ ...active, every: Number.MAX_SAFE_INTEGER }); await tick()
  assert.ok(f.calls[2]!.signal.aborted)
  f.calls[3]!.resolve(null); await tick()
  assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0]!.at, 3000 + 2_147_483_647)
  f.manager.dispose()
})

for (const [name, make] of badData) test('C11/A02/B12a: ' + name + ' through query and background failure contracts', async () => {
  const f = fixture(), a = f.page()
  try {
    const result = await a.query({ x: 1 }, async () => make())
    assert.equal(result.status, 'error')
    if (result.status === 'error') assert.equal(result.origin, 'execution')
    // 框架不改写调用方意愿：失败后 enabled 保持为真，已准备参数由后台路径接管。
    assert.equal(a.input.enabled, true); assert.equal(a.display, null)
    a.set(active); await tick()
    assert.equal(f.calls.length, 1)
    f.calls[0]!.resolve(make()); await tick()
    assert.equal(a.input.enabled, true); assert.equal(a.display, null)
    assert.equal(Object.keys(f.entries).length, 0)
    assert.equal(a.errors.at(-1)!.origin, 'background')
    await f.advance(100); assert.equal(f.calls.length, 2)
  } finally { f.manager.dispose() }
})

test('A01/A02/A06/B06/P08: entry return contracts preserve or clear demand at the correct boundary', async () => {
  const f = fixture(), a = f.page()
  a.handle.lifecycleActive = false
  assert.deepEqual(a.submit({ x: 1 }), { status: 'accepted' })
  const submission = a.handle.submission
  assert.deepEqual(await a.query({ x: 2 }, async () => null), { status: 'cancelled', reason: 'unavailable' })
  assert.equal(a.handle.submission, submission)
  assert.equal(f.readSnapshot({ x: 3 }), undefined)
  assert.equal(f.manager.inspect().resources.length, 0)
  assert.throws(() => f.readSnapshot([]))
  a.handle.lifecycleActive = true
  assert.equal((await a.query([], async () => null)).status, 'error')
  assert.equal(a.handle.submission, null); assert.equal(a.input.enabled, true)
  a.submit({ x: 1 }); await tick()
  f.calls[0]!.resolve(null); await tick()
  assert.equal(f.readSnapshot({ x: 1 }), null)
  assert.equal(a.submit(undefined).status, 'rejected')
  await tick(); assert.equal(a.handle.submission, null); assert.equal(a.display!.data, null)
  f.manager.dispose()
  assert.equal(f.readSnapshot([]), undefined)
  assert.deepEqual(await a.query({}, async () => null), { status: 'cancelled', reason: 'disposed' })
})

test('A04/C13/F06: validation reentry prevents runner; invalid commit is an execution failure', async () => {
  const f = fixture(), a = f.page({ ...active, enabled: false })
  const { logs, restore } = captureConsoleError()
  try {
    let first = true, ran = false
    f.setValidate(() => { if (first) { first = false; a.submit({ x: 2 }) } return true })
    assert.deepEqual(await a.query({ x: 1 }, async () => { ran = true; return null }), { status: 'cancelled', reason: 'superseded' })
    assert.equal(ran, false); assert.deepEqual(a.handle.submission!.parameters.args, { x: 2 })
    // 异步 effect 是契约违约：runner 拿到同步抛错，返回的 Promise 拒绝只走 observer 诊断一次。
    const bad = await a.query({ x: 3 }, async (_, context) => {
      context.commit((() => Promise.reject('bad effect')) as never)
      return null
    })
    assert.equal(bad.status, 'error')
    if (bad.status === 'error') assert.equal(bad.origin, 'execution')
    await tick()
    // 诊断不读取原异常内容：事件里只有固定说明与本次操作号。
    assert.equal(logs.length, 1)
    const event = logs[0]![1] as Record<string, unknown>
    assert.equal(event.origin, 'observer')
    assert.equal(event.error, 'commit requires a synchronous undefined return')
    assert.equal(typeof event.operationId, 'number')
    const thrown = await a.query({ x: 4 }, async (_, context) => {
      context.commit(() => { throw new Error('effect') }); return null
    })
    assert.equal(thrown.status, 'error')
  } finally { restore(); f.manager.dispose() }
})

test('M01–M09/F11/F12: seed 42, 300 finite operations preserve ownership and physical slots', async () => {
  const f = fixture(2), pages = [f.page(), f.page(), f.page()]
  let seed = 42, result = 0
  const finished = new Set<number>()
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  try {
    for (let step = 0; step < 300; step++) {
      const page = pages[random(pages.length)]!
      switch (random(5)) {
        case 0: page.submit({ key: random(3) }); break
        case 1: page.set({ ...active, enabled: random(2) === 1 }); break
        case 2: page.set({ ...active, visible: random(2) === 1, every: 50 + random(5) }); break
        case 3: {
          const index = random(Math.max(1, f.calls.length)), call = f.calls[index]
          if (call && !finished.has(index)) { finished.add(index); call.resolve({ result: result++ }) }
          break
        }
        case 4: await f.advance(100); break
      }
      await tick()
      const view = f.manager.inspect()
      assert.ok(view.running.length <= 2, 'seed 42 step ' + step)
      for (const task of view.queued) { assert.ok(!view.running.includes(task)); assert.equal(task.resource.task, task) }
      const ids = new Set<string>()
      for (const resource of view.resources) {
        ids.add(resource.id); assert.ok(resource.subscribers.size > 0)
        for (const subscription of resource.subscribers) {
          assert.equal(subscription.owner.activity, subscription)
          assert.equal(subscription.resource, resource)
          assert.ok(subscription.owner.submission)
        }
      }
      for (const key of Object.keys(f.entries)) assert.ok(ids.has(key))
      for (const page of pages) if (page.handle.activity?.kind === 'subscription') {
        assert.ok(page.handle.activity.resource.subscribers.has(page.handle.activity))
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

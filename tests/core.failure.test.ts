import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import type { PageSlot } from '../src/resource.ts'
import { declared, disposeAllCores, newCore, page, settle, sleep, type FakePost } from './core.helpers.ts'

afterEach(disposeAllCores)

test('A13 共享请求失败：保留旧址、把失败写进该身份那一格、下个周期继续', async () => {
  let fail = false
  let calls = 0
  const source = '/api/core/425'
  const core = newCore(2, async () => { calls++; if (fail) throw new Error('boom'); return 5 })
  const view = page(core, source, { enabled: true, every: 20 })

  view.submit({ id: 1 })
  await settle()
  fail = true
  await sleep(50)

  assert.ok(calls >= 2)
  assert.equal(view.last?.data, 5, '失败保留旧画面')
  assert.ok(view.failedAt(), '失败写进该身份那一格：按身份读得到（读取面这一侧由 tests/vue.test.ts 验证）')
  assert.equal(declared(core, view)?.declarers.size, 1, '资格与开启意愿都保留')
})

test('A11/A13 空结果（undefined）按请求失败处理，null 是有效结果', async () => {
  let mode: 'empty' | 'null' = 'empty'
  const source = '/api/core/480'
  const core = newCore(2, async () => (mode === 'empty' ? (undefined as unknown as number) : null))
  const empty = page(core, source)
  empty.submit({ id: 1 })
  await settle()
  assert.ok(empty.failedAt(), '空结果按请求失败：这一格处于失败态')
  assert.equal(empty.last?.data, null, '空结果不写数据：这一格只有失败')

  mode = 'null'
  const view = page(core, source)
  view.submit({ id: 2 })
  await settle()
  assert.equal(view.last?.data, null)
})

test('A11 交付面：null 之外的任何结果都整体替换，读者拿到的是结果表里同一个对象（要改自己复制）', async () => {
  const source = '/api/core/587'
  const quote = source
  const core = newCore(2, async () => ({ rows: [1] }))
  const view = page(core, quote)

  view.submit({ id: 1 })
  await settle()
  const first = view.last
  const copy = first?.data as { rows: number[] }
  copy.rows.push(2)

  // 数据是共享对象：要改自己复制（ADR-59）。这里改的就是结果表里那一份，后加入者读到的是同一个对象，
  // 而且它是按同一身份现读的——没有为它再取数。
  const late = page(core, quote)
  late.submit({ id: 1 })
  await settle()
  assert.deepEqual(late.last?.data, { rows: [1, 2] })
  assert.equal(late.last?.data, view.last?.data, '两个读者拿到的是结果表里同一个对象')
  assert.equal(view.key(), '{"id":1}')
})

test('A16 零回调：传输失败只写结果表，核心不认识页面也不调用任何页面代码', async () => {
  const source = '/api/core/625'
  // 同一个核心只有一个传输，因此按 URL 分派：失败的资源用另一个 URL。
  const core = newCore(2, async url => { if (url === '/api/core/643') throw new Error('down'); return 3 })
  const quote = source
  const hostile = page(core, quote, { enabled: true, every: 100_000 })
  const normal = page(core, quote)

  normal.submit({ id: 1 })
  hostile.submit({ id: 1 })
  await settle()

  assert.equal(normal.last?.data, 3, '一个读者拿到的结果不受另一个影响')
  assert.equal(hostile.last?.data, 3, '两个读者读的是结果表里同一份结果')
  assert.equal(snapshot(core).resources.length, 1, '页面回调失败不影响实例与结果')

  // 传输失败只是这个身份那一格的事实：两个声明者都能读到它，框架状态照旧。
  const failing = '/api/core/643'
  const victim = page(core, failing, { enabled: true, every: 100_000 })
  const witness = page(core, failing, { enabled: true, every: 100_000 })
  victim.submit({ id: 1 })
  witness.submit({ id: 1 })
  await settle()
  assert.ok(victim.failedAt(), '失败方自己读得到')
  assert.ok(witness.failedAt(), '同一个身份另一个读者读的是同一格，也读得到')
  assert.equal(victim.error() instanceof Error, true, '原始异常原样带出')
  assert.equal(declared(core, victim)?.declarers.size, 2)

  // 零回调（ADR-64）：配置槽只有数据，释放与销毁都不需要页面配合——下面这条在类型层面就钉住它。
  core.undeclare(victim.slot)
  assert.equal(snapshot(core).resources.flatMap(resource => [...resource.declarers]).includes(victim.slot), false,
    '释放只动声明，不调用任何页面代码')
  assert.equal(declared(core, witness)?.declarers.size, 1, '另一个需求的声明不受影响')
  const pure: PageSlot = { enabled: true, every: 1000, present: true }
  // @ts-expect-error `PageSlot` 没有回调字段：核心不持有任何可调用的东西（ADR-64、ADR-66）
  const withCallback: PageSlot = { ...pure, cleanup: () => {} }
  void withCallback
})

test('边界总账：运行期失败只走返回值或结果表这一格，公开入口都不抛错', async () => {
  // 取数侧：结果非法（`undefined`）与结果不可复制都只是后台失败，槽位当场交还。
  const broken: Array<{ name: string; post: FakePost }> = [
    { name: '/api/core/788', post: async () => undefined as unknown as number },
    { name: '/api/core/789', post: async () => ({ f: () => 1 }) },
  ]
  for (const { name, post } of broken) {
    const source = name
    const core = newCore(1, post)
    const view = page(core, source)
    assert.doesNotThrow(() => { view.submit({ id: 1 }) })
    await settle()
    assert.ok(view.failedAt(), '运行期失败写进该格，入口不抛错')
    assert.equal(snapshot(core).running.length, 0)
  }

  // 参数侧：复制失败、编码不出，一律只给同步 `rejected`（不通知），也不产生实例。
  const source = '/api/core/800'
  const core = newCore(1, async () => 1)
  const view = page(core, source)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  for (const bad of [cyclic, { f: () => 1 }]) {
    let status = ''
    assert.doesNotThrow(() => { status = view.submit(bad).status })
    assert.equal(status, 'rejected')
  }
  assert.equal(view.failedAt(), null, '输入非法一律不进结果表')
  assert.equal(snapshot(core).resources.length, 0)

  // 刷新侧：入口状态不成立（这里是没有身份）时直接返回，不抛错、不需要 try/catch。
  assert.doesNotThrow(() => { view.refresh() })
  assert.equal(snapshot(core).resources.length, 0, '未声明身份的刷新不产生实例或请求')
})


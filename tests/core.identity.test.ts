import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import { identityOf, prepareParameters, splitIdentity } from '../src/source.ts'
import { declared, disposeAllCores, eligible, newCore, page, settle } from './core.helpers.ts'

afterEach(disposeAllCores)

test('A01/A11 首次订阅立即取一次，结果按 args／data／时间整体读出', async () => {
  const source = '/api/core/84'
  const core = newCore(2, async () => 7)
  const quote = source
  const view = page(core, quote)

  assert.equal(view.submit({ symbol: 'A' }).status, 'accepted')
  await settle()

  assert.equal(view.writes(), 1)
  assert.deepEqual(view.last?.args, { symbol: 'A' })
  assert.equal(view.last?.data, 7)
  assert.equal(typeof view.last?.updatedAt, 'number')
})

test('A11/A02 同参数的两个组件共享同一次请求与同一份结果（要改自己复制）', async () => {
  let calls = 0
  const source = '/api/core/99'
  const quote = source
  const core = newCore(2, async () => { calls++; return { list: [1, 2] } })
  const first = page(core, quote)
  const second = page(core, quote)

  first.submit({ id: 1 })
  second.submit({ id: 1 })
  await settle()

  assert.equal(calls, 1)
  assert.equal(first.writes(), 1)
  assert.equal(second.writes(), 1)

  // 数据是共享对象：要改自己复制（ADR-59）。改到的就是结果表里那一份，所以另一个读者也看得到。
  const copy = first.last?.data as { list: number[] }
  copy.list.push(99)
  assert.deepEqual(second.last?.data, { list: [1, 2, 99] })
})

test('A02 身份是「URL ＋ 完整参数值」：字段顺序无关，数组顺序有关，不同参数各取一次', async () => {
  let calls = 0
  const source = '/api/core/123'
  const quote = source
  const core = newCore(4, async () => { calls++; return calls })
  const first = page(core, quote)
  const second = page(core, quote)
  const third = page(core, quote)

  first.submit({ id: 1, tags: ['a', 'b'] })
  second.submit({ tags: ['a', 'b'], id: 1 })
  await settle()
  assert.equal(calls, 1, '字段顺序不同仍是同一个身份')

  third.submit({ id: 1, tags: ['b', 'a'] })
  await settle()
  assert.equal(calls, 2, '数组顺序影响身份')
})

test('A02 同一个 URL 就是同一个身份：两处各声明一份定义仍然合并，只发一次取数', async () => {
  let calls = 0
  // 两份「定义」就是同一个 URL 字符串（资源声明不再是一个对象，ADR-74），因此是同一个身份。
  const firstSource = '/api/core/identity'
  const secondSource = '/api/core/identity'
  const core = newCore(2, async () => { calls++; return 42 })
  const first = page(core, firstSource)
  const second = page(core, secondSource)

  first.submit({ id: 1 })
  second.submit({ id: 1 })
  await settle()

  assert.equal(calls, 1, 'URL 与参数值相同就是同一个共享实例')
  assert.equal(first.writes(), 1)
  assert.equal(second.writes(), 1)
  assert.equal(snapshot(core).resources.length, 1)

  // 反向：URL 不同就是不同身份，即便参数值一模一样。
  const otherSource = '/api/core/identity-2'
  const third = page(core, otherSource)
  third.submit({ id: 1 })
  await settle()
  assert.equal(calls, 2, 'URL 不同则各有一次取数')
  assert.equal(snapshot(core).resources.length, 2)
})

test('A02 身份键的拼与拆是同一处规则：往返还原两级，URL 里出现 NUL 也不会串级', () => {
  const key = '{"symbol":"BTC","note":"a=b&c"}'
  const identity = identityOf('https://api.test/quote?x=1', key)
  assert.deepEqual(splitIdentity(identity), { url: 'https://api.test/quote?x=1', key }, '往返还原两级')

  // 分隔符是 NUL：拼接端只写一个，拆分端认**最后**一个——键那一侧不可能含裸 NUL（编码把控制字符
  // 写成六个字符的转义），URL 那一侧是调用方给的字符串、可能有，所以只有最后一个 NUL 说得准。
  const tricky = identityOf('https://api.test/x\u0000a', 'b')
  assert.deepEqual(splitIdentity(tricky), { url: 'https://api.test/x\u0000a', key: 'b' })
})

test('A04/A05 配置原地改写不改变声明：改 every／暂停／配置非法，声明者都还在（ADR-66 的可变配置槽）', async () => {
  const source = '/api/core/900'
  const core = newCore(1, async () => 1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const resource = declared(core, view)
  assert.notEqual(resource, undefined)
  assert.equal(resource?.declarers.size, 1)
  assert.equal(view.key(), '{"id":1}')

  view.set({ every: 5_000 }) // 改间隔：槽被原地改写，成员资格必须不变
  await settle()
  assert.equal(declared(core, view), resource, '还是同一个实例、同一份声明')
  assert.equal(resource?.declarers.size, 1, '声明者数不变')

  view.set({ enabled: false }) // 暂停：只失去资格，声明留着（A05）
  await settle()
  assert.equal(eligible(core, view), false)
  assert.equal(resource?.declarers.size, 1, '暂停不撤销声明')
  assert.equal(view.key(), '{"id":1}', '暂停不撤销身份')

  view.set(null) // 配置非法：声明仍然留着（A04），修正后按到期恢复
  await settle()
  assert.equal(declared(core, view), resource, '配置非法不撤销声明')
  assert.equal(snapshot(core).resources.length, 1, '声明还在：实例不回收')
})

test('A03 相同参数重复声明幂等：不新增请求、不重建订阅', async () => {
  let calls = 0
  const source = '/api/core/142'
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const instance = declared(core, view)

  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()

  assert.equal(calls, 1)
  assert.equal(declared(core, view), instance)
})

test('A03 参数被拒时返回 rejected，保留已有身份，且不通知（输入问题只走同步返回值）', async () => {
  const source = '/api/core/159'
  const core = newCore(2, async () => 1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const before = view.key()
  const instance = declared(core, view)

  // 值域外的容器（`Date`）在提交边界被拒：业务准入由调用方自己判，框架只管值域与编码。
  assert.equal(view.submit({ id: new Date() }).status, 'rejected')
  assert.equal(view.key(), before)
  assert.equal(declared(core, view), instance)
  // 校验失败不改动任何状态：旧身份仍然在后台继续取数；输入问题也不进结果表（ADR-51）。
  assert.equal(view.failedAt(), null, '参数被拒只走同步返回值')

  // 复制不出来（函数）时同样按 rejected 返回：异常由提交边界收住，不冒泡到调用方。
  const throwing = '/api/core/159-throwing'
  const victim = page(core, throwing)
  assert.equal(victim.submit({ id: () => 1 }).status, 'rejected')
  assert.equal(victim.key(), null, '被拒的声明不改动状态')
  assert.equal(victim.failedAt(), null, '被拒的声明不产生失败')
})

test('A18 参数编码与值域：键按 JSON 语义稳定排序，坏参数一律拒绝且不改动状态', async () => {
  const source = '/api/core/710'
  const core = newCore(1, async () => 1)
  const view = page(core, source)

  // 标量沿用 JSON 语义，不做业务合法性判断（那是调用方的责任）：键就是按键排序后的 JSON 文本。
  assert.equal(prepareParameters({ b: 1, a: 2 }).key, '{"a":2,"b":1}', '对象键排序')
  assert.equal(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['a', 'b'] }).key)
  assert.notEqual(prepareParameters({ tags: ['a', 'b'] }).key, prepareParameters({ tags: ['b', 'a'] }).key, '数组顺序影响身份')
  assert.equal(prepareParameters({ id: -0 }).key, prepareParameters({ id: 0 }).key, '-0 与 0 是同一个数')
  assert.equal(prepareParameters({ id: Number.NaN }).key, prepareParameters({ id: null }).key, 'NaN 按 JSON 语义读作 null')
  assert.equal(prepareParameters({ id: undefined }).key, prepareParameters({}).key, 'undefined 字段按 JSON 语义省略')

  // 严格线（ADR-52）：对象型参数只能是普通对象或数组。这些容器的内容对编码不可见（全部编码成 `{}`），
  // 不同内容会塌成同一个身份、共享另一条查询的数据，故一律拒绝。
  for (const box of [new Date(0), new Map([['k', 1]]), new Set([1]), /x/g, new ArrayBuffer(2)]) {
    assert.throws(() => prepareParameters({ box }), /参数只能是普通对象、数组与 JSON 标量/, `${box.constructor.name} 被拒绝`)
    assert.equal(view.submit({ box }).status, 'rejected', `${box.constructor.name} 的提交被拒绝`)
  }
  assert.equal(view.key(), null, '值域不合格的参数不改动任何状态')

  // 循环引用编码不出身份：同样按非法参数拒绝，且不改动任何状态。
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(view.submit(cyclic).status, 'rejected')
  assert.equal(view.key(), null)

  // 编码得出身份的参数照常接纳并取数。
  assert.equal(view.submit({ id: 1 }).status, 'accepted')
  await settle()
  assert.equal(view.last?.data, 1)
})

/**
 * 参数的隔离靠**每个消费者各一份副本**，不靠冻结（ADR-52）：`Object.freeze` 冻的是属性描述符，
 * 而 `Map.set` / `Set.add` / `Date.setTime` 写的是内部槽，规范上冻不住；框架私有那份既然不外发，
 * 就不需要任何「冻得住」的假设。
 */
test('A19 参数副本：每轮请求与每个接收者各拿一份副本，改自己的不影响别人', async () => {
  const seen: { id: number; tags: string[] }[] = []
  const source = '/api/core/748'
  const core = newCore(2, async (_url, body) => {
    const box = body as unknown as { id: number; tags: string[] }
    seen.push(box)
    box.tags.push('load 改的')
    return box.id
  })
  const a = page(core, source)
  const b = page(core, source)

  assert.equal(a.submit({ id: 1, tags: [] }).status, 'accepted')
  await settle()
  assert.deepEqual(seen[0]?.tags, ['load 改的'], 'load 改的是交给自己那份')
  assert.deepEqual(a.last?.args, { id: 1, tags: [] }, 'load 的改写没有进到身份里')

  a.refresh()
  await settle()
  assert.deepEqual(seen[1]?.tags, ['load 改的'], '上一轮 load 的改写没有留到下一轮')

  assert.equal(b.submit({ id: 1, tags: [] }).status, 'accepted')
  await settle()
  const argsOfA = a.last?.args as unknown as { tags: string[] }
  argsOfA.tags.push('A 页改的')
  assert.deepEqual(argsOfA.tags, ['A 页改的'], 'A 页改的是自己读到的那一份')
  assert.deepEqual(a.last?.args, { id: 1, tags: [] }, '下一次读到的仍是身份键所描述的那份值')
  assert.deepEqual(b.last?.args, { id: 1, tags: [] }, 'A 页改自己的参数影响不到 B 页')
})

/**
 * 这一条是「调用方不用写 try/catch」的总账：公开入口只给返回值、结果表这一格，或者什么都不给。
 * 唯一会同步抛错的是装配误用（`useRefresh` 不在 setup、没有协调者、`maxConcurrent` 非法、安装冲突），
 * 那些在 `vue.test.ts` 里各有一条，且都发生在第一次运行就能看见的固定位置。
 */

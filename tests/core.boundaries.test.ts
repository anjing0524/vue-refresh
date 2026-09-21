import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { snapshot } from '../scripts/observe.ts'
import {
  assertQueueConsistent, disposeAllCores, eligible, newCore, page, settle, sleep, tableOf,
} from './core.helpers.ts'

/**
 * 取值域与到期锚点的补充用例（对着《统一刷新管理.md》§3 的条文与 §4 的叶子写，不照实现反推）。
 *
 * 补的是三类「条文说了、叶子也列了，但取值域上还有洞」的地方：
 * ① `every`／`enabled` 的**整张取值域**（A04 的变体：只有正安全整数与布尔算有效）；
 * ② 到期锚点——「结算时刻 ＋ 当前最短周期」这两个词的每一半（U07）；
 * ③ 队列次序——手动刷新的命令在队首（U09）。
 * 适配层的两处边界（身份落定不等窗口、配置 getter 抛错）在 `tests/vue.test.ts` 末尾。
 */

afterEach(disposeAllCores)

test('A04 变体：every 只有正安全整数算有效，其余取值一律按配置非法处理', async () => {
  let calls = 0
  const source = '/api/core/boundary/every'
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1, '首次声明按默认周期取一次')

  // §3.6：`every` 只接受正安全整数毫秒，不转换、不取整；读不出或不是正安全整数时整槽按非法处理。
  const illegalEvery: ReadonlyArray<readonly [string, unknown]> = [
    ['0', 0],
    ['负数', -1],
    ['小数', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['超出安全整数范围', 2 ** 53],
    ['字符串', '1000'],
    ['布尔', true],
    ['null', null],
    ['undefined（读不出）', undefined],
  ]
  for (const [label, every] of illegalEvery) {
    core.setConfig(view.config, true, every, true)
    assert.equal(eligible(core, view), false, `every 是${label}：没有资格`)
    assert.equal(view.config.every, null, `every 是${label}：槽里不留下这个值`)
  }
  await settle()
  assert.equal(calls, 1, '这些取值都不产生取数')
  assert.equal(view.failedAt(), null, '配置非法不写失败：它是页面自己的输入（U05）')

  // `enabled` 的取值域同样只有布尔算有效。
  for (const enabled of ['true', 1, 0, null, undefined]) {
    core.setConfig(view.config, enabled, 100_000, true)
    assert.equal(eligible(core, view), false, `enabled 是 ${String(enabled)}：没有资格`)
  }
  await settle()
  assert.equal(calls, 1, '非布尔的开启意愿同样不取数')

  // 取值域的边界之内：1 与最大安全整数都算有效周期（最大值只是把到期推得很远）。
  core.setConfig(view.config, true, Number.MAX_SAFE_INTEGER, true)
  assert.equal(eligible(core, view), true, '最大安全整数是有效周期')
  await settle()
  assert.equal(calls, 1, '改成长周期只重排调度，不立刻重取')
})

test('A07 改周期立刻改变到期：改短立刻到期，改长立刻推迟', async () => {
  let calls = 0
  const source = '/api/core/boundary/every-change'
  const core = newCore(2, async () => { calls++; return calls })
  const view = page(core, source, { enabled: true, every: 100_000 })

  view.submit({ id: 1 })
  await settle()
  assert.equal(calls, 1)

  // 到期＝结算时刻＋当前周期；改短之后锚点从 100 秒变成 20ms，所以很快就到期（U07「改频率立刻生效」）。
  view.set({ every: 20 })
  await sleep(50)
  assert.ok(calls >= 2, `改短之后按新周期取数，不必等旧的一百秒走完，实测 ${calls} 次`)

  // 同一个公式：改长就把到期推到 100 秒之后，旧的那个短周期不再起作用。
  view.set({ every: 100_000 })
  await settle()
  const frozen = calls
  await sleep(60)
  assert.equal(calls, frozen, '改长之后不再按旧的短周期取数')
})

test('A07/A04 最短周期现算：最急的那一页暂停后，到期按次小值推迟', async () => {
  let calls = 0
  const source = '/api/core/boundary/eligible-every'
  const core = newCore(2, async () => { calls++; return calls })
  const fast = page(core, source, { enabled: true, every: 10 })
  const slow = page(core, source, { enabled: true, every: 100_000 })

  slow.submit({ id: 1 })
  fast.submit({ id: 1 })
  await sleep(60)
  assert.ok(calls >= 3, `最小周期生效：60ms 内至少 3 次，实测 ${calls}`)

  // 周期只算**有资格的**声明者（U07、A04）：最急的那一页一暂停，到期立刻按次小值重算。
  // 注意暂停时**不动它的 every**：留着 10ms 才能证明「不算没有资格的声明者」这一条承重。
  fast.set({ enabled: false })
  await settle()
  const frozen = calls
  await sleep(60)
  assert.equal(calls, frozen, '最急的那一页暂停后不再按 10ms 取数')

  // 恢复那一页：最短周期立刻回到 10ms。
  fast.set({ enabled: true })
  await sleep(50)
  assert.ok(calls > frozen, `恢复后立刻按最小周期取数，实测 ${calls - frozen} 次`)
})

test('A07 到期从结算时刻起算：结算时刻与结果时间是同一个墙钟读数', async () => {
  const started: number[] = []
  const every = 150
  const source = '/api/core/boundary/settle-anchor'
  const core = newCore(2, async () => {
    started.push(Date.now())
    await sleep(400) // 取数真的花了时间：发起时刻与结算时刻差得出来
    return started.length
  })
  const view = page(core, source, { enabled: true, every })

  view.submit({ id: 1 })
  await sleep(450) // 这一轮真的跑完（传输花 400ms）
  const resource = snapshot(core).resources[0]
  const key = view.key()
  assert.ok(resource && key !== null, '实例在册')
  const cell = tableOf(core).read(source, key)
  const settledAt = resource.settledAt
  assert.ok(cell && settledAt !== null, '结果与结算时刻都在')

  // §2.5：一次取数里那个时刻同时是结算时刻与结果时间（同一个墙钟，因此两者可以直接比较）。
  assert.equal(settledAt, cell.updatedAt, '结算时刻就是结果时间')
  assert.ok(settledAt > (started[0] ?? 0), '结算发生在取数结束那一刻，晚于发起')
  // §0.4：到期＝「最近一次结算时刻 ＋ 当前最短周期」——锚在**结局**，不是发起。
  assert.equal(resource.dueAt(settledAt), settledAt + every, '到期＝结算时刻＋当前周期')

  // 行为面：发起后一个周期（150ms）早就过去了，但结算后才起算——此刻仍不该有新请求。
  // 锚在「发起时刻＋周期」的实现会在这里红。
  assert.equal(started.length, 1, '发起＋周期已过、结算＋周期未到：不取数')

  await sleep(250)
  assert.ok(started.length >= 2, '越过结算＋周期后照常取下一轮')
  const second = started[1]
  assert.ok(second !== undefined && second - settledAt >= every - 5,
    `第二轮晚于结算＋周期（实测 ${(second ?? 0) - settledAt}ms）`)
})

test('A18 变体：复制不了的值（函数、Proxy）一律拒绝，且不改动已定身份', async () => {
  const source = '/api/core/boundary/unclonable'
  const core = newCore(1, async () => 1)
  const view = page(core, source)

  view.submit({ id: 1 })
  await settle()
  const key = view.key()
  assert.ok(key !== null, '旧身份已定')

  // §3.5：函数与 Proxy 这类复制不了的值在**复制这一步**就被拒绝（原生 `structuredClone` 抛错），
  // 走不到编码；拒绝只经同步返回值，旧身份原样保留、结果表那一格不动（U15）。
  const unclonable: ReadonlyArray<readonly [string, object]> = [
    ['函数', () => 1],
    ['Proxy', new Proxy({ id: 1 }, {})],
  ]
  for (const [label, value] of unclonable) {
    assert.equal(view.submit({ id: value }).status, 'rejected', `${label}按非法参数拒绝`)
  }
  assert.equal(view.key(), key, '被拒的提交不改动已定身份')
  assert.equal(view.failedAt(), null, '输入问题只走同步返回值，不写结果表那一格')
})

test('A09 手动刷新的命令插到队首：先于更早排队的到期取数', async () => {
  const started: number[] = []
  const hold: Array<() => void> = []
  const source = '/api/core/boundary/queue-head'
  const core = newCore(1, async (_url, body) => {
    const id = (body as { id: number }).id
    started.push(id)
    if (id === 1) await new Promise<void>(resolve => { hold.push(resolve) })
    return id
  })
  const second = page(core, source, { enabled: true, every: 100_000 })
  const first = page(core, source, { enabled: true, every: 100_000 })
  const third = page(core, source, { enabled: true, every: 100_000 })

  // 二号先取完一轮：此后它未到期，手里**没有执行**（于是刷新会走「插到队首」那条分支）。
  second.submit({ id: 2 })
  await settle()
  assert.deepEqual(started, [2])

  // 一号占住唯一槽位；三号从未结算过、立刻到期，只能排队。
  first.submit({ id: 1 })
  await settle()
  third.submit({ id: 3 })
  await settle()
  assert.deepEqual(started, [2, 1], '槽位被一号占住')
  assert.deepEqual(snapshot(core).queued.map(resource => resource.parameters.key), [third.key()], '队里只有三号')
  assertQueueConsistent(core)

  // 手动刷新是「人正等着」的取数：没有执行就插到队头（U09、U14）。
  second.refresh()
  await settle()
  assert.deepEqual(
    snapshot(core).queued.map(resource => resource.parameters.key),
    [second.key(), third.key()],
    '刷新的命令插到队首，排在更早的到期取数前面',
  )
  assertQueueConsistent(core)

  hold[0]?.()
  await settle()
  await settle()
  assert.deepEqual(started, [2, 1, 2, 3], '槽位一空出来，先跑刷新的那一个，随后才是排队更久的那一个')
  assertQueueConsistent(core)
})

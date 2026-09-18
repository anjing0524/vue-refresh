// Shared business assertions: run unchanged in Playwright or the local browser page.
export type Snapshot = ReturnType<Window['experiment']['snapshot']>
export interface Driver {
  open(path: string): Promise<void>
  snapshot(): Promise<Snapshot>
  enable(name: string, value: boolean): Promise<void>
  resolve(id: number, price: number): Promise<void>
  mutatePage(name: string, price: number): Promise<void>
  refresh(name: string, symbol: string): Promise<void>
  nestedOuter(shown: boolean): Promise<void>
  visibility(hidden: boolean): Promise<void>
  unmount(): Promise<void>
  requests(): Promise<Array<{ id: number; status: string; body: string }>>
  release(id: number): Promise<void>
  price(name: string): Promise<string>
}
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** 观测面上某一页读到的价格；还没有数据（首查失败或尚未上屏）或没有这一页时为 `null`。 */
const shown = (view: Snapshot['pages'][string] | undefined): number | null => view?.data?.quote.price ?? null
/** 结果表某一格里最后一次成功的价格；从未成功过时为 `null`。 */
const stored = (row: Snapshot['entries'][string] | undefined): number | null => row?.data?.quote.price ?? null
async function until(condition: () => Promise<boolean>, message: string) {
  const end = performance.now() + 5_000
  while (!(await condition())) {
    if (performance.now() > end) throw new Error(`Timed out: ${message}`)
    await sleep(20)
  }
}

export const scenarios: Array<{ name: string; run: (d: Driver) => Promise<void> }> = [
  { name: 'A14 暂停后显式刷新：同一条共享路径取一次、只更新本页、不恢复自动刷新', async run(d) {
    await d.open('/?test')
    await until(async () => (await d.requests()).length === 1, 'initial shared request')
    await d.enable('甲', false); await d.enable('乙', false)
    // 暂停只失去资格（ADR-61）：声明、实例与结果都不回收，只是不再自动取数。
    // 甲换身份刷新一次：新身份建立自己的实例并产生一次共享请求。
    await d.refresh('甲', 'OTHER')
    await until(async () => (await d.requests()).length === 2, 'refresh request')
    await d.release((await d.requests())[1]!.id)
    await until(async () => (await d.snapshot()).pages['甲']?.args.symbol === 'OTHER', 'refresh settles')
    const state = await d.snapshot()
    check(state.pages['甲']?.args.symbol === 'OTHER' && state.pages['甲']?.manual === true, 'display contains refreshed parameters and the page knows it was its own refresh')
    check(state.pages['乙'] === null, 'paused page without a refresh requirement receives nothing')
    check(Object.keys(state.entries).length === 1 && state.resources === 2, '两个身份各一个实例：甲换身份后的结果留在结果表里')
    await sleep(200)
    check((await d.requests()).length === 2, 'refresh must not start polling')
  } },
  { name: 'A09/A14 刷新与自动刷新共用队列：满槽时排队，不绕过并发上限', async run(d) {
    await d.open('/?test&slots=1')
    await until(async () => (await d.requests()).length === 1, 'background fills slot')
    await d.enable('甲', false)
    await d.refresh('甲', 'OTHER')
    await sleep(200)
    const blocked = await d.snapshot()
    check(blocked.running === 1 && blocked.calls.length === 1 && blocked.queued === 1, 'refresh must queue behind the full slot')
    check(blocked.pages['甲'] === null, 'refresh has not settled while queued')
    await d.release((await d.requests())[0]!.id)
    await until(async () => (await d.requests()).length === 2, 'queued refresh starts once the slot is really free')
    await d.release((await d.requests())[1]!.id)
    await until(async () => await d.price('甲') === String(100 + 2), 'refresh settles after the slot frees')
    check((await d.snapshot()).pages['甲']!.manual, 'page knows the result came after its own refresh')
  } },

  { name: 'A02/A06 真实HTTP：共享、暂停冻结画面、在途不取消、恢复', async run(d) {
    await d.open('/?test')
    await until(async () => (await d.requests()).length === 1, 'one shared request')
    check((await d.snapshot()).calls.length === 1, 'two subscribers must share the first load')
    const first = (await d.requests())[0]!
    await d.release(first.id)
    await until(async () => await d.price('甲') === String(100 + first.id) && await d.price('乙') === String(100 + first.id), 'both pages receive result')
    await until(async () => (await d.requests()).length === 2, 'next periodic request')
    const second = (await d.requests())[1]!
    await d.enable('甲', false)
    check((await d.requests())[1]!.status === 'pending', 'first subscriber must not cancel shared I/O')
    check(!(await d.snapshot()).calls[1]!.aborted, 'shared signal must remain active')
    await d.release(second.id)
    await until(async () => await d.price('乙') === String(100 + second.id), 'remaining page updates')
    // 暂停页不是该身份的读者，画面冻结在最后一帧；别人取回的新结果它不跟随（ADR-60）。
    check(await d.price('甲') === String(100 + first.id), 'paused page must stay frozen')
    await until(async () => (await d.requests()).length === 3, 'third request in flight')
    await d.enable('乙', false)
    // 两页都暂停：只失去资格（ADR-61）——已经发出的请求不取消，声明、实例与结果表条目都留着。
    await sleep(100)
    const stopped = await d.snapshot()
    check((await d.requests())[2]!.status === 'pending' && !stopped.calls[2]!.aborted, '暂停不取消已经发出的请求')
    check(stopped.running === 1, '在途请求仍占着物理槽位')
    check(stopped.resources === 1 && Object.keys(stopped.entries).length === 1, '声明还在：实例与结果表条目都留着')
    await sleep(300)
    check((await d.requests()).length === 3, 'no refresh while all paused')
    // 重新激活甲：这一次仍在途，因此不并发第二次（A08）；让它真实结束，再按到期继续。
    await d.enable('甲', true)
    check((await d.requests()).length === 3, '在途未结束时不再发起第二次')
    const third = (await d.requests())[2]!
    await d.release(third.id)
    await until(async () => await d.price('甲') === String(100 + third.id), 'restored page reads the in-flight result')
    await until(async () => (await d.requests()).length === 4, 'next periodic request after the slot frees')
    const fourth = (await d.requests())[3]!
    await d.release(fourth.id)
    await until(async () => await d.price('甲') === String(100 + fourth.id), 'restored page updates')
    check(await d.price('乙') === String(100 + second.id), 'other paused page remains frozen')
    await d.enable('甲', false)
  } },
  { name: 'A13 真实传输超时：客户端截止生效、槽位释放、页面收到失败', async run(d) {
    await d.open('/?test&timeout=300&every=3000')
    await until(async () => (await d.requests()).length === 1, 'first request in flight')
    await until(async () => (await d.snapshot()).events.some(event => event.includes('后台请求失败')), 'page observes the timeout failure')
    const state = await d.snapshot()
    check(state.calls[0]!.finished, 'deadline ends the real request')
    check((await d.requests())[0]!.status === 'aborted', 'transport saw the disconnect')
    // 失败是那一格的事实（ADR-63）：首查就失败时画面**不是** null，而是「有失败、没有数据」。
    const timedOut = state.pages['甲']
    check(shown(timedOut) === null && (timedOut?.failedAt ?? null) !== null,
      'timed-out request delivers a failure and no data')
    check(state.running === 0 && state.queued === 0, 'deadline releases the physical slot')
    await sleep(1_000)
    check((await d.requests()).length === 1, 'next attempt waits for the interval, not a busy retry')
  } },
  { name: 'A11 换身份建立新实例：旧身份的结果写回自己那一份，两个身份互不覆盖', async run(d) {
    await d.open('/?mode=controlled')
    await until(async () => (await d.snapshot()).calls.length === 1, 'initial controlled load')
    await d.enable('甲', false); await d.enable('乙', false)
    const old = (await d.snapshot()).calls[0]!
    // 暂停只失去资格（ADR-61）：已经发出的请求仍然在跑，不会被取消，也不会因为暂停而丢掉实例。
    check(!old.aborted && !old.finished, 'pausing does not cancel the controlled load')
    // 甲换身份：新身份建立自己的实例与请求；旧身份那一次仍在途（乙还声明着它）。
    await d.refresh('甲', 'OTHER')
    await until(async () => (await d.snapshot()).calls.length === 2, 'new identity request')
    await d.resolve(2, 222)
    await until(async () => await d.price('甲') === '222', 'new identity result wins')
    const id = Object.keys((await d.snapshot()).entries)[0]!
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).running === 0, 'old request really finished')
    const now = await d.snapshot()
    check(shown(now.pages['甲']) === 222 && stored(now.entries[id]) === 222, '旧身份的结果不会覆盖新身份那一份')
    check(now.resources === 2, '两个身份各一个实例（旧身份由仍暂停的乙声明着）')
    check(!now.events.some(e => e.includes('失败')), '两个身份都不产生失败通知')
    // 乙仍在暂停，而且它还没读到过任何一版：没有读取时间就直接读——那一份结果照常上屏；此后它有了
    // 上次读取时间，就冻在那儿不再跟随（ADR-72）。重新激活后直接读回自己身份当前那一份（不重查）。
    check(shown(now.pages['乙']) === 111, 'paused page without a last-read time reads the first version, then freezes')
    await d.enable('乙', true)
    await until(async () => await d.price('乙') === '111', 'restored page reads the current value of its own identity')
    check((await d.snapshot()).calls.length === 2, 'restoring reads the existing entry without a new request')
    await d.mutatePage('甲', 999)
    const isolated = await d.snapshot()
    // 结果是共享对象（ADR-59）：甲改的就是结果表里那一份（页面与结果表一起变）；乙读的是另一个身份，不受影响。
    check(shown(isolated.pages['甲']) === 999 && stored(isolated.entries[id]) === 999, 'mutation of the shared entry is visible through the reader and the Store')
    check(shown(isolated.pages['乙']) === 111, 'another identity is unaffected')
  } },
  { name: 'A09 真实结束才放槽：等待期间不启动、不忙循环', async run(d) {
    await d.open('/?mode=controlled&slots=1')
    await until(async () => (await d.snapshot()).calls.length === 1, 'initial load fills slot')
    // 乙换身份：第二个身份要取数，但槽位被占满 → 排队；不取消在途、也不自旋
    // （ADR-61 下不再用「暂停」制造取消，槽位只按真实结束交还）。
    await d.refresh('乙', 'OTHER')
    await until(async () => (await d.snapshot()).queued === 1, 'new task queues')
    await sleep(200)
    const blocked = await d.snapshot()
    // 「不自旋」的证据是这 200ms 里请求数没有增长（`calls.length === 1`）＋队列没被反复重建（`queued === 1`）。
    // 原还断言「没有正在 flush、没有唤醒 Timer」，那两项投影已随 ADR-74 从观测面删除（见 DESIGN §4.2）。
    check(blocked.running === 1 && blocked.calls.length === 1 && blocked.queued === 1, 'a full slot must queue without spinning')
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).calls.length === 2, 'real empty slot advances queue')
    check(shown((await d.snapshot()).pages['甲']) === 111, 'the first request delivers to its own identity')
    await d.resolve(2, 222)
    await until(async () => await d.price('乙') === '222', 'queued request actually delivers')
  } },
  { name: 'A06 卸载清理：晚到执行不复活资源', async run(d) {
    await d.open('/?mode=controlled')
    await until(async () => (await d.snapshot()).calls.length === 1, 'load before unmount')
    await d.unmount()
    check((await d.snapshot()).calls[0]!.aborted, 'unmount must abort')
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).running === 0, 'late load settled')
    const now = await d.snapshot()
    // 备注：`timer` 投影已随 ADR-74 从观测面删除，「卸载后没有残留唤醒 Timer」这条观测随之消失
    // ——它由 `dispose` 自己的清理保证（见 DESIGN §4.2）。
    check(!now.resources && !now.queued && !Object.keys(now.entries).length && now.pages['甲'] === null, 'disposed state must stay empty')
  } },

  { name: 'A04/A06 真实浏览器下祖先 KeepAlive 失活与受控 visibilitychange', async run(d) {
    // controlled 模式下 harness 的 deferred 先于 HTTP 发起，因此断言走 calls／pages，而不是 fixture 的请求表。
    await d.open('/?mode=controlled')
    const calls = async () => (await d.snapshot()).calls
    const nestedDisplay = async () => (await d.snapshot()).pages['嵌套']
    await until(async () => (await calls()).length === 1, '共享首查一次')
    // 先让共享首查真实结束：controlled 模式下未结算的 harness deferred 会一直占着物理槽。
    await d.resolve(1, 101)
    await until(async () => (await d.snapshot()).pages['甲'] !== null, '共享首查交付')
    // 挂载双层 KeepAlive 组合：嵌套页声明自己的身份并首查。
    await d.nestedOuter(true)
    await until(async () => (await calls()).length === 2, '嵌套页首查')
    const first = (await calls())[1]!.id
    await d.resolve(first, 100 + first)
    await until(async () => shown(await nestedDisplay()) === 100 + first, '嵌套页拿到首查结果')
    check((await d.snapshot()).resources === 2, '两个身份各自一个实例')

    // 祖先失活：外层 KeepAlive 切走 → 嵌套页 deactivated → 只失去资格（ADR-61）：
    // 声明、实例与结果都留着，也不再取数；没有「重建」这一步。
    const before = (await calls()).length
    await d.nestedOuter(false)
    await sleep(200)
    check((await d.snapshot()).resources === 2, '祖先失活只失去资格：两个实例都留着')
    check((await calls()).length === before, '祖先失活不得产生请求')
    check(shown(await nestedDisplay()) === 100 + first, '失活时画面保留')

    // 切回：仍是同一个实例与同一份结果（未到期），所以不重取，画面保持不变。
    await d.nestedOuter(true)
    await sleep(200)
    check((await calls()).length === before, '激活直接读回：未到期不重复取数')
    check((await d.snapshot()).resources === 2, '激活不重建实例')
    check(shown(await nestedDisplay()) === 100 + first, '激活后画面仍是同一份结果')

    // 受控 visibilitychange：走 app.ts 注册的那条真实监听，而不是直接调用核心（隐藏 ＝ 环境不允许）。
    await d.visibility(true)
    await sleep(200)
    check((await d.snapshot()).resources === 2, '隐藏只失去资格：声明与实例都留着')
    check((await calls()).length === before, '隐藏期间不产生请求')
    await d.visibility(false)
    await sleep(200)
    check((await calls()).length === before, '显示后未到期，不重复取数')
    // 显示后资格恢复：一次显式刷新真的能取到数（证明这一页又「活着」，且请求走的是同一条共享路径）。
    await d.refresh('甲', 'DEMO')
    await until(async () => (await calls()).length === before + 1, '显示后显式刷新取一次')
    const resumed = (await calls())[before]!.id
    await d.resolve(resumed, 0)
    await until(async () => (await d.snapshot()).running === 0, '显示后的刷新真实结束')

    // 卸载后：监听不再产生任何可观察效果（「监听已摘除」本身需要 CDP 才能取证，见 README）。
    await d.unmount()
    const disposed = (await calls()).length
    await d.visibility(true)
    await sleep(200)
    check((await calls()).length === disposed, '卸载后派发 visibilitychange 不产生请求')
    const final = await d.snapshot()
    check(final.running === 0 && final.queued === 0, '卸载后没有在途或排队任务')
  } },
]

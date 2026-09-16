// Shared business assertions: run unchanged in Playwright or the local browser page.
export type Snapshot = ReturnType<Window['experiment']['snapshot']>
export interface Driver {
  open(path: string): Promise<void>
  snapshot(): Promise<Snapshot>
  enable(name: string, value: boolean): Promise<void>
  resolve(id: number, price: number): Promise<void>
  mutatePage(name: string, price: number): Promise<void>
  refresh(name: string, symbol: string): Promise<void>
  unmount(): Promise<void>
  requests(): Promise<Array<{ id: number; status: string }>>
  release(id: number): Promise<void>
  price(name: string): Promise<string>
}
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(condition: () => Promise<boolean>, message: string) {
  const end = performance.now() + 5_000
  while (!(await condition())) {
    if (performance.now() > end) throw new Error(`Timed out: ${message}`)
    await sleep(20)
  }
}

export const scenarios: Array<{ name: string; run: (d: Driver) => Promise<void> }> = [
  { name: '暂停后显式刷新：同一条共享路径取一次、只更新本页、不恢复自动刷新', async run(d) {
    await d.open('/?test')
    await until(async () => (await d.requests()).length === 1, 'initial shared request')
    await d.enable('甲', false); await d.enable('乙', false)
    // 两页都暂停后实例已清理；甲刷新一次：临时要求建立实例并产生一次共享请求。
    await d.refresh('甲', 'OTHER')
    await until(async () => (await d.requests()).length === 2, 'refresh request')
    await d.release((await d.requests())[1]!.id)
    await until(async () => (await d.snapshot()).queryResults['甲']?.status === 'success', 'refresh settles')
    const state = await d.snapshot()
    check(state.pages['甲']!.args.symbol === 'OTHER' && state.pages['甲']!.origin === 'refresh', 'display contains refreshed parameters and origin')
    check(state.pages['乙'] === null, 'paused page without a refresh requirement receives nothing')
    check(Object.keys(state.entries).length === 0 && state.resources === 0, 'temporary requirement is cleaned up once it settles')
    await sleep(200)
    check((await d.requests()).length === 2, 'refresh must not start polling')
  } },
  { name: '刷新与自动刷新共用队列：满槽时排队，不绕过并发上限', async run(d) {
    await d.open('/?test&slots=1')
    await until(async () => (await d.requests()).length === 1, 'background fills slot')
    await d.enable('甲', false)
    await d.refresh('甲', 'OTHER')
    await sleep(200)
    const blocked = await d.snapshot()
    check(blocked.running === 1 && blocked.calls.length === 1 && blocked.queued === 1, 'refresh must queue behind the full slot')
    check(blocked.queryResults['甲'] === null, 'refresh has not settled while queued')
    await d.release((await d.requests())[0]!.id)
    await until(async () => (await d.requests()).length === 2, 'queued refresh starts once the slot is really free')
    await d.release((await d.requests())[1]!.id)
    await until(async () => (await d.snapshot()).queryResults['甲']?.status === 'success', 'refresh settles after the slot frees')
    check(await d.price('甲') === String(100 + 2), 'refresh delivered the shared result to the initiating paused page')
  } },

  { name: '真实HTTP：共享、单页冻结、最后取消、恢复', async run(d) {
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
    check(await d.price('甲') === String(100 + first.id), 'paused page must stay frozen')
    await until(async () => (await d.requests()).length === 3, 'third request in flight')
    await d.enable('乙', false)
    await until(async () => (await d.requests())[2]!.status === 'aborted', 'real HTTP disconnect')
    await until(async () => (await d.snapshot()).running === 0 && !(await d.snapshot()).timer, 'actual completion releases slot and timer')
    const stopped = await d.snapshot()
    check(stopped.calls[2]!.aborted && stopped.calls[2]!.finished, 'abort and execution completion both observed')
    check(stopped.resources === 0 && Object.keys(stopped.entries).length === 0, 'last exit removes resource and Store entry')
    await sleep(300)
    check((await d.requests()).length === 3, 'no refresh while all paused')
    await d.enable('甲', true)
    await until(async () => (await d.requests()).length === 4, 'restoration starts new request')
    const fourth = (await d.requests())[3]!
    await d.release(fourth.id)
    await until(async () => await d.price('甲') === String(100 + fourth.id), 'restored page updates')
    check(await d.price('乙') === String(100 + second.id), 'other paused page remains frozen')
    await d.enable('甲', false)
  } },
  { name: '真实传输超时：客户端截止生效、槽位释放、页面收到失败', async run(d) {
    await d.open('/?test&timeout=300&every=3000')
    await until(async () => (await d.requests()).length === 1, 'first request in flight')
    await until(async () => (await d.snapshot()).events.some(event => event.includes('后台请求失败')), 'page observes the timeout failure')
    const state = await d.snapshot()
    check(state.calls[0]!.finished, 'deadline ends the real request')
    check((await d.requests())[0]!.status === 'aborted', 'transport saw the disconnect')
    check(state.pages['甲'] === null, 'timed-out request delivers nothing')
    check(state.running === 0 && state.queued === 0, 'deadline releases the physical slot')
    await sleep(1_000)
    check((await d.requests()).length === 1, 'next attempt waits for the interval, not a busy retry')
  } },
  { name: '旧响应晚到：新资源不被覆盖或删除，页面副本独立', async run(d) {
    await d.open('/?mode=controlled')
    await until(async () => (await d.snapshot()).calls.length === 1, 'initial controlled load')
    await d.enable('甲', false); await d.enable('乙', false)
    const old = (await d.snapshot()).calls[0]!
    check(old.aborted && !old.finished, 'logical cancellation is not physical completion')
    await d.enable('甲', true)
    await until(async () => (await d.snapshot()).calls.length === 2, 'new resource request')
    await d.resolve(2, 222)
    await until(async () => await d.price('甲') === '222', 'new result wins')
    const id = Object.keys((await d.snapshot()).entries)[0]!
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).running === 0, 'old finally completed')
    const now = await d.snapshot()
    check(now.pages['甲']!.data.quote.price === 222 && now.entries[id]!.data.quote.price === 222 && now.resources === 1, 'old completion must not write or delete new resource')
    check(!now.events.some(e => e.includes('失败')), 'old cancellation must not notify failure')
    await d.enable('乙', true)
    await until(async () => await d.price('乙') === '222', 'existing snapshot delivered to returning subscriber')
    check((await d.snapshot()).calls.length === 2, 'ordinary restore with fresh history must not force another load')
    await d.mutatePage('甲', 999)
    const isolated = await d.snapshot()
    check(isolated.pages['乙']!.data.quote.price === 222 && isolated.entries[id]!.data.quote.price === 222, 'nested page mutation must not alias another page or Store')
  } },
  { name: '真实结束才放槽：等待期间不启动、不忙循环', async run(d) {
    await d.open('/?mode=controlled&slots=1')
    await until(async () => (await d.snapshot()).calls.length === 1, 'initial load fills slot')
    await d.enable('甲', false); await d.enable('乙', false); await d.enable('甲', true)
    await until(async () => (await d.snapshot()).queued === 1, 'new task queues')
    await sleep(200)
    const blocked = await d.snapshot()
    check(blocked.running === 1 && blocked.calls.length === 1 && !blocked.pending && !blocked.timer, 'abort must not release slot or spin scheduler')
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).calls.length === 2, 'real empty slot advances queue')
    check((await d.snapshot()).pages['甲'] === null, 'cancelled result must not publish')
    await d.resolve(2, 222)
    await until(async () => await d.price('甲') === '222', 'queued request actually delivers')
  } },
  { name: '卸载清理：晚到执行不复活资源', async run(d) {
    await d.open('/?mode=controlled')
    await until(async () => (await d.snapshot()).calls.length === 1, 'load before unmount')
    await d.unmount()
    check((await d.snapshot()).calls[0]!.aborted, 'unmount must abort')
    await d.resolve(1, 111)
    await until(async () => (await d.snapshot()).running === 0, 'late load settled')
    const now = await d.snapshot()
    check(!now.resources && !now.queued && !now.timer && !Object.keys(now.entries).length && now.pages['甲'] === null, 'disposed state must stay empty')
  } },
]

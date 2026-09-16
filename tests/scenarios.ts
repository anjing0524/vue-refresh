// Shared business assertions: run unchanged in Playwright or the local browser page.
export type Snapshot = ReturnType<Window['experiment']['snapshot']>
export interface Driver {
  open(path: string): Promise<void>
  snapshot(): Promise<Snapshot>
  enable(name: string, value: boolean): Promise<void>
  resolve(id: number, price: number): Promise<void>
  mutatePage(name: string, price: number): Promise<void>
  query(name: string, symbol: string): Promise<void>
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
  { name: '暂停后独立查询：固定interface对象、只更新本页、不写共享分区', async run(d) {
    await d.open('/?test')
    await until(async () => (await d.requests()).length === 1, 'initial shared request')
    await d.enable('甲', false); await d.enable('乙', false)
    await d.query('甲', 'OTHER')
    await until(async () => (await d.requests()).length === 2, 'independent query')
    await d.release((await d.requests())[1]!.id)
    await until(async () => (await d.snapshot()).queryResults['甲']?.status === 'success', 'query settles')
    const state = await d.snapshot()
    check(state.pages['甲']!.args.symbol === 'OTHER' && state.pages['甲']!.origin === 'query', 'display contains query parameters and origin')
    check(state.pages['乙'] === null && state.resources === 0 && Object.keys(state.entries).length === 0, 'paused query must not publish shared data')
    await sleep(200)
    check((await d.requests()).length === 2, 'paused query must not start background refresh')
  } },
  { name: '独立查询不等后台槽：关闭立即取消，其他订阅继续', async run(d) {
    await d.open('/?test&slots=1')
    await until(async () => (await d.requests()).length === 1, 'background fills slot')
    await d.query('甲', 'OTHER')
    await until(async () => (await d.requests()).length === 2, 'query bypasses full slot')
    check((await d.snapshot()).running === 1, 'query must not consume background slot')
    await d.enable('甲', false)
    await until(async () => (await d.snapshot()).queryResults['甲']?.status === 'cancelled', 'query cancellation settles')
    const result = (await d.snapshot()).queryResults['甲']!
    check(result.status === 'cancelled' && result.reason === 'unavailable', 'close edge cancellation reason')
    check(!(await d.snapshot()).calls[0]!.aborted, 'remaining subscriber keeps background request')
    await d.release((await d.requests())[0]!.id)
    await until(async () => (await d.snapshot()).pages['乙'] !== null, 'remaining page receives data')
    check((await d.snapshot()).pages['甲'] === null, 'cancelled query cannot publish')
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

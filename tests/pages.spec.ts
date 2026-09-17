/**
 * 代表页面的交互断言（阶段 12）：三条页面与 B09 组合的关键交互全部由真实点击/输入驱动，
 * 断言读的是页面渲染出来的文本、HTTP fixture 的请求记录与示例的只读观测面。
 *
 * 使用 fixture 的手动结算（`manual: true`）：请求只有被显式 release 才结束，
 * 因此「什么时候真的完成」由测试决定，断言不依赖 700ms 的机器速度。
 */
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

interface Row { id: number; status: string; query: string }

test.describe.configure({ timeout: 45_000 })

const state = async (request: APIRequestContext): Promise<Row[]> =>
  await (await request.get('/__fixture/state')).json() as Row[]

const param = (row: Row, name: string): string | null => new URLSearchParams(row.query).get(name)
const symbolOf = (row: Row): string | null => param(row, 'symbol')

/** 最后一条匹配的请求号；`Array.findLast` 不在 ES2022 lib 内，这里手写。 */
function lastId(rows: Row[], predicate: (row: Row) => boolean): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (predicate(row)) return row.id
  }
  return undefined
}

const pendingId = async (request: APIRequestContext): Promise<number> => {
  await expect.poll(async () => lastId(await state(request), row => row.status === 'pending') ?? 0)
    .toBeGreaterThan(0)
  return lastId(await state(request), row => row.status === 'pending')!
}
const release = async (request: APIRequestContext, id: number): Promise<void> => {
  await request.post(`/__fixture/release/${id}`)
}
const releasePending = async (request: APIRequestContext): Promise<void> => {
  for (const row of await state(request)) if (row.status === 'pending') await release(request, row.id)
}
const inspect = (page: Page) => page.evaluate(() => window.pages.inspect())

test.beforeEach(async ({ request, page }) => {
  await request.post('/__fixture/reset', { data: { manual: true } })
  page.on('pageerror', error => { throw error })
})

test('查询列表：提交才发请求、分页排序复用已提交参数、独立启停、暂停仍可刷新、失败关闭', async ({ page, request }) => {
  await page.goto('/?page=query-list')
  await expect(page.getByTestId('page-query-list')).toBeVisible()

  // 完整参数提交：一次提交四个字段，构成共享身份。
  await expect(page.getByTestId('ql-submitted')).toHaveText('已提交参数：demo / SH / 第 1 页 / 按价格')
  await expect(page.getByTestId('ql-diff')).toHaveText('表单与已提交参数一致')
  const first = await pendingId(request)
  expect(param((await state(request))[0]!, 'market')).toBe('SH')
  expect(param((await state(request))[0]!, 'page')).toBe('1')
  expect(param((await state(request))[0]!, 'sortBy')).toBe('price')
  await release(request, first)
  await expect(page.getByTestId('ql-price-600000')).toHaveText(`${100 + first * 10}.00`)

  // 独立启停：暂停后不再产生后台请求；改表单与提交都只改页面事实。
  await page.getByTestId('ql-toggle').click()
  await expect(page.getByTestId('ql-status')).toHaveText('已暂停')
  const idle = (await state(request)).length
  await page.getByTestId('ql-page').fill('2')
  await page.getByTestId('ql-sort').selectOption('volume')
  await expect(page.getByTestId('ql-diff')).toHaveText('表单有未提交修改')
  await page.getByTestId('ql-submit').click()
  await expect(page.getByTestId('ql-submitted')).toHaveText('已提交参数：demo / SH / 第 2 页 / 按成交量')
  await page.waitForTimeout(300)
  expect((await state(request)).length).toBe(idle)
  expect((await state(request)).some(row => param(row, 'page') === '2')).toBe(false)

  // 恢复：立即按已提交参数取数，而不是回到表单草稿或旧参数。
  await page.getByTestId('ql-toggle').click()
  await expect.poll(async () => lastId(await state(request), row => param(row, 'page') === '2') ?? 0).toBeGreaterThan(0)
  const revalidated = lastId(await state(request), row => param(row, 'page') === '2')!
  expect(param((await state(request)).find(row => row.id === revalidated)!, 'sortBy')).toBe('volume')
  await release(request, revalidated)
  await expect(page.getByTestId('ql-origin')).toContainText('共享刷新')
  await expect(page.getByTestId('ql-price-600000')).toHaveText(`${100 + revalidated * 10}.00`)

  // 暂停后仍可刷新一次：走同一条共享路径更新本页，不恢复自动刷新。
  await page.getByTestId('ql-toggle').click()
  await expect(page.getByTestId('ql-status')).toHaveText('已暂停')
  const frozen = (await state(request)).length
  await page.getByTestId('ql-once').click()
  const refreshed = await pendingId(request)
  expect((await state(request)).length).toBe(frozen + 1)
  await release(request, refreshed)
  await expect(page.getByTestId('ql-origin')).toContainText('本页刷新')
  await expect(page.getByTestId('ql-price-600000')).toHaveText(`${100 + refreshed * 10}.00`)
  await page.waitForTimeout(500)
  const afterQuery = (await state(request)).length
  expect(afterQuery).toBe(frozen + 1)

  // 失败关闭：框架只通知，关闭由页面在 onError 里做；画面保留。
  const kept = await page.getByTestId('ql-price-600000').innerText()
  await request.post('/__fixture/fail-next', { data: { count: 1 } })
  await page.getByTestId('ql-toggle').click()
  await expect(page.getByTestId('ql-status')).toHaveText('已暂停')
  await expect(page.getByTestId('ql-note')).toContainText('页面关闭自动刷新')
  await expect(page.getByTestId('ql-price-600000')).toHaveText(kept)
  expect((await state(request)).filter(row => row.status === 'failed').length).toBe(1)
  await page.waitForTimeout(800)
  expect((await state(request)).length).toBe(afterQuery + 1)
})

test('行情面板：无查询按钮、一次提交、响应式频率、显示多旧、首查失败继续、失活冻结', async ({ page, request }) => {
  await request.post('/__fixture/fail-next', { data: { count: 1 } })
  await page.goto('/?page=quote-panel')
  await expect(page.getByTestId('page-quote-panel')).toBeVisible()

  // 无查询按钮：面板只有配置输入与失活开关。
  expect(await page.locator('[data-testid="qp-query"]').count()).toBe(0)

  // 后台首查失败继续：失败不关闭需求，下个周期继续取数。
  await expect(page.getByTestId('qp-failures')).toHaveText('后台失败次数：1')
  await expect(page.getByTestId('qp-note')).toContainText('保留开启意愿')
  expect((await state(request))[0]!.status).toBe('failed')
  const retry = await pendingId(request)
  await release(request, retry)
  await expect(page.getByTestId('qp-price')).toHaveText(`${100 + retry}.00`)

  // 一次提交已准备参数对象；频率变化与重渲染都不再提交。
  await expect(page.getByTestId('qp-submits')).toHaveText('提交次数：1')
  await expect(page.getByTestId('qp-submitted')).toContainText('demo / DEMO')

  // 显示数据多旧：时间与相对年龄都来自交付面的 updatedAt，页面不自建 Timer。
  await expect(page.getByTestId('qp-age')).toContainText('数据时间：')
  await expect(page.getByTestId('qp-age')).toContainText('秒前')

  // 频率变化不再解释成数据失效：改成 5 秒后保留在途请求，也不立刻补一次。
  await page.getByTestId('qp-every').selectOption('5000')
  const quiet = (await state(request)).length
  await page.waitForTimeout(3_200)
  expect((await state(request)).length).toBe(quiet)

  // 响应式频率：改回 1 秒后明显变密。
  await page.getByTestId('qp-every').selectOption('1000')
  await expect.poll(async () => (await state(request)).length).toBeGreaterThan(quiet)
  await releasePending(request)
  await expect.poll(async () => (await state(request)).length, { timeout: 10_000 }).toBeGreaterThan(quiet + 1)
  await releasePending(request)
  await expect(page.getByTestId('qp-submits')).toHaveText('提交次数：1')

  // 失活冻结：KeepAlive 切走后不再请求。
  await page.getByTestId('qp-toggle-live').click()
  await expect(page.getByTestId('qp-state')).toHaveText('面板已失活（冻结）')
  await releasePending(request)
  const frozen = (await state(request)).length
  await page.waitForTimeout(2_500)
  expect((await state(request)).length).toBe(frozen)

  // 切回：同一个实例恢复（不重新提交），并重新取数。
  await page.getByTestId('qp-toggle-live').click()
  await expect(page.getByTestId('qp-state')).toHaveText('面板已激活')
  await expect(page.getByTestId('qp-submits')).toHaveText('提交次数：1')
  const resumed = await pendingId(request)
  expect(resumed).toBeGreaterThan(0)
})

test('双组件共享：1s/5s 同参共享、单页暂停、重新进入交付已有结果、切换品种、全部退订、快照隔离', async ({ page, request }) => {
  await page.goto('/?page=shared-pair')
  await expect(page.getByTestId('page-shared-pair')).toBeVisible()

  // 1s/5s 同参共享：一次 load 交付给两个订阅（两份快照显示同一个请求号）。
  const first = await pendingId(request)
  await release(request, first)
  await expect(page.getByTestId('sp-request-甲')).toContainText(`来自请求 ${first} · DEMO`)
  await expect(page.getByTestId('sp-request-乙')).toContainText(`来自请求 ${first} · DEMO`)
  await expect(page.getByTestId('sp-price-甲')).toHaveText(`${100 + first}.00`)
  await expect(page.getByTestId('sp-price-乙')).toHaveText(`${100 + first}.00`)

  // 单页暂停：共享 I/O 不因一个订阅退出而取消，另一页继续收到新结果。
  const second = await pendingId(request)
  await page.getByTestId('sp-toggle-甲').click()
  const inFlight = (await state(request)).find(row => row.id === second)!
  expect(inFlight.status).toBe('pending')
  await release(request, second)
  await expect(page.getByTestId('sp-price-乙')).toHaveText(`${100 + second}.00`)
  await expect(page.getByTestId('sp-price-甲')).toHaveText(`${100 + first}.00`)

  // 重新进入：卸载甲后乙仍持有实例；重新挂载把已有结果直接交付给新订阅，不强制新请求。
  await page.getByTestId('sp-unmount-a').click()
  await expect.poll(async () => (await inspect(page)).resources).toBe(1)
  const beforeReenter = (await state(request)).length
  await page.getByTestId('sp-mount-a').click()
  await expect(page.getByTestId('sp-request-甲')).toContainText(`来自请求 ${second} · DEMO`)
  expect((await state(request)).length).toBe(beforeReenter)

  // Store 快照隔离：页面副本被篡改不影响共享分区与另一页。
  await page.getByTestId('sp-read-snapshot').click()
  await expect(page.getByTestId('sp-snapshot')).toHaveText(`共享快照（readSnapshot）：${100 + second}.00`)
  await page.getByTestId('sp-mutate-a').click()
  await expect(page.getByTestId('sp-copies')).toContainText('甲 999.00')
  await expect(page.getByTestId('sp-copies')).toContainText(`乙 ${100 + second}.00`)
  await expect(page.getByTestId('sp-price-乙')).toHaveText(`${100 + second}.00`)
  await page.getByTestId('sp-read-snapshot').click()
  await expect(page.getByTestId('sp-snapshot')).toHaveText(`共享快照（readSnapshot）：${100 + second}.00`)

  // 切换品种：新参数即新身份，两页一起换到新实例。
  await page.getByTestId('sp-symbol').selectOption('DEMO2')
  await expect.poll(async () => lastId(await state(request), row => symbolOf(row) === 'DEMO2') ?? 0)
    .toBeGreaterThan(0)
  const switched = lastId(await state(request), row => symbolOf(row) === 'DEMO2')!
  await release(request, switched)
  await expect(page.getByTestId('sp-price-甲')).toHaveText(`${100 + switched}.00`)
  await expect(page.getByTestId('sp-price-乙')).toHaveText(`${100 + switched}.00`)

  // 全部退订：实例、分区与句柄一起消失。
  await page.getByTestId('sp-unmount-all').click()
  await expect.poll(async () => (await inspect(page)).resources).toBe(0)
  expect((await inspect(page)).entries).toBe(0)
  expect((await inspect(page)).handles).toBe(0)

  // 重新进入两页：分区已删除，重新首查。
  await page.getByTestId('sp-remount').click()
  await expect.poll(async () => (await inspect(page)).resources).toBe(1)
  const fresh = await pendingId(request)
  await release(request, fresh)
  await expect(page.getByTestId('sp-price-甲')).toHaveText(`${100 + fresh}.00`)
})

test('A05/A14 无启停按钮，前次失败后在同一个同步块里开启意愿并声明新身份，不先请求旧参数', async ({ page, request }) => {
  await request.post('/__fixture/fail-next', { data: { count: 1 } })
  await page.goto('/?page=b09')
  await expect(page.getByTestId('page-b09')).toBeVisible()

  // 无启停按钮。
  expect(await page.locator('[data-testid="b09-toggle"]').count()).toBe(0)

  // 前次失败：页面在 onError 里关闭意愿，框架不代劳。
  await expect(page.getByTestId('b09-failures')).toHaveText('前次后台失败：1 次')
  await expect(page.getByTestId('b09-state')).toHaveText('开启意愿：假（页面已关闭）')
  const before = await state(request)
  expect(before.length).toBe(1)
  expect(symbolOf(before[0]!)).toBe('B09')
  expect(before[0]!.status).toBe('failed')

  // 同步块内开启意愿并声明新身份：第一笔就是新参数，不先按旧参数发共享请求。
  await page.getByTestId('b09-refresh').click()
  await expect.poll(async () => (await state(request)).length).toBe(2)
  const afterQuery = await state(request)
  expect(symbolOf(afterQuery[1]!)).toBe('B09-NEW')
  expect(afterQuery.slice(1).some(row => symbolOf(row) === 'B09')).toBe(false)

  // 刷新成功后转为普通订阅：仍按新参数继续取数。
  await release(request, afterQuery[1]!.id)
  await expect(page.getByTestId('b09-request')).toContainText('B09-NEW')
  await expect(page.getByTestId('b09-state')).toHaveText('开启意愿：真')
  // 刷新成功后按普通订阅继续：下一次请求由新间隔（5 秒）到期产生。
  await expect.poll(async () => (await state(request)).length, { timeout: 8_000 }).toBe(3)
  const background = (await state(request))[2]!
  expect(symbolOf(background)).toBe('B09-NEW')
  await release(request, background.id)
  await expect(page.getByTestId('b09-price')).toHaveText(`${100 + background.id}.00`)
})

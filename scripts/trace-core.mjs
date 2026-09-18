// 差分轨迹：用同一套脚本化场景驱动 RefreshCore，打印**只看结构、不看时间**的可观测轨迹。
//
// 用途：任何声称「零行为变化」的重构（改名字、提取函数、换一种写法）都可以在改动前后各跑一遍，
// 用 `cmp` 对比两份轨迹是否逐字节相同——这是单测之外更强的证据（单测只覆盖它覆盖到的分支）。
//
// 轨迹里**不出现任何时间戳**（`settledAt` / `updatedAt` 都只打「有没有」），也不依赖真实时钟：
// 每个场景用显式 resolve/reject 推进请求，因此同一份代码每次跑出的轨迹都一样。
//
// 运行：node scripts/trace-core.mjs [> 轨迹文件]
import { RefreshCore } from '../src/core.ts'
import { defineRefresh, prepareParameters } from '../src/source.ts'

/** 结果表替身：记录写入顺序，只暴露「结构」。 */
function newTable() {
  const writes = []
  const cells = new Map()
  const id = (url, key) => `${url}\u0000${key}`
  return {
    writes,
    sink: {
      write: (url, key, data) => {
        cells.set(id(url, key), { data, failed: false })
        writes.push(`write ${url} ${key} ${JSON.stringify(data)}`)
      },
      fail: (url, key) => {
        const previous = cells.get(id(url, key))
        cells.set(id(url, key), { data: previous?.data, failed: true })
        writes.push(`fail ${url} ${key}`)
      },
      remove: (url, key) => {
        cells.delete(id(url, key))
        writes.push(`remove ${url} ${key}`)
      },
      list: () => [...cells].map(([k, cell]) => ({ url: k.split('\u0000')[0], key: k.split('\u0000')[1], cell })),
    },
    /** 一格的结构视图：有没有数据、是不是失败态、失败过没有——都没有时间戳。 */
    cell: (url, key) => {
      const cell = cells.get(id(url, key))
      if (!cell) return 'none'
      return `data=${cell.data === undefined ? 'none' : JSON.stringify(cell.data)} failed=${cell.failed}`
    },
  }
}

/** 每个场景一个核心：传输由用例显式放行，顺序完全确定。 */
function newCore(maxConcurrent) {
  const table = newTable()
  const pending = []
  const core = new RefreshCore(maxConcurrent, {
    // 传输的形状对齐真实 axios：成功要交回 `{ data }`，否则核心会按「结果非法」判失败。
    post: () => new Promise((resolve, reject) => {
      pending.push({ resolve: value => { resolve({ data: value }) }, reject })
    }),
  }, table.sink)
  return { core, table, pending }
}

const config = (enabled, every = 100_000, active = true) => ({ enabled, every, active })
const source = defineRefresh('/api/trace', {})
const params = args => prepareParameters(args, source)

/** 一步一行：先打印这一步做了什么，再打印核心此刻的结构。 */
function step(trace, label, core) {
  const view = core.snapshot()
  const running = view.running.length
  const queued = view.queued.length
  // 注意用**替身自己**的格子形状（`{data, failed}`），不要去读核心那套字段名。
  const cells = view.results
    .map(row => `${row.key}:${row.cell.data === undefined ? 'nodata' : 'data'}${row.cell.failed ? '+failed' : ''}`)
    .sort()
  trace.push(`${label} | resources=${view.resources.length} declarers=${view.declarers.length} queued=${queued} running=${running} timer=${view.scheduled} cells=[${cells.join(',')}]`)
}

const trace = []
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

// S1 两个页面同身份：合并成一次取数，结果写进同一格
{
  const { core, pending } = newCore(2)
  const a = config(true)
  const b = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  step(trace, 'S1 submit a', core)
  core.submit(b, '/api/trace', params({ id: 1 }))
  core.submit(b, '/api/trace', params({ id: 1 })) // 同身份幂等
  step(trace, 'S1 submit b（幂等）', core)
  await settle()
  step(trace, 'S1 排到执行', core)
  pending[0].resolve(7)
  await settle()
  step(trace, 'S1 成功', core)
  core.dispose()
}

// S2 换身份：旧实例由另一个声明者保留，新身份建自己的实例
{
  const { core, pending } = newCore(2)
  const a = config(true)
  const b = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  core.submit(b, '/api/trace', params({ id: 1 }))
  await settle()
  pending[0].resolve(1)
  await settle()
  core.submit(a, '/api/trace', params({ id: 2 }))
  step(trace, 'S2 a 换身份', core)
  await settle()
  pending[1].resolve(2)
  await settle()
  step(trace, 'S2 新身份成功', core)
  core.dispose()
}

// S3 暂停页刷新一次：要求按页记，结果照写
{
  const { core, pending } = newCore(2)
  const a = config(false)
  core.submit(a, '/api/trace', params({ id: 1 }))
  step(trace, 'S3 暂停页提交', core)
  step(trace, `S3 refresh 收下=${core.refresh(a, '/api/trace', params({ id: 1 }).key)}`, core)
  step(trace, `S3 暂停页有资格=${core.isEligible(a, '/api/trace', params({ id: 1 }).key)}`, core)
  await settle()
  pending[0].resolve(3)
  await settle()
  step(trace, 'S3 刷新成功', core)
  core.dispose()
}

// S4 隐藏：不取数；恢复按到期取一次
{
  const { core, pending } = newCore(2)
  const a = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  await settle()
  pending[0].resolve(4)
  await settle()
  core.setVisible(false)
  await settle()
  step(trace, 'S4 隐藏', core)
  core.setVisible(true)
  await settle()
  step(trace, 'S4 恢复（未到期不取）', core)
  core.dispose()
}

// S5 失败：写进同一格、旧数据保留、要求结算
{
  const { core, pending } = newCore(2)
  const a = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  await settle()
  pending[0].resolve(5)
  await settle()
  core.refresh(a, '/api/trace', params({ id: 1 }).key)
  await settle()
  pending[1].reject(new Error('boom'))
  await settle()
  step(trace, 'S5 失败', core)
  core.dispose()
}

// S6 并发上限：满槽排队，先来先跑
{
  const { core, pending } = newCore(1)
  const a = config(true)
  const b = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  core.submit(b, '/api/trace', params({ id: 2 }))
  await settle()
  step(trace, 'S6 一跑一队', core)
  pending[0].resolve(1)
  await settle()
  step(trace, 'S6 槽空后第二个起跑', core)
  pending[1].resolve(2)
  await settle()
  step(trace, 'S6 都成功', core)
  core.dispose()
}

// S7 卸载最后一个声明者：实例与结果一起消失，在途 abort
{
  const { core, pending } = newCore(2)
  const a = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  await settle()
  core.undeclare(a)
  step(trace, 'S7 卸载（在途仍占槽）', core)
  pending[0].resolve(9)
  await settle()
  step(trace, 'S7 迟到结束', core)
  core.dispose()
}

// S8 销毁：之后一切入口都不产生事实，迟到的结果不写表
{
  const { core, pending, table } = newCore(2)
  const a = config(true)
  core.submit(a, '/api/trace', params({ id: 1 }))
  await settle()
  core.dispose()
  step(trace, 'S8 销毁', core)
  const submitted = core.submit(a, '/api/trace', params({ id: 2 }))
  const refreshed = core.refresh(a, '/api/trace', params({ id: 1 }).key)
  pending[0].resolve(10)
  await settle()
  step(trace, `S8 销毁后调用 submit=${submitted.status} refresh=${refreshed}`, core)
  trace.push(`S8 结果表写入次数=${table.writes.length}`)
}

console.log(trace.join('\n'))

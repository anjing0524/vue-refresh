import assert from 'node:assert/strict'
import { RefreshCore } from '../src/core.ts'
import type { ResultCell, ResultSink } from '../src/core.ts'
import type { Config, Resource } from '../src/resource.ts'
import { prepareParameters } from '../src/source.ts'
import type { Parameters } from '../src/source.ts'
import type { RefreshDisplay, SubmitResult } from '../src/public-types.ts'
import { snapshot } from '../scripts/observe.ts'

/**
 * 核心测试的共享夹具：结果表替身、核心工厂、页面替身与探针。
 * 用例本体按规则域拆在 `core.identity / core.schedule / core.refresh / core.failure / core.lifecycle` 五个文件里，
 * 每个文件各自 `afterEach(disposeAllCores)`。
 */

/** 每个用例建过的核心；分片文件的 afterEach 经 `disposeAllCores` 清空（周期调度留下的 Timer 会挡住进程退出）。 */
const cores: RefreshCore[] = []

/**
 * 结果表替身：与 Pinia store 同形（格＝成功 ＋ 失败，整格换新对象、随实例释放即删），
 * 并记录成功写入次序供断言。`onWrite` 让用例模拟「写结果的那一刻页面代码同步重入」。
 */
function newTable() {
  const cells = new Map<string, ResultCell>()
  const writes: Array<{ url: string; key: string; data: unknown; updatedAt: number }> = []
  const id = (url: string, key: string): string => `${url}\u0000${key}`
  const table = {
    sink: {
      write(url: string, key: string, data: unknown, updatedAt: number): void {
        cells.set(id(url, key), { data, updatedAt, error: undefined, failedAt: null })
        writes.push({ url, key, data, updatedAt })
        table.onWrite?.()
      },
      fail(url: string, key: string, error: unknown, failedAt: number): void {
        const previous = cells.get(id(url, key))
        cells.set(id(url, key), {
          data: previous?.data, updatedAt: previous?.updatedAt ?? null, error, failedAt,
        })
        table.onWrite?.()
      },
      remove(url: string, key: string): void { cells.delete(id(url, key)) },
      read(url: string, key: string): ResultCell | undefined { return cells.get(id(url, key)) },
      list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[] {
        const rows: { url: string; key: string; cell: ResultCell }[] = []
        for (const [raw, cell] of cells) {
          const [url = '', key = ''] = raw.split('\u0000')
          rows.push({ url, key, cell })
        }
        return rows
      },
    } satisfies ResultSink & { list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[] },
    writes,
    onWrite: null as (() => void) | null,
    read(url: string, key: string): ResultCell | undefined { return cells.get(id(url, key)) },
    /** 这一格上最近一次失败的时刻；成功过、或从未写过都是 `null`。 */
    failedAt(url: string, key: string): number | null { return cells.get(id(url, key))?.failedAt ?? null },
    /** 这一格上最近一次失败的原始异常。 */
    error(url: string, key: string): unknown { return cells.get(id(url, key))?.error },
  }
  return table
}

/** 每个核心一张结果表：`newCore` 建表并登记，`page()` 从这里取，因此调用点不用改。 */
const tables = new WeakMap<RefreshCore, ReturnType<typeof newTable>>()

/**
 * 每个用例一个假传输：返回值就是这次取数的结果（框架只取它的 `data`）。
 * 旧契约里写在定义上的 `load` 原样搬到这里——框架自己发 `post(url, 参数值的克隆, { signal })`。
 */
export type FakePost = (url: string, body: object, context: { readonly signal: AbortSignal }) => Promise<unknown>
export function newCore(maxConcurrent: number, post: FakePost = async () => undefined): RefreshCore {
  const table = newTable()
  const core = new RefreshCore(maxConcurrent, {
    // 显式标注参数：`RefreshHttp.post` 的第二个参数是 `unknown`，这里要收窄回假传输的 `object`。
    post: async (url: string, body: object, context: { readonly signal: AbortSignal }) => ({
      data: await post(url, body, context),
    }),
  }, table.sink)
  tables.set(core, table)
  cores.push(core)
  return core
}

/** 取本核心的结果表；只有经 `newCore` 建立的核心才有。 */
export function tableOf(core: RefreshCore): ReturnType<typeof newTable> {
  const table = tables.get(core)
  assert.ok(table, '核心必须先经 newCore 建立结果表')
  return table
}

/** 每个分片文件的 afterEach 调它：销毁本文件用例建过的核心（周期调度留下的唯一唤醒 Timer 会挡住进程退出）。 */
export function disposeAllCores(): void {
  for (const core of cores.splice(0)) core.dispose()
}

/**
 * 配置快照的默认值：环境允许（这一页激活且浏览器可见）、开启意愿、超长周期。
 *
 * `present` 是**适配层合成**的「环境允许」：ADR-61 起这一页是否激活在快照里，可见性也由适配层并进来
 * ——核心只读这一份快照，不持有全局可见性。
 */
export const DEFAULT_CONFIG: Config = { enabled: true, every: 100_000, present: true }
/** 只给要改的那几项；`null` 表示整份快照非法。 */
export type PartialConfig = { enabled?: boolean; every?: number; present?: boolean }

/** 一页：一份配置槽 ＋ 按身份读结果表。与适配层同一分工（ADR-64、ADR-66）。 */
export interface Page {
  /** 这一页在核心里的**全部内容**：一份配置快照，原地改写，按身份挂在实例的 `declarers` 里。 */
  readonly config: Config
  readonly url: string
  readonly last: RefreshDisplay<object, unknown> | undefined
  /** 已声明身份的参数键；没有身份时为 `null`（参数准备在调用方这一侧，与适配层同形）。 */
  key(): string | null
  /** 本页**当前身份**那一格上最近一次失败的时刻；没有身份、成功过、从未写过都是 `null`（ADR-63）。 */
  failedAt(): number | null
  /** 本页**当前身份**那一格上最近一次失败的原始异常。 */
  error(): unknown
  /** 本页**当前身份**被写进结果表几次（成功；旧契约里的「交付次数」）；没有身份时为 0。 */
  writes(): number
  submit(args: object): SubmitResult
  refresh(): void
  /** 合并式写快照：只给要改的那项，其余沿用当前值（ADR-61 的单一写入口）；`null` 表示配置非法。 */
  set(next: PartialConfig | null): void
}

export function page(
  core: RefreshCore,
  source: string,
  initial: PartialConfig | null = {},
): Page {
  const table = tableOf(core)
  const url = source
  // 交给核心的只有数据：URL、配置快照与身份（参数准备在提交边界做）——与适配层同一分工（ADR-64、ADR-66）。
  // 资源声明现在就是 URL 字符串本身：没有定义对象、也没有准入回调（ADR-74）。
  const config: Config = initial === null
    ? { enabled: false, every: null, present: false }
    : { ...DEFAULT_CONFIG, ...initial }
  /** 本页已声明身份的副本：页面 → 身份这条映射归调用方（核心只按身份登记，ADR-66）。 */
  let declared: Parameters | null = null
  return {
    config,
    url,
    key: () => declared?.key ?? null,
    writes(): number {
      const key = declared?.key
      if (key === undefined) return 0
      return table.writes.filter(write => write.url === url && write.key === key).length
    },
    failedAt(): number | null {
      const key = declared?.key
      return key === undefined ? null : table.failedAt(url, key)
    },
    error(): unknown {
      const key = declared?.key
      return key === undefined ? undefined : table.error(url, key)
    },
    // 与适配层同形：准备失败就地变成 `rejected`，核心拿到的永远是可用身份（ADR-64）。
    submit: args => {
      let parameters: Parameters
      try {
        parameters = prepareParameters(args)
      } catch (error) {
        return { status: 'rejected', error }
      }
      const result = core.submit(config, url, parameters)
      if (result.status === 'accepted') declared = parameters
      return result
    },
    refresh: () => {
      if (declared === null) return
      core.refresh(config, url, declared.key)
    },
    set(next) {
      if (next === null) core.setConfig(config, undefined, undefined, false)
      else core.setConfig(config, next.enabled ?? config.enabled, next.every ?? config.every, next.present ?? config.present)
    },
    get last() {
      if (declared === null) return undefined
      const cell = table.read(url, declared.key)
      if (!cell) return undefined
      // `display` 的形状：`args` 每次读取复制一份（身份键所描述的那份值），`data` 是结果表里同一个对象。
      return {
        args: structuredClone(declared.args),
        data: cell.updatedAt === null ? null : cell.data,
        updatedAt: cell.updatedAt,
        error: cell.error,
        failedAt: cell.failedAt,
      }
    },
  }
}

/**
 * 两个探针的分工（ADR-61 把「声明」与「资格」拆开之后）：
 *
 * - `declared`：这个句柄**声明**到了哪个实例。声明只要页面挂载着就一直算（暂停、失活、隐藏都不撤销），
 *   它决定实例与结果的生死——只有卸载、换身份、销毁才撤销。
 * - `reader`：这个句柄此刻算不算该身份的**读者**（有资格，或刚点过刷新还没读到）。
 *   它只决定画面跟不跟随新结果（冻结见 ADR-60），不决定实例在不在。
 */
export function declared(core: RefreshCore, view: Page): Resource | undefined {
  return snapshot(core).resources.find(resource => resource.declarers.has(view.config))
}

/**
 * 这一页此刻有没有取数资格（环境 ＋ 开启意愿）。
 *
 * 注意这里**只问资格**：ADR-66 把「谁该跟随结果表」的读闸门搬到了适配层
 * （`isEligible` ＋「还没有读取时间且浏览器可见」），核心不再回答那个问题——读闸门的效果由 tests/vue.test.ts 的 A05 用例证明。
 */
export function eligible(core: RefreshCore, view: Page): boolean {
  const key = view.key()
  return key !== null && core.isEligible(view.config, view.url, key)
}

/**
 * 队列不变量：在队的实例必须带着「这次执行」的 controller，而且不可能同时在跑。
 *
 * `queue` 的唯一写入者是 `place`，它进入 `queued` 时就建好 controller，因此 `startQueued`
 * 不再复核归属（ADR-62 删掉了那个已不可达的分支）。这条断言把那个前提钉住：一旦有人新增
 * 第二个入队路径，它会红。
 */
export function assertQueueConsistent(core: RefreshCore): void {
  const view = snapshot(core)
  for (const resource of view.queued) {
    assert.notEqual(resource.controller, null, '在队的实例必须带着这次执行的 controller')
    assert.equal(view.running.includes(resource), false, '在队的实例不可能同时在跑')
  }
  // `enqueue` 不去重：前提是调用点都保证它不在队里，这条探针替运行期守着。
  assert.equal(new Set(view.queued).size, view.queued.length, '队列里没有重复项：一个实例一次只排一次')
}

/** 让微任务与 0ms 定时器跑完（每个 `await` 一跳）。 */
export const settle = async (rounds = 3): Promise<void> => {
  for (let index = 0; index < rounds; index++) await new Promise(resolve => { setTimeout(resolve, 0) })
}

export const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

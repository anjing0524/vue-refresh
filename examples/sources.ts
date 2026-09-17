/**
 * 三条代表页面共用的业务定义与本地服务适配。
 *
 * 页面只做两件事：声明「要哪份数据、多久一次、什么时候算需要」，以及决定拿到结果后怎么显示。
 * 身份、共享、调度、取消与有效结果交付都由框架负责；参数与 DTO 的运行时校验属于 HTTP 边界。
 */
import { defineRefresh } from '../src/source'
import type { RefreshManager, RefreshSource } from '../src/public-types'

export type SortField = 'price' | 'change' | 'volume'

/** 列表查询的完整业务参数：四个字段一起构成数据身份。 */
export interface ListParams { account: string; market: string; page: number; sortBy: SortField }

export interface ListRow { symbol: string; price: number; change: number; volume: number }

export interface ListResult { rows: ListRow[]; page: number; requestId: number }

export interface QuoteParams { account: string; symbol: string }

export interface QuoteResult { quote: { price: number; requestId: number } }

/** 页面与自动化断言共用的请求日志：只记录真实到达 HTTP 边界的调用。 */
export interface CallLog { id: number; url: string; finished: boolean; aborted: boolean; failed: boolean }

export const log: { calls: CallLog[]; events: string[] } = { calls: [], events: [] }

async function request(path: string, signal: AbortSignal): Promise<unknown> {
  const call: CallLog = { id: log.calls.length + 1, url: path, finished: false, aborted: false, failed: false }
  log.calls.push(call)
  log.events.push(`请求${call.id}：开始 ${path}`)
  signal.addEventListener('abort', () => {
    call.aborted = true
    log.events.push(`请求${call.id}：收到取消信号`)
  }, { once: true })
  try {
    // 超时与取消都在传输层生效：Deadline 覆盖响应体读取，不做提前的 Promise.race。
    const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch (error) {
    call.failed = true
    throw error
  } finally {
    call.finished = true
    log.events.push(`请求${call.id}：执行结束`)
  }
}

const quoteQuery = (args: QuoteParams): string =>
  `account=${encodeURIComponent(args.account)}&symbol=${encodeURIComponent(args.symbol)}`

/** HTTP 边界的响应校验：业务结构在这里被拒绝，框架只拒绝 undefined 并建立副本所有权。 */
function readQuote(body: unknown): QuoteResult {
  const data = body as { quote?: { price?: unknown; requestId?: unknown } } | null
  if (!data || typeof data.quote !== 'object' || data.quote === null) throw new TypeError('Invalid quote response')
  const { price, requestId } = data.quote
  if (typeof price !== 'number' || !Number.isFinite(price) || typeof requestId !== 'number') {
    throw new TypeError('Invalid quote response')
  }
  return { quote: { price, requestId } }
}

export async function runQuote(args: QuoteParams, { signal }: { signal: AbortSignal }): Promise<QuoteResult> {
  return readQuote(await request(`/api/quote?${quoteQuery(args)}`, signal))
}

function readList(body: unknown, page: number): ListResult {
  const data = body as { rows?: unknown; requestId?: unknown }
  if (!Array.isArray(data.rows) || typeof data.requestId !== 'number') throw new TypeError('Invalid list response')
  const rows = data.rows.map(raw => {
    const row = raw as Partial<ListRow>
    if (typeof row.symbol !== 'string' || typeof row.price !== 'number' || !Number.isFinite(row.price)
      || typeof row.change !== 'number' || typeof row.volume !== 'number') throw new TypeError('Invalid list row')
    return { symbol: row.symbol, price: row.price, change: row.change, volume: row.volume }
  })
  return { rows, page, requestId: data.requestId }
}

export async function runList(args: ListParams, { signal }: { signal: AbortSignal }): Promise<ListResult> {
  const query = new URLSearchParams({
    account: args.account, market: args.market, page: String(args.page), sortBy: args.sortBy,
  })
  return readList(await request(`/api/list?${query.toString()}`, signal), args.page)
}

const MARKETS = ['SH', 'SZ', 'HK']

export const listSource = defineRefresh<ListParams, ListResult>({
  // validate 属于资源定义：所有使用方共用同一套业务规则，只检查业务条件。
  validate: p => p.account.length > 0 && MARKETS.includes(p.market)
    && Number.isSafeInteger(p.page) && p.page >= 1,
  load: runList,
})

export const quoteSource = defineRefresh<QuoteParams, QuoteResult>({
  validate: p => p.account.length > 0 && p.symbol.length > 0,
  load: runQuote,
})

let installed: RefreshManager | null = null

/** 外壳安装完成后写入；页面只用公开入口读共享结果。 */
export function bindManager(manager: RefreshManager): void {
  installed = manager
}

/** 只读共享快照：不创建实例、不延长生存期，无结果返回 undefined。返回类型由包自己的签名推断。 */
export function readShared<P extends object, T>(source: RefreshSource<P, T>, args: P) {
  return installed?.readSnapshot(source, args)
}

/** 相对时间按当前时刻重算（随交付重渲染）；页面不为此自建 Timer。 */
export function ageLine(updatedAt: number): string {
  return `${new Date(updatedAt).toLocaleTimeString()} · ${Math.max(0, Math.round((Date.now() - updatedAt) / 1000))} 秒前`
}

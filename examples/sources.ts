/**
 * 三条代表页面共用的业务定义与本地服务适配。
 *
 * 页面只做两件事：声明「要哪份数据、多久一次、什么时候算需要」，以及决定拿到结果后怎么显示。
 * 身份（URL ＋ 参数值）、共享、调度、取消与有效结果交付都由框架负责；请求也由框架发起——它按定义里的
 * URL 对 `demoHttp` 发 `post(url, 参数值, { signal })`。参数与 DTO 的运行时校验属于这一侧（业务／传输适配）。
 */
import { defineRefresh } from '../src/source'
import type { RefreshHttp } from '../src/core'


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

/**
 * 传输：框架只要求一个 `post`，真实的 axios 实例在结构上就满足这个形状。
 * 这里用 fetch 顶替（示例不带 axios 依赖），本地夹具按 URL 分派。
 */
export const demoHttp: RefreshHttp = {
  post: async (url, body, { signal }) => ({ data: await request(url, body as object, signal) }),
}

async function request(path: string, body: object, signal: AbortSignal): Promise<unknown> {
  const call: CallLog = { id: log.calls.length + 1, url: path, finished: false, aborted: false, failed: false }
  log.calls.push(call)
  log.events.push(`请求${call.id}：开始 ${path}`)
  signal.addEventListener('abort', () => {
    call.aborted = true
    log.events.push(`请求${call.id}：收到取消信号`)
  }, { once: true })
  try {
    // 超时与取消都在传输层生效：Deadline 覆盖响应体读取，不做提前的 Promise.race。
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload: unknown = await response.json()
    // 响应形状的校验也在传输层：畸形响应变成取数失败，而不是被当成成功结果交付。
    return path === '/api/list' ? readList(payload, (body as ListParams).page) : readQuote(payload)
  } catch (error) {
    call.failed = true
    throw error
  } finally {
    call.finished = true
    log.events.push(`请求${call.id}：执行结束`)
  }
}

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

// 参数准入由调用方在 `submit` 之前自己判（框架不再替调用方跑任何回调，ADR-74），因此这里只有 URL：
// 声明一次参数类型与原始返回结构，同一个 URL 的多次声明合并成同一个实例。
export const listSource = defineRefresh<ListParams, ListResult>('/api/list')

export const quoteSource = defineRefresh<QuoteParams, QuoteResult>('/api/quote')

/** 相对时间按当前时刻重算（随交付重渲染）；页面不为此自建 Timer。 */
export function ageLine(updatedAt: number): string {
  return `${new Date(updatedAt).toLocaleTimeString()} · ${Math.max(0, Math.round((Date.now() - updatedAt) / 1000))} 秒前`
}

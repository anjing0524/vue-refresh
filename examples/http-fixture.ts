import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// Local experiment service only. No client-side request or Pinia substitutes.
export function httpFixture(): Plugin {
  let nextId = 0
  let manual = false
  /** 接下来的 N 个业务请求返回 500，用于观察「后台失败继续」与「失败关闭」。 */
  let failNext = 0
  const requests: Array<{ id: number; status: string; query: string }> = []
  const pending = new Map<number, { response: ServerResponse; timer?: ReturnType<typeof setTimeout>; kind: 'quote' | 'list'; url: URL }>()
  const json = (res: ServerResponse, value: unknown) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }
  function release(id: number) {
    const entry = pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(id)
    const record = requests.find(r => r.id === id)!
    record.status = 'completed'
    json(entry.response, entry.kind === 'list' ? listBody(entry.url, id) : { quote: { price: 100 + id, requestId: id } })
  }
  // 合成列表：同一请求号给出同一份数据，排序字段参与结果，便于断言。
  const MARKETS: Record<string, readonly string[]> = {
    SH: ['600000', '600036', '601318'],
    SZ: ['000001', '000002', '300750'],
    HK: ['00700', '09988', '03690'],
  }
  function listBody(url: URL, id: number) {
    const symbols = MARKETS[url.searchParams.get('market') ?? ''] ?? []
    const sortBy = url.searchParams.get('sortBy') ?? 'price'
    const key = sortBy === 'change' ? 'change' : sortBy === 'volume' ? 'volume' : 'price'
    return {
      rows: symbols.map((symbol, index) => ({
        symbol,
        price: 100 + id * 10 + index,
        change: Number((((index % 2 === 0 ? 1 : -1) * (id + index)) / 100).toFixed(2)),
        volume: 1000 * (index + 1) + id,
      })).sort((left, right) => left[key] - right[key]),
      requestId: id,
    }
  }
  async function body(req: IncomingMessage) {
    let value = ''
    for await (const chunk of req) value += String(chunk)
    return value ? JSON.parse(value) as { manual?: boolean; count?: number } : {}
  }
  return {
    name: 'local-http-fixture',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname === '/__fixture/state') {
          json(res, requests)
        } else if (url.pathname === '/__fixture/reset' && req.method === 'POST') {
          void body(req).then(config => {
            for (const entry of pending.values()) {
              clearTimeout(entry.timer)
              entry.response.destroy()
            }
            pending.clear()
            requests.length = 0
            nextId = 0
            manual = config.manual ?? false
            failNext = 0
            json(res, { ok: true })
          }).catch(() => { res.statusCode = 400; res.end() })
        } else if (url.pathname === '/__fixture/fail-next' && req.method === 'POST') {
          void body(req).then(config => {
            failNext = config.count ?? 1
            json(res, { ok: true })
          }).catch(() => { res.statusCode = 400; res.end() })
        } else if (url.pathname.startsWith('/__fixture/release/') && req.method === 'POST') {
          release(Number(url.pathname.split('/').at(-1)))
          json(res, { ok: true })
        } else if (url.pathname === '/api/quote' || url.pathname === '/api/list') {
          const id = ++nextId
          const record = { id, status: 'pending', query: url.search }
          requests.push(record)
          if (failNext > 0) {
            failNext -= 1
            record.status = 'failed'
            res.statusCode = 500
            json(res, { error: 'fixture failure' })
            return
          }
          const entry: { response: ServerResponse; timer?: ReturnType<typeof setTimeout>; kind: 'quote' | 'list'; url: URL } = {
            response: res, kind: url.pathname === '/api/list' ? 'list' : 'quote', url,
          }
          pending.set(id, entry)
          res.on('close', () => {
            if (!res.writableEnded) record.status = 'aborted'
            clearTimeout(entry.timer)
            pending.delete(id)
          })
          if (!manual) entry.timer = setTimeout(() => release(id), 700)
        } else next()
      })
      server.httpServer?.on('close', () => {
        for (const entry of pending.values()) clearTimeout(entry.timer)
      })
    },
  }
}

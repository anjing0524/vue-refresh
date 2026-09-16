import { createApp, defineComponent, h, inject, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import { createPinia } from 'pinia'
import { defineRefresh } from '../src/source'
import type { DeepReadonly, RefreshHandle, RefreshLoadContext, RefreshResult } from '../src/public-types'
import type { Manager } from '../src/manager'
interface QuoteParams { account: string; symbol: string }
interface Quote { quote: { price: number; requestId: number } }
import { createRefreshManager, managerKey } from '../src/app'
import { useRefresh } from '../src/vue'
import { bindManager, log } from './sources'
import type { CallLog } from './sources'
import { QueryListPage } from './pages/query-list'
import { QuotePanelPage } from './pages/quote-panel'
import { B09View, SharedPairPage } from './pages/shared-pair'
import './style.css'

const params = new URLSearchParams(location.search)

/** 集成验证台的只读观测面；只给测试用，不是 src/package API。 */
export interface HarnessSnapshot {
  calls: Array<{ id: number; aborted: boolean; finished: boolean }>
  events: string[]
  queryResults: Record<string, RefreshResult | null>
  pages: Record<string, { readonly args: QuoteParams; readonly data: Quote; readonly origin: string; readonly updatedAt: number } | null>
  entries: Record<string, { version: number; data: Quote }>
  running: number
  queued: number
  resources: number
  timer: boolean
  pending: boolean
}
export interface HarnessBridge {
  snapshot(): HarnessSnapshot
  query(name: string, symbol: string): void
  enable(name: string, enabled: boolean): void
  resolve(id: number, price: number): void
  mutatePage(name: string, price: number): void
  submit(name: string, args: QuoteParams): { readonly status: string } | undefined
  unmount(): void
}

/** 外壳的只读观测面；同样只给示例与测试用。 */
export interface ShellBridge {
  inspect(): {
    resources: number; handles: number; entries: number
    running: number; queued: number; scheduled: boolean
  }
  log(): { calls: CallLog[]; events: string[] }
}

/**
 * 集成验证台。
 *
 * `tests/browser.html` 与 Playwright 的六条场景共用这一个视图，代码保持原样：它带
 * `?mode=controlled` 的手动结算与只读测试桥，与三条代表页面不是同一类东西，因此不合并；
 * 它的请求函数也不能复用 `sources.ts` 的 `runQuote`——手动结算只在这里需要。
 */
function mountHarness(): void {
  const controlled = params.get('mode') === 'controlled'
  const every = controlled ? 60_000 : params.has('test') ? 120 : 2_000
  const calls: Array<{ id: number; signal: AbortSignal; finished: boolean; resolve: (value: Quote) => void }> = []
  const events: string[] = []
  const readQuote = async (args: DeepReadonly<QuoteParams>, { signal }: RefreshLoadContext): Promise<Quote> => {
    const id = calls.length + 1
    let resolve!: (value: Quote) => void
    const deferred = controlled ? new Promise<Quote>(yes => { resolve = yes }) : null
    const call = { id, signal, finished: false, resolve: (value: Quote) => resolve(value) }
    calls.push(call)
    signal.addEventListener('abort', () => events.push(`请求${id}：收到取消信号`), { once: true })
    events.push(`请求${id}：开始`)
    try {
      if (deferred) return await deferred
      // Deadline includes response body consumption; no early Promise.race.
      const response = await fetch(`/api/quote?account=${args.account}&symbol=${args.symbol}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: unknown = await response.json()
      // The HTTP boundary owns the business response contract.
      if (!data || typeof data !== 'object' || !('quote' in data)
        || !data.quote || typeof data.quote !== 'object'
        || !('price' in data.quote) || typeof data.quote.price !== 'number'
        || !Number.isFinite(data.quote.price)
        || !('requestId' in data.quote) || typeof data.quote.requestId !== 'number') {
        throw new TypeError('Invalid quote response')
      }
      return { quote: { price: data.quote.price, requestId: data.quote.requestId } }
    } finally {
      call.finished = true
      events.push(`请求${id}：执行结束`)
    }
  }
  const source = defineRefresh<QuoteParams, Quote>({
    validate: params => params.account.length > 0 && params.symbol.length > 0,
    load: readQuote,
  })
  const queryResults: Record<string, RefreshResult | null> = {}

  let manager: Manager
  const components = new Map<string, { task: RefreshHandle<QuoteParams, Quote>; enabled: ReturnType<typeof ref<boolean>> }>()
  const Widget = defineComponent({
    props: { label: { type: String, required: true } },
    setup(props) {
      manager = inject(managerKey)!.manager
      const enabled = ref(true)
      const draftSymbol = ref('DEMO')
      const task = useRefresh(source, { enabled, every, onError: () => { events.push('后台请求失败，等待下一周期') } })
      components.set(props.label, { task, enabled })
      const args: QuoteParams = props.label === '甲'
        ? { account: 'demo', symbol: 'DEMO' } : { symbol: 'DEMO', account: 'demo' }
      onMounted(() => task.submit(args))
      return () => h('section', { class: 'card', 'data-testid': props.label }, [
        h('div', { class: 'card-heading' }, [h('h2', `组件${props.label}`), h('span', enabled.value ? '订阅中' : '已暂停')]),
        h('p', { class: 'price', 'data-testid': `price-${props.label}` }, task.display.value?.data.quote.price.toString() ?? '等待首查'),
        h('p', task.display.value ? `来自请求 ${task.display.value.data.quote.requestId}` : '两个组件共用同一来源和参数'),
        h('p', task.display.value ? `展示参数：${task.display.value.args.symbol} · ${task.display.value.origin === 'refresh' ? '本页刷新' : '共享刷新'}` : ''),
        // updatedAt 是墙钟读数：相对时间按 U16/§2.5 的建议把差值钳制到 0，避免校时回拨显示负数。
        h('p', { 'data-testid': `age-${props.label}` }, task.display.value
          ? `数据时间：${new Date(task.display.value.updatedAt).toLocaleTimeString()} · ${Math.max(0, Math.round((Date.now() - task.display.value.updatedAt) / 1000))} 秒前`
          : ''),
        h('label', ['品种 ', h('input', { value: draftSymbol.value, onInput: (event: Event) => { draftSymbol.value = (event.target as HTMLInputElement).value } })]),
        h('button', { onClick: () => { task.submit({ account: 'demo', symbol: draftSymbol.value }); void task.refresh() } }, '刷新本页'),
        h('button', { onClick: () => { enabled.value = !enabled.value } }, enabled.value ? '暂停刷新' : '恢复刷新'),
      ])
    },
  })
  const app = createApp({
    render: () => h('main', [
      h('p', { class: 'eyebrow' }, '真实 Vue · Pinia · HTTP'),
      h('h1', '两个组件，一份共享刷新'),
      h('p', { class: 'intro' }, '暂停一页，另一页继续；全部暂停后取消请求，恢复时重新获取。暂停页面保留自己的画面。'),
      h('div', { class: 'cards' }, [h(Widget, { label: '甲' }), h(Widget, { label: '乙' })]),
      h('p', { class: 'note' }, '固定业务参数接口 · 共享刷新与独立查询 · 验证范围见运行记录。'),
    ]),
  })
  const pinia = createPinia()
  app.use(pinia)
  const refresh = createRefreshManager({ pinia, maxConcurrent: params.get('slots') === '1' ? 1 : 2 })
  app.use(refresh)
  if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
  app.mount('#app')

  // Example-only test bridge, never a src/package API or production diagnostic field.
  const bridge: HarnessBridge = {
    snapshot() {
      // 只读观测面：示例面板与测试用同一个投影，不直接读核心的可变字段。
      const view = manager.inspect()
      return {
        calls: calls.map(c => ({ id: c.id, aborted: c.signal.aborted, finished: c.finished })),
        events: [...events],
        queryResults: structuredClone(queryResults),
        pages: Object.fromEntries([...components].map(([name, c]) => [name, structuredClone(c.task.display.value)])),
        entries: structuredClone(view.entries) as Record<string, { version: number; data: Quote }>,
        running: view.running.length, queued: view.queued.length,
        resources: view.resources.length,
        timer: view.scheduled, pending: view.pendingFlush,
      }
    },
    query(name: string, symbol: string) {
      const page = components.get(name)!
      queryResults[name] = null
      // 主动刷新：先声明身份，再用与自动刷新同一条路径取一次。
      page.task.submit({ account: 'demo', symbol })
      void page.task.refresh().then(result => { queryResults[name] = result })
    },
    enable(name: string, enabled: boolean) { components.get(name)!.enabled.value = enabled },
    resolve(id: number, price: number) { if (controlled) calls[id - 1]!.resolve({ quote: { price, requestId: id } }) },
    mutatePage(name: string, price: number) {
      // Deliberately bypass readonly only to verify runtime ownership isolation.
      const data = components.get(name)!.task.display.value!.data as Quote
      data.quote.price = price
    },
    submit(name: string, args: QuoteParams) { return components.get(name)!.task.submit(args) },
    unmount() { app.unmount() },
  }
  window.experiment = bridge
}

const VIEWS: Array<{ id: string; label: string; component: Component }> = [
  { id: 'query-list', label: '查询列表', component: QueryListPage },
  { id: 'quote-panel', label: '行情面板', component: QuotePanelPage },
  { id: 'shared-pair', label: '双组件共享', component: SharedPairPage },
  { id: 'b09', label: 'B09 组合', component: B09View },
]

/**
 * 三条代表页面与 B09 组合：只挂载当前视图，切走即整体释放，
 * 因此每个视图的共享事实只由它自己的组件决定。
 */
function mountShell(): void {
  const pinia = createPinia()
  const refresh = createRefreshManager({ pinia, maxConcurrent: params.get('slots') === '1' ? 1 : 2 })
  bindManager(refresh)
  const active = ref(params.get('page') ?? VIEWS[0]!.id)
  let manager: Manager | null = null
  const current = (): { id: string; label: string; component: Component } =>
    VIEWS.find(view => view.id === active.value) ?? VIEWS[0]!

  const Shell = defineComponent({
    setup() {
      manager = inject(managerKey)!.manager
      return () => h('main', [
        h('p', { class: 'eyebrow' }, '真实 Vue · Pinia · HTTP · 三个代表页面'),
        h('h1', '统一刷新管理：代表页面'),
        h('nav', { class: 'tabs' }, VIEWS.map(view => h('button', {
          'data-testid': `tab-${view.id}`,
          class: view.id === active.value ? 'tab active' : 'tab',
          onClick: () => { active.value = view.id },
        }, view.label))),
        h('p', { class: 'note' }, '页面只表达刷新需求：身份、共享、调度、取消与有效结果交付由框架负责。'),
        h('section', { class: 'view' }, [h(current().component, { key: current().id })]),
      ])
    },
  })
  const app = createApp(Shell)
  app.use(pinia)
  app.use(refresh)
  if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
  app.mount('#app')

  window.pages = {
    inspect() {
      const view = manager!.inspect()
      return {
        resources: view.resources.length, handles: view.handles.length,
        entries: Object.keys(view.entries).length,
        running: view.running.length, queued: view.queued.length, scheduled: view.scheduled,
      }
    },
    log: () => ({ calls: log.calls.map(call => ({ ...call })), events: [...log.events] }),
  }
}

declare global {
  interface Window {
    experiment: HarnessBridge
    pages: ShellBridge
  }
}

if (params.has('test') || params.get('mode') === 'controlled') mountHarness()
else mountShell()
